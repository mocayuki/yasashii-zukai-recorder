import { describe, expect, it } from 'vitest';
import { keychainVault, type Exec } from './keychain';

// security コマンドを偽物に差し替えて、呼び方（鍵を引数に載せず標準入力で渡す、base64 で置く）を確かめる

function fakeSecurity() {
	const items = new Map<string, string>(); // "service/account" → base64
	const calls: Array<{ args: string[]; input?: string }> = [];
	const exec: Exec = (args, input) => {
		calls.push({ args, input });
		if (args[0] === 'find-generic-password') {
			const key = `${args[2]}/${args[4]}`;
			const v = items.get(key);
			return v === undefined
				? { status: 44, stdout: '', stderr: 'The specified item could not be found' }
				: { status: 0, stdout: `${v}\n`, stderr: '' };
		}
		if (args[0] === '-i') {
			const m = /^add-generic-password -U -s "([^"]*)" -a "([^"]*)" -l "([^"]*)" -w (\S+)\n$/.exec(
				input ?? ''
			);
			if (!m) return { status: 0, stdout: '', stderr: 'security: unknown command' };
			items.set(`${m[1]}/${m[2]}`, m[4]);
			return { status: 0, stdout: '', stderr: '' };
		}
		if (args[0] === 'delete-generic-password') {
			items.delete(`${args[2]}/${args[4]}`);
			return { status: 0, stdout: '', stderr: '' };
		}
		return { status: 1, stdout: '', stderr: 'unknown' };
	};
	return { items, calls, exec };
}

describe('keychainVault（security を通した置き方）', () => {
	it('鍵は引数に載せず標準入力で渡し、base64 で置く。読むときは戻す', () => {
		const fake = fakeSecurity();
		const vault = keychainVault('yasashii-zukai-recorder', fake.exec);
		vault.set('openaiApiKey', 'sk-てすと\n2行目', 'やさしい図解レコーダー: OpenAI の API キー');
		const add = fake.calls.find((c) => c.args[0] === '-i');
		expect(add).toBeDefined();
		// 引数には鍵が無い（ps に出ない）
		expect(add!.args).toEqual(['-i']);
		expect(add!.input).not.toContain('sk-てすと');
		expect(add!.input).toContain(Buffer.from('sk-てすと\n2行目', 'utf8').toString('base64'));
		expect(add!.input).toContain('-s "yasashii-zukai-recorder" -a "openaiApiKey"');
		expect(vault.get('openaiApiKey')).toBe('sk-てすと\n2行目');
		expect(vault.get('hubToken')).toBeNull();
		vault.remove('openaiApiKey');
		expect(vault.get('openaiApiKey')).toBeNull();
	});

	it('置いたあと読み戻せなければ投げる（-i は失敗しても 0 で終わることがある）', () => {
		const fake = fakeSecurity();
		const broken: Exec = (args, input) =>
			args[0] === '-i'
				? { status: 0, stdout: '', stderr: 'User interaction is not allowed.' }
				: fake.exec(args, input);
		const vault = keychainVault('svc', broken);
		expect(() => vault.set('hubToken', 'x', 'l')).toThrow('User interaction is not allowed');
	});

	it('項目の名前の " と改行は外す（security -i の 1 行を壊さない）', () => {
		const fake = fakeSecurity();
		const vault = keychainVault('svc', fake.exec);
		vault.set('hubToken', 'v', 'ラベル"with\nquote');
		const add = fake.calls.find((c) => c.args[0] === '-i');
		expect(add!.input).toContain('-l "ラベルwithquote"');
	});
});
