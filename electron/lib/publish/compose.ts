/**
 * 投稿先ごとの本文を OpenAI に作らせる。材料はノートの題と、テロップ（書き起こし）。
 * gpt-4o-mini で 1 回数円。作ったものは画面で直せる
 */
import type { ComposeResult, Platform } from '../../../shared/publish';
import {
	clipTranscript,
	composePrompt,
	fitX,
	noteArticlePrompt,
	noteTargetChars,
	PLATFORMS
} from '../../../shared/publish';
import { findRecording } from '../library';
import { cuesForExport } from '../../../shared/cues';
import { loadSettings } from '../settings';
import { getTranscript } from '../transcripts';

/**
 * 投稿文は gpt-4.1-mini（1 回 1 円ほど）。gpt-4o-mini は YouTube の説明で箇条書き・ハッシュタグ・タグ・
 * チャプターを丸ごと省くことがあった（2026-09-17）。足りなければ gpt-4.1 で 1 回だけ作り直す
 */
const MODEL = 'gpt-4.1-mini';
const RETRY_MODEL = 'gpt-4.1';
/** note の記事は長くて質が要るので、指示に忠実なモデル（1 本 5〜15 円ほど） */
const NOTE_MODEL = 'gpt-4.1';

export async function composePosts(
	recordingId: string,
	platforms: Platform[]
): Promise<ComposeResult> {
	const settings = await loadSettings();
	if (!settings.openaiApiKey) throw new Error('設定に OpenAI の API キーを入れてください');
	const rec = await findRecording(recordingId);
	if (!rec) throw new Error('収録が見つかりません');
	const transcript = await getTranscript(recordingId).catch(() => null);
	// 書き出した動画と同じ時刻になるよう、カットを外したテロップに [mm:ss] を付けて渡す（チャプター用）
	const cues = transcript ? cuesForExport(transcript.cues, rec.cuts ?? [], rec.durationMs) : [];
	const spoken = cues.map((c) => `[${mmss(c.startMs)}] ${c.text}`).join('\n');
	const totalMs = cues.length ? cues[cues.length - 1].endMs : 0;
	if (!spoken.trim())
		throw new Error(
			'テロップ（書き起こし）がまだありません。先に「テロップを作る」を押してください'
		);
	const all = platforms.filter((p) => PLATFORMS.some((x) => x.id === p));
	if (all.length === 0) return {};
	// note の記事は別の呼び出し（長い・強いモデル・書き起こしを全部）。ほかと並行して待つ
	const wantNote = all.includes('note');
	const wanted = all.filter((p) => p !== 'note');
	const plain = cues.map((c) => c.text).join('\n');
	const notePromise = wantNote ? composeNote(settings.openaiApiKey, rec.title, plain) : null;
	if (wanted.length === 0) {
		const note = await notePromise!;
		return note ? { note } : {};
	}

	const user = `題: ${rec.title}\n\n書き起こし:\n${clipTranscript(spoken)}`;
	let parsed = await askJson(settings.openaiApiKey, MODEL, composePrompt(wanted), user);
	// YouTube の説明に箇条書き・ハッシュタグ・タグ・チャプターが揃っていなければ、強いモデルで 1 回作り直す
	if (wanted.includes('youtube') && !youtubeComplete(parsed.youtube, totalMs)) {
		console.log(
			'[compose] YouTube の中身が足りないので作り直す:',
			JSON.stringify(parsed.youtube).slice(0, 200)
		);
		const again = await askJson(settings.openaiApiKey, RETRY_MODEL, composePrompt(wanted), user);
		if (youtubeComplete(again.youtube, totalMs) || !parsed.youtube)
			parsed = { ...parsed, ...again };
	}
	const out: ComposeResult = {};
	for (const p of wanted) {
		const v = parsed[p] as
			| {
					title?: unknown;
					text?: unknown;
					description?: unknown;
					tags?: unknown;
					hashtags?: unknown;
					chapters?: unknown;
			  }
			| undefined;
		if (!v || typeof v !== 'object') continue;
		const text =
			typeof v.text === 'string' ? v.text : typeof v.description === 'string' ? v.description : '';
		const title = typeof v.title === 'string' ? v.title.trim() : undefined;
		const topic =
			typeof (v as { topic?: unknown }).topic === 'string'
				? (v as { topic: string }).topic.trim().replace(/^#/, '').slice(0, 20) || undefined
				: undefined;
		const tags = Array.isArray(v.tags)
			? v.tags.filter((t): t is string => typeof t === 'string').map((t) => t.trim())
			: undefined;
		// 行末の余分な空白（AI が付けがち）は落とす
		let body = text
			.split('\n')
			.map((l) => l.trimEnd())
			.join('\n')
			.trim();
		let chapters: Array<{ time: string; title: string }> | undefined;
		if (p === 'youtube' && Array.isArray(v.chapters) && totalMs >= 3 * 60_000) {
			chapters = v.chapters
				.filter(
					(c): c is { time: string; title: string } =>
						!!c &&
						typeof c === 'object' &&
						typeof (c as { time?: unknown }).time === 'string' &&
						typeof (c as { title?: unknown }).title === 'string'
				)
				.map((c) => ({ time: normalizeTime(c.time), title: c.title.trim() }))
				.filter((c) => c.title);
			if (chapters.length >= 3) {
				if (chapters[0].time !== '00:00') chapters[0] = { ...chapters[0], time: '00:00' };
				body += `\n\n▼チャプター\n${chapters.map((c) => `${c.time} ${c.title}`).join('\n')}`;
			} else chapters = undefined;
		}
		// ハッシュタグは説明のいちばん下（チャプターのあと）。AI が hashtags を省いたら tags から作る（逆も）
		let hashtags: string[] | undefined;
		if (p === 'youtube') {
			const raw =
				Array.isArray(v.hashtags) && v.hashtags.length ? v.hashtags : (tags ?? []).slice(0, 8);
			hashtags = raw
				.filter((t): t is string => typeof t === 'string')
				.map((t) => t.trim().replace(/^＃/, '#'))
				.map((t) => (t.startsWith('#') ? t : `#${t}`))
				.filter((t) => t.length > 1);
			if (hashtags.length > 0) body += `\n\n${hashtags.join(' ')}`;
		}
		const tagsOut =
			p === 'youtube' && (!tags || tags.length === 0) && hashtags?.length
				? hashtags.map((h) => h.replace(/^#/, ''))
				: tags;
		out[p] = {
			title,
			text: p === 'x' ? fitX(body) : body,
			topic,
			tags: tagsOut,
			hashtags,
			chapters
		};
	}
	if (notePromise) {
		const note = await notePromise;
		if (note) out.note = note;
	}
	return out;
}

async function askJson(
	apiKey: string,
	model: string,
	system: string,
	user: string
): Promise<Record<string, unknown>> {
	const res = await fetch('https://api.openai.com/v1/chat/completions', {
		method: 'POST',
		headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({
			model,
			temperature: 0.5,
			response_format: { type: 'json_object' },
			messages: [
				{ role: 'system', content: system },
				{ role: 'user', content: user }
			]
		})
	});
	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new Error(`OpenAI: HTTP ${res.status} ${body.slice(0, 200)}`);
	}
	const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
	try {
		return JSON.parse(json.choices?.[0]?.message?.content ?? '{}') as Record<string, unknown>;
	} catch {
		throw new Error('OpenAI の返事が読めませんでした');
	}
}

/** YouTube の返事に、説明の箇条書き・ハッシュタグ・タグ・（3 分以上なら）チャプターが揃っているか */
export function youtubeComplete(v: unknown, totalMs: number): boolean {
	if (!v || typeof v !== 'object') return false;
	const y = v as { description?: unknown; hashtags?: unknown; tags?: unknown; chapters?: unknown };
	const desc = typeof y.description === 'string' ? y.description : '';
	const bullets = (desc.match(/^・/gm) ?? []).length;
	const n = (x: unknown) => (Array.isArray(x) ? x.length : 0);
	if (bullets < 2) return false;
	if (n(y.hashtags) < 3 && n(y.tags) < 3) return false;
	if (totalMs >= 3 * 60_000 && n(y.chapters) < 3) return false;
	return true;
}

/** note の記事（題と Markdown の本文）。書き起こしは時刻無しで全部渡す */
async function composeNote(
	apiKey: string,
	title: string,
	plainTranscript: string
): Promise<{ title?: string; text: string; tags?: string[] } | null> {
	const target = noteTargetChars([...plainTranscript.replace(/\s+/g, '')].length);
	const res = await fetch('https://api.openai.com/v1/chat/completions', {
		method: 'POST',
		headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({
			model: NOTE_MODEL,
			temperature: 0.5,
			max_tokens: 10000,
			messages: [
				{ role: 'system', content: noteArticlePrompt(target) },
				{
					role: 'user',
					content: `題: ${title}\n\n書き起こし:\n${clipTranscript(plainTranscript, 60000)}`
				}
			]
		})
	});
	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new Error(`OpenAI（note の記事）: HTTP ${res.status} ${body.slice(0, 200)}`);
	}
	const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
	// 返事は Markdown の本文そのもの。念のため、コードブロックの囲いと先頭の # の題は外す
	let text = (json.choices?.[0]?.message?.content ?? '').trim();
	text = text.replace(/^```(?:markdown|md)?\s*\n/i, '').replace(/\n```\s*$/, '');
	text = text.replace(/^# .*\n+/, '');
	// 1 行目が題らしい短い行（句点なし・40 文字以内・次が空行）なら外す（題は動画の題を使う）
	text = text.replace(/^(?![-#*>])[^\n。]{1,40}\n\n+/, '');
	text = text
		.split('\n')
		.map((l) => l.trimEnd())
		.join('\n')
		.trim();
	if (!text) return null;
	// 最後の「タグ: a、b、c」の行はハッシュタグ（note の別欄に入れる）。本文からは外す
	let tags: string[] | undefined;
	const m = /(?:^|\n)\s*タグ[:：]\s*(.+)\s*$/.exec(text);
	if (m) {
		tags = m[1]
			.split(/[、,，\s#]+/)
			.map((t) => t.trim())
			.filter((t) => t.length >= 2 && t.length <= 20)
			.slice(0, 10);
		text = text.slice(0, m.index).trim();
	}
	// 題は動画の題をそのまま使う（画面側で入れる）
	return { text, tags };
}

/** ミリ秒を mm:ss（1 時間を超えたら h:mm:ss） */
function mmss(ms: number): string {
	const t = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(t / 3600);
	const m = Math.floor((t % 3600) / 60);
	const s = t % 60;
	const pad = (n: number) => String(n).padStart(2, '0');
	return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** AI が返した時刻（mm:ss や h:mm:ss）を YouTube の形に整える。読めなければ 00:00 */
function normalizeTime(t: string): string {
	const parts = t
		.trim()
		.split(':')
		.map((x) => Number(x));
	if (parts.length < 2 || parts.some((x) => Number.isNaN(x))) return '00:00';
	let sec = 0;
	for (const p of parts) sec = sec * 60 + p;
	return mmss(sec * 1000);
}
