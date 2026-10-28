/** Worker に渡される束ね（wrangler.toml と secret） */
export interface Env {
	DB: D1Database;
	MEDIA: R2Bucket;
	/** 自分自身（wrangler.toml の services）。仕事を新しい呼び出しで進めるのに使う */
	SELF?: Fetcher;
	/** アプリとハブの合言葉（wrangler secret put HUB_TOKEN）。アプリの設定にも同じ値を入れる */
	HUB_TOKEN: string;
	/**
	 * D1 に入れる SNS のトークンを暗号化する鍵（`openssl rand -base64 32 | npx wrangler secret put TOKEN_KEY`）。
	 * 32 バイトを base64 にしたもの。無い・形が違うと、接続と API が「TOKEN_KEY が…」で止まる（crypto.ts）。
	 * 無くしたら復号できないので、各 SNS をつなぎ直す
	 */
	TOKEN_KEY: string;
	/** 配置したあとの公開 URL（末尾 / なし） */
	PUBLIC_URL: string;
	X_CLIENT_ID?: string;
	X_CLIENT_SECRET?: string;
	/** Meta のアプリ: ユースケースごとに ID とシークレットが別。Threads と Instagram は各ユースケースの設定画面、Facebook はアプリ設定 → ベーシック */
	THREADS_APP_ID?: string;
	THREADS_APP_SECRET?: string;
	IG_APP_ID?: string;
	IG_APP_SECRET?: string;
	FB_APP_ID?: string;
	FB_APP_SECRET?: string;
	/** 投稿する Facebook ページの id（省略時は名前に「図解」を含むページ） */
	FB_PAGE_ID?: string;
	/** TikTok のアプリ（審査前は Sandbox の鍵）。wrangler secret put TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET */
	TIKTOK_CLIENT_KEY?: string;
	TIKTOK_CLIENT_SECRET?: string;
	/** TikTok の審査に通ったら "1"（wrangler.toml の vars）。通るまでは公開範囲を SELF_ONLY に固定する（TikTok の決まり） */
	TIKTOK_AUDITED?: string;
	/** TikTok の開発者ポータルの URL 所有確認の code（tiktok<code>.txt の <code>）。wrangler.toml の vars */
	TIKTOK_SITE_VERIFICATION?: string;
}
