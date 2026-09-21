import { promises as fs } from 'node:fs';
import { newNode } from '../../shared/notes';
import type { ImportResult, LegacyBackup, Note, Recording } from '../../shared/types';
import { findRecording, listNotes, saveNote, saveRecording, writeMediaFile } from './library';

function extensionFor(mimeType: string): string {
	const base = mimeType.split(';')[0].trim().toLowerCase();
	if (base === 'audio/mp4' || base === 'video/mp4') return 'm4a';
	if (base === 'audio/ogg') return 'ogg';
	return 'webm';
}

function dataUrlToBytes(dataUrl: string): { bytes: Uint8Array; mimeType: string } {
	const m = /^data:([^;,]+)?(;[^,]*)?,(.*)$/s.exec(dataUrl);
	if (!m) throw new Error('音声データの形式が読めませんでした。');
	const mimeType = m[1] ?? 'audio/webm';
	const isBase64 = (m[2] ?? '').includes('base64');
	const bytes = isBase64
		? Buffer.from(m[3], 'base64')
		: Buffer.from(decodeURIComponent(m[3]), 'utf8');
	return { bytes: new Uint8Array(bytes), mimeType };
}

/**
 * 初期版（ブラウザー版）が書き出したバックアップ JSON を取り込む。
 * 1 件の旧録音 → ノート 1 件（タイトル・メモ）＋ 収録 1 件（音声）。
 * 同じ id が既にあれば飛ばす。
 */
export async function importLegacyBackup(file: string): Promise<ImportResult> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await fs.readFile(file, 'utf8'));
	} catch {
		throw new Error(
			'バックアップファイルを読み取れませんでした。初期版で書き出した JSON を選んでください。'
		);
	}
	const data = parsed as Partial<LegacyBackup> | null;
	if (!data || data.app !== 'yasashii-voice-notes' || !Array.isArray(data.notes)) {
		throw new Error('このファイルは「やさしい録音ノート」のバックアップではないようです。');
	}
	const existingNotes = new Set((await listNotes()).map((n) => n.id));
	const result: ImportResult = { notes: 0, recordings: 0, skipped: 0 };

	for (const old of data.notes) {
		if (!old || typeof old.id !== 'string' || typeof old.audio !== 'string') {
			result.skipped += 1;
			continue;
		}
		if (existingNotes.has(old.id) || (await findRecording(old.id))) {
			result.skipped += 1;
			continue;
		}
		const { bytes, mimeType } = dataUrlToBytes(old.audio);
		const fileName = `${old.id}.${extensionFor(mimeType || old.mimeType)}`;
		const size = await writeMediaFile(fileName, bytes);

		const note: Note = {
			id: old.id,
			title: old.title || '録音',
			// 旧メモは自由な文章なので、1 行を 1 つの子ノードにする
			root: newNode(old.title || '録音', {
				children: (typeof old.memo === 'string' ? old.memo : '')
					.split('\n')
					.map((l) => l.replace(/^[-*]\s+/, '').trim())
					.filter(Boolean)
					.map((l) => newNode(l))
			}),
			createdAt: old.createdAt,
			updatedAt: old.updatedAt ?? old.createdAt
		};
		const recording: Recording = {
			id: old.id,
			noteId: old.id,
			title: old.title || '録音',
			kind: 'mic',
			createdAt: old.createdAt,
			updatedAt: old.updatedAt ?? old.createdAt,
			durationMs: old.durationMs ?? 0,
			mimeType: mimeType || old.mimeType || 'audio/webm',
			fileName,
			size,
			hasVideo: false,
			hasMic: true,
			displaySurface: null,
			status: 'complete',
			markers: []
		};
		await saveNote(note);
		await saveRecording(recording);
		result.notes += 1;
		result.recordings += 1;
	}
	return result;
}
