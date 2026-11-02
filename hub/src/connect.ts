/**
 * SNS の接続を始める（POST /api/connect/:platform）。合言葉は呼ぶ側（API の Bearer）で確かめ済みのこと。
 * 許可画面の URL（使い捨ての state 入り。10 分で無効）を返し、アプリがそれをブラウザーで開く。
 * 合言葉は URL に入れない（2026-11-02 までは /connect/:platform?t=合言葉 を開いていて、ブラウザーの履歴やログに残った）
 */
import type { Env } from './env';
import { putState } from './db';
import { pkceChallenge, randomToken } from './oauth';
import { getPublisher } from './platforms';

export async function startConnect(
	env: Env,
	platform: string
): Promise<{ url: string } | { error: string; status: 404 | 500 }> {
	const publisher = getPublisher(platform);
	if (!publisher) return { error: `${platform} にはまだ対応していません`, status: 404 };
	const missing = publisher.missingConfig(env);
	if (missing) return { error: missing, status: 500 };
	const state = randomToken(24);
	const verifier = randomToken(48);
	await putState(env.DB, state, publisher.platform, verifier);
	return { url: publisher.authorizeUrl(env, state, await pkceChallenge(verifier)) };
}
