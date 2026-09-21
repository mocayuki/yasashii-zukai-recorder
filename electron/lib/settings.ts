import { app } from 'electron';
import { isSubtitleLang } from '../../shared/subtitles';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Settings } from '../../shared/types';

/** 設定はアプリの userData に置く（保存先フォルダーとは別。鍵もここには書かない） */
function settingsFile(): string {
	return path.join(app.getPath('userData'), 'settings.json');
}

/**
 * 保存先の既定はアプリ自身の置き場所（~/Library/Application Support/やさしい図解レコーダー/library）。
 * ダウンロードフォルダーは整理で消えやすいので、そこには置かない。
 */
export function defaultLibraryPath(): string {
	return path.join(app.getPath('userData'), 'library');
}

/** 旧名「やさしい録音ノート」のころの置き場所（userData）の保存先。改名のあと設定に残っていたら新しい場所へ直す */
export function oldNameLibraryPath(): string {
	return path.join(app.getPath('appData'), 'やさしい録音ノート', 'library');
}

/** 以前の既定（ダウンロードの中）。起動時にここから移す */
export function legacyLibraryPath(): string {
	return path.join(app.getPath('downloads'), 'やさしい録音ノート');
}

let cache: Settings | null = null;

export async function loadSettings(): Promise<Settings> {
	if (cache) return cache;
	const defaults: Settings = {
		libraryPath: defaultLibraryPath(),
		micDeviceId: null,
		micGain: 1,
		micCompressor: true,
		speakerDeviceId: null,
		bgmFile: null,
		bgmVolume: 0.2,
		bgmDuck: true,
		bgmDuckLevel: 0.3,
		openaiApiKey: null,
		transcriptTerms: '',
		transcriptReplacements: '',
		noiseReduction: 'off',
		subtitleLanguages: [],
		youtubeClientId: null,
		youtubeClientSecret: null,
		youtubeAuth: null,
		hubUrl: null,
		hubToken: null,
		windowBounds: null,
		workspaceBounds: null
	};
	try {
		const raw = await fs.readFile(settingsFile(), 'utf8');
		const parsed = JSON.parse(raw) as Partial<Settings>;
		cache = sanitize({ ...defaults, ...parsed });
	} catch {
		cache = defaults;
	}
	return cache;
}

export const MIC_GAIN_MIN = 0.5;
export const MIC_GAIN_MAX = 6;

/** 画面から来た値や古い設定ファイルの値を、使える範囲に収める */
function sanitize(s: Settings): Settings {
	const num = (v: unknown, fallback: number, min: number, max: number) =>
		typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
	return {
		...s,
		micGain: num(s.micGain, 1, MIC_GAIN_MIN, MIC_GAIN_MAX),
		bgmVolume: num(s.bgmVolume, 0.2, 0, 1),
		bgmDuck: s.bgmDuck !== false,
		bgmDuckLevel: num(s.bgmDuckLevel, 0.3, 0, 1),
		micCompressor: s.micCompressor !== false,
		openaiApiKey:
			typeof s.openaiApiKey === 'string' && s.openaiApiKey.trim() ? s.openaiApiKey.trim() : null,
		transcriptTerms: typeof s.transcriptTerms === 'string' ? s.transcriptTerms.slice(0, 20000) : '',
		transcriptReplacements:
			typeof s.transcriptReplacements === 'string' ? s.transcriptReplacements.slice(0, 20000) : '',
		noiseReduction:
			s.noiseReduction === 'light' || s.noiseReduction === 'strong' ? s.noiseReduction : 'off',
		subtitleLanguages: Array.isArray(s.subtitleLanguages)
			? s.subtitleLanguages.filter((v): v is string => isSubtitleLang(v))
			: [],
		youtubeClientId:
			typeof s.youtubeClientId === 'string' && s.youtubeClientId.trim()
				? s.youtubeClientId.trim()
				: null,
		youtubeClientSecret:
			typeof s.youtubeClientSecret === 'string' && s.youtubeClientSecret.trim()
				? s.youtubeClientSecret.trim()
				: null,
		youtubeAuth:
			s.youtubeAuth &&
			typeof s.youtubeAuth.refreshToken === 'string' &&
			typeof s.youtubeAuth.accessToken === 'string'
				? { ...s.youtubeAuth }
				: null,
		hubUrl:
			typeof s.hubUrl === 'string' && /^https?:\/\//.test(s.hubUrl.trim())
				? s.hubUrl.trim().replace(/\/+$/, '')
				: null,
		hubToken: typeof s.hubToken === 'string' && s.hubToken.trim() ? s.hubToken.trim() : null,
		windowBounds: sanitizeBounds(s.windowBounds),
		workspaceBounds: sanitizeBounds(s.workspaceBounds)
	};
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
	const current = await loadSettings();
	cache = sanitize({ ...current, ...patch });
	await fs.mkdir(path.dirname(settingsFile()), { recursive: true });
	await fs.writeFile(settingsFile(), JSON.stringify(cache, null, 2), 'utf8');
	return cache;
}

type Bounds = { x: number; y: number; width: number; height: number };
function sanitizeBounds(b: Bounds | null | undefined): Bounds | null {
	if (!b) return null;
	return [b.x, b.y, b.width, b.height].every((v) => typeof v === 'number' && Number.isFinite(v))
		? { x: b.x, y: b.y, width: b.width, height: b.height }
		: null;
}
