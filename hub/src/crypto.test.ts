import { describe, expect, it } from 'vitest';
import {
	ENC_PREFIX,
	decryptToken,
	encryptToken,
	isEncrypted,
	tokenKey,
	tokenKeyError
} from './crypto';

// 32 バイトを base64 にした決まった鍵（テスト用。本物ではない）
const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const OTHER_KEY = 'Hx4dHBsaGRgXFhUUExIREA8ODQwLCgkIBwYFBAMCAQA=';

describe('crypto（SNS のトークンの暗号化）', () => {
	it('決まった鍵で暗号化 → 復号が戻る（日本語・長い文字列も）', async () => {
		const key = await tokenKey({ TOKEN_KEY: KEY });
		for (const plain of ['abc', 'トークン', 'x'.repeat(4000), '']) {
			const stored = await encryptToken(key, plain);
			expect(stored.startsWith(ENC_PREFIX)).toBe(true);
			expect(await decryptToken(key, stored)).toBe(plain);
		}
	});

	it('保存する形は enc1:<IV の base64>:<暗号文の base64>。IV は 12 バイトで毎回ちがう', async () => {
		const key = await tokenKey({ TOKEN_KEY: KEY });
		const a = await encryptToken(key, 'same');
		const b = await encryptToken(key, 'same');
		const [va, iva, cta] = a.split(':');
		const [vb, ivb, ctb] = b.split(':');
		expect(va).toBe('enc1');
		expect(vb).toBe('enc1');
		expect(atob(iva)).toHaveLength(12);
		expect(iva).not.toBe(ivb);
		expect(cta).not.toBe(ctb);
		expect(atob(cta)).toHaveLength('same'.length + 16); // 本文 + GCM のタグ 16 バイト
	});

	it('ちがう鍵では復号できず、分かる言葉で止まる', async () => {
		const stored = await encryptToken(await tokenKey({ TOKEN_KEY: KEY }), 'secret');
		await expect(decryptToken(await tokenKey({ TOKEN_KEY: OTHER_KEY }), stored)).rejects.toThrow(
			/復号できません.*つなぎ直して/
		);
	});

	it('形が崩れたものは復号しない', async () => {
		const key = await tokenKey({ TOKEN_KEY: KEY });
		await expect(decryptToken(key, 'plain-token')).rejects.toThrow(/形ではありません/);
		await expect(decryptToken(key, 'enc1:AAAA')).rejects.toThrow(/崩れて/);
		await expect(decryptToken(key, 'enc1:AAAA:BBBB')).rejects.toThrow(/崩れて/);
	});

	it('isEncrypted は enc1: で始まるものだけ true', () => {
		expect(isEncrypted('enc1:a:b')).toBe(true);
		expect(isEncrypted('abc')).toBe(false);
		expect(isEncrypted('')).toBe(false);
		expect(isEncrypted(null)).toBe(false);
		expect(isEncrypted(undefined)).toBe(false);
	});

	it('TOKEN_KEY が無い・形が違うときは、置き方の分かる言葉。正しければ null', async () => {
		expect(tokenKeyError({})).toMatch(/TOKEN_KEY.*ありません.*wrangler secret put TOKEN_KEY/);
		expect(tokenKeyError({ TOKEN_KEY: '  ' })).toMatch(/ありません/);
		expect(tokenKeyError({ TOKEN_KEY: 'short' })).toMatch(/形が違います.*32 バイト/);
		expect(tokenKeyError({ TOKEN_KEY: btoa('x'.repeat(16)) })).toMatch(/形が違います/);
		expect(tokenKeyError({ TOKEN_KEY: '!!!not base64!!!' })).toMatch(/形が違います/);
		expect(tokenKeyError({ TOKEN_KEY: KEY })).toBeNull();
		expect(tokenKeyError({ TOKEN_KEY: `${KEY}\n` })).toBeNull(); // 末尾の改行は気にしない
		await expect(tokenKey({})).rejects.toThrow(/TOKEN_KEY/);
	});
});
