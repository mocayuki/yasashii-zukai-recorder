/**
 * 字幕ファイル（.srt）の外国語版。
 * 日本語のテロップを OpenAI で翻訳し、言語ごとの .srt にする。翻訳した文はテロップの id ごとに覚えておき、
 * 元の文が変わっていなければ次回は翻訳し直さない（お金と時間の節約）
 */
import type { Cue } from './types';

export type SubtitleLang = 'en' | 'ko' | 'zh-Hant' | 'zh-Hans' | 'fr' | 'es' | 'pt-BR';

export const SUBTITLE_LANGS: Array<{ code: SubtitleLang; label: string; name: string }> = [
	{ code: 'en', label: '英語', name: 'English' },
	{ code: 'ko', label: '韓国語', name: 'Korean' },
	{ code: 'zh-Hant', label: '中国語（繁体字）', name: 'Traditional Chinese (Taiwan)' },
	{ code: 'zh-Hans', label: '中国語（簡体字）', name: 'Simplified Chinese' },
	{ code: 'fr', label: 'フランス語', name: 'French' },
	{ code: 'es', label: 'スペイン語', name: 'Spanish' },
	{ code: 'pt-BR', label: 'ポルトガル語（ブラジル）', name: 'Brazilian Portuguese' }
];

export function isSubtitleLang(v: unknown): v is SubtitleLang {
	return SUBTITLE_LANGS.some((l) => l.code === v);
}

/** 覚えている翻訳: 言語 → テロップ id → { 元の文, 訳 } */
export type TranslationCache = Record<string, Record<string, { src: string; text: string }>>;

/** まだ訳していない（または元の文が変わった）テロップ */
export function pickUntranslated(
	cues: Cue[],
	cache: Record<string, { src: string; text: string }> | undefined
): Cue[] {
	return cues.filter((c) => {
		const hit = cache?.[c.id];
		return !hit || hit.src !== c.text;
	});
}

/** 翻訳の結果を当てて、訳の入ったテロップにする（訳が無いものは元の文のまま） */
export function applyTranslation(
	cues: Cue[],
	cache: Record<string, { src: string; text: string }> | undefined
): Cue[] {
	return cues.map((c) => {
		const hit = cache?.[c.id];
		return hit && hit.src === c.text ? { ...c, text: hit.text } : c;
	});
}

/** OpenAI へ渡す文（JSON）。id と文の組の一覧 */
export function translationPrompt(langName: string, terms: string[]): string {
	const glossary = terms.length
		? `\nProper nouns (names of people, products, channels) to keep consistent: ${terms.join(', ')}. Write them the way subtitles in ${langName} normally would (for example, romanize Japanese personal names in English, and use the target script when that is natural). Do not translate their meaning.`
		: '';
	return (
		`You translate Japanese YouTube subtitles into ${langName}. ` +
		`Translate each item naturally and concisely as a subtitle line (short, spoken style). ` +
		`Keep the same ids and the same number of items. Do not merge or split items. ` +
		`Return only JSON: {"items":[{"id":"...","text":"..."}]}.` +
		glossary
	);
}

/** OpenAI の返事（JSON 文字列）から id → 訳 を取り出す。形が違えば空 */
export function parseTranslation(json: string): Map<string, string> {
	const out = new Map<string, string>();
	try {
		const obj = JSON.parse(json) as { items?: Array<{ id?: unknown; text?: unknown }> };
		for (const it of obj.items ?? []) {
			if (typeof it.id === 'string' && typeof it.text === 'string' && it.text.trim())
				out.set(it.id, it.text.trim());
		}
	} catch {
		/* 形が違う */
	}
	return out;
}

/** ファイル名: 題名.ja.srt / 題名.en.srt … */
export function srtFileName(base: string, lang: 'ja' | SubtitleLang): string {
	return `${base}.${lang}.srt`;
}
