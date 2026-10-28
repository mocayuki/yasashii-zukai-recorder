import { describe, expect, it } from 'vitest';
import { getAccount, saveAccount, type AccountRow, type AccountStore } from './db';
import { decryptToken, isEncrypted, tokenKey } from './crypto';

const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

/**
 * 偽の D1。accounts の 3 つの文（SELECT・INSERT … ON CONFLICT・UPDATE … WHERE platform = ? AND access_token = ?）だけ分かる。
 * writes に、実行した書き込みの SQL と値を残す
 */
function fakeDb(rows: AccountRow[] = []) {
	const table = new Map(rows.map((r) => [r.platform, { ...r }]));
	const writes: { sql: string; args: unknown[] }[] = [];
	const db = {
		prepare(sql: string) {
			const kind = sql.trim().split(/\s+/)[0].toUpperCase();
			return {
				bind(...args: unknown[]) {
					return {
						async first() {
							if (kind !== 'SELECT') throw new Error(`偽の D1: first は SELECT だけ: ${sql}`);
							return table.get(args[0] as string) ?? null;
						},
						async run() {
							writes.push({ sql, args });
							if (kind === 'INSERT') {
								const [
									platform,
									user_id,
									username,
									access_token,
									refresh_token,
									expires_at,
									updated_at
								] = args as [string, string, string, string, string | null, number | null, number];
								table.set(platform, {
									platform: platform as AccountRow['platform'],
									user_id,
									username,
									access_token,
									refresh_token,
									expires_at,
									updated_at
								});
								return { meta: { changes: 1 } };
							}
							if (kind === 'UPDATE') {
								const [access_token, refresh_token, platform, oldAccess] = args as [
									string,
									string | null,
									string,
									string
								];
								const row = table.get(platform);
								if (!row || row.access_token !== oldAccess) return { meta: { changes: 0 } };
								row.access_token = access_token;
								row.refresh_token = refresh_token;
								return { meta: { changes: 1 } };
							}
							throw new Error(`偽の D1: 知らない文: ${sql}`);
						}
					};
				}
			};
		}
	};
	const env = { DB: db, TOKEN_KEY: KEY } as unknown as AccountStore;
	return { env, table, writes };
}

const plainRow: AccountRow = {
	platform: 'x',
	user_id: '123',
	username: 'moca',
	access_token: 'plain-access',
	refresh_token: 'plain-refresh',
	expires_at: 1_700_000_000_000,
	updated_at: 1_690_000_000_000
};

describe('db: accounts のトークンの暗号化', () => {
	it('saveAccount は暗号化してから入れる。row は平文のまま変えない。refresh が無ければ null のまま', async () => {
		const { env, table } = fakeDb();
		const key = await tokenKey(env);
		const row = { ...plainRow };
		await saveAccount(env, row);
		const stored = table.get('x')!;
		expect(isEncrypted(stored.access_token)).toBe(true);
		expect(isEncrypted(stored.refresh_token)).toBe(true);
		expect(await decryptToken(key, stored.access_token)).toBe('plain-access');
		expect(await decryptToken(key, stored.refresh_token!)).toBe('plain-refresh');
		expect(stored.username).toBe('moca');
		expect(row.access_token).toBe('plain-access'); // 呼ぶ側の値は平文のまま

		await saveAccount(env, { ...plainRow, platform: 'threads', refresh_token: null });
		expect(table.get('threads')!.refresh_token).toBeNull();
		expect(isEncrypted(table.get('threads')!.access_token)).toBe(true);
	});

	it('入れて読むと平文に戻る（往復）。暗号化済みの行は読んでも書き戻さない', async () => {
		const { env, writes } = fakeDb();
		await saveAccount(env, plainRow);
		const n = writes.length;
		const got = await getAccount(env, 'x');
		expect(got).toMatchObject({
			platform: 'x',
			user_id: '123',
			username: 'moca',
			access_token: 'plain-access',
			refresh_token: 'plain-refresh',
			expires_at: 1_700_000_000_000
		});
		expect(writes.length).toBe(n); // 読んだだけ
		expect(await getAccount(env, 'threads')).toBeNull();
	});

	it('平文の行を読んだら、そのまま使い、暗号化して書き戻す（updated_at は触らない）。次に読むときは書き戻さない', async () => {
		const { env, table, writes } = fakeDb([plainRow]);
		const key = await tokenKey(env);
		const got = await getAccount(env, 'x');
		expect(got?.access_token).toBe('plain-access');
		expect(got?.refresh_token).toBe('plain-refresh');

		expect(writes).toHaveLength(1);
		expect(writes[0].sql).toMatch(
			/^UPDATE accounts SET access_token = \?, refresh_token = \? WHERE platform = \? AND access_token = \?$/
		);
		expect(writes[0].args[2]).toBe('x');
		expect(writes[0].args[3]).toBe('plain-access'); // 読んだときの値のままの行だけ書き換える
		const stored = table.get('x')!;
		expect(isEncrypted(stored.access_token)).toBe(true);
		expect(isEncrypted(stored.refresh_token)).toBe(true);
		expect(await decryptToken(key, stored.access_token)).toBe('plain-access');
		expect(await decryptToken(key, stored.refresh_token!)).toBe('plain-refresh');
		expect(stored.updated_at).toBe(plainRow.updated_at);

		const again = await getAccount(env, 'x');
		expect(again?.access_token).toBe('plain-access');
		expect(writes).toHaveLength(1);
	});

	it('refresh_token が無い平文の行も直す（null は null のまま）', async () => {
		const { env, table, writes } = fakeDb([
			{ ...plainRow, platform: 'instagram', refresh_token: null }
		]);
		const got = await getAccount(env, 'instagram');
		expect(got?.refresh_token).toBeNull();
		expect(writes).toHaveLength(1);
		expect(isEncrypted(table.get('instagram')!.access_token)).toBe(true);
		expect(table.get('instagram')!.refresh_token).toBeNull();
	});

	it('TOKEN_KEY が無ければ、読むのも入れるのも分かる言葉で止まる', async () => {
		const { env } = fakeDb([plainRow]);
		const noKey = { DB: env.DB, TOKEN_KEY: '' } as AccountStore;
		await expect(getAccount(noKey, 'x')).rejects.toThrow(/TOKEN_KEY/);
		await expect(saveAccount(noKey, plainRow)).rejects.toThrow(/TOKEN_KEY/);
	});

	it('ちがう鍵で入れた行は、読むとつなぎ直しを促す', async () => {
		const { env, table } = fakeDb();
		await saveAccount(env, plainRow);
		const other = {
			DB: env.DB,
			TOKEN_KEY: 'Hx4dHBsaGRgXFhUUExIREA8ODQwLCgkIBwYFBAMCAQA='
		} as AccountStore;
		await expect(getAccount(other, 'x')).rejects.toThrow(/つなぎ直して/);
		expect(isEncrypted(table.get('x')!.access_token)).toBe(true); // 壊してはいない
	});
});
