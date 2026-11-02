import { describe, expect, it, vi } from 'vitest';
import { memoryVault } from './keychain';
import { asYouTubeAuth, isSecretName, SecretStore, SLOT_LABELS, splitSecrets } from './secrets';

// 鍵は settings.json に書かず、Mac のキーチェーンに置く（2026-10-28）。
// ここではキーチェーンを偽物（memoryVault）に差し替えて、置き方・読み方・以前の settings.json からの移し方を確かめる

const auth = {
	refreshToken: 'r-1',
	accessToken: 'a-1',
	expiresAt: 1_700_000_000_000,
	channelTitle: 'やさしい図解',
	channelId: 'UC1',
	scope: 'https://www.googleapis.com/auth/youtube.force-ssl'
};

describe('SecretStore（鍵の置き場）', () => {
	it('置く・読む・消す。キーチェーンの項目名に何の鍵か入る', () => {
		const vault = memoryVault();
		const store = new SecretStore(vault, 'やさしい図解レコーダー');
		store.set('openaiApiKey', 'sk-test-1234');
		store.set('hubToken', '  hub-secret  ');
		expect(vault.items.get('openaiApiKey')).toEqual({
			value: 'sk-test-1234',
			label: 'やさしい図解レコーダー: OpenAI の API キー'
		});
		// 前後の空白は落として置く
		expect(store.get('hubToken')).toBe('hub-secret');
		expect(store.get('youtubeClientSecret')).toBeNull();
		expect(store.status()).toEqual({
			openaiApiKey: true,
			youtubeClientSecret: false,
			hubToken: true
		});

		store.set('openaiApiKey', null);
		expect(store.get('openaiApiKey')).toBeNull();
		// 空や空白だけも「消す」
		store.set('hubToken', '   ');
		expect(vault.items.size).toBe(0);
	});

	it('一度読んだ鍵は覚えておき、何度も security を呼ばない', () => {
		const vault = memoryVault();
		vault.items.set('openaiApiKey', { value: 'sk-test', label: '' });
		const store = new SecretStore(vault, 'x');
		const get = vi.spyOn(vault, 'get');
		expect(store.get('openaiApiKey')).toBe('sk-test');
		expect(store.get('openaiApiKey')).toBe('sk-test');
		expect(get).toHaveBeenCalledTimes(1);
		// 無かったものは覚えない（あとから入れたら読めるように）
		expect(store.get('hubToken')).toBeNull();
		vault.items.set('hubToken', { value: 'later', label: '' });
		expect(store.get('hubToken')).toBe('later');
	});

	it('置けなかったときは投げ、覚えていた前の鍵のまま', () => {
		const vault = memoryVault();
		const store = new SecretStore(vault, 'x');
		store.set('openaiApiKey', 'sk-old');
		vault.set = () => {
			throw new Error('キーチェーンに置けませんでした');
		};
		expect(() => store.set('openaiApiKey', 'sk-new')).toThrow('置けませんでした');
		expect(store.get('openaiApiKey')).toBe('sk-old');
	});

	it('YouTube の接続（トークン）は JSON で 1 つの項目に置き、形を確かめて戻す', () => {
		const vault = memoryVault();
		const store = new SecretStore(vault, 'x');
		store.setYouTubeAuth(auth);
		expect(vault.items.get('youtubeAuth')?.label).toBe('x: YouTube の接続（トークン）');
		expect(store.getYouTubeAuth()).toEqual(auth);
		store.setYouTubeAuth(null);
		expect(store.getYouTubeAuth()).toBeNull();
		// 壊れた中身は無いものとして扱う（落ちない）
		vault.items.set('youtubeAuth', { value: '{not json', label: '' });
		expect(new SecretStore(vault, 'x').getYouTubeAuth()).toBeNull();
	});
});

describe('以前の settings.json から移す', () => {
	const oldFile = {
		libraryPath: '/tmp/lib',
		micGain: 2,
		openaiApiKey: 'sk-old',
		youtubeClientId: 'id.apps.googleusercontent.com',
		youtubeClientSecret: 'GOCSPX-old',
		youtubeAuth: auth,
		hubUrl: 'https://hub.example',
		hubToken: 'hub-old'
	};

	it('splitSecrets は鍵の欄だけを分け、ほかの設定はそのまま残す', () => {
		const { secrets, rest } = splitSecrets(oldFile);
		expect(Object.keys(secrets).sort()).toEqual(
			['hubToken', 'openaiApiKey', 'youtubeAuth', 'youtubeClientSecret'].sort()
		);
		expect(rest).toEqual({
			libraryPath: '/tmp/lib',
			micGain: 2,
			youtubeClientId: 'id.apps.googleusercontent.com',
			hubUrl: 'https://hub.example'
		});
		// 画面から来た設定に鍵が混ざっていても settings.json には書かれない
		expect(splitSecrets({ micGain: 3, openaiApiKey: 'sk-x' }).rest).toEqual({ micGain: 3 });
	});

	it('4 つ全部をキーチェーンへ移し、移したものの名前を返す（知らせは 1 回）', () => {
		const vault = memoryVault();
		const store = new SecretStore(vault, 'x');
		const { secrets } = splitSecrets(oldFile);
		const r = store.migrate(secrets);
		expect(r.moved).toEqual(['openaiApiKey', 'youtubeClientSecret', 'hubToken', 'youtubeAuth']);
		expect(r.leftover).toEqual({});
		expect(store.get('openaiApiKey')).toBe('sk-old');
		expect(store.get('youtubeClientSecret')).toBe('GOCSPX-old');
		expect(store.get('hubToken')).toBe('hub-old');
		expect(store.getYouTubeAuth()).toEqual(auth);
		expect(r.moved.map((s) => SLOT_LABELS[s])).toEqual([
			'OpenAI の API キー',
			'YouTube のクライアント シークレット',
			'投稿ハブの合言葉',
			'YouTube の接続（トークン）'
		]);
		// もう一度（鍵の無い settings.json）では何も移さない
		expect(store.migrate({}).moved).toEqual([]);
	});

	it('形のおかしい値（空・型違い）は移さず捨てる', () => {
		const vault = memoryVault();
		const store = new SecretStore(vault, 'x');
		const r = store.migrate({
			openaiApiKey: '   ',
			hubToken: 123,
			youtubeAuth: { channelTitle: 'トークンが無い' }
		});
		expect(r.moved).toEqual([]);
		expect(r.leftover).toEqual({});
		expect(vault.items.size).toBe(0);
	});

	it('キーチェーンで断られた鍵は leftover に返し、この起動の間は使える', () => {
		const vault = memoryVault();
		const realSet = vault.set;
		vault.set = (account, value, label) => {
			if (account === 'hubToken') throw new Error('断られた');
			realSet(account, value, label);
		};
		const store = new SecretStore(vault, 'x');
		const r = store.migrate({ openaiApiKey: 'sk-old', hubToken: 'hub-old' });
		expect(r.moved).toEqual(['openaiApiKey']);
		expect(r.leftover).toEqual({ hubToken: 'hub-old' });
		expect(vault.items.has('hubToken')).toBe(false);
		// 移せなかった分も、この起動の間は読める（settings.json に残して次に開いたときにもう一度）
		expect(store.get('hubToken')).toBe('hub-old');
	});
});

describe('小さな部品', () => {
	it('isSecretName は画面から入れる 3 つだけ通す', () => {
		expect(isSecretName('openaiApiKey')).toBe(true);
		expect(isSecretName('hubToken')).toBe(true);
		expect(isSecretName('youtubeAuth')).toBe(false);
		expect(isSecretName('libraryPath')).toBe(false);
		expect(isSecretName(null)).toBe(false);
	});
	it('asYouTubeAuth はトークン 2 つが文字で入っているものだけ通す', () => {
		expect(asYouTubeAuth(auth)).toEqual(auth);
		expect(asYouTubeAuth({ refreshToken: 'r', accessToken: 'a' })).toEqual({
			refreshToken: 'r',
			accessToken: 'a',
			expiresAt: 0,
			channelTitle: '',
			channelId: ''
		});
		expect(asYouTubeAuth({ refreshToken: 'r' })).toBeNull();
		expect(asYouTubeAuth('r')).toBeNull();
	});
});
