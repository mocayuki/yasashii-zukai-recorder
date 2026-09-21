import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Cue, Recording, TranscribeProgress, Transcript } from '../../shared/types';
import { normalizeCues, splitSentence, telopSpec } from '../../shared/cues';
import { applyReplacements } from '../../shared/transcribe-terms';
import { ensureLibrary, mediaFilePath, safeId } from './library';
import { runFfmpeg } from './ffmpeg';

/**
 * テロップ（文字起こし）。`transcripts/<recordingId>.json` に持つ。
 * 作るときは、収録から声だけを小さな mp3 にして OpenAI の文字起こし（whisper-1）に送り、
 * 文ごとの区切り（segment）をテロップにする。API キーは userData の settings.json にだけ置く。
 */

function transcriptFile(root: string, recordingId: string): string {
	return path.join(root, 'transcripts', `${safeId(recordingId)}.json`);
}

export async function getTranscript(recordingId: string): Promise<Transcript | null> {
	const root = await ensureLibrary();
	try {
		const raw = await fs.readFile(transcriptFile(root, recordingId), 'utf8');
		const t = JSON.parse(raw) as Transcript;
		return { ...t, cues: normalizeCues(Array.isArray(t.cues) ? t.cues : []) };
	} catch {
		return null;
	}
}

export async function saveTranscript(transcript: Transcript): Promise<void> {
	const root = await ensureLibrary();
	const file = transcriptFile(root, transcript.recordingId);
	const tmp = `${file}.tmp`;
	await fs.writeFile(
		tmp,
		JSON.stringify({ ...transcript, updatedAt: Date.now() }, null, 2),
		'utf8'
	);
	await fs.rename(tmp, file);
}

export async function removeTranscript(recordingId: string): Promise<void> {
	const root = await ensureLibrary();
	await fs.rm(transcriptFile(root, recordingId), { force: true });
}

interface WhisperSegment {
	start: number;
	end: number;
	text: string;
	/** 無音（話していない）の確からしさ 0〜1。高いのに文があるのは作り話（幻聴）のことが多い */
	no_speech_prob?: number;
	/** 文の確からしさ（対数）。低いほど怪しい */
	avg_logprob?: number;
	/** 同じ言葉の繰り返しの度合い。高いと壊れている */
	compression_ratio?: number;
}

/**
 * whisper の作り話（幻聴）を落とす。
 * 音が小さい所や終わりの静かな所で、prompt に入れた言葉（辞書やノートの言葉）をそのまま吐くことがある。
 * 「文が prompt の中の言葉と同じで、無音の確からしさが高いか確信が低い」ものと、
 * 「無音の確からしさがとても高い」もの、「同じ言葉の繰り返し」を捨てる
 */
export function dropHallucinations(
	segments: WhisperSegment[],
	prompt: string,
	terms: string[] = []
): { kept: WhisperSegment[]; dropped: WhisperSegment[] } {
	const promptFlat = compact(prompt);
	const kept: WhisperSegment[] = [];
	const dropped: WhisperSegment[] = [];
	for (const s of segments) {
		const text = compact(s.text ?? '');
		const noSpeech = s.no_speech_prob ?? 0;
		const logprob = s.avg_logprob ?? 0;
		const ratio = s.compression_ratio ?? 1;
		const echoesPrompt = text.length >= 3 && promptFlat.includes(text);
		// 無音の確からしさは 30 秒の窓ごとに同じ値が付くので、それだけでは落とさない（本当に話している 26 秒が
		// 0.851 で丸ごと落ち、あとのテロップが全部前にずれた 2026-09-17）。whisper 本体と同じく「確信も低い」ときだけ
		const bad =
			(noSpeech > 0.6 && logprob < -1.0) ||
			ratio > 2.4 ||
			(echoesPrompt && (noSpeech > 0.3 || logprob < -0.7)) ||
			(echoesPrompt && s.end - s.start < 1.2) ||
			// 辞書の言葉だけを並べた文（本当に言ったなら前後に別の言葉が付く）
			(text.length > 0 && text === compact(termsTail(s.text ?? '', terms).stripped));
		if (bad) dropped.push(s);
		else kept.push(s);
	}
	// 最後の segment の末尾に辞書の言葉が連なっていたら、それも作り話（終わりの静かな所で吐く）。言葉の前までを残す
	const last = kept[kept.length - 1];
	if (last && terms.length) {
		const { rest, stripped } = termsTail(last.text ?? '', terms);
		if (stripped && compact(rest)) kept[kept.length - 1] = { ...last, text: rest };
		else if (stripped && !compact(rest)) {
			kept.pop();
			dropped.push(last);
		}
	}
	return { kept, dropped };
}

/**
 * 文の末尾から、辞書の言葉（句読点付き）を取れるだけ取る。
 * rest = 残り、stripped = 取った部分（無ければ空）
 */
export function termsTail(text: string, terms: string[]): { rest: string; stripped: string } {
	let rest = text.trim();
	let stripped = '';
	const sorted = [...terms].filter((t) => t.trim()).sort((a, b) => b.length - a.length);
	for (;;) {
		const m = /^(.*?)([、。，．,.\s]*)$/.exec(rest);
		const body = m ? m[1] : rest;
		const hit = sorted.find((t) => body.endsWith(t));
		if (!hit) break;
		const cut = body.length - hit.length;
		stripped = rest.slice(cut) + stripped;
		rest = rest.slice(0, cut).replace(/[、。，．,.\s]+$/, '');
	}
	return { rest, stripped };
}
interface WhisperWord {
	word: string;
	start: number;
	end: number;
}

/** 文の終わり（ここでテロップを切る） */
const SENTENCE_END = /[。！？!?]/;

/**
 * whisper が吐く、文字として成り立たないコード（未定義・私用領域・制御文字。例: U+FF00）を落とす。
 * 画面では □ になって見える。改行とタブは残す
 */
export function cleanTranscriptText(text: string): string {
	return text
		.replace(/[\p{Cn}\p{Co}\p{Cs}]/gu, '')
		.replace(/[\p{Cc}]/gu, (c) => (c === '\n' || c === '\t' ? c : ''));
}

/**
 * 文（needle）を、単語をつないだ文字列（hay）の from 付近から、多少違っていても探す（表記の違い・言い落とし・
 * 別のモデルの文でも当たるように）。半大域の並べ合わせ: hay 側の始まりと終わりは自由、needle は全部使う。
 * 一致 +2、違い -1、抜け -1。文字の 4 割以上が順に一致していれば見つかったとし、一致した最初と最後の文字の位置を返す
 */
export function locateFuzzy(
	hay: string,
	needle: string,
	from: number,
	backChars = 40,
	ahead = 40
): { start: number; end: number } | null {
	const n = needle.length;
	if (n === 0) return null;
	const lo = Math.max(0, from - backChars);
	const hi = Math.min(hay.length, from + ahead + n * 2);
	const m = hi - lo;
	if (m <= 0) return null;
	// dp[i][j]: needle の先頭 i 文字を、hay[lo..lo+j) の中で終わるように合わせた最良の点（hay の始まりは自由）
	const W = m + 1;
	const dp = new Int32Array((n + 1) * W);
	const back = new Uint8Array((n + 1) * W); // 1: 斜め, 2: 上（needle 抜け）, 3: 左（hay 抜け）
	const NEG = -1_000_000;
	for (let j = 0; j <= m; j++) dp[j] = 0;
	for (let i = 1; i <= n; i++) {
		dp[i * W] = -i;
		back[i * W] = 2;
		for (let j = 1; j <= m; j++) {
			const diag = dp[(i - 1) * W + j - 1] + (needle[i - 1] === hay[lo + j - 1] ? 2 : -1);
			const up = dp[(i - 1) * W + j] - 1;
			const left = dp[i * W + j - 1] - 1;
			let best = diag;
			let b = 1;
			if (up > best) {
				best = up;
				b = 2;
			}
			if (left > best) {
				best = left;
				b = 3;
			}
			dp[i * W + j] = best === NEG ? NEG : best;
			back[i * W + j] = b;
		}
	}
	let bestJ = -1;
	let bestScore = NEG;
	for (let j = 1; j <= m; j++) {
		if (dp[n * W + j] > bestScore) {
			bestScore = dp[n * W + j];
			bestJ = j;
		}
	}
	if (bestJ < 0 || bestScore <= 0) return null;
	// 戻って hay 側の始まりと、一致した文字の数を求める。半分以上が一致していれば見つかったとする
	let i = n;
	let j = bestJ;
	let startJ = bestJ;
	let endJ = -1;
	let matched = 0;
	while (i > 0 && j > 0) {
		const b = back[i * W + j];
		if (b === 1) {
			if (needle[i - 1] === hay[lo + j - 1]) {
				matched++;
				if (endJ < 0) endJ = j;
				startJ = j;
			}
			i--;
			j--;
		} else if (b === 2) i--;
		else j--;
	}
	// 4 割以上が順に一致していれば同じ文とみなす（whisper が動詞や語尾を落としていても当たる）
	if (matched * 5 < n * 2 || endJ < 0) return null;
	return { start: lo + startJ - 1, end: lo + endJ - 1 };
}

/** 文字の比較用: 空白と記号を除く（segment の文には「。、」などの記号が入り、word には入らないことがある） */
function compact(text: string): string {
	return text.replace(/[\s、。，．！？!?,.:;：；「」『』（）()［］\[\]｛｝{}…‥・~〜"'“”‘’]+/g, '');
}

/**
 * OpenAI の文字起こし結果から、文ごとのテロップにする。
 * whisper-1 の segment の時刻は日本語だと粗く（秒単位、始まりが同じになる）、そのままでは合わないので、
 * word（単語ごとの時刻）を優先して使う: segment の文を「。！？」で文に分け、単語を順に当てはめて
 * 最初の単語の始まり〜最後の単語の終わりを文の時刻にする。word が無ければ segment の時刻を使う。
 */
export function toCues(
	segments: WhisperSegment[],
	words: WhisperWord[] = [],
	maxChars?: number
): Cue[] {
	const sentences: { text: string; segStart: number }[] = [];
	for (const s of segments) {
		const text = cleanTranscriptText(s.text ?? '').trim();
		if (!text) continue;
		// 文の終わりで分け（終わりの記号は前の文に付ける）、長い文はさらに「、」で分ける
		let buf = '';
		for (const ch of text) {
			buf += ch;
			if (SENTENCE_END.test(ch)) {
				for (const t of splitSentence(buf, maxChars))
					sentences.push({ text: t, segStart: s.start });
				buf = '';
			}
		}
		if (buf.trim())
			for (const t of splitSentence(buf, maxChars)) sentences.push({ text: t, segStart: s.start });
	}

	const cues: Cue[] = [];
	const usable = words.filter((w) => compact(w.word) !== '' && Number.isFinite(w.start));
	if (usable.length > 0) {
		// 単語を全部つないだ文字列（記号・空白なし）を作り、1 文字ごとにその単語の時刻を持たせる。
		// 文ごとに、その文字列の中で文（記号なし）が現れる位置を探して、最初と最後の文字の時刻を使う。
		// 以前は文字数を数えて順に当てていたため、文にだけ含まれる「。、」の分だけ単語を余分に消費し、
		// 文ごとにずれが積み上がって後半ほどテロップが遅れていた（2026-09-12 修正）
		// 記号だけの word（「。」「、」が単独で返ることがある）は文字列には入れないが、
		// 文の終わりの時刻を延ばすのに使う（記号の word の終わりまでをその文にする）
		const valid = words.filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end));
		const chars: { start: number; end: number; wi: number }[] = [];
		let all = '';
		valid.forEach((w, wi) => {
			const t = compact(w.word);
			all += t;
			for (let i = 0; i < t.length; i++) {
				chars.push({ start: Math.round(w.start * 1000), end: Math.round(w.end * 1000), wi });
			}
		});
		const endWithPunct = (to: number): number => {
			let end = chars[to].end;
			for (let j = chars[to].wi + 1; j < valid.length && compact(valid[j].word) === ''; j++) {
				end = Math.max(end, Math.round(valid[j].end * 1000));
			}
			return end;
		};
		let pos = 0;
		let lastSegStart = -1;
		for (const { text: sentence, segStart } of sentences) {
			const key = compact(sentence);
			if (key.length === 0) continue;
			// 新しい segment に入ったら、探し始めをその segment の始まり（1 秒前）まで進める。
			// 間の segment が落ちていても（作り話として捨てた・言い直し）、そこで止まったまま
			// あとの文が全部前に当たることがなくなる（word の始まりは segment の始まりと同じ時刻）
			if (Number.isFinite(segStart) && segStart !== lastSegStart) {
				lastSegStart = segStart;
				const anchorMs = Math.round((segStart - 1) * 1000);
				let a = pos;
				while (a < chars.length && chars[a].start < anchorMs) a++;
				pos = a;
			}
			if (pos >= chars.length) break;
			// いまの位置から先で見つかればそこへ（同じ言葉が先にもあるときに飛びすぎないよう、探す範囲は先の 40 文字まで）。
			// 後ろへは戻らない（戻ると時刻が前後して、重なりの整理で消えてしまう）
			let at = all.indexOf(key, pos);
			if (at < 0 || at > pos + 40) at = -1;
			let from: number;
			let to: number;
			if (at >= 0) {
				from = at;
				to = Math.min(chars.length - 1, at + key.length - 1);
				pos = to + 1;
			} else {
				// そのままでは見つからない（言い直し・表記の違い・別のモデルの文）: 多少違っても近くで探す
				const fz = locateFuzzy(all, key, pos, 0, 40);
				if (fz) {
					from = Math.min(chars.length - 1, fz.start);
					to = Math.min(chars.length - 1, Math.max(fz.end, from));
					pos = to + 1;
				} else {
					// それでも見つからない: いまの位置から、文字数の半分だけ進める
					// （進みすぎると戻れないので控えめに。次の文が先で見つかれば、そこで合う）
					from = pos;
					to = Math.min(chars.length - 1, pos + Math.max(0, Math.ceil(key.length / 2) - 1));
					pos = to + 1;
				}
			}
			const startMs = chars[from].start;
			const endMs = endWithPunct(to);
			cues.push({
				id: randomUUID(),
				startMs,
				endMs: Math.max(endMs, startMs + 500),
				text: sentence
			});
		}
	} else {
		// word が無い: segment の時刻で。始まりが前と同じなら、前の終わりから
		let cursor = 0;
		for (const s of segments) {
			const text = cleanTranscriptText(s.text ?? '').trim();
			if (!text) continue;
			const startMs = Math.max(cursor, Math.round(s.start * 1000));
			const endMs = Math.max(startMs + 500, Math.round(s.end * 1000));
			cues.push({ id: randomUUID(), startMs, endMs, text });
			cursor = endMs;
		}
	}
	// 前後の重なりをなくす（前のテロップは次の始まりで終える）。
	// 次の始まりが前の始まりと同じ（単語の時刻が取れなかった短い文）なら、前を 0.3 秒だけ残して次を少し遅らせる
	for (let i = 0; i + 1 < cues.length; i++) {
		if (cues[i + 1].startMs <= cues[i].startMs) {
			cues[i + 1].startMs = cues[i].startMs + 300;
			if (cues[i + 1].endMs < cues[i + 1].startMs + 300)
				cues[i + 1].endMs = cues[i + 1].startMs + 300;
		}
		if (cues[i].endMs > cues[i + 1].startMs) cues[i].endMs = cues[i + 1].startMs;
	}
	return normalizeCues(cues);
}

/** @deprecated toCues を使う（互換のため残す） */
export function segmentsToCues(segments: WhisperSegment[]): Cue[] {
	return toCues(segments, []);
}

export async function generateTranscript(
	rec: Recording,
	apiKey: string,
	onProgress: (p: TranscribeProgress) => void,
	opts: { replacements?: Array<[string, string]> } = {}
): Promise<Transcript> {
	const src = await mediaFilePath(rec);
	const tmpDir = path.join(app.getPath('temp'), 'yasashii-zukai-recorder');
	await fs.mkdir(tmpDir, { recursive: true });
	const audio = path.join(tmpDir, `${rec.id}.mp3`);
	onProgress({ recordingId: rec.id, phase: 'extracting' });
	// 声だけを 16kHz モノラル 48kbps の mp3 に（1 時間で 20MB ほど。API の上限 25MB に収まる）
	await runFfmpeg(
		['-i', src, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '48k', audio],
		{ totalMs: rec.durationMs }
	);
	try {
		const st = await fs.stat(audio);
		if (st.size > 25 * 1024 * 1024) {
			throw new Error(
				'音声が 25MB を超えています（1 時間を超える収録はまだ文字起こしできません）。'
			);
		}
		onProgress({ recordingId: rec.id, phase: 'uploading' });
		// whisper-1 だけ、prompt 無しで（ヒントを渡すとその書き方をまねて動詞を落としたり、ヒントの言葉を吐いたりした）。
		// 固有名詞の書き方は、あとの「置き換え」と「誤りの候補を出す（AI）」で直す
		const form = new FormData();
		form.append('file', new Blob([await fs.readFile(audio)], { type: 'audio/mpeg' }), 'voice.mp3');
		form.append('model', 'whisper-1');
		form.append('language', 'ja');
		form.append('response_format', 'verbose_json');
		form.append('timestamp_granularities[]', 'segment');
		form.append('timestamp_granularities[]', 'word');
		const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
			method: 'POST',
			headers: { Authorization: `Bearer ${apiKey}` },
			body: form
		});
		if (!res.ok) {
			const body = await res.text().catch(() => '');
			if (res.status === 401)
				throw new Error('API キーが正しくありません。設定で確かめてください。');
			throw new Error(`文字起こしに失敗しました（${res.status}）。${body.slice(0, 200)}`);
		}
		const json = (await res.json()) as {
			language?: string;
			segments?: WhisperSegment[];
			words?: WhisperWord[];
		};
		const pairs = opts.replacements ?? [];
		// 無音の所の文（作り話）や、同じ言葉の繰り返しは落とす
		const { kept, dropped } = dropHallucinations(json.segments ?? [], '', []);
		if (dropped.length)
			console.log(
				'[transcribe] 作り話を落とした:',
				dropped.map((d) => `${d.start}-${d.end} ${d.text}`).join(' | ')
			);
		const cues = toCues(
			kept,
			json.words ?? [],
			telopSpec(rec.width ?? 1920, rec.height ?? 1080).maxChars
		).map((c) => (pairs.length ? { ...c, text: applyReplacements(c.text, pairs) } : c));
		const transcript: Transcript = {
			recordingId: rec.id,
			cues,
			raw: {
				segments: (json.segments ?? []).map((s) => ({
					start: s.start,
					end: s.end,
					text: s.text,
					no_speech_prob: s.no_speech_prob,
					avg_logprob: s.avg_logprob,
					compression_ratio: s.compression_ratio
				})),
				words: (json.words ?? []).map((w) => ({ word: w.word, start: w.start, end: w.end }))
			},
			source: 'openai',
			language: json.language ?? 'ja',
			createdAt: Date.now(),
			updatedAt: Date.now()
		};
		await saveTranscript(transcript);
		onProgress({ recordingId: rec.id, phase: 'done' });
		return transcript;
	} catch (err) {
		onProgress({ recordingId: rec.id, phase: 'failed', message: (err as Error).message });
		throw err;
	} finally {
		await fs.rm(audio, { force: true }).catch(() => {});
	}
}
