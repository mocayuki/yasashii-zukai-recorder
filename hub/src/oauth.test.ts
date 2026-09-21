import { describe, expect, it } from 'vitest';
import { basicAuth, pkceChallenge, randomToken } from './oauth';

describe('oauth', () => {
	it('randomToken は URL に使える文字だけ', () => {
		const t = randomToken(32);
		expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(randomToken()).not.toBe(t);
	});
	it('pkceChallenge は RFC 7636 の例と一致', async () => {
		expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
			'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
		);
	});
	it('basicAuth', () => {
		expect(basicAuth('id', 'secret')).toBe('Basic aWQ6c2VjcmV0');
	});
});
