import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryVault } from './keychain';

// 以前 settings.json に平文で入れていた鍵を、はじめて開いたときにキーチェーンへ移して settings.json から消す（2026-10-28）。
// electron とキーチェーンは偽物。設定ファイルは仮のフォルダーに置く

let tmp = '';
const vault = memoryVault();
vi.mock('electron', () => ({
	app: { getPath: () => tmp, isPackaged: true }
}));
vi.mock(import('./keychain'), async (importOriginal) => ({
	...(await importOriginal()),
	keychainVault: () => vault
}));

const settingsFile = () => path.join(tmp, 'settings.json');

beforeEach(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yvn-settings-'));
	vault.items.clear();
	vi.resetModules();
});
afterEach(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

const auth = {
	refreshToken: 'r-1',
	accessToken: 'a-1',
	expiresAt: 1,
	channelTitle: 'ch',
	channelId: 'UC1'
};

describe('settings.json の鍵をキーチェーンへ移す', () => {
	it('開いたとき 1 回だけ移し、ファイルから消し、知らせを 1 回返す', async () => {
		await fs.writeFile(
			settingsFile(),
			JSON.stringify({
				micGain: 2,
				openaiApiKey: 'sk-old',
				youtubeClientId: 'cid',
				youtubeClientSecret: 'GOCSPX-old',
				youtubeAuth: auth,
				hubUrl: 'https://hub.example/',
				hubToken: 'hub-old'
			})
		);
		const m = await import('./settings');
		const s = await m.loadSettings();
		// 設定そのものは残る（鍵の欄は型からも無い）
		expect(s.micGain).toBe(2);
		expect(s.youtubeClientId).toBe('cid');
		expect(s.hubUrl).toBe('https://hub.example');
		expect('openaiApiKey' in s).toBe(false);
		// 鍵はキーチェーンへ
		expect(m.getSecret('openaiApiKey')).toBe('sk-old');
		expect(m.getSecret('youtubeClientSecret')).toBe('GOCSPX-old');
		expect(m.getSecret('hubToken')).toBe('hub-old');
		expect(m.getYouTubeAuth()).toEqual(auth);
		expect(m.secretStatus()).toEqual({
			openaiApiKey: true,
			youtubeClientSecret: true,
			hubToken: true
		});
		// settings.json からは消えている
		const written = JSON.parse(await fs.readFile(settingsFile(), 'utf8'));
		expect(Object.keys(written)).not.toContain('openaiApiKey');
		expect(Object.keys(written)).not.toContain('youtubeClientSecret');
		expect(Object.keys(written)).not.toContain('youtubeAuth');
		expect(Object.keys(written)).not.toContain('hubToken');
		expect(written.micGain).toBe(2);
		// 知らせは 1 回だけ
		expect(m.takeStartupNotices()).toEqual([
			'鍵をキーチェーンに移しました（OpenAI の API キー、YouTube のクライアント シークレット、投稿ハブの合言葉、YouTube の接続（トークン））'
		]);
		expect(m.takeStartupNotices()).toEqual([]);
	});

	it('鍵の無い settings.json では何もしない（知らせも無い）', async () => {
		await fs.writeFile(settingsFile(), JSON.stringify({ micGain: 2 }));
		const m = await import('./settings');
		await m.loadSettings();
		expect(vault.items.size).toBe(0);
		expect(m.takeStartupNotices()).toEqual([]);
		expect(m.secretStatus()).toEqual({
			openaiApiKey: false,
			youtubeClientSecret: false,
			hubToken: false
		});
	});

	it('画面から鍵の欄が混ざって来ても settings.json には書かない。setSecret はキーチェーンへ', async () => {
		const m = await import('./settings');
		await m.loadSettings();
		await m.saveSettings({ micGain: 3, openaiApiKey: 'sk-x' } as never);
		const written = JSON.parse(await fs.readFile(settingsFile(), 'utf8'));
		expect(written.micGain).toBe(3);
		expect('openaiApiKey' in written).toBe(false);
		expect(await m.setSecret('openaiApiKey', ' sk-new ')).toEqual({
			openaiApiKey: true,
			youtubeClientSecret: false,
			hubToken: false
		});
		expect(vault.items.get('openaiApiKey')?.value).toBe('sk-new');
		expect(await m.setSecret('openaiApiKey', null)).toMatchObject({ openaiApiKey: false });
		expect(JSON.parse(await fs.readFile(settingsFile(), 'utf8'))).not.toHaveProperty(
			'openaiApiKey'
		);
	});

	it('キーチェーンで断られた鍵は settings.json に残し、次の保存でも消さない。置けたら消す', async () => {
		await fs.writeFile(
			settingsFile(),
			JSON.stringify({ micGain: 2, openaiApiKey: 'sk-old', hubToken: 'hub-old' })
		);
		const realSet = vault.set;
		let refuse = true;
		vault.set = (account, value, label) => {
			if (refuse && account === 'hubToken') throw new Error('断られた');
			realSet(account, value, label);
		};
		const m = await import('./settings');
		await m.loadSettings();
		expect(m.takeStartupNotices()).toEqual(['鍵をキーチェーンに移しました（OpenAI の API キー）']);
		// 移せなかった合言葉は、この起動の間は使える
		expect(m.getSecret('hubToken')).toBe('hub-old');
		let written = JSON.parse(await fs.readFile(settingsFile(), 'utf8'));
		expect(written).toEqual({ ...written, hubToken: 'hub-old' });
		expect('openaiApiKey' in written).toBe(false);
		// ほかの設定を保存しても、残した合言葉は消えない
		await m.saveSettings({ micGain: 4 });
		written = JSON.parse(await fs.readFile(settingsFile(), 'utf8'));
		expect(written.hubToken).toBe('hub-old');
		expect(written.micGain).toBe(4);
		// 置けるようになって入れ直したら、ファイルからも消える
		refuse = false;
		await m.setSecret('hubToken', 'hub-new');
		written = JSON.parse(await fs.readFile(settingsFile(), 'utf8'));
		expect('hubToken' in written).toBe(false);
		expect(vault.items.get('hubToken')?.value).toBe('hub-new');
		vault.set = realSet;
	});
});
