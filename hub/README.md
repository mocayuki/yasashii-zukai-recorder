# 投稿ハブ（yasashii-hub）

やさしい図解レコーダーから X・Threads・Instagram・TikTok へ投稿・予約投稿するための Cloudflare Worker。
アプリは動画をここへ上げ（R2）、仕事（jobs）を登録する。ハブは 30 分ごと（日本時間 12:00〜23:30）に時刻の来た予約を SNS の API で投稿し、動画を消す。すぐ投稿は cron を待たない。

- `src/index.ts` … 入口（Hono）。公開ページ、接続（OAuth）、API、cron
- `src/platforms/` … 投稿先ごとの実装（`x.ts`、`meta.ts`（Threads・Instagram・Facebook）、`tiktok.ts`）
- `src/scheduler.ts` … 予約の実行と動画の掃除
- `src/db.ts` … D1 の読み書き。`migrations/` に表の定義
- `../shared/publish.ts` … アプリと共有する型と規則

## 初回の準備（Cloudflare 側）

```bash
cd hub
npx wrangler login                          # ブラウザーで Cloudflare にログイン
npx wrangler d1 create hub                  # 出てきた database_id を wrangler.toml に書く
npx wrangler r2 bucket create yasashii-hub-media
npm run db:remote                           # 表を作る
npx wrangler secret put HUB_TOKEN           # アプリとの合言葉（長い乱数）
npx wrangler secret put X_CLIENT_ID         # X の Developer Console → アプリ → Keys and tokens → OAuth 2.0 Client ID
npx wrangler secret put X_CLIENT_SECRET
npm run deploy                              # https://yasashii-hub.<account>.workers.dev
```

配置できたら `wrangler.toml` の `PUBLIC_URL` を実際の URL に直してもう一度 `npm run deploy`。
X の Developer Console では Callback URL に `<PUBLIC_URL>/connect/x/callback`、Website URL に `<PUBLIC_URL>` を入れる。

## ローカルで動かす

```bash
cp .dev.vars.example .dev.vars   # HUB_TOKEN などを書く
npm run db:local
npm run dev                      # http://localhost:8787
```

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
