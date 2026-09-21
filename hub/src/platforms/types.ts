import type { HubPlatform, HubPostRequest } from '../../../shared/publish';
import type { Env } from '../env';
import type { AccountRow } from '../db';

/**
 * 仕事の進みの持ち回り。Worker は 1 回の呼び出しで長くは走れないので、
 * 段階ごとに state を保存し、時間切れなら Yield を投げて次の呼び出しで続きからやる
 */
export interface JobControl {
	/** これまでに保存した進み（器の id、送った片の数など） */
	state: Record<string, string>;
	/** 進みを足して保存する */
	save(patch: Record<string, string>): Promise<void>;
	/** この呼び出しで使える時間の終わり（UNIX ms） */
	deadline: number;
	/** 期限を過ぎていたら Yield を投げる。待ちのループで毎回呼ぶ */
	checkTime(): void;
}

/** 時間切れ。しくじりではなく「続きは次に」の合図 */
export class Yield extends Error {
	constructor() {
		super('yield');
		this.name = 'Yield';
	}
}

/** ひとつの投稿先。つなぐ（OAuth）と、投稿する、の 2 つができればよい */
export interface Publisher {
	platform: HubPlatform;
	/** 設定（client id など）が揃っていなければ、足りないものの説明 */
	missingConfig(env: Env): string | null;
	/** ブラウザーへ送る許可画面の URL。state と verifier はハブが保存する */
	authorizeUrl(env: Env, state: string, challenge: string): string;
	/** 戻ってきた code をトークンに替え、アカウント情報も取る */
	exchangeCode(env: Env, code: string, verifier: string): Promise<Omit<AccountRow, 'updated_at'>>;
	/** 期限が近ければトークンを更新して、更新後の行を返す（更新の要らない投稿先はそのまま返す） */
	freshAccount(env: Env, account: AccountRow): Promise<AccountRow>;
	/** 動画（R2 の鍵）と本文で 1 件投稿し、投稿の URL を返す。進みは ctl に保存し、時間切れは Yield */
	post(
		env: Env,
		account: AccountRow,
		req: HubPostRequest,
		media: { key: string; size: number; contentType: string },
		ctl: JobControl
	): Promise<string>;
}

export function redirectUri(env: Env, platform: HubPlatform): string {
	return `${env.PUBLIC_URL}/connect/${platform}/callback`;
}

export async function readJson<T>(res: Response, what: string): Promise<T> {
	const text = await res.text();
	if (!res.ok) throw new Error(`${what}: HTTP ${res.status} ${text.slice(0, 300)}`);
	try {
		return JSON.parse(text) as T;
	} catch {
		throw new Error(`${what}: 返事が JSON ではありません: ${text.slice(0, 200)}`);
	}
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 「処理が終わるまで待つ」ループの共通形。期限が来たら Yield（次の呼び出しで続き） */
export async function waitUntilDone(
	ctl: JobControl,
	check: () => Promise<'done' | 'wait'>,
	intervalMs = 5000
): Promise<void> {
	for (;;) {
		ctl.checkTime();
		if ((await check()) === 'done') return;
		ctl.checkTime();
		await sleep(Math.min(intervalMs, Math.max(500, ctl.deadline - Date.now())));
	}
}
