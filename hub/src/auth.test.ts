import { describe, expect, it } from 'vitest';
import { bearerToken, cookieValue, tokenMatches } from './auth';

describe('auth', () => {
	it('tokenMatches は同じときだけ true', () => {
		expect(tokenMatches('abc', 'abc')).toBe(true);
		expect(tokenMatches('abc', 'abd')).toBe(false);
		expect(tokenMatches('ab', 'abc')).toBe(false);
		expect(tokenMatches(null, 'abc')).toBe(false);
		expect(tokenMatches('abc', undefined)).toBe(false);
	});
	it('Bearer と cookie を読む', () => {
		expect(
			bearerToken(new Request('http://x', { headers: { authorization: 'Bearer  tok ' } }))
		).toBe('tok');
		expect(bearerToken(new Request('http://x'))).toBeNull();
		expect(
			cookieValue(new Request('http://x', { headers: { cookie: 'a=1; hub=t%3Dok; b=2' } }), 'hub')
		).toBe('t=ok');
	});
});
