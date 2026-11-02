import { describe, expect, it } from 'vitest';
import { startConnect } from './connect';
import type { Env } from './env';

// SNS の接続（2026-11-02）: 合言葉を URL（/connect/:platform?t=…）に入れない。
// アプリが Bearer で POST /api/connect/:platform を呼び、SNS の許可画面の URL（使い捨ての state 入り）をもらって開く

const HUB_TOKEN = 'hub-secret-token';

/** 偽の D1。oauth_states に入れる文だけ分かる */
function fakeDb() {
	const states: { state: string; platform: string; verifier: string }[] = [];
	const db = {
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					return {
						async run() {
							if (!/^INSERT INTO oauth_states\b/.test(sql.trim()))
								throw new Error(`偽の D1: 知らない文: ${sql}`);
							const [state, platform, verifier] = args as string[];
							states.push({ state, platform, verifier });
							return { meta: { changes: 1 } };
						}
					};
				}
			};
		}
	};
	return { db: db as unknown as D1Database, states };
}

function makeEnv(db: D1Database, extra: Partial<Env> = {}): Env {
	return {
		DB: db,
		MEDIA: {} as R2Bucket,
		HUB_TOKEN,
		TOKEN_KEY: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
		PUBLIC_URL: 'https://hub.example',
		X_CLIENT_ID: 'x-client',
		...extra
	};
}

describe('SNS の接続を始める（startConnect）', () => {
	it('許可画面の URL を返す。state は D1 に置き、合言葉は URL に入れない', async () => {
		const { db, states } = fakeDb();
		const r = await startConnect(makeEnv(db), 'x');
		if (!('url' in r)) throw new Error(r.error);
		const u = new URL(r.url);
		expect(u.origin + u.pathname).toBe('https://x.com/i/oauth2/authorize');
		expect(u.searchParams.get('redirect_uri')).toBe('https://hub.example/connect/x/callback');
		expect(states).toHaveLength(1);
		expect(states[0].platform).toBe('x');
		expect(u.searchParams.get('state')).toBe(states[0].state);
		expect(u.searchParams.get('code_challenge')).toBeTruthy();
		expect(r.url).not.toContain(HUB_TOKEN);
	});

	it('呼ぶたびに別の state（使い捨て）', async () => {
		const { db, states } = fakeDb();
		await startConnect(makeEnv(db), 'x');
		await startConnect(makeEnv(db), 'x');
		expect(states).toHaveLength(2);
		expect(states[0].state).not.toBe(states[1].state);
	});

	it('対応していない SNS・SNS の鍵が無いときは、分かる言葉で止め、state も作らない', async () => {
		const { db, states } = fakeDb();
		expect(await startConnect(makeEnv(db), 'myspace')).toEqual({
			error: 'myspace にはまだ対応していません',
			status: 404
		});
		const noClient = await startConnect(makeEnv(db, { X_CLIENT_ID: undefined }), 'x');
		expect(noClient).toMatchObject({ status: 500 });
		expect('error' in noClient && noClient.error).toContain('X_CLIENT_ID');
		expect(states).toHaveLength(0);
	});
});
