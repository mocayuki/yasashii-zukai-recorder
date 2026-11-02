/**
 * Mac のキーチェーンに鍵を置く部品。Mac に元から入っている security（Apple の道具）を通して使う。
 *
 * - アプリが直接キーチェーンを使うと（Electron の safeStorage）、自分で署名したアプリは入れ直すたびに
 *   macOS が別のアプリと見てパスワードを聞く。security を通すと聞かれない
 * - 中身は base64 で置く（改行や記号の入った値でも、そのまま戻せるように）
 * - 鍵は引数に載せず、`security -i` の標準入力で渡す（ps に出さない）
 */
import { spawnSync } from 'node:child_process';

export interface Vault {
	/** 無ければ null */
	get(account: string): string | null;
	/** 置けなかったときは投げる（キーチェーンで断られたときなど） */
	set(account: string, value: string, label: string): void;
	remove(account: string): void;
}

/** security を動かす形（テストでは偽物に差し替える） */
export type Exec = (
	args: string[],
	input?: string
) => { status: number | null; stdout: string; stderr: string };

const SECURITY = '/usr/bin/security';

const securityExec: Exec = (args, input) => {
	const r = spawnSync(SECURITY, args, { encoding: 'utf8', input });
	return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

/** security -i に渡す文字（名前はこちらで決めたものだけ。念のため " と \ と改行は外す） */
function quote(s: string): string {
	return `"${s.replace(/["\\\n]/g, '')}"`;
}

/** service はキーチェーンアクセスで見える名前。account ごとに 1 つ */
export function keychainVault(service: string, exec: Exec = securityExec): Vault {
	const get = (account: string): string | null => {
		const r = exec(['find-generic-password', '-s', service, '-a', account, '-w']);
		if (r.status !== 0) return null;
		return Buffer.from(r.stdout.trim(), 'base64').toString('utf8');
	};
	return {
		get,
		set(account, value, label) {
			const encoded = Buffer.from(value, 'utf8').toString('base64');
			const r = exec(
				['-i'],
				`add-generic-password -U -s ${quote(service)} -a ${quote(account)} -l ${quote(label)} -w ${encoded}\n`
			);
			// -i は、中の命令がうまくいかなくても 0 で終わることがあるので、読み戻して確かめる
			if (get(account) !== value) {
				const reason = r.stderr.trim().slice(0, 200);
				throw new Error(`キーチェーンに置けませんでした${reason ? `（${reason}）` : ''}`);
			}
		},
		remove(account) {
			exec(['delete-generic-password', '-s', service, '-a', account]);
		}
	};
}

/** テスト用（キーチェーンにさわらない） */
export function memoryVault(): Vault & { items: Map<string, { value: string; label: string }> } {
	const items = new Map<string, { value: string; label: string }>();
	return {
		items,
		get: (account) => items.get(account)?.value ?? null,
		set: (account, value, label) => void items.set(account, { value, label }),
		remove: (account) => void items.delete(account)
	};
}
