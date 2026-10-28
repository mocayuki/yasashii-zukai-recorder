/**
 * 仕事の実行。Worker は 1 回の呼び出しで長くは走れないので、
 * 「時間の許すところまで進めて、進みを保存して手を離す」を繰り返す。
 * 呼ぶ側: すぐ投稿はアプリが POST /api/jobs/:id/run を何度も呼ぶ。予約と取りこぼしは cron（30 分ごと）が拾う
 */
import type { Env } from './env';
import {
	claimJob,
	deleteMedia,
	dueJobIds,
	failJob,
	finishJob,
	getAccount,
	getJob,
	getJobPayload,
	getJobState,
	getMedia,
	mediaUnused,
	saveAccount,
	saveJobState,
	staleMediaKeys,
	yieldJob
} from './db';
import { getPublisher } from './platforms';
import { Yield, type JobControl } from './platforms/types';

/** 1 回の呼び出しで使う時間の目安。HTTP からは短め、cron からは長め */
export const HTTP_BUDGET_MS = 20_000;
export const CRON_BUDGET_MS = 8 * 60_000;
/**
 * 1 回の呼び出しで進める「歩」の数（処理待ちの 1 回の確認や、1 片の送信が 1 歩。1 歩は fetch・R2・D1 で 3 件ほど）。
 * Cloudflare は 1 回の呼び出しの副要求（subrequest）が無料プランで 50 件まで。超えると "Too many subrequests" で落ちるので、
 * その手前で手を離し（Yield）、続きは新しい呼び出しでやる
 */
export const STEPS_PER_CALL = 12;

/**
 * 1 件を、期限まで進める。返り値: 'done' | 'failed' | 'yield'（続きあり） | 'skip'（押さえられなかった）
 */
export async function stepJob(
	env: Env,
	id: string,
	budgetMs: number
): Promise<'done' | 'failed' | 'yield' | 'skip'> {
	const now = Date.now();
	if (!(await claimJob(env.DB, id, now))) return 'skip';
	const job = (await getJob(env.DB, id))!;
	const payload = (await getJobPayload(env.DB, id))!;
	const state = await getJobState(env.DB, id);
	let steps = 0;
	const ctl: JobControl = {
		state,
		deadline: now + budgetMs,
		async save(patch) {
			Object.assign(state, patch);
			await saveJobState(env.DB, id, state);
		},
		checkTime() {
			// 時間切れか、副要求の予算切れなら、進みを保存して手を離す
			if (Date.now() > this.deadline || ++steps > STEPS_PER_CALL) throw new Yield();
		}
	};
	try {
		const publisher = getPublisher(job.platform);
		if (!publisher) throw new Error(`${job.platform} にはまだ対応していません`);
		const missing = publisher.missingConfig(env);
		if (missing) throw new Error(missing);
		const stored = await getAccount(env, job.platform);
		if (!stored) throw new Error(`${job.platform} がつながっていません。ハブで接続してください`);
		const account = await publisher.freshAccount(env, stored);
		// getAccount は復号した平文を返すので、ここは平文どうしの比べ。入れるときに saveAccount が暗号化する
		if (account.access_token !== stored.access_token) await saveAccount(env, account);
		const media = await getMedia(env.DB, job.mediaKey);
		if (!media) throw new Error('動画がハブに残っていません（上げ直してください）');
		const url = await publisher.post(
			env,
			account,
			payload,
			{ key: media.key, size: media.size, contentType: media.content_type },
			ctl
		);
		await finishJob(env.DB, id, url);
		await cleanupMedia(env, job.mediaKey);
		return 'done';
	} catch (err) {
		if (err instanceof Yield) {
			await yieldJob(env.DB, id);
			return 'yield';
		}
		await failJob(env.DB, id, job.attempts, (err as Error).message ?? String(err));
		await cleanupMedia(env, job.mediaKey);
		return 'failed';
	}
}

/** 終わるか時間が尽きるまで、同じ仕事を続けて進める */
export async function runJobUntil(env: Env, id: string, budgetMs: number): Promise<void> {
	const end = Date.now() + budgetMs;
	while (Date.now() < end) {
		const r = await stepJob(env, id, Math.min(HTTP_BUDGET_MS, end - Date.now()));
		if (r !== 'yield') return;
	}
}

/** その動画を待つ仕事が無くなったら R2 から消す（置きっぱなしにしない） */
export async function cleanupMedia(env: Env, key: string) {
	if (!(await mediaUnused(env.DB, key))) return;
	await env.MEDIA.delete(key);
	await deleteMedia(env.DB, key);
}

/**
 * 1 件を 1 歩進める。SELF（自分への binding）があれば新しい呼び出しでやる（副要求の上限が呼び出しごとなので、
 * ここから何度呼んでも尽きない）。無ければ（手元の確認など）この呼び出しの中で
 */
async function stepJobFresh(
	env: Env,
	id: string,
	budgetMs: number
): Promise<'done' | 'failed' | 'yield' | 'skip'> {
	if (!env.SELF) return stepJob(env, id, budgetMs);
	const res = await env.SELF.fetch(`https://self/api/jobs/${encodeURIComponent(id)}/step`, {
		method: 'POST',
		headers: { authorization: `Bearer ${env.HUB_TOKEN}` }
	});
	if (!res.ok) throw new Error(`続きの呼び出しに失敗: HTTP ${res.status}`);
	const j = (await res.json()) as { result?: 'done' | 'failed' | 'yield' | 'skip' };
	return j.result ?? 'skip';
}

/** cron: 時刻の来た予約と、途中で切られた仕事を、時間の許す限り進める。1 件ずつ、終わるまで続けてから次へ */
export async function runDue(env: Env, budgetMs = CRON_BUDGET_MS): Promise<number> {
	const end = Date.now() + budgetMs;
	let n = 0;
	while (Date.now() < end) {
		const ids = await dueJobIds(env.DB, Date.now());
		if (ids.length === 0) break;
		let progressed = false;
		for (const id of ids) {
			// この 1 件を、終わるか時間が尽きるまで進める（歩ごとに新しい呼び出し）
			let r: 'done' | 'failed' | 'yield' | 'skip' = 'yield';
			while (Date.now() < end && r === 'yield') {
				r = await stepJobFresh(env, id, Math.min(HTTP_BUDGET_MS, end - Date.now()));
			}
			if (r !== 'skip') progressed = true;
			if (r === 'done' || r === 'failed') n++;
			if (Date.now() >= end) break;
		}
		if (!progressed) break;
	}
	// 7 日より古い動画は、仕事の有無に関わらず掃除
	for (const key of await staleMediaKeys(env.DB, 7 * 24 * 60 * 60_000)) {
		await env.MEDIA.delete(key);
		await deleteMedia(env.DB, key);
	}
	return n;
}
