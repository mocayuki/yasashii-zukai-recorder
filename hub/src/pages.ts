/** 公開ページ（利用規約・プライバシーポリシー・アプリの紹介）と、接続の結果の画面。SNS の開発者登録に URL が要る */
const APP = 'やさしい図解レコーダー';
const OWNER = '亀井ゆき（やさしいAI図解解説）';

function layout(title: string, body: string): string {
	return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} | ${APP}</title>
<style>
	body { margin: 0; background: #ffd94a; color: #1d1a12; font-family: "Hiragino Maru Gothic ProN", "Zen Maru Gothic", system-ui, sans-serif; line-height: 1.8; }
	main { max-width: 720px; margin: 40px auto; padding: 28px 32px; background: #fffdf5; border: 3px solid #1d1a12; border-radius: 22px; box-shadow: 6px 6px 0 #1d1a12; }
	h1 { font-size: 24px; margin: 0 0 8px; } h2 { font-size: 17px; margin: 24px 0 4px; }
	p, li { font-size: 15px; } .muted { color: #6b6455; font-size: 13px; }
	a { color: #1d1a12; } nav a { margin-right: 14px; font-size: 13px; }
	code { background: #f1ecd8; padding: 1px 6px; border-radius: 6px; }
</style></head>
<body><main>${body}
<hr style="border:0;border-top:2px solid #e9e1c6;margin:28px 0 12px">
<nav><a href="/">${APP}</a><a href="/terms">利用規約</a><a href="/privacy">プライバシーポリシー</a></nav>
</main></body></html>`;
}

export const homePage = () =>
	layout(
		'投稿ハブ',
		`<h1>${APP}</h1>
<p>図解を開きながら話すだけで、テロップ付きの解説動画ができる Mac 用のアプリです。作った動画は、YouTube・X・Threads・Instagram・TikTok へこのハブを通して投稿します。</p>
<p>このアプリと投稿ハブは ${OWNER} が自分の動画を投稿するために作り、運用しているものです。一般向けの配布やサービスの提供は行っていません。</p>
<p class="muted">お問い合わせ: YouTube チャンネル「やさしいAI図解解説」の概要欄から。</p>`
	);

export const termsPage = () =>
	layout(
		'利用規約',
		`<h1>利用規約</h1>
<p class="muted">最終更新: 2026 年 9 月 15 日</p>
<p>この規約は、${OWNER}（以下「運営者」）が提供する「${APP}」および投稿ハブ（以下「本サービス」）の利用条件を定めます。</p>
<h2>1. 本サービスの内容</h2>
<p>本サービスは、運営者が作成した動画を、運営者自身の SNS アカウント（YouTube・X・Threads・Instagram・TikTok）へ投稿・予約投稿するためのものです。</p>
<h2>2. 利用者</h2>
<p>本サービスの利用者は運営者本人に限られます。第三者への提供、販売、貸与は行いません。</p>
<h2>3. 各 SNS の規約</h2>
<p>投稿は、各 SNS の利用規約・開発者ポリシーに従って行います。各 SNS の API を通じて取得したデータを第三者へ再配布することはありません。</p>
<h2>4. 免責</h2>
<p>本サービスは現状有姿で提供され、投稿の成否や SNS 側の仕様変更による不具合について、運営者はいかなる保証も行いません。</p>
<h2>5. 変更</h2>
<p>運営者は必要に応じてこの規約を変更することがあります。変更後の規約はこのページに掲載した時点で効力を持ちます。</p>`
	);

export const privacyPage = () =>
	layout(
		'プライバシーポリシー',
		`<h1>プライバシーポリシー</h1>
<p class="muted">最終更新: 2026 年 9 月 15 日</p>
<p>${OWNER}（以下「運営者」）は、「${APP}」および投稿ハブ（以下「本サービス」）において、次のとおり情報を取り扱います。</p>
<h2>1. 取り扱う情報</h2>
<ul>
<li>各 SNS との接続に必要なアクセストークンとアカウント名（運営者自身のアカウントのみ）</li>
<li>投稿する動画ファイルと本文、投稿予定日時</li>
</ul>
<h2>2. 利用目的</h2>
<p>運営者自身の SNS アカウントへ動画を投稿・予約投稿するためだけに利用します。</p>
<h2>3. 保存と削除</h2>
<p>動画ファイルは投稿が終わり次第削除します（最長 7 日で自動削除）。アクセストークンは接続を切った時点で削除します。データは Cloudflare のサーバー（Workers・R2・D1）に保存します。</p>
<h2>4. 第三者への提供</h2>
<p>投稿先の SNS（Google、X、Meta、TikTok）へ、投稿に必要な範囲で送信します。それ以外の第三者へ提供することはありません。</p>
<h2>5. 一般の閲覧者について</h2>
<p>本サービスは一般の利用者からの情報を収集しません。このサイトは Cookie を利用した追跡や解析を行いません。</p>
<h2>6. データの削除依頼</h2>
<p>SNS 側の連携解除により、当該アカウントに関するトークンは削除されます。その他の削除依頼は上記の連絡先までご連絡ください。</p>`
	);

export const resultPage = (ok: boolean, message: string) =>
	layout(
		ok ? '接続しました' : '接続できませんでした',
		`<h1>${ok ? '接続しました' : '接続できませんでした'}</h1><p>${message}</p><p class="muted">このタブは閉じて、アプリに戻ってください。</p>`
	);
