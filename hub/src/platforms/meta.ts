/**
 * Meta の 3 つ（Threads・Instagram・Facebook ページ）。共通: OAuth は code 方式（PKCE なし、state のみ）、
 * 動画は「公開 URL を渡す → 器（container）ができるのを待つ → 公開」。ハブの /m/:key が公開 URL になる
 */
import type { HubPostRequest } from '../../../shared/publish';
import type { Env } from '../env';
import type { AccountRow } from '../db';
import { readJson, redirectUri, waitUntilDone, type JobControl, type Publisher } from './types';

const GRAPH = 'v21.0';
/** Threads の Graph は v1.0 のまま */
const TH_V = 'v1.0';

function form(params: Record<string, string>): RequestInit {
	return {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams(params)
	};
}

function q(base: string, params: Record<string, string>): string {
	const u = new URL(base);
	for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
	return u.toString();
}

/** 器（container）の処理が終わるまで待つ。Threads は status、Instagram は status_code。時間切れは Yield */
async function waitContainer(
	ctl: JobControl,
	url: (fields: string) => string,
	field: 'status' | 'status_code',
	what: string
) {
	await waitUntilDone(ctl, async () => {
		const j = await readJson<Record<string, string> & { error_message?: string }>(
			await fetch(url(`${field},error_message`)),
			`${what}の処理の様子`
		);
		const st = j[field];
		if (st === 'FINISHED') return 'done';
		if (st === 'ERROR' || st === 'EXPIRED')
			throw new Error(`${what}の処理に失敗: ${j.error_message ?? st}`);
		return 'wait';
	});
}

/** 長期トークンの残りが 7 日を切ったら更新する（Threads / Instagram）。更新の URL だけが違う */
function refreshIfNeeded(refreshUrl: (token: string) => string, what: string) {
	return async (_env: Env, account: AccountRow): Promise<AccountRow> => {
		if (!account.expires_at || account.expires_at > Date.now() + 7 * 24 * 60 * 60_000)
			return account;
		const j = await readJson<{ access_token: string; expires_in: number }>(
			await fetch(refreshUrl(account.access_token)),
			`${what}のトークン更新`
		);
		return {
			...account,
			access_token: j.access_token,
			expires_at: Date.now() + j.expires_in * 1000
		};
	};
}

// ---------------- Threads ----------------
const TH = 'https://graph.threads.net';

export const threadsPublisher: Publisher = {
	platform: 'threads',
	missingConfig(env) {
		return env.THREADS_APP_ID && env.THREADS_APP_SECRET
			? null
			: 'THREADS_APP_ID / THREADS_APP_SECRET が設定されていません';
	},
	authorizeUrl(env, state) {
		return q('https://threads.net/oauth/authorize', {
			client_id: env.THREADS_APP_ID!,
			redirect_uri: redirectUri(env, 'threads'),
			scope: 'threads_basic,threads_content_publish',
			response_type: 'code',
			state
		});
	},
	async exchangeCode(env, code) {
		const short = await readJson<{ access_token: string; user_id: string | number }>(
			await fetch(
				`${TH}/oauth/access_token`,
				form({
					client_id: env.THREADS_APP_ID!,
					client_secret: env.THREADS_APP_SECRET!,
					grant_type: 'authorization_code',
					redirect_uri: redirectUri(env, 'threads'),
					code
				})
			),
			'Threads のトークン'
		);
		const long = await readJson<{ access_token: string; expires_in: number }>(
			await fetch(
				q(`${TH}/access_token`, {
					grant_type: 'th_exchange_token',
					client_secret: env.THREADS_APP_SECRET!,
					access_token: short.access_token
				})
			),
			'Threads の長期トークン'
		);
		const me = await readJson<{ id: string; username: string }>(
			await fetch(
				q(`${TH}/${TH_V}/me`, { fields: 'id,username', access_token: long.access_token })
			),
			'Threads のアカウント'
		);
		return {
			platform: 'threads',
			user_id: me.id,
			username: me.username,
			access_token: long.access_token,
			refresh_token: null,
			expires_at: Date.now() + long.expires_in * 1000
		};
	},
	freshAccount: refreshIfNeeded(
		(t) => q(`${TH}/refresh_access_token`, { grant_type: 'th_refresh_token', access_token: t }),
		'Threads'
	),
	async post(env, account, req, media, ctl) {
		const videoUrl = `${env.PUBLIC_URL}/m/${media.key}`;
		const token = account.access_token;
		if (!ctl.state.container) {
			const container = await readJson<{ id: string }>(
				await fetch(
					`${TH}/${TH_V}/${account.user_id}/threads`,
					form({
						media_type: 'VIDEO',
						video_url: videoUrl,
						text: req.text,
						...(req.topic ? { topic_tag: req.topic } : {}),
						access_token: token
					})
				),
				'Threads の器づくり'
			);
			await ctl.save({ container: container.id });
		}
		if (!ctl.state.postId) {
			await waitContainer(
				ctl,
				(f) => q(`${TH}/${TH_V}/${ctl.state.container}`, { fields: f, access_token: token }),
				'status',
				'Threads の動画'
			);
			const published = await readJson<{ id: string }>(
				await fetch(
					`${TH}/${TH_V}/${account.user_id}/threads_publish`,
					form({ creation_id: ctl.state.container, access_token: token })
				),
				'Threads の公開'
			);
			await ctl.save({ postId: published.id });
		}
		const info = await readJson<{ permalink?: string }>(
			await fetch(
				q(`${TH}/${TH_V}/${ctl.state.postId}`, { fields: 'permalink', access_token: token })
			),
			'Threads の URL'
		).catch(() => ({ permalink: undefined }));
		return info.permalink ?? `https://www.threads.net/@${account.username}`;
	}
};

// ---------------- Instagram（Instagram ログイン方式） ----------------
const IG = 'https://graph.instagram.com';

export const instagramPublisher: Publisher = {
	platform: 'instagram',
	missingConfig(env) {
		return env.IG_APP_ID && env.IG_APP_SECRET
			? null
			: 'IG_APP_ID / IG_APP_SECRET が設定されていません';
	},
	authorizeUrl(env, state) {
		return q('https://www.instagram.com/oauth/authorize', {
			client_id: env.IG_APP_ID!,
			redirect_uri: redirectUri(env, 'instagram'),
			scope: 'instagram_business_basic,instagram_business_content_publish',
			response_type: 'code',
			state
		});
	},
	async exchangeCode(env, code) {
		const short = await readJson<{ access_token: string; user_id: string | number }>(
			await fetch(
				'https://api.instagram.com/oauth/access_token',
				form({
					client_id: env.IG_APP_ID!,
					client_secret: env.IG_APP_SECRET!,
					grant_type: 'authorization_code',
					redirect_uri: redirectUri(env, 'instagram'),
					code
				})
			),
			'Instagram のトークン'
		);
		const long = await readJson<{ access_token: string; expires_in: number }>(
			await fetch(
				q(`${IG}/access_token`, {
					grant_type: 'ig_exchange_token',
					client_secret: env.IG_APP_SECRET!,
					access_token: short.access_token
				})
			),
			'Instagram の長期トークン'
		);
		const me = await readJson<{ user_id: string; username: string }>(
			await fetch(
				q(`${IG}/${GRAPH}/me`, { fields: 'user_id,username', access_token: long.access_token })
			),
			'Instagram のアカウント'
		);
		return {
			platform: 'instagram',
			user_id: String(me.user_id),
			username: me.username,
			access_token: long.access_token,
			refresh_token: null,
			expires_at: Date.now() + long.expires_in * 1000
		};
	},
	freshAccount: refreshIfNeeded(
		(t) => q(`${IG}/refresh_access_token`, { grant_type: 'ig_refresh_token', access_token: t }),
		'Instagram'
	),
	async post(env, account, req, media, ctl) {
		// リール。横の動画はアプリ側で 9:16 の帯付きにしてから上がってくる
		const videoUrl = `${env.PUBLIC_URL}/m/${media.key}`;
		const token = account.access_token;
		if (!ctl.state.container) {
			const container = await readJson<{ id: string }>(
				await fetch(
					`${IG}/${GRAPH}/${account.user_id}/media`,
					form({
						media_type: 'REELS',
						video_url: videoUrl,
						caption: req.text,
						share_to_feed: 'true',
						access_token: token
					})
				),
				'Instagram の器づくり'
			);
			await ctl.save({ container: container.id });
		}
		if (!ctl.state.postId) {
			await waitContainer(
				ctl,
				(f) => q(`${IG}/${GRAPH}/${ctl.state.container}`, { fields: f, access_token: token }),
				'status_code',
				'Instagram の動画'
			);
			const published = await readJson<{ id: string }>(
				await fetch(
					`${IG}/${GRAPH}/${account.user_id}/media_publish`,
					form({ creation_id: ctl.state.container, access_token: token })
				),
				'Instagram の公開'
			);
			await ctl.save({ postId: published.id });
		}
		const info = await readJson<{ permalink?: string }>(
			await fetch(
				q(`${IG}/${GRAPH}/${ctl.state.postId}`, { fields: 'permalink', access_token: token })
			),
			'Instagram の URL'
		).catch(() => ({ permalink: undefined }));
		return info.permalink ?? `https://www.instagram.com/${account.username}/`;
	}
};

// ---------------- Facebook ページ ----------------
const FB = 'https://graph.facebook.com';

export const facebookPublisher: Publisher = {
	platform: 'facebook',
	missingConfig(env) {
		return env.FB_APP_ID && env.FB_APP_SECRET
			? null
			: 'FB_APP_ID / FB_APP_SECRET が設定されていません';
	},
	authorizeUrl(env, state) {
		return q(`https://www.facebook.com/${GRAPH}/dialog/oauth`, {
			client_id: env.FB_APP_ID!,
			redirect_uri: redirectUri(env, 'facebook'),
			scope: 'pages_show_list,pages_manage_posts,pages_read_engagement',
			response_type: 'code',
			state
		});
	},
	async exchangeCode(env, code) {
		const user = await readJson<{ access_token: string }>(
			await fetch(
				q(`${FB}/${GRAPH}/oauth/access_token`, {
					client_id: env.FB_APP_ID!,
					client_secret: env.FB_APP_SECRET!,
					redirect_uri: redirectUri(env, 'facebook'),
					code
				})
			),
			'Facebook のトークン'
		);
		const long = await readJson<{ access_token: string }>(
			await fetch(
				q(`${FB}/${GRAPH}/oauth/access_token`, {
					grant_type: 'fb_exchange_token',
					client_id: env.FB_APP_ID!,
					client_secret: env.FB_APP_SECRET!,
					fb_exchange_token: user.access_token
				})
			),
			'Facebook の長期トークン'
		);
		// 管理しているページの一覧。FB_PAGE_ID があればそれ、無ければ名前に「図解」を含むもの、それも無ければ最初のもの
		const pages = await readJson<{
			data: Array<{ id: string; name: string; access_token: string }>;
		}>(
			await fetch(
				q(`${FB}/${GRAPH}/me/accounts`, {
					fields: 'id,name,access_token',
					access_token: long.access_token
				})
			),
			'Facebook のページ一覧'
		);
		const page =
			pages.data.find((p) => env.FB_PAGE_ID && p.id === env.FB_PAGE_ID) ??
			pages.data.find((p) => /図解/.test(p.name)) ??
			pages.data[0];
		if (!page)
			throw new Error(
				'管理している Facebook ページが見つかりません。許可の画面でページを選んでください'
			);
		// ページのトークンは（長期のユーザートークンから取ると）切れない
		return {
			platform: 'facebook',
			user_id: page.id,
			username: page.name,
			access_token: page.access_token,
			refresh_token: null,
			expires_at: null
		};
	},
	async freshAccount(_env, account) {
		return account;
	},
	async post(env, account, req, media, ctl) {
		const videoUrl = `${env.PUBLIC_URL}/m/${media.key}`;
		const token = account.access_token;
		if (!ctl.state.videoId) {
			const video = await readJson<{ id: string }>(
				await fetch(
					`https://graph-video.facebook.com/${GRAPH}/${account.user_id}/videos`,
					form({ file_url: videoUrl, description: req.text, access_token: token })
				),
				'Facebook の動画投稿'
			);
			await ctl.save({ videoId: video.id });
		}
		// Facebook は URL から裏で取りに来る。取り終わって処理が済むまで待ってから動画を消す
		if (ctl.state.ready !== '1') {
			await waitUntilDone(ctl, async () => {
				const j = await readJson<{
					status?: {
						video_status?: string;
						processing_phase?: { status?: string; errors?: Array<{ message?: string }> };
					};
				}>(
					await fetch(
						q(`${FB}/${GRAPH}/${ctl.state.videoId}`, { fields: 'status', access_token: token })
					),
					'Facebook の動画処理の様子'
				);
				const st = j.status?.video_status;
				if (st === 'ready') return 'done';
				if (st === 'error')
					throw new Error(
						`Facebook の動画処理に失敗: ${j.status?.processing_phase?.errors?.[0]?.message ?? ''}`
					);
				return 'wait';
			});
			await ctl.save({ ready: '1' });
		}
		return `https://www.facebook.com/${account.user_id}/videos/${ctl.state.videoId}`;
	}
};
