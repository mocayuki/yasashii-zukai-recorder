import type { Cut } from './types';

/**
 * カット編集の計算。画面（プレビューの飛ばし再生）と Electron（書き出し）の両方で使う。
 * カットは「消す範囲」。書き出すのは、その隙間（残す区間）。
 */

export interface Segment {
	startMs: number;
	endMs: number;
}

/** 範囲を整え、重なりや接触をまとめ、時刻順に並べる。長さ 0 以下は捨てる */
export function normalizeCuts(cuts: Cut[], durationMs: number): Cut[] {
	const clamped = cuts
		.map((c) => ({
			...c,
			startMs: Math.max(0, Math.min(c.startMs, c.endMs)),
			endMs: Math.min(durationMs, Math.max(c.startMs, c.endMs))
		}))
		.filter((c) => c.endMs - c.startMs > 0)
		.sort((a, b) => a.startMs - b.startMs);
	const out: Cut[] = [];
	for (const c of clamped) {
		const last = out[out.length - 1];
		if (last && c.startMs <= last.endMs) last.endMs = Math.max(last.endMs, c.endMs);
		else out.push({ ...c });
	}
	return out;
}

/** 残す区間（カットの隙間）。カットが無ければ全体 1 つ */
export function keptSegments(cuts: Cut[], durationMs: number): Segment[] {
	const segs: Segment[] = [];
	let cursor = 0;
	for (const c of normalizeCuts(cuts, durationMs)) {
		if (c.startMs > cursor) segs.push({ startMs: cursor, endMs: c.startMs });
		cursor = Math.max(cursor, c.endMs);
	}
	if (cursor < durationMs) segs.push({ startMs: cursor, endMs: durationMs });
	return segs;
}

/** 残す長さの合計 */
export function keptDuration(cuts: Cut[], durationMs: number): number {
	return keptSegments(cuts, durationMs).reduce((sum, s) => sum + (s.endMs - s.startMs), 0);
}

/** 再生位置がカットの中なら、そのカットの終わりを返す（飛ばし再生用）。外なら null */
export function skipTarget(cuts: Cut[], atMs: number, durationMs: number): number | null {
	for (const c of normalizeCuts(cuts, durationMs)) {
		if (atMs >= c.startMs && atMs < c.endMs) return c.endMs;
	}
	return null;
}

/** 元の時刻を、書き出し後の時刻に直す（カット分だけ前にずれる）。カットの中なら、その直前の位置 */
export function toExportedTime(cuts: Cut[], atMs: number, durationMs: number): number {
	let removed = 0;
	for (const c of normalizeCuts(cuts, durationMs)) {
		if (c.endMs <= atMs) removed += c.endMs - c.startMs;
		else if (c.startMs < atMs) removed += atMs - c.startMs;
	}
	return atMs - removed;
}
