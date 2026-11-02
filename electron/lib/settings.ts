import { app } from 'electron';
import { isSubtitleLang } from '../../shared/subtitles';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { YouTubeAuth } from '../../shared/publish';
import type { SecretName, SecretStatus, Settings } from '../../shared/types';
import { keychainVault } from './keychain';
import { SecretStore, SLOT_LABELS, splitSecrets, type Slot } from './secrets';

/**
 * 設定はアプリの userData に置く（保存先フォルダーとは別）。
 * 鍵・トークン（OpenAI の API キー、YouTube のシークレットと接続、投稿ハブの合言葉）はここには書かず、
 * Mac のキーチェーンに置く（secrets.ts / keychain.ts）。以前 settings.json に入れていた鍵は、開いたときに 1 回だけ移す
 */
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

// ---- 鍵（キーチェーン） ----

/** 確認用の別インスタンス（YASASHII_USER_DATA。main.ts 参照）か。設定と同じく鍵も別にして、本物の投稿ハブの合言葉などを見ないようにする */
function isTestInstance(): boolean {
	return !app.isPackaged && !!process.env.YASASHII_USER_DATA;
}

let store: SecretStore | null = null;
function secrets(): SecretStore {
	if (!store) {
		// service はキーチェーンアクセスの「場所」、label は項目の名前になる
		const test = isTestInstance();
		store = new SecretStore(
			keychainVault(test ? 'yasashii-zukai-recorder.test' : 'yasashii-zukai-recorder'),
			test ? 'やさしい図解レコーダー（確認用）' : 'やさしい図解レコーダー'
		);
	}
	return store;
}

/** キーチェーンへ移せなかった鍵（settings.json に残して、次に開いたときにもう一度） */
let leftover: Partial<Record<Slot, unknown>> = {};
/** 開いたときに画面で 1 回だけ知らせること */
const notices: string[] = [];

export function getSecret(name: SecretName): string | null {
	return secrets().get(name);
}

/** 鍵をキーチェーンに置く（null か空で消す）。置いたあとの有る／無しを返す */
export async function setSecret(name: SecretName, value: string | null): Promise<SecretStatus> {
	secrets().set(name, value);
	if (name in leftover) {
		// 移せずに settings.json に残っていた前の鍵が、次に開いたときに今の鍵を上書きしないように
		delete leftover[name];
		await writeSettingsFile();
	}
	return secrets().status();
}

export function secretStatus(): SecretStatus {
	return secrets().status();
}

export function getYouTubeAuth(): YouTubeAuth | null {
	return secrets().getYouTubeAuth();
}

export async function setYouTubeAuth(auth: YouTubeAuth | null): Promise<void> {
	secrets().setYouTubeAuth(auth);
	if ('youtubeAuth' in leftover) {
		delete leftover.youtubeAuth;
		await writeSettingsFile();
	}
}

/** 開いたときの知らせを返して消す（1 回だけ出す） */
export function takeStartupNotices(): string[] {
	return notices.splice(0);
}

// ---- 設定 ----

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
		transcriptTerms: '',
		transcriptReplacements: '',
		noiseReduction: 'off',
		subtitleLanguages: [],
		youtubeClientId: null,
		hubUrl: null,
		windowBounds: null,
		workspaceBounds: null
	};
	let raw: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(await fs.readFile(settingsFile(), 'utf8'));
		if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>;
	} catch {
		/* 無い・読めない → 既定で始める */
	}
	// 鍵の欄は設定には入れない。以前の settings.json に残っていたら、キーチェーンへ移してファイルから消す
	const { secrets: found, rest } = splitSecrets(raw);
	cache = sanitize({ ...defaults, ...(rest as Partial<Settings>) });
	if (Object.keys(found).length > 0) {
		const r = secrets().migrate(found);
		leftover = r.leftover;
		if (r.moved.length > 0)
			notices.push(
				`鍵をキーチェーンに移しました（${r.moved.map((s) => SLOT_LABELS[s]).join('、')}）`
			);
		await writeSettingsFile().catch((err) => console.warn('設定を書き直せませんでした', err));
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
		hubUrl:
			typeof s.hubUrl === 'string' && /^https?:\/\//.test(s.hubUrl.trim())
				? s.hubUrl.trim().replace(/\/+$/, '')
				: null,
		windowBounds: sanitizeBounds(s.windowBounds),
		workspaceBounds: sanitizeBounds(s.workspaceBounds)
	};
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
	const current = await loadSettings();
	// 鍵の欄が混ざって来ても settings.json には書かない（鍵は setSecret でキーチェーンへ）
	const { rest } = splitSecrets(patch ?? {});
	cache = sanitize({ ...current, ...(rest as Partial<Settings>) });
	await writeSettingsFile();
	return cache;
}

/** settings.json を書く。移せなかった鍵があれば、それだけは残す */
async function writeSettingsFile(): Promise<void> {
	if (!cache) return;
	await fs.mkdir(path.dirname(settingsFile()), { recursive: true });
	await fs.writeFile(settingsFile(), JSON.stringify({ ...cache, ...leftover }, null, 2), 'utf8');
}

type Bounds = { x: number; y: number; width: number; height: number };
function sanitizeBounds(b: Bounds | null | undefined): Bounds | null {
	if (!b) return null;
	return [b.x, b.y, b.width, b.height].every((v) => typeof v === 'number' && Number.isFinite(v))
		? { x: b.x, y: b.y, width: b.width, height: b.height }
		: null;
}
