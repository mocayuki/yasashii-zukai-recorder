import type {
	HubAccount,
	HubJob,
	HubJobStatus,
	HubPlatform,
	HubPostRequest
} from '../../shared/publish';
import type { Env } from './env';
import { decryptToken, encryptToken, isEncrypted, tokenKey } from './crypto';

/** アカウントの読み書きに要るもの: D1 と、トークンを暗号化する鍵（TOKEN_KEY） */
export type AccountStore = Pick<Env, 'DB' | 'TOKEN_KEY'>;

/** accounts の 1 行。access_token / refresh_token は D1 の中では暗号化（crypto.ts の enc1:…）、この型の上では平文 */
export interface AccountRow {
	platform: HubPlatform;
	user_id: string;
	username: string;
	access_token: string;
	refresh_token: string | null;
	expires_at: number | null;
	updated_at: number;
}

interface JobRow {
	id: string;
	platform: HubPlatform;
	media_key: string;
	payload: string;
	scheduled_at: number;
	status: HubJobStatus;
	attempts: number;
	error: string | null;
	result_url: string | null;
	created_at: number;
	updated_at: number;
	state: string | null;
	lease_until: number | null;
}

export const MAX_ATTEMPTS = 3;
/** 取りかかりの期限。これを過ぎても running のままなら、途中で切られたとみなして続きをやる */
export const LEASE_MS = 90_000;

export function toJob(r: JobRow): HubJob {
	const payload = JSON.parse(r.payload) as HubPostRequest;
	return {
		id: r.id,
		platform: r.platform,
		ref: payload.ref,
		status: r.status,
		text: payload.text,
		mediaKey: r.media_key,
		scheduledAt: new Date(r.scheduled_at).toISOString(),
		attempts: r.attempts,
		error: r.error ?? undefined,
		resultUrl: r.result_url ?? undefined,
		createdAt: new Date(r.created_at).toISOString(),
		updatedAt: new Date(r.updated_at).toISOString()
	};
}

/**
 * 読んで、トークンを復号して返す（返す行のトークンは平文。呼ぶ側はそのまま SNS に渡し、平文どうしで比べる）。
 * 暗号化より前に入れた平文の行を読んだときは、そのまま使い、暗号化して書き戻す（読んだときに直す。表の形は変えない）
 */
export async function getAccount(
	env: AccountStore,
	platform: HubPlatform
): Promise<AccountRow | null> {
	const key = await tokenKey(env);
	const row = await env.DB.prepare('SELECT * FROM accounts WHERE platform = ?')
		.bind(platform)
		.first<AccountRow>();
	if (!row) return null;
	const open = (s: string) => (isEncrypted(s) ? decryptToken(key, s) : Promise.resolve(s));
	const plain: AccountRow = {
		...row,
		access_token: await open(row.access_token),
		refresh_token: row.refresh_token === null ? null : await open(row.refresh_token)
	};
	const stillPlain =
		!isEncrypted(row.access_token) ||
		(row.refresh_token !== null && !isEncrypted(row.refresh_token));
	if (stillPlain) {
		// 書き戻すのは、読んだときの値のままの行だけ（その間に別の呼び出しが新しいトークンを入れていたら、そちらを残す）。
		// updated_at は触らない（つないだ・更新した時刻のままにする）
		await env.DB.prepare(
			'UPDATE accounts SET access_token = ?, refresh_token = ? WHERE platform = ? AND access_token = ?'
		)
			.bind(
				await encryptToken(key, plain.access_token),
				plain.refresh_token === null ? null : await encryptToken(key, plain.refresh_token),
				platform,
				row.access_token
			)
			.run();
	}
	return plain;
}

/** 入れる（トークンは暗号化してから）。row は平文のまま変えない */
export async function saveAccount(
	env: AccountStore,
	row: Omit<AccountRow, 'updated_at'>
): Promise<void> {
	const key = await tokenKey(env);
	const access = await encryptToken(key, row.access_token);
	const refresh = row.refresh_token === null ? null : await encryptToken(key, row.refresh_token);
	await env.DB.prepare(
		`INSERT INTO accounts (platform, user_id, username, access_token, refresh_token, expires_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(platform) DO UPDATE SET user_id = excluded.user_id, username = excluded.username,
			   access_token = excluded.access_token, refresh_token = excluded.refresh_token,
			   expires_at = excluded.expires_at, updated_at = excluded.updated_at`
	)
		.bind(row.platform, row.user_id, row.username, access, refresh, row.expires_at, Date.now())
		.run();
}

export async function deleteAccount(db: D1Database, platform: HubPlatform): Promise<void> {
	await db.prepare('DELETE FROM accounts WHERE platform = ?').bind(platform).run();
}

export async function listAccounts(db: D1Database): Promise<HubAccount[]> {
	const { results } = await db
		.prepare('SELECT platform, username, updated_at FROM accounts')
		.all<{ platform: HubPlatform; username: string; updated_at: number }>();
	return results.map((r) => ({
		platform: r.platform,
		username: r.username,
		updatedAt: new Date(r.updated_at).toISOString()
	}));
}

export async function putState(
	db: D1Database,
	state: string,
	platform: HubPlatform,
	verifier: string
) {
	await db
		.prepare('INSERT INTO oauth_states (state, platform, verifier, created_at) VALUES (?, ?, ?, ?)')
		.bind(state, platform, verifier, Date.now())
		.run();
}

/** 使ったら消す。10 分より古いものは無効 */
export async function takeState(
	db: D1Database,
	state: string
): Promise<{ platform: HubPlatform; verifier: string } | null> {
	const row = await db
		.prepare('SELECT platform, verifier, created_at FROM oauth_states WHERE state = ?')
		.bind(state)
		.first<{ platform: HubPlatform; verifier: string; created_at: number }>();
	await db
		.prepare('DELETE FROM oauth_states WHERE state = ? OR created_at < ?')
		.bind(state, Date.now() - 10 * 60_000)
		.run();
	if (!row || row.created_at < Date.now() - 10 * 60_000) return null;
	return { platform: row.platform, verifier: row.verifier };
}

export async function putMedia(db: D1Database, key: string, size: number, contentType: string) {
	await db
		.prepare(
			'INSERT OR REPLACE INTO media (key, size, content_type, created_at) VALUES (?, ?, ?, ?)'
		)
		.bind(key, size, contentType, Date.now())
		.run();
}

export async function getMedia(db: D1Database, key: string) {
	return (
		(await db
			.prepare('SELECT key, size, content_type, created_at FROM media WHERE key = ?')
			.bind(key)
			.first<{ key: string; size: number; content_type: string; created_at: number }>()) ?? null
	);
}

export async function createJob(
	db: D1Database,
	id: string,
	req: HubPostRequest,
	scheduledAt: number
): Promise<HubJob> {
	const now = Date.now();
	await db
		.prepare(
			`INSERT INTO jobs (id, platform, media_key, payload, scheduled_at, status, attempts, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?)`
		)
		.bind(id, req.platform, req.mediaKey, JSON.stringify(req), scheduledAt, now, now)
		.run();
	return (await getJob(db, id))!;
}

export async function getJob(db: D1Database, id: string): Promise<HubJob | null> {
	const row = await db.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first<JobRow>();
	return row ? toJob(row) : null;
}

export async function getJobPayload(db: D1Database, id: string): Promise<HubPostRequest | null> {
	const row = await db
		.prepare('SELECT payload FROM jobs WHERE id = ?')
		.bind(id)
		.first<{ payload: string }>();
	return row ? (JSON.parse(row.payload) as HubPostRequest) : null;
}

export async function listJobs(db: D1Database, limit = 50): Promise<HubJob[]> {
	const { results } = await db
		.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?')
		.bind(limit)
		.all<JobRow>();
	return results.map(toJob);
}

/** 予約の日時を変える（まだ取りかかっていない queued だけ） */
export async function rescheduleJob(db: D1Database, id: string, when: number): Promise<boolean> {
	const r = await db
		.prepare(`UPDATE jobs SET scheduled_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'`)
		.bind(when, Date.now(), id)
		.run();
	return (r.meta.changes ?? 0) > 0;
}

export async function cancelJob(db: D1Database, id: string): Promise<boolean> {
	const r = await db
		.prepare(
			`UPDATE jobs SET status = 'canceled', updated_at = ? WHERE id = ? AND status = 'queued'`
		)
		.bind(Date.now(), id)
		.run();
	return (r.meta.changes ?? 0) > 0;
}

/**
 * いま取りかかれる仕事の id: 時刻の来た queued と、期限切れの running（途中で切られたもの）。
 * 取りかかるときは claimJob で 1 件ずつ押さえる（cron とアプリが重なっても二重にはやらない）
 */
export async function dueJobIds(db: D1Database, now: number, limit = 5): Promise<string[]> {
	const { results } = await db
		.prepare(
			`SELECT id FROM jobs
			 WHERE (status = 'queued' AND scheduled_at <= ?) OR (status = 'running' AND COALESCE(lease_until, 0) < ?)
			 ORDER BY scheduled_at LIMIT ?`
		)
		.bind(now, now, limit)
		.all<{ id: string }>();
	return results.map((r) => r.id);
}

/** 押さえる。queued なら回数を 1 増やす。running（期限切れ）なら続きなので増やさない */
export async function claimJob(db: D1Database, id: string, now: number): Promise<boolean> {
	const r = await db
		.prepare(
			`UPDATE jobs SET
			   attempts = CASE WHEN status = 'queued' THEN attempts + 1 ELSE attempts END,
			   status = 'running', lease_until = ?, updated_at = ?
			 WHERE id = ? AND (status = 'queued' OR (status = 'running' AND COALESCE(lease_until, 0) < ?))`
		)
		.bind(now + LEASE_MS, now, id, now)
		.run();
	return (r.meta.changes ?? 0) > 0;
}

export async function getJobState(db: D1Database, id: string): Promise<Record<string, string>> {
	const row = await db
		.prepare('SELECT state FROM jobs WHERE id = ?')
		.bind(id)
		.first<{ state: string | null }>();
	try {
		return row?.state ? (JSON.parse(row.state) as Record<string, string>) : {};
	} catch {
		return {};
	}
}

export async function saveJobState(db: D1Database, id: string, state: Record<string, string>) {
	await db
		.prepare('UPDATE jobs SET state = ?, lease_until = ?, updated_at = ? WHERE id = ?')
		.bind(JSON.stringify(state), Date.now() + LEASE_MS, Date.now(), id)
		.run();
}

/** 時間切れで手を離す。running のまま、期限だけ消す（次の呼び出しがすぐ続きをやれる） */
export async function yieldJob(db: D1Database, id: string) {
	await db
		.prepare('UPDATE jobs SET lease_until = 0, updated_at = ? WHERE id = ?')
		.bind(Date.now(), id)
		.run();
}

export async function finishJob(db: D1Database, id: string, resultUrl: string) {
	await db
		.prepare(
			`UPDATE jobs SET status = 'done', result_url = ?, error = NULL, updated_at = ? WHERE id = ?`
		)
		.bind(resultUrl, Date.now(), id)
		.run();
}

/** しくじり。回数が残っていれば 2 分後にもう一度並べる */
export async function failJob(db: D1Database, id: string, attempts: number, error: string) {
	const retry = attempts < MAX_ATTEMPTS;
	await db
		.prepare(
			// やり直すときも進み（state）は残す。消すと、投稿先に作った器や動画をもう一度作って二重投稿になる
			`UPDATE jobs SET status = ?, error = ?, scheduled_at = ?, lease_until = NULL, updated_at = ? WHERE id = ?`
		)
		.bind(
			retry ? 'queued' : 'failed',
			error.slice(0, 1000),
			retry ? Date.now() + 2 * 60_000 : Date.now(),
			Date.now(),
			id
		)
		.run();
}

/** この動画を待っている仕事が残っていなければ true */
export async function mediaUnused(db: D1Database, key: string): Promise<boolean> {
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS n FROM jobs WHERE media_key = ? AND status IN ('queued', 'running')`
		)
		.bind(key)
		.first<{ n: number }>();
	return (row?.n ?? 0) === 0;
}

export async function deleteMedia(db: D1Database, key: string) {
	await db.prepare('DELETE FROM media WHERE key = ?').bind(key).run();
}

/** 7 日より古い動画の鍵（掃除用） */
export async function staleMediaKeys(db: D1Database, olderThanMs: number): Promise<string[]> {
	const { results } = await db
		.prepare('SELECT key FROM media WHERE created_at < ?')
		.bind(Date.now() - olderThanMs)
		.all<{ key: string }>();
	return results.map((r) => r.key);
}
