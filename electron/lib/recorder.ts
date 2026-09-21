import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { Recording, RecordingBegin, RecordingFinish } from '../../shared/types';
import { ensureLibrary, findRecording, listRecordings, saveRecording } from './library';
import { probeDurationMs, remuxInPlace } from './ffmpeg';

/**
 * 収録本体の順次書き込み。
 * 画面から 1 秒ごとに送られてくるデータを、開いたままのファイルへ追記する。
 * メモリーに全量をためない。途中で落ちても追記済みの部分はファイルに残る。
 */

const open = new Map<string, { handle: FileHandle; queue: Promise<void> }>();

function safeName(name: string): string {
	const base = path.basename(name);
	if (!/^[A-Za-z0-9_.-]{1,120}$/.test(base)) throw new Error(`不正なファイル名です: ${name}`);
	return base;
}

export async function beginRecording(meta: RecordingBegin): Promise<Recording> {
	const root = await ensureLibrary();
	const fileName = safeName(meta.fileName);
	const file = path.join(root, 'media', fileName);
	const handle = await fs.open(file, 'w');
	open.set(meta.id, { handle, queue: Promise.resolve() });
	const now = Date.now();
	const rec: Recording = {
		id: meta.id,
		noteId: meta.noteId,
		title: meta.title,
		kind: meta.kind,
		createdAt: now,
		updatedAt: now,
		durationMs: 0,
		mimeType: meta.mimeType,
		fileName,
		size: 0,
		hasVideo: meta.hasVideo,
		hasMic: meta.hasMic,
		displaySurface: null,
		status: 'recording',
		markers: [],
		width: meta.width,
		height: meta.height
	};
	await saveRecording(rec);
	return rec;
}

export function appendRecording(id: string, chunk: ArrayBuffer | Uint8Array): Promise<void> {
	const entry = open.get(id);
	if (!entry) return Promise.reject(new Error('この収録は開いていません。'));
	const buf = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
	// 順番が入れ替わらないよう、書き込みは 1 本の列に並べる
	entry.queue = entry.queue.then(async () => {
		await entry.handle.write(buf);
	});
	return entry.queue;
}

export async function finishRecording(id: string, meta: RecordingFinish): Promise<Recording> {
	const entry = open.get(id);
	if (entry) {
		await entry.queue.catch(() => {});
		await entry.handle.close();
		open.delete(id);
	}
	const rec = await findRecording(id);
	if (!rec) throw new Error('収録のメタ情報が見つかりません。');
	const root = await ensureLibrary();
	const file = path.join(root, 'media', rec.fileName);
	// 長さと索引を付ける（編集画面で正確に頭出しできるように）。中身はそのまま
	await remuxInPlace(file);
	const st = await fs.stat(file).catch(() => null);
	const next: Recording = {
		...rec,
		durationMs: meta.durationMs,
		markers: meta.markers,
		peaks: meta.peaks,
		peaksPerSecond: meta.peaksPerSecond,
		size: st?.size ?? 0,
		status: 'complete',
		updatedAt: Date.now()
	};
	await saveRecording(next);
	return next;
}

/** 前回、終了処理まで行けなかった収録を「回収」の状態にする（起動時に呼ぶ） */
export async function recoverUnfinished(): Promise<number> {
	const root = await ensureLibrary();
	let count = 0;
	for (const rec of await listRecordings()) {
		if (rec.status !== 'recording' || open.has(rec.id)) continue;
		const st = await fs.stat(path.join(root, 'media', rec.fileName)).catch(() => null);
		if (!st || st.size === 0) continue;
		// 長さは終了処理で書くはずだったので、詰め直してからファイルから測り直す（0 のままだと編集画面で扱えない）
		const file = path.join(root, 'media', rec.fileName);
		await remuxInPlace(file);
		const durationMs = await probeDurationMs(file).catch(() => 0);
		await saveRecording({
			...rec,
			size: st.size,
			durationMs: durationMs || rec.durationMs,
			status: 'recovered',
			updatedAt: Date.now()
		});
		count += 1;
	}
	return count;
}

/** アプリ終了時に、開いているファイルを閉じる */
export async function closeAll(): Promise<void> {
	for (const [id, entry] of open) {
		await entry.queue.catch(() => {});
		await entry.handle.close().catch(() => {});
		open.delete(id);
	}
}
