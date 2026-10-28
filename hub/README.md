# 投稿ハブ（yasashii-hub）

やさしい図解レコーダーから X・Threads・Instagram・TikTok へ投稿・予約投稿するための Cloudflare Worker。
アプリは動画をここへ上げ（R2）、仕事（jobs）を登録する。ハブは 30 分ごと（日本時間 12:00〜23:30）に時刻の来た予約を SNS の API で投稿し、動画を消す。すぐ投稿は cron を待たない。

- `src/index.ts` … 入口（Hono）。公開ページ、接続（OAuth）、API、cron
- `src/platforms/` … 投稿先ごとの実装（`x.ts`、`meta.ts`（Threads・Instagram・Facebook）、`tiktok.ts`）
- `src/scheduler.ts` … 予約の実行と動画の掃除
- `src/db.ts` … D1 の読み書き。`migrations/` に表の定義
- `src/crypto.ts` … D1 に入れる SNS のトークンの暗号化（AES-256-GCM。鍵は secret の `TOKEN_KEY`）
- `../shared/publish.ts` … アプリと共有する型と規則

## 初回の準備（Cloudflare 側）

```bash
cd hub
npx wrangler login                          # ブラウザーで Cloudflare にログイン
npx wrangler d1 create hub                  # 出てきた database_id を wrangler.toml に書く
npx wrangler r2 bucket create yasashii-hub-media
npm run db:remote                           # 表を作る
npx wrangler secret put HUB_TOKEN           # アプリとの合言葉（長い乱数）
openssl rand -base64 32 | npx wrangler secret put TOKEN_KEY   # SNS のトークンを暗号化する鍵（下の「SNS のトークンの守り」）
npx wrangler secret put X_CLIENT_ID         # X の Developer Console → アプリ → Keys and tokens → OAuth 2.0 Client ID
npx wrangler secret put X_CLIENT_SECRET
npm run deploy                              # https://yasashii-hub.<account>.workers.dev
```

配置できたら `wrangler.toml` の `PUBLIC_URL` を実際の URL に直してもう一度 `npm run deploy`。
X の Developer Console では Callback URL に `<PUBLIC_URL>/connect/x/callback`、Website URL に `<PUBLIC_URL>` を入れる。

## ローカルで動かす

```bash
cp .dev.vars.example .dev.vars   # HUB_TOKEN・TOKEN_KEY（openssl rand -base64 32。本番とは別の値でよい）などを書く
npm run db:local
npm run dev                      # http://localhost:8787
```

## SNS のトークンの守り（TOKEN_KEY）

X・Threads・Instagram・Facebook・TikTok のトークン（`accounts` の `access_token` / `refresh_token`）は、Worker の中で暗号化してから D1 に入れる（`src/crypto.ts`。AES-256-GCM、行ごとに別の IV。D1 の中では `enc1:` で始まる）。D1 の書き出し・バックアップ・ダッシュボードから読まれても、鍵が無ければトークンは読めない。Cloudflare のアカウントごと取られたときは守れない（鍵も同じ場所にあるので）。

- **鍵を置くとき**: `openssl rand -base64 32 | npx wrangler secret put TOKEN_KEY`。控えは要らない（Cloudflare が持つ。無くしても下のとおりつなぎ直せばよい）
- **鍵が無い・形が違うとき**: 接続ページと API（アプリの設定の「投稿ハブ」の様子）が「TOKEN_KEY（SNS のトークンを暗号化する鍵）がありません…」で止まる。置いてから使う
- **前から平文で入っている行があるとき**（この仕組みより前につないだアカウント）: 次にそのアカウントで投稿・トークン更新をしたとき、そのまま使って暗号化して書き戻す。表の形は変えないので migration は要らない。どこまで直ったかは `npx wrangler d1 execute hub --remote --command "SELECT platform, substr(access_token, 1, 5) AS head FROM accounts"` で見る（`enc1:` なら直っている）
- **鍵を無くした・変えたとき**: 前の鍵で入れたトークンは復号できないので、投稿が「SNS のトークンを復号できません…つなぎ直してください」で止まる。アプリの設定の「投稿ハブ」から、つないでいた SNS をつなぎ直すだけ（新しい鍵で入る）

## API（すべて `Authorization: Bearer <HUB_TOKEN>`）

| 方法   | 道                       | 何をする                                                                                         |
| ------ | ------------------------ | ------------------------------------------------------------------------------------------------ |
| GET    | /api/status              | 接続の様子                                                                                       |
| PUT    | /api/media               | 動画を上げる（本体そのまま、Content-Length 必須）→ `{ key, url }`                                |
| POST   | /api/jobs                | `{ platform, mediaKey, text, scheduledAt?, orientation }` → 仕事。scheduledAt が無ければすぐ投稿 |
| GET    | /api/jobs, /api/jobs/:id | 様子を見る                                                                                       |
| POST   | /api/jobs/:id/run        | 続きを進める（最長 20 秒ほど）。すぐ投稿はアプリがこれを終わるまで繰り返す                       |
| PATCH  | /api/jobs/:id            | 予約の日時を変える（`{ scheduledAt }`。queued のものだけ）                                       |
| DELETE | /api/jobs/:id            | 予約を取り消す                                                                                   |
| DELETE | /api/accounts/:platform  | 接続を切る                                                                                       |

接続はブラウザーで `<PUBLIC_URL>/connect/x?t=<HUB_TOKEN>` を開く（アプリの設定から開ける）。

## TikTok

Login Kit（`user.info.basic`, `video.publish`）と Content Posting API の Direct Post（FILE_UPLOAD、10 MB ずつ）。開発者ポータルで Redirect URI に `https://<ハブ>/connect/tiktok/callback`、Terms / Privacy に `/terms` `/privacy` を登録し、`wrangler secret put TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET`（審査前は Sandbox の鍵）。審査前の投稿は公開範囲が「自分だけ（SELF_ONLY）」に限られる。審査が通ったら wrangler.toml の vars に `TIKTOK_AUDITED = "1"` を足す（それまでは投稿者の選択に関わらず SELF_ONLY で投稿する）。
