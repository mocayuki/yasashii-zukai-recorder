import { app, dialog, type BrowserWindow } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Cue, Recording, SubtitleProgress, Transcript } from '../../shared/types';
import { cuesForExport, toSrt } from '../../shared/cues';
import {
	applyTranslation,
	parseTranslation,
	pickUntranslated,
	srtFileName,
	SUBTITLE_LANGS,
	translationPrompt,
	type SubtitleLang
} from '../../shared/subtitles';
import { safeFileName } from './ffmpeg';
import { saveTranscript } from './transcripts';

/** 翻訳に使うモデル（安くて速い。字幕の 1 行ずつなので十分） */
const MODEL = 'gpt-4o-mini';
const BATCH = 60;

/** 保存先のフォルダーを選ぶ（開発時は YASASHII_EXPORT_DIR）。取りやめなら null */
async function pickDir(win: BrowserWindow | null): Promise<string | null> {
	const devDir = !app.isPackaged ? process.env.YASASHII_EXPORT_DIR : undefined;
	if (devDir) return devDir;
	const result = await dialog.showOpenDialog(win ?? undefined!, {
		title: '字幕ファイルを保存するフォルダー',
		defaultPath: app.getPath('downloads'),
		buttonLabel: 'ここに保存',
		properties: ['openDirectory', 'createDirectory']
	});
	if (result.canceled || result.filePaths.length === 0) return null;
	return result.filePaths[0];
}

/** OpenAI にまとめて翻訳を頼む。id → 訳 */
async function translateBatch(
	apiKey: string,
	langName: string,
	terms: string[],
	items: Cue[]
): Promise<Map<string, string>> {
	const res = await fetch('https://api.openai.com/v1/chat/completions', {
		method: 'POST',
		headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({
			model: MODEL,
			temperature: 0.2,
			response_format: { type: 'json_object' },
			messages: [
				{ role: 'system', content: translationPrompt(langName, terms) },
				{
					role: 'user',
					content: JSON.stringify({ items: items.map((c) => ({ id: c.id, text: c.text })) })
				}
			]
		})
	});
	if (!res.ok) {
		const body = await res.text().catch(() => '');
		if (res.status === 401) throw new Error('API キーが正しくありません。設定で確かめてください。');
		throw new Error(`翻訳に失敗しました（${res.status}）。${body.slice(0, 200)}`);
	}
	const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
	return parseTranslation(json.choices?.[0]?.message?.content ?? '');
}

/**
 * 字幕ファイルを保存する。日本語（.ja.srt）と、設定で選んだ言語の分（.en.srt など）。
 * 時刻はカットを外した後（書き出した mp4 と同じ）。翻訳は transcript.translations に覚えて、次回は差分だけ訳す
 */
/**
 * 字幕（srt の文字列）を言語ごとに作る。まず日本語、次に langs の外国語（OpenAI で翻訳。訳は transcript に覚えて次回は訳し直さない）。
 * ファイルには書かない（保存するときも、YouTube に付けるときも、これを使う）
 */
export async function buildSubtitles(
	rec: Recording,
	transcript: Transcript,
	langs: SubtitleLang[],
	apiKey: string | null,
	terms: string[],
	onProgress: (p: SubtitleProgress) => void
): Promise<Array<{ lang: string; srt: string }>> {
	const out: Array<{ lang: string; srt: string }> = [];
	// まず日本語（翻訳が失敗しても、これだけは残る）
	const ja = cuesForExport(transcript.cues, rec.cuts ?? [], rec.durationMs);
	out.push({ lang: 'ja', srt: toSrt(ja) });
	if (langs.length === 0) return out;
	if (!apiKey)
		throw new Error('外国語版には OpenAI の API キーが要ります。設定で入力してください。');
	const translations = { ...(transcript.translations ?? {}) };
	for (const lang of langs) {
		const info = SUBTITLE_LANGS.find((l) => l.code === lang);
		if (!info) continue;
		const cache = { ...(translations[lang] ?? {}) };
		// 翻訳は元のテロップ（カット前）の id で覚える。訳すのは、カット後に残るものだけ
		const need = pickUntranslated(ja, cache);
		let done = 0;
		onProgress({ recordingId: rec.id, lang, done, total: need.length });
		for (let i = 0; i < need.length; i += BATCH) {
			const chunk = need.slice(i, i + BATCH);
			const got = await translateBatch(apiKey, info.name, terms, chunk);
			for (const c of chunk) {
				const t = got.get(c.id);
				if (t) cache[c.id] = { src: c.text, text: t };
			}
			done += chunk.length;
			onProgress({ recordingId: rec.id, lang, done, total: need.length });
		}
		translations[lang] = cache;
		// 途中で止まっても、ここまでの訳は残す
		transcript.translations = translations;
		await saveTranscript(transcript);
		out.push({ lang, srt: toSrt(applyTranslation(ja, cache)) });
	}
	return out;
}

/** 字幕ファイルを選んだフォルダーに保存する（手元に欲しいとき用） */
export async function saveSubtitles(
	rec: Recording,
	transcript: Transcript,
	langs: SubtitleLang[],
	apiKey: string | null,
	terms: string[],
	win: BrowserWindow | null,
	onProgress: (p: SubtitleProgress) => void
): Promise<{ dir: string; files: string[] } | null> {
	const dir = await pickDir(win);
	if (!dir) return null;
	const base = safeFileName(rec.title || '収録');
	const files: string[] = [];
	for (const { lang, srt } of await buildSubtitles(
		rec,
		transcript,
		langs,
		apiKey,
		terms,
		onProgress
	)) {
		const p = path.join(dir, srtFileName(base, lang as SubtitleLang | 'ja'));
		await fs.writeFile(p, srt, 'utf8');
		files.push(p);
	}
	return { dir, files };
}
