import { promises as fs } from 'node:fs';
import path from 'node:path';
import { normalizeNote } from '../../shared/notes';
import type { Note, Recording } from '../../shared/types';
import {
	defaultLibraryPath,
	legacyLibraryPath,
	loadSettings,
	oldNameLibraryPath,
	saveSettings
} from './settings';

/**
 * 保存先フォルダー（ライブラリー）の読み書き。
 *
 *   <libraryPath>/notes/<id>.json     ノート
 *   <libraryPath>/media/<id>.json     収録のメタ情報
 *   <libraryPath>/media/<id>.<ext>    収録の本体
 *   <libraryPath>/exports/            書き出した動画（フェーズ 3）
 *   <libraryPath>/transcripts/        文字起こし（フェーズ 4）
 *   <libraryPath>/images/             ノードに付けた画像
 *
 * BGM の音楽ファイルは保存先ではなく、アプリ自身の置き場所（userData/bgm。electron/lib/bgm.ts）に持つ。
 */

export const SUBDIRS = ['notes', 'media', 'exports', 'transcripts', 'images'] as const;

export async function libraryPath(): Promise<string> {
	return (await loadSettings()).libraryPath;
}

/**
 * フォルダーを丸ごと別の場所へ移す。同じディスクなら rename で一瞬。
 * 移し先がすでにあれば（前回の移動の途中など）中身を 1 つずつ移す。移したら true
 */
export async function moveFolder(from: string, to: string): Promise<boolean> {
	try {
		await fs.access(from);
	} catch {
		return false;
	}
	await fs.mkdir(path.dirname(to), { recursive: true });
	let toExists = false;
	try {
		await fs.access(to);
		toExists = true;
	} catch {
		/* 無い */
	}
	if (!toExists) {
		await fs.rename(from, to);
		return true;
	}
	for (const name of await fs.readdir(from)) {
		const src = path.join(from, name);
		const dst = path.join(to, name);
		try {
			await fs.access(dst);
			// 同名のフォルダーは中身を足す（ファイルは移し先を優先）
			const st = await fs.stat(src);
			if (st.isDirectory()) await moveFolder(src, dst);
		} catch {
			await fs.rename(src, dst);
		}
	}
	await fs.rmdir(from).catch(() => {});
	return true;
}

/**
 * 以前の既定の保存先（ダウンロードの中）を使っていたら、アプリ自身の置き場所へ丸ごと移す。
 * 移せなければそのまま使い続ける。移したら true
 */
export async function migrateLegacyLibrary(): Promise<boolean> {
	const s = await loadSettings();
	const current = path.resolve(s.libraryPath);
	const dest = defaultLibraryPath();
	// 改名前の置き場所（userData の中）を指していたら、新しい置き場所へ。中身は main.ts が起動時に移している
	if (current === path.resolve(oldNameLibraryPath())) {
		try {
			await moveFolder(current, dest); // まだ残っていれば移す（無ければ何もしない）
		} catch (err) {
			console.warn('旧名の保存先を移せませんでした', err);
		}
		await saveSettings({ libraryPath: dest });
		// 空のフォルダーだけが残っていれば消す
		for (const d of SUBDIRS) await fs.rmdir(path.join(current, d)).catch(() => {});
		await fs.rmdir(current).catch(() => {});
		await fs.rmdir(path.dirname(current)).catch(() => {});
		return true;
	}
	const legacy = legacyLibraryPath();
	if (current !== path.resolve(legacy)) return false;
	try {
		const moved = await moveFolder(legacy, dest);
		await saveSettings({ libraryPath: dest });
		return moved;
	} catch (err) {
		console.warn('保存先をアプリの置き場所へ移せませんでした（今の場所を使い続けます）', err);
		return false;
	}
}

export async function ensureLibrary(): Promise<string> {
	const root = await libraryPath();
	await Promise.all(SUBDIRS.map((d) => fs.mkdir(path.join(root, d), { recursive: true })));
	return root;
}

/** id にパス記号が混ざっていても、フォルダーの外へ出ないようにする */
export function safeId(id: string): string {
	if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) {
		throw new Error(`不正な id です: ${id}`);
	}
	return id;
}

/** 途中で落ちても壊れたファイルが残らないよう、一時ファイルに書いてから置き換える */
async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
	const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
	await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
	await fs.rename(tmp, file);
}

async function readJsonFiles<T>(dir: string): Promise<T[]> {
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch {
		return [];
	}
	const results: T[] = [];
	for (const name of names) {
		if (!name.endsWith('.json') || name.includes('.tmp-')) continue;
		try {
			const raw = await fs.readFile(path.join(dir, name), 'utf8');
			results.push(JSON.parse(raw) as T);
		} catch (err) {
			// 1 件壊れていても、ほかの件は読めるようにする
			console.warn(`読めないファイルを飛ばしました: ${name}`, err);
		}
	}
	return results;
}

// ---------- ノート ----------

export async function listNotes(): Promise<Note[]> {
	const root = await ensureLibrary();
	const raw = await readJsonFiles<unknown>(path.join(root, 'notes'));
	// 旧形式（本文が文字列）もここで木に直す
	const notes = raw.map(normalizeNote).filter((n): n is Note => n !== null);
	return notes.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function saveNote(note: Note): Promise<void> {
	const root = await ensureLibrary();
	await writeJsonAtomic(path.join(root, 'notes', `${safeId(note.id)}.json`), note);
}

export async function removeNote(id: string): Promise<void> {
	const root = await ensureLibrary();
	await fs.rm(path.join(root, 'notes', `${safeId(id)}.json`), { force: true });
	// ノートに属する収録も一緒に消す
	const recordings = (await listRecordings()).filter((r) => r.noteId === id);
	await Promise.all(recordings.map((r) => removeRecording(r.id)));
}

// ---------- 収録 ----------

export async function listRecordings(): Promise<Recording[]> {
	const root = await ensureLibrary();
	const recordings = await readJsonFiles<Recording>(path.join(root, 'media'));
	return recordings.sort((a, b) => b.createdAt - a.createdAt);
}

export async function saveRecording(recording: Recording): Promise<void> {
	const root = await ensureLibrary();
	await writeJsonAtomic(path.join(root, 'media', `${safeId(recording.id)}.json`), recording);
}

export async function mediaFilePath(recording: Recording): Promise<string> {
	const root = await ensureLibrary();
	const base = path.basename(recording.fileName);
	return path.join(root, 'media', base);
}

export async function findRecording(id: string): Promise<Recording | null> {
	const root = await ensureLibrary();
	try {
		const raw = await fs.readFile(path.join(root, 'media', `${safeId(id)}.json`), 'utf8');
		return JSON.parse(raw) as Recording;
	} catch {
		return null;
	}
}

export async function removeRecording(id: string): Promise<void> {
	const rec = await findRecording(id);
	const root = await ensureLibrary();
	if (rec) {
		await fs.rm(await mediaFilePath(rec), { force: true });
	}
	await fs.rm(path.join(root, 'media', `${safeId(id)}.json`), { force: true });
	await removeExportFiles(id);
}

/**
 * 書き出した mp4 の置き場所（保存先の exports/<収録 id>-<書き出し id>.mp4。字幕・サムネは同じ名前で拡張子違い）。
 * 古い形（exportId 無し・'legacy'）は exports/<収録 id>.mp4
 */
export async function exportFilePath(id: string, exportId?: string): Promise<string> {
	const root = await ensureLibrary();
	const base = exportId && exportId !== 'legacy' ? `${safeId(id)}-${safeId(exportId)}` : safeId(id);
	return path.join(root, 'exports', `${base}.mp4`);
}

/** 書き出し関係のファイル（mp4 と .srt・サムネ）を消す。exportId を省くとその収録の全部 */
export async function removeExportFiles(id: string, exportId?: string): Promise<void> {
	const root = await ensureLibrary();
	const dir = path.join(root, 'exports');
	let names: string[] = [];
	try {
		names = await fs.readdir(dir);
	} catch {
		return;
	}
	const base = exportId && exportId !== 'legacy' ? `${safeId(id)}-${safeId(exportId)}` : safeId(id);
	for (const name of names) {
		const mine = exportId
			? name === `${base}.mp4` || name.startsWith(`${base}.`)
			: name === `${safeId(id)}.mp4` ||
				name.startsWith(`${safeId(id)}.`) ||
				name.startsWith(`${safeId(id)}-`);
		if (mine) await fs.rm(path.join(dir, name), { force: true });
	}
}

/** 収録本体をまるごと書く（初期版からの取り込み用。収録中の追記はフェーズ 2 で別途） */
export async function writeMediaFile(fileName: string, data: Uint8Array): Promise<number> {
	const root = await ensureLibrary();
	const file = path.join(root, 'media', path.basename(fileName));
	await fs.writeFile(file, data);
	return data.byteLength;
}

// ---------- 容量 ----------

export async function usedBytes(): Promise<number> {
	const root = await ensureLibrary();
	let total = 0;
	for (const sub of SUBDIRS) {
		const dir = path.join(root, sub);
		let names: string[] = [];
		try {
			names = await fs.readdir(dir);
		} catch {
			continue;
		}
		for (const name of names) {
			try {
				const st = await fs.stat(path.join(dir, name));
				if (st.isFile()) total += st.size;
			} catch {
				/* 消えた直後などは無視 */
			}
		}
	}
	return total;
}

/** フォルダーの名前の一覧。`folders.json` に持つ（空のフォルダーも残せるように、ノートとは別） */
export async function listFolders(): Promise<string[]> {
	const root = await ensureLibrary();
	try {
		const raw = await fs.readFile(path.join(root, 'folders.json'), 'utf8');
		const parsed = JSON.parse(raw) as { names?: unknown };
		return Array.isArray(parsed.names)
			? parsed.names.filter((n): n is string => typeof n === 'string')
			: [];
	} catch {
		return [];
	}
}

export async function saveFolders(names: string[]): Promise<void> {
	const root = await ensureLibrary();
	const clean = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
	await writeJsonAtomic(path.join(root, 'folders.json'), { names: clean });
}
