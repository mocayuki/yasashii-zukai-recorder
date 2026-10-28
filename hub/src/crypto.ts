/**
 * D1 に入れる SNS のトークン（accounts.access_token / refresh_token）の暗号化。
 * 鍵は Worker の secret TOKEN_KEY（32 バイトを base64 にしたもの。`openssl rand -base64 32` で作る）。
 * AES-256-GCM（WebCrypto）。行ごとに 12 バイトの乱数 IV。
 * 保存する形は `enc1:<IV の base64>:<暗号文の base64>`（頭の enc1 が版。形を変えるときは enc2 にして両方読めるようにする）
 */
export const ENC_PREFIX = 'enc1:';
const KEY_BYTES = 32;
const IV_BYTES = 12;

const HOW_TO_SET =
	'`openssl rand -base64 32 | npx wrangler secret put TOKEN_KEY` で置いてください（hub/README.md）';

/** TOKEN_KEY が無い・形が違うときの説明。問題なければ null */
export function tokenKeyError(env: { TOKEN_KEY?: string }): string | null {
	const raw = env.TOKEN_KEY?.trim();
	if (!raw) return `TOKEN_KEY（SNS のトークンを暗号化する鍵）がありません。${HOW_TO_SET}`;
	const bytes = fromBase64(raw);
	if (!bytes || bytes.length !== KEY_BYTES)
		return `TOKEN_KEY の形が違います（32 バイトを base64 にしたもの）。${HOW_TO_SET}`;
	return null;
}

let cached: { raw: string; key: Promise<CryptoKey> } | null = null;

/** TOKEN_KEY を AES-GCM の鍵にする（同じ値なら使い回す）。無い・形が違うときは分かる言葉で止まる */
export async function tokenKey(env: { TOKEN_KEY?: string }): Promise<CryptoKey> {
	const err = tokenKeyError(env);
	if (err) throw new Error(err);
	const raw = env.TOKEN_KEY!.trim();
	if (cached?.raw !== raw) {
		cached = {
			raw,
			key: crypto.subtle.importKey('raw', fromBase64(raw)!, { name: 'AES-GCM' }, false, [
				'encrypt',
				'decrypt'
			])
		};
	}
	return cached.key;
}

/** 暗号化した形（enc1:…）で入っているか。平文の行（暗号化より前に入れたもの）は false */
export function isEncrypted(stored: string | null | undefined): boolean {
	return typeof stored === 'string' && stored.startsWith(ENC_PREFIX);
}

export async function encryptToken(key: CryptoKey, plain: string): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const sealed = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv },
		key,
		new TextEncoder().encode(plain)
	);
	return `${ENC_PREFIX}${toBase64(iv)}:${toBase64(new Uint8Array(sealed))}`;
}

export async function decryptToken(key: CryptoKey, stored: string): Promise<string> {
	if (!isEncrypted(stored)) throw new Error('暗号化したトークンの形ではありません');
	const parts = stored.slice(ENC_PREFIX.length).split(':');
	const iv = parts.length === 2 ? fromBase64(parts[0]) : null;
	const sealed = parts.length === 2 ? fromBase64(parts[1]) : null;
	if (!iv || !sealed || iv.length !== IV_BYTES)
		throw new Error('暗号化したトークンの形が崩れています');
	try {
		const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, sealed);
		return new TextDecoder().decode(plain);
	} catch {
		throw new Error(
			'SNS のトークンを復号できません（TOKEN_KEY が変わっていませんか）。ハブでつなぎ直してください'
		);
	}
}

function toBase64(u8: Uint8Array): string {
	let s = '';
	for (const b of u8) s += String.fromCharCode(b);
	return btoa(s);
}

/** base64（URL 形でもよい）をバイト列に。読めなければ null */
function fromBase64(s: string): Uint8Array<ArrayBuffer> | null {
	try {
		const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
		const u8 = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
		return u8;
	} catch {
		return null;
	}
}
