/**
 * 投稿ハブ（Cloudflare Worker）。
 *   公開ページ: /  /terms  /privacy  /m/:key（SNS に渡す動画）
 *   接続:      /connect/:platform?t=合言葉 → SNS の許可画面 → /connect/:platform/callback
 *   API（Bearer 合言葉）: /api/status, PUT /api/media（100 MB まで）, /api/media/multipart（大きい動画を分けて）, POST /api/jobs, GET /api/jobs, GET /api/jobs/:id, DELETE /api/jobs/:id, DELETE /api/accounts/:platform
 *   cron: 30 分ごと（日本時間 12:00〜23:30）に時刻の来た予約を投稿
 */
import { Hono } from 'hono';
import type { Env } from './env';
import { bearerToken, tokenMatches } from './auth';
import { homePage, privacyPage, resultPage, termsPage } from './pages';
import { pkceChallenge, randomToken } from './oauth';
import {
	cancelJob,
	createJob,
	deleteAccount,
	getJob,
	getMedia,
	listAccounts,
	listJobs,
	putMedia,
	putState,
	rescheduleJob,
	takeState,
	saveAccount,
	getAccount
} from './db';
import { getPublisher, HUB_PLATFORMS } from './platforms';
import { tiktokCreatorInfo, tiktokPublisher } from './platforms/tiktok';
import { cleanupMedia, HTTP_BUDGET_MS, runDue, runJobUntil, stepJob } from './scheduler';
import { hubTextError, type HubPostRequest } from '../../shared/publish';

const app = new Hono<{ Bindings: Env }>();
const MAX_MEDIA = 2 * 1024 * 1024 * 1024; // 全体（multipart で上げる）
const SINGLE_MAX = 100 * 1024 * 1024; // 1 回の HTTP で受けられる本体（Cloudflare の上限）

// ---- 公開ページ ----
app.get('/', (c) => c.html(homePage()));
// TikTok の開発者ポータルの「URL の所有確認」用の署名ファイル（ファイル名の tiktok<code>.txt を、中身 tiktok-developers-site-verification=<code> で返す）。
// code は wrangler.toml の vars TIKTOK_SITE_VERIFICATION。秘密ではない
app.get('/:file{tiktok[A-Za-z0-9_-]+\\.txt}', (c) => {
	const code = c.req.param('file').slice('tiktok'.length, -'.txt'.length);
	if (!c.env.TIKTOK_SITE_VERIFICATION || code !== c.env.TIKTOK_SITE_VERIFICATION)
		return c.text('not found', 404);
	return c.text(`tiktok-developers-site-verification=${code}`);
});
app.get('/terms', (c) => c.html(termsPage()));
app.get('/privacy', (c) => c.html(privacyPage()));

// SNS（Meta など）が動画を取りに来る。鍵は推測できない乱数で、投稿が終わると消える
app.get('/m/:key', async (c) => {
	const key = c.req.param('key');
	if (!/^[A-Za-z0-9_-]{20,}$/.test(key)) return c.notFound();
	const range = c.req.header('range');
	const obj = await c.env.MEDIA.get(key, range ? { range: c.req.raw.headers } : undefined);
	if (!obj) return c.notFound();
	const headers = new Headers();
	obj.writeHttpMetadata(headers);
	headers.set('accept-ranges', 'bytes');
	const part = range && obj.range ? rangeOf(obj.range, obj.size) : null;
	headers.set('content-length', String(part ? part.end - part.start + 1 : obj.size));
	if (part) headers.set('content-range', `bytes ${part.start}-${part.end}/${obj.size}`);
	return new Response(obj.body, { status: part ? 206 : 200, headers });
});

/** R2 の range（offset/length か suffix）を、始まりと終わりの位置に直す */
function rangeOf(r: R2Range, size: number): { start: number; end: number } {
	if ('suffix' in r && typeof r.suffix === 'number') {
		const n = Math.min(r.suffix, size);
		return { start: size - n, end: size - 1 };
	}
	const start = 'offset' in r && typeof r.offset === 'number' ? r.offset : 0;
	const length = 'length' in r && typeof r.length === 'number' ? r.length : size - start;
	return { start, end: start + length - 1 };
}

// Meta（Threads / Instagram / Facebook）の「アンインストール」「データ削除」の通知先。自分しか使わないので受け取って返事するだけ
app.post('/meta/uninstall', (c) => c.json({ ok: true }));
app.post('/meta/delete', (c) =>
	c.json({ url: `${c.env.PUBLIC_URL}/privacy`, confirmation_code: `del-${Date.now()}` })
);
app.get('/meta/delete', (c) => c.html(privacyPage()));
app.get('/meta/uninstall', (c) => c.json({ ok: true }));

// ---- 接続（ブラウザー） ----
app.get('/connect/:platform', async (c) => {
	const platform = c.req.param('platform');
	const t = c.req.query('t');
	if (!tokenMatches(t, c.env.HUB_TOKEN))
		return c.html(resultPage(false, '合言葉が違います。アプリの設定から開き直してください。'), 403);
	const publisher = getPublisher(platform);
	if (!publisher) return c.html(resultPage(false, `${platform} にはまだ対応していません。`), 404);
	const missing = publisher.missingConfig(c.env);
	if (missing) return c.html(resultPage(false, missing), 500);
	const state = randomToken(24);
	const verifier = randomToken(48);
	await putState(c.env.DB, state, publisher.platform, verifier);
	const url = publisher.authorizeUrl(c.env, state, await pkceChallenge(verifier));
	return c.redirect(url, 302);
});

app.get('/connect/:platform/callback', async (c) => {
	// 合言葉は開始時（/connect/:platform）で確かめ済み。戻りは、そのとき D1 に置いた乱数 state が合うかだけで確かめる
	// （cookie はブラウザーの設定次第で届かないことがあるので頼らない）
	const platform = c.req.param('platform');
	const publisher = getPublisher(platform);
	if (!publisher) return c.html(resultPage(false, `${platform} にはまだ対応していません。`), 404);
	const err = c.req.query('error');
	if (err)
		return c.html(resultPage(false, `${platform} 側で許可されませんでした（${err}）。`), 400);
	// Meta は code の後ろに #_ を付けて戻すことがある
	const code = c.req.query('code')?.replace(/#_$/, '');
	const state = c.req.query('state');
	if (!code || !state) return c.html(resultPage(false, 'code か state がありません。'), 400);
	const saved = await takeState(c.env.DB, state);
	if (!saved || saved.platform !== publisher.platform)
		return c.html(resultPage(false, '接続の手続きが古くなっています。やり直してください。'), 400);
	try {
		const account = await publisher.exchangeCode(c.env, code, saved.verifier);
		await saveAccount(c.env.DB, account);
		return c.html(resultPage(true, `${platform} の @${account.username} としてつながりました。`));
	} catch (e) {
		return c.html(resultPage(false, (e as Error).message), 502);
	}
});

// ---- API（アプリから。Bearer 合言葉） ----
const api = new Hono<{ Bindings: Env }>();
api.use('*', async (c, next) => {
	if (!tokenMatches(bearerToken(c.req.raw), c.env.HUB_TOKEN))
		return c.json({ error: '合言葉が違います' }, 401);
	await next();
});

api.get('/status', async (c) => {
	const accounts = await listAccounts(c.env.DB);
	return c.json({
		ok: true,
		publicUrl: c.env.PUBLIC_URL,
		platforms: HUB_PLATFORMS.map((p) => ({
			platform: p,
			configured: getPublisher(p)!.missingConfig(c.env) === null,
			account: accounts.find((a) => a.platform === p) ?? null
		}))
	});
});

// 動画を上げる。本体をそのまま R2 へ流す（multipart にはしない）
api.put('/media', async (c) => {
	const size = Number(c.req.header('content-length') ?? 0);
	const contentType = c.req.header('content-type') || 'video/mp4';
	if (!c.req.raw.body || !size)
		return c.json({ error: '本体がありません（Content-Length が必要）' }, 400);
	if (size > SINGLE_MAX)
		return c.json({ error: '1 回で上げられるのは 100 MB までです（分けて上げてください）' }, 413);
	const key = randomToken(24);
	await c.env.MEDIA.put(key, c.req.raw.body, { httpMetadata: { contentType } });
	await putMedia(c.env.DB, key, size, contentType);
	return c.json({ key, url: `${c.env.PUBLIC_URL}/m/${key}`, size });
});

// 大きい動画は分けて上げる（R2 の multipart）。始める → 片を PUT（5 MB 以上、100 MB まで、最後以外は同じ大きさ）→ 締める
api.post('/media/multipart', async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as { contentType?: string };
	const contentType = body.contentType || 'video/mp4';
	const key = randomToken(24);
	const up = await c.env.MEDIA.createMultipartUpload(key, { httpMetadata: { contentType } });
	return c.json({ key, uploadId: up.uploadId });
});
api.put('/media/multipart/:key/:uploadId/:part', async (c) => {
	const size = Number(c.req.header('content-length') ?? 0);
	const n = Number(c.req.param('part'));
	if (!c.req.raw.body || !size)
		return c.json({ error: '本体がありません（Content-Length が必要）' }, 400);
	if (size > SINGLE_MAX) return c.json({ error: '1 片は 100 MB までです' }, 413);
	if (!Number.isInteger(n) || n < 1 || n > 10000) return c.json({ error: '片の番号が変です' }, 400);
	const up = c.env.MEDIA.resumeMultipartUpload(c.req.param('key'), c.req.param('uploadId'));
	const part = await up.uploadPart(n, c.req.raw.body);
	return c.json({ partNumber: part.partNumber, etag: part.etag });
});
api.post('/media/multipart/:key/:uploadId/complete', async (c) => {
	const body = (await c.req.json().catch(() => null)) as {
		parts?: { partNumber: number; etag: string }[];
		contentType?: string;
	} | null;
	if (!body?.parts?.length) return c.json({ error: '片の一覧がありません' }, 400);
	const key = c.req.param('key');
	const up = c.env.MEDIA.resumeMultipartUpload(key, c.req.param('uploadId'));
	const obj = await up.complete(body.parts);
	if (obj.size > MAX_MEDIA) {
		await c.env.MEDIA.delete(key);
		return c.json({ error: '動画が大きすぎます（2 GB まで）' }, 413);
	}
	await putMedia(c.env.DB, key, obj.size, body.contentType || 'video/mp4');
	return c.json({ key, url: `${c.env.PUBLIC_URL}/m/${key}`, size: obj.size });
});
api.delete('/media/multipart/:key/:uploadId', async (c) => {
	const up = c.env.MEDIA.resumeMultipartUpload(c.req.param('key'), c.req.param('uploadId'));
	await up.abort().catch(() => {});
	return c.json({ aborted: true });
});

api.post('/jobs', async (c) => {
	const req = (await c.req.json().catch(() => null)) as HubPostRequest | null;
	if (!req || typeof req.mediaKey !== 'string' || typeof req.text !== 'string')
		return c.json({ error: '内容が足りません' }, 400);
	if (!getPublisher(req.platform))
		return c.json({ error: `${req.platform} にはまだ対応していません` }, 400);
	const textErr = hubTextError(req.platform, req.text);
	if (textErr) return c.json({ error: textErr }, 400);
	if (!(await getMedia(c.env.DB, req.mediaKey)))
		return c.json({ error: '動画が見つかりません。先に上げてください' }, 400);
	const when = req.scheduledAt ? Date.parse(req.scheduledAt) : Date.now();
	if (Number.isNaN(when)) return c.json({ error: '日時が読めません' }, 400);
	const job = await createJob(c.env.DB, randomToken(12), req, Math.max(when, Date.now()));
	// すぐの投稿は cron を待たずに取りかかる（返事はすぐ返し、裏で進められるところまで進める。続きはアプリの /run か cron）
	if (!req.scheduledAt) c.executionCtx.waitUntil(runJobUntil(c.env, job.id, HTTP_BUDGET_MS));
	return c.json(job, 201);
});

api.get('/jobs', async (c) => c.json(await listJobs(c.env.DB)));
api.get('/jobs/:id', async (c) => {
	const job = await getJob(c.env.DB, c.req.param('id'));
	return job ? c.json(job) : c.json({ error: '無い' }, 404);
});
// 続きを進める（時間の許すところまで）。アプリが終わるまで繰り返し呼ぶ
api.post('/jobs/:id/run', async (c) => {
	const job = await getJob(c.env.DB, c.req.param('id'));
	if (!job) return c.json({ error: '無い' }, 404);
	if (job.status === 'queued' || job.status === 'running') {
		// 途中の仕事（running）はいつでも続きを。queued は時刻が来てから
		if (job.status === 'running' || Date.parse(job.scheduledAt) <= Date.now())
			await stepJob(c.env, job.id, HTTP_BUDGET_MS);
	}
	return c.json(await getJob(c.env.DB, job.id));
});
// 1 歩だけ進める（cron が SELF 経由で呼ぶ。返事は進み具合）
api.post('/jobs/:id/step', async (c) => {
	const job = await getJob(c.env.DB, c.req.param('id'));
	if (!job) return c.json({ error: '無い' }, 404);
	const result = await stepJob(c.env, job.id, HTTP_BUDGET_MS);
	return c.json({ result });
});
// 予約の日時を変える（queued のものだけ）
api.patch('/jobs/:id', async (c) => {
	const body = (await c.req.json().catch(() => null)) as { scheduledAt?: string } | null;
	const when = body?.scheduledAt ? Date.parse(body.scheduledAt) : NaN;
	if (Number.isNaN(when)) return c.json({ error: '日時が読めません' }, 400);
	const ok = await rescheduleJob(c.env.DB, c.req.param('id'), Math.max(when, Date.now()));
	if (!ok) return c.json({ error: 'もう取りかかっているか、無い予約です' }, 409);
	return c.json(await getJob(c.env.DB, c.req.param('id')));
});
api.delete('/jobs/:id', async (c) => {
	const job = await getJob(c.env.DB, c.req.param('id'));
	if (!job) return c.json({ error: '無い' }, 404);
	const ok = await cancelJob(c.env.DB, job.id);
	if (ok) await cleanupMedia(c.env, job.mediaKey);
	return c.json({ canceled: ok });
});
api.delete('/accounts/:platform', async (c) => {
	await deleteAccount(c.env.DB, c.req.param('platform') as HubPostRequest['platform']);
	return c.json({ ok: true });
});
// TikTok の投稿者の情報（画面で公開範囲などを選ばせるために、投稿の前に出す決まり）
let creatorCache: { user: string; at: number; info: unknown } | null = null;
api.get('/tiktok/creator', async (c) => {
	const stored = await getAccount(c.env.DB, 'tiktok');
	if (!stored) return c.json({ error: 'TikTok がつながっていません' }, 400);
	// TikTok の creator_info は 1 分 20 回まで。同じ isolate の間は 2 分覚えて、読みすぎない
	if (
		creatorCache &&
		creatorCache.user === stored.user_id &&
		Date.now() - creatorCache.at < 120_000
	)
		return c.json(creatorCache.info);
	const account = await tiktokPublisher.freshAccount(c.env, stored);
	if (account.access_token !== stored.access_token) await saveAccount(c.env.DB, account);
	const info = await tiktokCreatorInfo(c.env, account.access_token);
	creatorCache = { user: stored.user_id, at: Date.now(), info };
	return c.json(info);
});
// 手で cron 相当を回す（確認用）
api.post('/run', async (c) => c.json({ ran: await runDue(c.env) }));

app.route('/api', api);

export default {
	fetch: app.fetch,
	async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		ctx.waitUntil(runDue(env));
	}
} satisfies ExportedHandler<Env>;
