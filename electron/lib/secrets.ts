/**
 * 鍵・トークンの置き場。settings.json には書かず、Mac のキーチェーンに置く（keychain.ts）。
 *
 * - 画面から入れるもの（OpenAI の API キー・YouTube のクライアント シークレット・投稿ハブの合言葉）と、
 *   YouTube に接続したときにアプリが受け取るトークン（youtubeAuth）の 4 つ
 * - 画面には中身を渡さない。有る／無いだけ（SecretStatus）
 * - 以前は settings.json に平文で入れていた。アプリを開いたときに 1 回だけキーチェーンへ移し、settings.json から消す（migrate）
 * - 一度読んだ値は覚えておき、何度も security を呼ばない
 *
 * electron には依存しない（テストは偽物のキーチェーン memoryVault で）
 */
import type { YouTubeAuth } from '../../shared/publish';
import type { SecretName, SecretStatus } from '../../shared/types';
import type { Vault } from './keychain';

/** キーチェーンに置くもの。画面から入れる 3 つ（SecretName）と、YouTube の接続（トークン） */
export type Slot = SecretName | 'youtubeAuth';

export const SECRET_NAMES: readonly SecretName[] = [
	'openaiApiKey',
	'youtubeClientSecret',
	'hubToken'
];
export const SLOTS: readonly Slot[] = [...SECRET_NAMES, 'youtubeAuth'];

/** キーチェーンアクセスで何の鍵か分かるように、項目の名前に入れる */
export const SLOT_LABELS: Record<Slot, string> = {
	openaiApiKey: 'OpenAI の API キー',
	youtubeClientSecret: 'YouTube のクライアント シークレット',
	hubToken: '投稿ハブの合言葉',
	youtubeAuth: 'YouTube の接続（トークン）'
};

export function isSecretName(v: unknown): v is SecretName {
	return typeof v === 'string' && (SECRET_NAMES as readonly string[]).includes(v);
}

function isSlot(v: string): v is Slot {
	return (SLOTS as readonly string[]).includes(v);
}

/** settings.json の中身（や画面から来た設定）から、鍵の欄を分ける。鍵は settings.json に書かない */
export function splitSecrets<T extends object>(
	raw: T
): { secrets: Partial<Record<Slot, unknown>>; rest: Omit<T, Slot> } {
	const secrets: Partial<Record<Slot, unknown>> = {};
	const rest: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(raw)) {
		if (isSlot(k)) secrets[k] = v;
		else rest[k] = v;
	}
	return { secrets, rest: rest as Omit<T, Slot> };
}

/** 文字の鍵として使える形か（空や空白だけは無しと同じ） */
function asText(v: unknown): string | null {
	return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** YouTube の接続として使える形か（トークンが 2 つとも文字で入っているもの） */
export function asYouTubeAuth(v: unknown): YouTubeAuth | null {
	if (!v || typeof v !== 'object') return null;
	const a = v as Partial<YouTubeAuth>;
	if (typeof a.refreshToken !== 'string' || typeof a.accessToken !== 'string') return null;
	return {
		refreshToken: a.refreshToken,
		accessToken: a.accessToken,
		expiresAt: typeof a.expiresAt === 'number' && Number.isFinite(a.expiresAt) ? a.expiresAt : 0,
		channelTitle: typeof a.channelTitle === 'string' ? a.channelTitle : '',
		channelId: typeof a.channelId === 'string' ? a.channelId : '',
		...(typeof a.scope === 'string' ? { scope: a.scope } : {})
	};
}

export class SecretStore {
	/** 一度読んだ値（無かったものは覚えない。あとから入れたら読めるように） */
	private readonly cache = new Map<Slot, string>();

	constructor(
		private readonly vault: Vault,
		/** キーチェーンアクセスで見える項目の名前の頭（「やさしい図解レコーダー」など） */
		private readonly labelPrefix: string
	) {}

	get(slot: Slot): string | null {
		const cached = this.cache.get(slot);
		if (cached !== undefined) return cached;
		const v = this.vault.get(slot);
		if (v !== null) this.cache.set(slot, v);
		return v;
	}

	/** null か空なら消す。置けなかったときは投げ、覚えていた値はそのまま */
	set(slot: Slot, value: string | null): void {
		const v = slot === 'youtubeAuth' ? value : asText(value);
		if (v === null) {
			this.vault.remove(slot);
			this.cache.delete(slot);
			return;
		}
		this.vault.set(slot, v, `${this.labelPrefix}: ${SLOT_LABELS[slot]}`);
		this.cache.set(slot, v);
	}

	/** 画面に見せる分（有る／無いだけ） */
	status(): SecretStatus {
		return {
			openaiApiKey: this.get('openaiApiKey') !== null,
			youtubeClientSecret: this.get('youtubeClientSecret') !== null,
			hubToken: this.get('hubToken') !== null
		};
	}

	getYouTubeAuth(): YouTubeAuth | null {
		const raw = this.get('youtubeAuth');
		if (raw === null) return null;
		try {
			return asYouTubeAuth(JSON.parse(raw));
		} catch {
			return null;
		}
	}

	setYouTubeAuth(auth: YouTubeAuth | null): void {
		this.set('youtubeAuth', auth ? JSON.stringify(auth) : null);
	}

	/**
	 * settings.json にあった鍵をキーチェーンへ移す。
	 * - moved: 移せたもの（呼び出し側が settings.json から消して、1 回だけ知らせる）
	 * - leftover: 移せなかったもの（キーチェーンで断られたときなど）。settings.json に残して、次に開いたときにもう一度。
	 *   この起動の間は覚えておいて、そのまま使えるようにする
	 * 形のおかしい値（空・型違い）は、移さず捨てる（どちらにも入らない）
	 */
	migrate(found: Partial<Record<Slot, unknown>>): {
		moved: Slot[];
		leftover: Partial<Record<Slot, unknown>>;
	} {
		const moved: Slot[] = [];
		const leftover: Partial<Record<Slot, unknown>> = {};
		for (const slot of SLOTS) {
			if (!(slot in found)) continue;
			const raw = found[slot];
			const value =
				slot === 'youtubeAuth'
					? (() => {
							const a = asYouTubeAuth(raw);
							return a ? JSON.stringify(a) : null;
						})()
					: asText(raw);
			if (value === null) continue;
			try {
				this.set(slot, value);
				moved.push(slot);
			} catch {
				leftover[slot] = raw;
				this.cache.set(slot, value);
			}
		}
		return { moved, leftover };
	}
}
