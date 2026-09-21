/**
 * X（旧 Twitter）。OAuth 2.0 PKCE（機密クライアント）+ v2 の媒体アップロード（初期化→追加→確定→処理待ち）+ 投稿。
 * 料金は使った分だけ（投稿 1 件 0.015 ドルほど。リンク入りは 0.20 ドル）
 */
import type { HubPostRequest } from '../../../shared/publish';
import type { Env } from '../env';
import type { AccountRow } from '../db';
import { basicAuth } from '../oauth';
import { readJson, redirectUri, waitUntilDone, type JobControl, type Publisher } from './types';

const SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'media.write', 'offline.access'];
const API = 'https://api.x.com/2';
/** 1 回に送る大きさ。X は 1 片 5 MB まで */
const CHUNK = 4 * 1024 * 1024;

interface TokenResponse {
	access_token: string;
	refresh_token?: string;
	expires_in?: number;
}

async function tokenRequest(env: Env, params: Record<string, string>): Promise<TokenResponse> {
	const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
	if (env.X_CLIENT_SECRET) headers.authorization = basicAuth(env.X_CLIENT_ID!, env.X_CLIENT_SECRET);
	const res = await fetch(`${API}/oauth2/token`, {
		method: 'POST',
		headers,
		body: new URLSearchParams({ client_id: env.X_CLIENT_ID!, ...params })
	});
	return readJson<TokenResponse>(res, 'X のトークン');
}

async function me(token: string): Promise<{ id: string; username: string }> {
	const res = await fetch(`${API}/users/me`, { headers: { authorization: `Bearer ${token}` } });
	const j = await readJson<{ data: { id: string; username: string } }>(res, 'X のアカウント');
	return j.data;
}

type ProcessingInfo =
	{ state: string; check_after_secs?: number; error?: { message?: string } } | undefined;

export const xPublisher: Publisher = {
	platform: 'x',
	missingConfig(env) {
		return env.X_CLIENT_ID
			? null
			: 'X_CLIENT_ID が設定されていません（wrangler secret put X_CLIENT_ID）';
	},
	authorizeUrl(env, state, challenge) {
		const u = new URL('https://x.com/i/oauth2/authorize');
		u.searchParams.set('response_type', 'code');
		u.searchParams.set('client_id', env.X_CLIENT_ID!);
		u.searchParams.set('redirect_uri', redirectUri(env, 'x'));
		u.searchParams.set('scope', SCOPES.join(' '));
		u.searchParams.set('state', state);
		u.searchParams.set('code_challenge', challenge);
		u.searchParams.set('code_challenge_method', 'S256');
		return u.toString();
	},
	async exchangeCode(env, code, verifier) {
		const t = await tokenRequest(env, {
			grant_type: 'authorization_code',
			code,
			redirect_uri: redirectUri(env, 'x'),
			code_verifier: verifier
		});
		const u = await me(t.access_token);
		return {
			platform: 'x',
			user_id: u.id,
			username: u.username,
			access_token: t.access_token,
			refresh_token: t.refresh_token ?? null,
			expires_at: t.expires_in ? Date.now() + t.expires_in * 1000 : null
		};
	},
	async freshAccount(env, account) {
		// X のアクセストークンは 2 時間。5 分前になったら refresh_token で取り直す
		if (!account.expires_at || account.expires_at > Date.now() + 5 * 60_000) return account;
		if (!account.refresh_token) throw new Error('X の接続が切れています。つなぎ直してください');
		const t = await tokenRequest(env, {
			grant_type: 'refresh_token',
			refresh_token: account.refresh_token
		});
		return {
			...account,
			access_token: t.access_token,
			refresh_token: t.refresh_token ?? account.refresh_token,
			expires_at: t.expires_in ? Date.now() + t.expires_in * 1000 : null
		};
	},
	async post(env, account, req, media, ctl: JobControl) {
		const auth = { authorization: `Bearer ${account.access_token}` };
		// 1. 初期化（media id を保存）
		if (!ctl.state.mediaId) {
			const init = await readJson<{ data: { id: string } }>(
				await fetch(`${API}/media/upload/initialize`, {
					method: 'POST',
					headers: { ...auth, 'content-type': 'application/json' },
					body: JSON.stringify({
						media_category: 'tweet_video',
						media_type: media.contentType || 'video/mp4',
						total_bytes: media.size,
						shared: false
					})
				}),
				'X の動画アップロード（初期化）'
			);
			await ctl.save({ mediaId: init.data.id, sent: '0' });
		}
		const mediaId = ctl.state.mediaId;
		// 2. 4 MB ずつ追加（R2 から範囲で読む。送った片の数を保存）
		const total = Math.ceil(media.size / CHUNK);
		for (let i = Number(ctl.state.sent ?? 0); i < total; i++) {
			ctl.checkTime();
			const offset = i * CHUNK;
			const length = Math.min(CHUNK, media.size - offset);
			const obj = await env.MEDIA.get(media.key, { range: { offset, length } });
			if (!obj) throw new Error('動画がハブに見つかりません');
			const form = new FormData();
			form.set('segment_index', String(i));
			form.set(
				'media',
				new Blob([await obj.arrayBuffer()], { type: 'application/octet-stream' }),
				'chunk'
			);
			const res = await fetch(`${API}/media/upload/${mediaId}/append`, {
				method: 'POST',
				headers: auth,
				body: form
			});
			if (!res.ok)
				throw new Error(
					`X の動画アップロード（${i + 1} 片目）: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`
				);
			await ctl.save({ sent: String(i + 1) });
		}
		// 3. 確定
		if (!ctl.state.finalized) {
			const fin = await readJson<{ data: { processing_info?: ProcessingInfo } }>(
				await fetch(`${API}/media/upload/${mediaId}/finalize`, { method: 'POST', headers: auth }),
				'X の動画アップロード（確定）'
			);
			await ctl.save({
				finalized: '1',
				processed:
					fin.data.processing_info && fin.data.processing_info.state !== 'succeeded' ? '0' : '1'
			});
		}
		// 4. 処理が終わるまで待つ
		if (ctl.state.processed !== '1') {
			await waitUntilDone(ctl, async () => {
				const info = (
					await readJson<{ data: { processing_info?: ProcessingInfo } }>(
						await fetch(`${API}/media/upload?command=STATUS&media_id=${mediaId}`, {
							headers: auth
						}),
						'X の動画処理の様子'
					)
				).data.processing_info;
				if (!info || info.state === 'succeeded') return 'done';
				if (info.state === 'failed')
					throw new Error(`X の動画処理に失敗: ${info.error?.message ?? ''}`);
				return 'wait';
			});
			await ctl.save({ processed: '1' });
		}
		// 5. 投稿
		if (!ctl.state.tweetId) {
			const tweet = await readJson<{ data: { id: string } }>(
				await fetch(`${API}/tweets`, {
					method: 'POST',
					headers: { ...auth, 'content-type': 'application/json' },
					body: JSON.stringify({ text: req.text, media: { media_ids: [mediaId] } })
				}),
				'X の投稿'
			);
			await ctl.save({ tweetId: tweet.data.id });
		}
		return `https://x.com/${account.username}/status/${ctl.state.tweetId}`;
	}
};
