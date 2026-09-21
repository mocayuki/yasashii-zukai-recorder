import type { Cue, Cut } from './types';
import { normalizeCuts, toExportedTime } from './cuts';

/**
 * テロップ（字幕）の計算。画面（プレビュー）と Electron（書き出し）の両方で使う。
 * 時刻は元の収録の時刻で持ち、書き出しのときにカット分を詰める。
 */

/** いまの時刻に出すテロップ（無ければ null） */
export function cueAt(cues: Cue[], atMs: number): Cue | null {
	for (const c of cues) if (atMs >= c.startMs && atMs < c.endMs) return c;
	return null;
}

/** 時刻順に並べ、空のものと長さ 0 以下のものを除く */
export function normalizeCues(cues: Cue[]): Cue[] {
	return cues
		.filter((c) => c.text.trim() !== '' && c.endMs > c.startMs)
		.map((c) => ({ ...c, text: c.text.trim() }))
		.sort((a, b) => a.startMs - b.startMs);
}

/** カットを外した書き出し後の時刻に直す。カットの中に完全に入るものは落とし、はみ出す分は詰める */
export function cuesForExport(cues: Cue[], cuts: Cut[], durationMs: number): Cue[] {
	const norm = normalizeCuts(cuts, durationMs);
	const out: Cue[] = [];
	for (const c of normalizeCues(cues)) {
		let s = c.startMs;
		let e = c.endMs;
		for (const k of norm) {
			// 始まりがカットの中なら、カットの終わりまで遅らせる。終わりがカットの中なら、カットの始まりで切る
			if (s >= k.startMs && s < k.endMs) s = k.endMs;
			if (e > k.startMs && e <= k.endMs) e = k.startMs;
		}
		if (e - s < 200) continue; // 0.2 秒未満は出さない
		out.push({
			...c,
			startMs: toExportedTime(norm, s, durationMs),
			endMs: toExportedTime(norm, e, durationMs)
		});
	}
	return out.filter((c) => c.endMs > c.startMs);
}

function pad(n: number, w: number): string {
	return String(n).padStart(w, '0');
}

/** SRT 用 00:00:00,000 */
export function srtTime(ms: number): string {
	const t = Math.max(0, Math.round(ms));
	const h = Math.floor(t / 3600000);
	const m = Math.floor((t % 3600000) / 60000);
	const s = Math.floor((t % 60000) / 1000);
	return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(t % 1000, 3)}`;
}

/** ASS 用 0:00:00.00（1/100 秒） */
export function assTime(ms: number): string {
	const t = Math.max(0, Math.round(ms / 10));
	const h = Math.floor(t / 360000);
	const m = Math.floor((t % 360000) / 6000);
	const s = Math.floor((t % 6000) / 100);
	return `${h}:${pad(m, 2)}:${pad(s, 2)}.${pad(t % 100, 2)}`;
}

export function toSrt(cues: Cue[]): string {
	return normalizeCues(cues)
		.map((c, i) => `${i + 1}\n${srtTime(c.startMs)} --> ${srtTime(c.endMs)}\n${c.text}\n`)
		.join('\n');
}

export interface AssStyle {
	/** 例: 'Zen Maru Gothic Black'（アプリに同梱。resources/fonts） */
	fontName: string;
	fontSize: number;
	/** 下からの余白（px） */
	marginBottom: number;
	/** 動画の大きさ（ASS の PlayRes） */
	width: number;
	height: number;
	/** 左右の余白 */
	margin: number;
}

const DEFAULT_ASS: AssStyle = {
	fontName: 'Zen Maru Gothic Black',
	fontSize: 84,
	marginBottom: 64,
	width: 1920,
	height: 1080,
	margin: 70
};

/** テロップ 1 つの長さの目安（これを超える文は「、」で分けて別のテロップにする）。横の動画 */
export const TELOP_MAX_CHARS = 28;

/** 動画の大きさに合わせたテロップの設定 */
export interface TelopSpec {
	width: number;
	height: number;
	fontSize: number;
	/** 左右の余白 */
	margin: number;
	/** 下からの余白（縦の動画は下のボタン類と重ならないよう広く） */
	marginBottom: number;
	/** テロップ 1 つの長さの目安 */
	maxChars: number;
}

export function telopSpec(width = 1920, height = 1080): TelopSpec {
	const portrait = height > width;
	return portrait
		? { width, height, fontSize: 72, margin: 56, marginBottom: 300, maxChars: 16 }
		: { width, height, fontSize: 84, margin: 70, marginBottom: 64, maxChars: TELOP_MAX_CHARS };
}

/**
 * 長い文を「、」などの区切りで複数のかたまりに分ける（各かたまりは maxChars 以内を目指す）。
 * 区切りで分けられないときは maxChars ごとに切る
 */
export function splitSentence(text: string, maxChars = TELOP_MAX_CHARS): string[] {
	const t = text.trim();
	if (visualLength(t) <= maxChars) return t ? [t] : [];
	// 「、」「，」の直後で節に分ける（記号は前の節に付ける）
	const clauses = t.split(/(?<=[、，,])/).filter((c) => c.trim() !== '');
	const out: string[] = [];
	let cur = '';
	for (const c of clauses) {
		if (cur && visualLength(cur + c) > maxChars) {
			out.push(cur);
			cur = '';
		}
		cur += c;
	}
	if (cur) out.push(cur);
	// 区切りの無い長い節はここでは切らない（別のテロップに分かれて言葉の途中で切り替わるより、
	// 1 つのテロップの中で 2 行に折り返すほうが読みやすい。折り返しは layoutTelop が行う）
	return out;
}

/**
 * 長いテロップを、文字数に応じた時間で複数に分ける（単語ごとの時刻が無いときの近似）。
 * 元の始まり〜終わりを、各かたまりの文字数の割合で分ける
 */
export function splitLongCue(cue: Cue, maxChars = TELOP_MAX_CHARS, makeId?: () => string): Cue[] {
	const pieces = splitSentence(cue.text, maxChars);
	if (pieces.length <= 1) return [cue];
	const total = pieces.reduce((s, p) => s + visualLength(p), 0);
	const span = cue.endMs - cue.startMs;
	const out: Cue[] = [];
	let t = cue.startMs;
	pieces.forEach((p, i) => {
		const len = Math.round((span * visualLength(p)) / total);
		const endMs = i === pieces.length - 1 ? cue.endMs : t + len;
		out.push({
			id: i === 0 ? cue.id : (makeId?.() ?? `${cue.id}-${i}`),
			startMs: t,
			endMs,
			text: p
		});
		t = endMs;
	});
	return out;
}

/** 1 行に入る文字数（1920 幅、左右の余白 120px ずつ、全角 1 文字 ≒ 文字サイズ px） */
/** 1 行に入る文字数。Zen Maru Gothic の全角は 1em より少し細い（約 0.92em）ので、その分多めに見積もる。
 * 見積もりが少し楽観的でも、ASS 側（WrapStyle 0）が幅を超えた行を自動で折るので切れることはない */
export function charsPerLine(fontSize: number, width = 1920, margin = 120): number {
	return Math.max(8, Math.floor((width - margin * 2) / (fontSize * 0.92)));
}

/** 文字の見た目の幅（全角 1、半角 0.5） */
function visualLength(text: string): number {
	let n = 0;
	for (const ch of text) n += /[\x20-\x7e]/.test(ch) ? 0.5 : /[、。，．・]/.test(ch) ? 0.6 : 1;
	return n;
}

/**
 * 長いテロップを行に分ける。1 行の上限を超える手前の「、。」などの区切りで折り、
 * 区切りが無ければ上限で折る。行頭に句読点が来ないようにする
 */
export function wrapTelop(text: string, maxChars: number): string[] {
	const chars = [...text.trim()];
	const lines: string[] = [];
	let line: string[] = [];
	let lastBreak = -1; // line の中で、区切りの直後の位置
	const BREAK_AFTER = /[、。！？!?,.）」』]/;
	const NO_HEAD = /[、。！？!?,.）」』ー]/;
	for (const ch of chars) {
		line.push(ch);
		if (BREAK_AFTER.test(ch)) lastBreak = line.length;
		if (visualLength(line.join('')) > maxChars) {
			// 上限を超えた: 区切りがあればそこで、無ければ 1 文字戻して折る（行頭に句読点を置かない）
			const useBreak = lastBreak > 0 && lastBreak < line.length && lastBreak >= maxChars * 0.55;
			let cut = useBreak ? lastBreak : line.length - 1;
			if (cut < line.length && NO_HEAD.test(line[cut])) cut += 1;
			lines.push(line.slice(0, cut).join(''));
			line = line.slice(cut);
			lastBreak = -1;
		}
	}
	if (line.length) lines.push(line.join(''));
	return lines.filter((l) => l.trim() !== '');
}

/**
 * テロップの文字サイズと行分け。2 行まで（3 行は多い）。基本の大きさで 2 行に入らないときだけ 0.85 倍、
 * それでも入らなければ 0.7 倍にして 2 行に収める。
 * 最後の行が数文字だけ余る（「す。」など）ときは、字を小さくするのではなく、行の長さをそろえる（真ん中あたりで折る）。
 * 字を小さくするのは行数が上限を超えるときだけ（両側に余白があるのに小さくなるのを避ける）
 */
export function layoutTelop(
	text: string,
	base = 60,
	width = 1920,
	margin = 120
): { fontSize: number; lines: string[] } {
	const isOrphan = (lines: string[]) =>
		lines.length > 1 && visualLength(lines[lines.length - 1] ?? '') < 6;
	const candidates = (
		[
			[base, 2],
			[Math.round(base * 0.85), 2],
			[Math.round(base * 0.7), 2]
		] as const
	).map(([fontSize, maxLines]) => {
		const perLine = charsPerLine(fontSize, width, margin);
		let lines = wrapTelop(text, perLine);
		if (isOrphan(lines)) {
			// 行数は変えずに、各行の長さをそろえ直す（短い行が最後に残らないように）
			const total = visualLength(text);
			for (let limit = Math.ceil(total / lines.length); limit < perLine; limit++) {
				const balanced = wrapTelop(text, limit);
				if (balanced.length === lines.length && !isOrphan(balanced)) {
					lines = balanced;
					break;
				}
			}
		}
		return { fontSize, lines, ok: lines.length <= maxLines };
	});
	const good = candidates.find((c) => c.ok);
	if (good) return { fontSize: good.fontSize, lines: good.lines };
	// どれも収まらない: いちばん行数が少ないもの
	const fewest = candidates.reduce((a, b) => (b.lines.length < a.lines.length ? b : a));
	return { fontSize: fewest.fontSize, lines: fewest.lines };
}

/** アプリの見た目に合わせた字幕: 白い帯の上に墨色の太い文字（絵と重なっても読めるように）。1920×1080 基準 */
export function toAss(cues: Cue[], style: Partial<AssStyle> = {}): string {
	const st = { ...DEFAULT_ASS, ...style };
	// ASS の色は &HAABBGGRR。墨 #1C1812 → 12 18 1C、クリーム #FFFDF6 → F6 FD FF
	const head = [
		'[Script Info]',
		'ScriptType: v4.00+',
		`PlayResX: ${st.width}`,
		`PlayResY: ${st.height}`,
		'WrapStyle: 0',
		'',
		'[V4+ Styles]',
		'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
		// BorderStyle 3 = 文字の後ろに箱（BackColour）。Outline がその余白。白は少しだけ透かす（&H14 = 92% 不透明）。
		// 書体は同梱の Zen Maru Gothic Black（極太の丸ゴシック。アプリの見た目と同じ）。Bold は書体そのものが太いので 0
		`Style: Telop,${st.fontName},${st.fontSize},&H0012181C,&H0012181C,&H14FFFFFF,&H14FFFFFF,0,0,0,0,100,100,1,0,3,18,0,2,${st.margin},${st.margin},${st.marginBottom},1`,
		'',
		'[Events]',
		'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
	];
	const lines = normalizeCues(cues).map((c) => {
		// 長い文は行に分け、入りきらなければ文字を小さくする（枠の外で切れないように）
		const t = layoutTelop(c.text.replace(/[{}]/g, ''), st.fontSize, st.width, st.margin);
		const size = t.fontSize !== st.fontSize ? `{\\fs${t.fontSize}}` : '';
		return `Dialogue: 0,${assTime(c.startMs)},${assTime(c.endMs)},Telop,,0,0,0,,${size}${t.lines.join('\\N')}`;
	});
	return [...head, ...lines].join('\n') + '\n';
}
