import { describe, expect, it } from 'vitest';
import worker from './index';
import type { Env } from './env';
import { resultPage } from './pages';

// 接続の結果の画面（K185。2026-11-02）: 道の値や ?error= の文字は、ただの文字として出す（HTML として動かさない）

const SCRIPT = '<script>alert(1)</script>';
const IMG = '<img src=x onerror="alert(1)">';

describe('接続の結果の画面（resultPage）', () => {
	it('message の HTML はエスケープして出す', () => {
		const html = resultPage(false, `${SCRIPT}${IMG}`);
		expect(html).not.toContain('<script>');
		expect(html).not.toContain('<img');
		expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
		expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
	});

	it("& と ' も置きかえる。ふつうの文はそのまま", () => {
		expect(resultPage(false, "a & b 'c'")).toContain('<p>a &amp; b &#39;c&#39;</p>');
		expect(resultPage(true, 'x の @moca としてつながりました。')).toContain(
			'<p>x の @moca としてつながりました。</p>'
		);
	});
});

describe('接続の戻り先（GET /connect/:platform/callback）', () => {
	// どちらの道も D1 を読む前に返すので、env は空でよい
	const env = {} as Env;
	const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
	const get = (path: string) => worker.fetch(new Request(`https://hub.example${path}`), env, ctx);

	it('知らない platform の文字はエスケープして出す', async () => {
		const res = await get(`/connect/${encodeURIComponent(IMG)}/callback`);
		expect(res.status).toBe(404);
		const html = await res.text();
		expect(html).not.toContain('<img');
		expect(html).toContain(
			'&lt;img src=x onerror=&quot;alert(1)&quot;&gt; にはまだ対応していません。'
		);
	});

	it('?error= の文字はエスケープして出す', async () => {
		const res = await get(`/connect/x/callback?error=${encodeURIComponent(SCRIPT)}`);
		expect(res.status).toBe(400);
		const html = await res.text();
		expect(html).not.toContain('<script>');
		expect(html).toContain('x 側で許可されませんでした（&lt;script&gt;alert(1)&lt;/script&gt;）。');
	});
});
