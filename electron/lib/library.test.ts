import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newNode } from '../../shared/notes';
import type { Note, Recording } from '../../shared/types';

// 設定はテスト用の一時フォルダーを指すようにする（electron モジュールは読まない）
let tmp = '';
vi.mock('./settings', () => ({
	loadSettings: async () => ({ libraryPath: tmp }),
	saveSettings: async () => ({ libraryPath: tmp }),
	defaultLibraryPath: () => tmp,
	legacyLibraryPath: () => tmp,
	oldNameLibraryPath: () => tmp
}));

const {
	listNotes,
	saveNote,
	removeNote,
	listRecordings,
	saveRecording,
	removeRecording,
	usedBytes,
	writeMediaFile,
	moveFolder
} = await import('./library');
const { importLegacyBackup } = await import('./legacy');

function note(id: string, patch: Partial<Note> = {}): Note {
	return { id, title: `t-${id}`, root: newNode(`t-${id}`), createdAt: 1, updatedAt: 1, ...patch };
}

function recording(id: string, noteId: string): Recording {
	return {
		id,
		noteId,
		title: id,
		kind: 'mic',
		createdAt: 1,
		updatedAt: 1,
		durationMs: 1000,
		mimeType: 'audio/webm',
		fileName: `${id}.webm`,
		size: 3,
		hasVideo: false,
		hasMic: true,
		displaySurface: null,
		status: 'complete',
		markers: []
	};
}

beforeEach(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yvn-'));
});

afterEach(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

describe('notes', () => {
	it('保存・一覧・削除ができ、更新日の新しい順に並ぶ', async () => {
		await saveNote(note('a', { updatedAt: 1 }));
		await saveNote(note('b', { updatedAt: 5 }));
		const list = await listNotes();
		expect(list.map((n) => n.id)).toEqual(['b', 'a']);
		await removeNote('b');
		expect((await listNotes()).map((n) => n.id)).toEqual(['a']);
	});

	it('壊れた JSON があっても、ほかのノートは読める', async () => {
		await saveNote(note('ok'));
		await fs.writeFile(path.join(tmp, 'notes', 'broken.json'), '{ not json', 'utf8');
		const list = await listNotes();
		expect(list.map((n) => n.id)).toEqual(['ok']);
	});

	it('旧形式（本文が文字列）のノートも木として読める', async () => {
		await fs.mkdir(path.join(tmp, 'notes'), { recursive: true });
		await fs.writeFile(
			path.join(tmp, 'notes', 'old.json'),
			JSON.stringify({
				id: 'old',
				title: '旧',
				body: '# 見出し\n- 項目\n- [x] 済',
				createdAt: 1,
				updatedAt: 1
			}),
			'utf8'
		);
		const [n] = await listNotes();
		expect(n.root.children.map((x) => [x.text, x.checked])).toEqual([
			['項目', null],
			['済', true]
		]);
	});

	it('不正な id はフォルダーの外に書かない', async () => {
		await expect(saveNote(note('../evil'))).rejects.toThrow();
	});
});

describe('recordings', () => {
	it('ノートを消すと、属する収録とファイルも消える', async () => {
		await saveNote(note('n1'));
		await writeMediaFile('r1.webm', new Uint8Array([1, 2, 3]));
		await saveRecording(recording('r1', 'n1'));
		expect(await usedBytes()).toBeGreaterThan(3);
		await removeNote('n1');
		expect(await listRecordings()).toEqual([]);
		await expect(fs.stat(path.join(tmp, 'media', 'r1.webm'))).rejects.toThrow();
	});

	it('収録だけを消せる', async () => {
		await writeMediaFile('r2.webm', new Uint8Array([1]));
		await saveRecording(recording('r2', 'n'));
		await removeRecording('r2');
		expect(await listRecordings()).toEqual([]);
	});
});

describe('legacy import', () => {
	it('初期版のバックアップをノートと収録に分けて取り込み、重複は飛ばす', async () => {
		const audio = `data:audio/webm;codecs=opus;base64,${Buffer.from('abc').toString('base64')}`;
		const backup = {
			app: 'yasashii-voice-notes',
			version: 1,
			exportedAt: '2026-09-11T00:00:00Z',
			notes: [
				{
					id: 'old1',
					title: '朝の打ち合わせ',
					memo: '来週の予定',
					createdAt: 10,
					updatedAt: 11,
					durationMs: 9000,
					mimeType: 'audio/webm',
					size: 3,
					audio
				},
				{
					id: 'old1',
					title: '重複',
					memo: '',
					createdAt: 10,
					updatedAt: 11,
					durationMs: 9000,
					mimeType: 'audio/webm',
					size: 3,
					audio
				}
			]
		};
		const file = path.join(tmp, 'backup.json');
		await fs.writeFile(file, JSON.stringify(backup), 'utf8');
		const r = await importLegacyBackup(file);
		expect(r).toEqual({ notes: 1, recordings: 1, skipped: 1 });
		const notes = await listNotes();
		expect(notes[0]).toMatchObject({ id: 'old1', title: '朝の打ち合わせ' });
		expect(notes[0].root.text).toBe('朝の打ち合わせ');
		expect(notes[0].root.children.map((n) => n.text)).toEqual(['来週の予定']);
		const recs = await listRecordings();
		expect(recs[0]).toMatchObject({
			id: 'old1',
			noteId: 'old1',
			fileName: 'old1.webm',
			size: 3,
			kind: 'mic'
		});
		expect(await fs.readFile(path.join(tmp, 'media', 'old1.webm'), 'utf8')).toBe('abc');
	});

	it('別アプリの JSON は拒否する', async () => {
		const file = path.join(tmp, 'x.json');
		await fs.writeFile(file, JSON.stringify({ app: 'other', notes: [] }), 'utf8');
		await expect(importLegacyBackup(file)).rejects.toThrow('バックアップではない');
	});
});

describe('moveFolder（保存先の引っ越し）', () => {
	it('移し先が無ければ丸ごと移す', async () => {
		const base = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-'));
		const from = path.join(base, 'from');
		const to = path.join(base, 'to');
		await fs.mkdir(path.join(from, 'notes'), { recursive: true });
		await fs.writeFile(path.join(from, 'notes', 'a.json'), '{}');
		expect(await moveFolder(from, to)).toBe(true);
		expect(await fs.readFile(path.join(to, 'notes', 'a.json'), 'utf8')).toBe('{}');
		await expect(fs.access(from)).rejects.toBeTruthy();
		await fs.rm(base, { recursive: true, force: true });
	});
	it('移し先がすでにあれば中身を足し、同名ファイルは移し先を優先する', async () => {
		const base = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-'));
		const from = path.join(base, 'from');
		const to = path.join(base, 'to');
		await fs.mkdir(path.join(from, 'media'), { recursive: true });
		await fs.mkdir(path.join(to, 'media'), { recursive: true });
		await fs.writeFile(path.join(from, 'media', 'x.webm'), 'old');
		await fs.writeFile(path.join(from, 'media', 'y.webm'), 'y');
		await fs.writeFile(path.join(to, 'media', 'x.webm'), 'new');
		expect(await moveFolder(from, to)).toBe(true);
		expect(await fs.readFile(path.join(to, 'media', 'x.webm'), 'utf8')).toBe('new');
		expect(await fs.readFile(path.join(to, 'media', 'y.webm'), 'utf8')).toBe('y');
		await fs.rm(base, { recursive: true, force: true });
	});
	it('元が無ければ何もしない', async () => {
		const base = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-'));
		expect(await moveFolder(path.join(base, 'nope'), path.join(base, 'to'))).toBe(false);
		await fs.rm(base, { recursive: true, force: true });
	});
});
