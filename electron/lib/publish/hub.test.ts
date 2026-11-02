import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// SNS の接続（2026-11-02）: 合言葉は URL に入れず Bearer で送り、ハブが返した許可画面の URL だけをブラウザーで開く。
// electron・設定・ffmpeg は偽物

const HUB_TOKEN = 'hub-secret-token';
const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn() }));
vi.mock('electron', () => ({ shell: { openExternal }, app: { getPath: () => '/tmp' } }));
vi.mock('../settings', () => ({
	loadSettings: async () => ({ hubUrl: 'https://hub.example' }),
	getSecret: (name: string) => (name === 'hubToken' ? HUB_TOKEN : null)
}));
vi.mock('../ffmpeg', () => ({ probeDurationMs: async () => 0, runFfmpeg: async () => {} }));

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
	openExternal.mockReset();
	fetchMock.mockReset();
	vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
	vi.unstubAllGlobals();
});

describe('hubConnect', () => {
	it('合言葉はヘッダーで送り、返ってきた許可画面の URL を開く（合言葉は URL に入らない）', async () => {
		const authorize = 'https://x.com/i/oauth2/authorize?state=abc';
		fetchMock.mockResolvedValue(Response.json({ url: authorize }));
		const { hubConnect } = await import('./hub');
		await hubConnect('x');
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('https://hub.example/api/connect/x');
		expect(url).not.toContain(HUB_TOKEN);
		expect(init?.method).toBe('POST');
		expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${HUB_TOKEN}`);
		expect(openExternal).toHaveBeenCalledWith(authorize);
	});

	it('ハブが古いまま（この API が無い）なら、新しくするように言う。ブラウザーは開かない', async () => {
		fetchMock.mockResolvedValue(new Response('404 Not Found', { status: 404 }));
		const { hubConnect } = await import('./hub');
		await expect(hubConnect('x')).rejects.toThrow('投稿ハブが古いままです');
		expect(openExternal).not.toHaveBeenCalled();
	});

	it('https でない URL が返ってきたら開かない', async () => {
		fetchMock.mockResolvedValue(Response.json({ url: 'file:///etc/passwd' }));
		const { hubConnect } = await import('./hub');
		await expect(hubConnect('x')).rejects.toThrow('許可画面の URL が返りませんでした');
		expect(openExternal).not.toHaveBeenCalled();
	});
});
