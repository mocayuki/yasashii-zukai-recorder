/**
 * TikTok。Login Kit（OAuth 2.0 + PKCE）と Content Posting API の Direct Post（動画を片に分けて送る FILE_UPLOAD）。
 * 審査前（Sandbox / 未監査）のアプリは、投稿の公開範囲が「自分だけ（SELF_ONLY）」に限られる。
 * 審査が通ったら PRIVACY を 'PUBLIC_TO_EVERYONE' にする（creator_info の privacy_level_options にあるものだけ選べる）
 */
import type { TikTokCreatorInfo, TikTokPrivacy } from '../../../shared/publish';
import type { Env } from '../env';
import type { AccountRow } from '../db';
import { readJson, redirectUri, waitUntilDone, type JobControl, type Publisher } from './types';

const SCOPES = ['user.info.basic', 'video.publish'];
const API = 'https://open.tiktokapis.com/v2';
/** 1 片の大きさ（5 MB 以上 64 MB 以下。最後の片は余りを足すので最大でこの 2 倍弱） */
const CHUNK = 10 * 1024 * 1024;
/** 審査前は、投稿者が何を選んでも SELF_ONLY でしか投稿できない（unaudited_client_can_only_post_to_private_accounts） */
const DEFAULT_PRIVACY = 'SELF_ONLY';

interface TikTokError {
	code: string;
	message?: string;
	log_id?: string;
}

/** TikTok の返事は HTTP 200 でも error.code が 'ok' 以外ならしくじり */
async function readTikTok<T>(res: Response, what: string): Promise<T> {
	const j = await readJson<T & { error?: TikTokError }>(res, what);
	if (j.error && j.error.code !== 'ok')
		throw new Error(`${what}: ${j.error.code} ${j.error.message ?? ''}`.trim());
	return j;
}

interface TokenResponse {
	access_token: string;
	refresh_token?: string;
	expires_in?: number;
	open_id: string;
	scope?: string;
}

async function tokenRequest(env: Env, params: Record<string, string>): Promise<TokenResponse> {
	const res = await fetch(`${API}/oauth/token/`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_key: env.TIKTOK_CLIENT_KEY!,
			client_secret: env.TIKTOK_CLIENT_SECRET!,
			...params
		})
	});
	const j = await readJson<TokenResponse & { error?: string; error_description?: string }>(
		res,
		'TikTok のトークン'
	);
	if (j.error) throw new Error(`TikTok のトークン: ${j.error} ${j.error_description ?? ''}`);
	return j;
}

interface CreatorInfo {
	creator_username?: string;
	creator_nickname?: string;
	creator_avatar_url?: string;
	privacy_level_options?: string[];
	comment_disabled?: boolean;
	duet_disabled?: boolean;
	stitch_disabled?: boolean;
	max_video_post_duration_sec?: number;
}

/** 投稿者の情報（ユーザー名、選べる公開範囲、動画の長さの上限）。投稿の前に必ず聞く決まり */
async function creatorInfo(token: string): Promise<CreatorInfo> {
	const j = await readTikTok<{ data?: CreatorInfo }>(
		await fetch(`${API}/post/publish/creator_info/query/`, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${token}`,
				'content-type': 'application/json; charset=UTF-8'
			}
		}),
		'TikTok の投稿者の情報'
	);
	return j.data ?? {};
}

/** 投稿者の情報を、アプリの画面用の形で返す（GET /api/tiktok/creator） */
export async function tiktokCreatorInfo(env: Env, token: string): Promise<TikTokCreatorInfo> {
	const info = await creatorInfo(token);
	return {
		audited: env.TIKTOK_AUDITED === '1',
		nickname: info.creator_nickname ?? info.creator_username ?? '',
		avatarUrl: info.creator_avatar_url ?? null,
		privacyOptions: (info.privacy_level_options ?? []) as TikTokPrivacy[],
		commentDisabled: !!info.comment_disabled,
		duetDisabled: !!info.duet_disabled,
		stitchDisabled: !!info.stitch_disabled,
		maxDurationSec: info.max_video_post_duration_sec ?? null
	};
}

export const tiktokPublisher: Publisher = {
	platform: 'tiktok',
	missingConfig(env) {
		if (!env.TIKTOK_CLIENT_KEY || !env.TIKTOK_CLIENT_SECRET)
			return 'TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET が設定されていません（wrangler secret put …）';
		return null;
	},
	authorizeUrl(env, state, challenge) {
		const u = new URL('https://www.tiktok.com/v2/auth/authorize/');
		u.searchParams.set('client_key', env.TIKTOK_CLIENT_KEY!);
		u.searchParams.set('scope', SCOPES.join(','));
		u.searchParams.set('response_type', 'code');
		u.searchParams.set('redirect_uri', redirectUri(env, 'tiktok'));
		u.searchParams.set('state', state);
		u.searchParams.set('code_challenge', challenge);
		u.searchParams.set('code_challenge_method', 'S256');
		return u.toString();
	},
	async exchangeCode(env, code, verifier) {
		const t = await tokenRequest(env, {
			grant_type: 'authorization_code',
			code,
			redirect_uri: redirectUri(env, 'tiktok'),
			code_verifier: verifier
		});
		// ユーザー名は creator_info から（user.info.basic には表示名しか無い）
		let username = '';
		try {
			const info = await creatorInfo(t.access_token);
			username = info.creator_username ?? info.creator_nickname ?? '';
		} catch {
			/* 名前が取れなくてもつなぐ */
		}
		if (!username) {
			const u = await readTikTok<{ data: { user: { display_name?: string } } }>(
				await fetch(`${API}/user/info/?fields=open_id,display_name`, {
					headers: { authorization: `Bearer ${t.access_token}` }
				}),
				'TikTok のアカウント'
			);
			username = u.data.user.display_name ?? t.open_id;
		}
		return {
			platform: 'tiktok',
			user_id: t.open_id,
			username,
			access_token: t.access_token,
			refresh_token: t.refresh_token ?? null,
			expires_at: t.expires_in ? Date.now() + t.expires_in * 1000 : null
		};
	},
	async freshAccount(env, account) {
		// アクセストークンは 24 時間、refresh_token は 1 年。10 分前になったら取り直す
		if (!account.expires_at || account.expires_at > Date.now() + 10 * 60_000) return account;
		if (!account.refresh_token)
			throw new Error('TikTok の接続が切れています。つなぎ直してください');
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
		const json = { ...auth, 'content-type': 'application/json; charset=UTF-8' };
		// 1. 初期化（公開範囲を確かめてから。publish_id と upload_url を保存）
		if (!ctl.state.publishId) {
			const info = await creatorInfo(account.access_token);
			// 公開範囲は投稿者がアプリで選んだもの。ただし審査前は SELF_ONLY 固定。選べるものの中に無ければ SELF_ONLY
			const opts = req.tiktok;
			const options = info.privacy_level_options ?? [];
			const wanted =
				env.TIKTOK_AUDITED === '1' ? opts?.privacy || DEFAULT_PRIVACY : DEFAULT_PRIVACY;
			const privacy = options.includes(wanted) ? wanted : DEFAULT_PRIVACY;
			// 片の数: 5 MB 未満は 1 片。それ以外は CHUNK ごとに切り、余りは最後の片に足す（TikTok の決まり）
			const chunkSize = media.size < CHUNK ? media.size : CHUNK;
			const count = Math.max(1, Math.floor(media.size / chunkSize));
			const init = await readTikTok<{ data: { publish_id: string; upload_url: string } }>(
				await fetch(`${API}/post/publish/video/init/`, {
					method: 'POST',
					headers: json,
					body: JSON.stringify({
						post_info: {
							title: (req.title || req.text).slice(0, 2200),
							privacy_level: privacy,
							// 投稿者の設定で止めてあるものは、アプリで許可していても止める
							disable_comment: !!info.comment_disabled || !(opts?.allowComment ?? true),
							disable_duet: !!info.duet_disabled || !(opts?.allowDuet ?? true),
							disable_stitch: !!info.stitch_disabled || !(opts?.allowStitch ?? true),
							video_cover_timestamp_ms: 1000,
							// 宣伝の申告（宣伝を含むときだけ）
							...(opts?.commercial
								? {
										brand_organic_toggle: !!opts.brandOrganic,
										brand_content_toggle: !!opts.brandContent
									}
								: {})
						},
						source_info: {
							source: 'FILE_UPLOAD',
							video_size: media.size,
							chunk_size: chunkSize,
							total_chunk_count: count
						}
					})
				}),
				'TikTok の投稿（初期化）'
			);
			await ctl.save({
				publishId: init.data.publish_id,
				uploadUrl: init.data.upload_url,
				chunkSize: String(chunkSize),
				count: String(count),
				sent: '0',
				privacy
			});
		}
		// 2. 片を送る（R2 から範囲で読む。送った片の数を保存）
		const chunkSize = Number(ctl.state.chunkSize);
		const count = Number(ctl.state.count);
		for (let i = Number(ctl.state.sent ?? 0); i < count; i++) {
			ctl.checkTime();
			const offset = i * chunkSize;
			const end = i === count - 1 ? media.size : offset + chunkSize; // 最後の片は終わりまで
			const length = end - offset;
			const obj = await env.MEDIA.get(media.key, { range: { offset, length } });
			if (!obj) throw new Error('動画がハブに見つかりません');
			const res = await fetch(ctl.state.uploadUrl, {
				method: 'PUT',
				headers: {
					'content-type': media.contentType || 'video/mp4',
					'content-length': String(length),
					'content-range': `bytes ${offset}-${end - 1}/${media.size}`
				},
				body: await obj.arrayBuffer()
			});
			if (!res.ok && res.status !== 206)
				throw new Error(
					`TikTok の動画アップロード（${i + 1}/${count} 片目）: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`
				);
			await ctl.save({ sent: String(i + 1) });
		}
		// 3. 処理が終わるまで待つ
		const publishId = ctl.state.publishId;
		if (!ctl.state.postId) {
			let postId = '';
			await waitUntilDone(
				ctl,
				async () => {
					const st = await readTikTok<{
						data: {
							status: string;
							fail_reason?: string;
							publicaly_available_post_id?: (string | number)[];
						};
					}>(
						await fetch(`${API}/post/publish/status/fetch/`, {
							method: 'POST',
							headers: json,
							body: JSON.stringify({ publish_id: publishId })
						}),
						'TikTok の投稿の様子'
					);
					const s = st.data.status;
					if (s === 'PUBLISH_COMPLETE') {
						postId = String(st.data.publicaly_available_post_id?.[0] ?? '');
						return 'done';
					}
					if (s === 'FAILED') throw new Error(`TikTok の投稿に失敗: ${st.data.fail_reason ?? ''}`);
					return 'wait';
				},
				5000
			);
			await ctl.save({ postId: postId || '-' });
		}
		const postId = ctl.state.postId;
		const user = account.username ? `@${account.username}` : '';
		return postId && postId !== '-'
			? `https://www.tiktok.com/${user || '@'}/video/${postId}`
			: `https://www.tiktok.com/${user}`;
	}
};
