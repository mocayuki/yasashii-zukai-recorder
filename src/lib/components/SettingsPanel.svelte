<script lang="ts">
	import { api } from '$lib/api';
	import { PLATFORMS, youtubeCanDelete, type HubPlatform } from '$shared/publish';
	import { library } from '$lib/stores/library.svelte';
	import { settings } from '$lib/stores/settings.svelte';
	import { SUBTITLE_LANGS } from '$shared/subtitles';
	import { storage } from '$lib/stores/storage.svelte';
	import { toast } from '$lib/stores/toast.svelte';
	import { formatBytes } from '$lib/utils/format';

	let { open, onClose }: { open: boolean; onClose: () => void } = $props();

	let dialog = $state<HTMLDialogElement | null>(null);
	let busy = $state(false);
	let version = $state('');

	// 設定画面は最初に開く画面になり得るので、ここで設定を読む（読む前は API キーが空に見えていた）
	$effect(() => {
		if (open && !settings.value) void settings.load();
	});

	$effect(() => {
		if (!dialog) return;
		if (open && !dialog.open) dialog.showModal();
		if (!open && dialog.open) dialog.close();
	});

	$effect(() => {
		void api()
			.app.version()
			.then((v) => (version = v))
			.catch(() => {});
	});

	async function chooseFolder() {
		busy = true;
		try {
			const chosen = await storage.chooseFolder();
			if (chosen) {
				await library.load();
				toast.show('保存先を変更しました');
			}
		} catch (err) {
			toast.error((err as Error).message);
		} finally {
			busy = false;
		}
	}

	async function makeBackup() {
		busy = true;
		try {
			const r = await api().storage.backup();
			if (r)
				toast.show(
					`バックアップを作りました（${r.files} ファイル、${formatBytes(r.bytes)}）: ${r.path}`
				);
		} catch (err) {
			toast.error((err as Error).message);
		} finally {
			busy = false;
		}
	}

	let ytBusy = $state(false);
	let hub = $state<Awaited<ReturnType<ReturnType<typeof api>['publish']['hubStatus']>> | null>(
		null
	);
	async function loadHub() {
		hub = null;
		hub = await api().publish.hubStatus();
	}
	async function saveHub(patch: { hubUrl?: string | null; hubToken?: string | null }) {
		await settings.save(patch);
		await loadHub();
	}
	async function hubConnect(platform: HubPlatform) {
		try {
			await api().publish.hubConnect(platform);
			toast.show('ブラウザーで許可してください');
		} catch (err) {
			toast.error((err as Error).message);
		}
	}
	async function hubDisconnect(platform: HubPlatform) {
		try {
			await api().publish.hubDisconnect(platform);
			await loadHub();
			toast.show('接続を切りました');
		} catch (err) {
			toast.error((err as Error).message);
		}
	}
	$effect(() => {
		if (open) void loadHub();
	});
	async function ytConnect() {
		ytBusy = true;
		try {
			const name = await api().publish.youtubeConnect();
			await settings.load();
			toast.show(`YouTube に接続しました: ${name}`);
		} catch (err) {
			toast.error((err as Error).message);
		} finally {
			ytBusy = false;
		}
	}
	async function ytDisconnect() {
		await api().publish.youtubeDisconnect();
		await settings.load();
		toast.show('YouTube との接続を切りました');
	}
	async function toggleLang(code: string, on: boolean) {
		const cur = settings.value?.subtitleLanguages ?? [];
		const next = on ? [...new Set([...cur, code])] : cur.filter((c) => c !== code);
		await settings.save({ subtitleLanguages: next });
	}
	async function saveApiKey(v: string) {
		try {
			await settings.save({ openaiApiKey: v.trim() || null });
			toast.show(v.trim() ? 'API キーを保存しました' : 'API キーを消しました');
		} catch (err) {
			toast.error((err as Error).message);
		}
	}

	async function importLegacy() {
		busy = true;
		try {
			const r = await api().legacy.importBackup();
			if (r) {
				await library.load();
				await storage.refresh();
				toast.show(
					`取り込みました：ノート ${r.notes} 件、収録 ${r.recordings} 件${r.skipped ? `、${r.skipped} 件は既にあるため省略` : ''}`
				);
			}
		} catch (err) {
			toast.error((err as Error).message);
		} finally {
			busy = false;
		}
	}
</script>

<dialog bind:this={dialog} class="dialog" onclose={onClose} aria-labelledby="settings-heading">
	<div class="dialog__inner">
		<!-- 見出しはスクロールしても上に残る。閉じるのは右上の × -->
		<div class="dialog__head">
			<h2 id="settings-heading" class="card__title">設定</h2>
			<button
				type="button"
				class="dialog__close"
				aria-label="閉じる"
				title="閉じる（Esc）"
				onclick={onClose}>×</button
			>
		</div>

		<section class="dialog__section">
			<h3 class="dialog__h">保存先フォルダー</h3>
			<p class="dialog__path" title={storage.info?.libraryPath}>
				{storage.info?.libraryPath ?? '…'}
			</p>
			<p class="muted">
				ノート・収録・画像は、アプリ自身の置き場所（ライブラリ → Application
				Support）に普通のファイルとして入ります。ダウンロードフォルダーの整理では消えません。BGM
				も同じ場所の bgm フォルダーにあります。
			</p>
			<div class="dialog__actions">
				<button
					type="button"
					class="btn btn--sm btn--yellow"
					onclick={chooseFolder}
					disabled={busy}
				>
					フォルダーを変更
				</button>
				<button
					type="button"
					class="btn btn--sm"
					onclick={() => api().settings.openLibraryFolder()}
				>
					Finder で開く
				</button>
			</div>
			<p class="muted">
				フォルダーを変更しても、前のフォルダーの中身は自動では移りません。必要なら Finder
				で移してください。
			</p>
		</section>

		{#if storage.info}
			<section class="dialog__section">
				<h3 class="dialog__h">容量</h3>
				<dl class="dialog__dl">
					<div>
						<dt>使用中</dt>
						<dd>
							{formatBytes(storage.info.usedBytes)}（ノート {storage.info.noteCount} 件、収録 {storage
								.info.recordingCount} 件）
						</dd>
					</div>
					{#if storage.info.freeBytes !== null && storage.info.totalBytes !== null}
						<div>
							<dt>ディスクの空き</dt>
							<dd>
								{formatBytes(storage.info.freeBytes)} / {formatBytes(storage.info.totalBytes)}
							</dd>
						</div>
					{:else}
						<div>
							<dt>ディスクの空き</dt>
							<dd>取得できませんでした</dd>
						</div>
					{/if}
				</dl>
				<p class="muted">
					画面収録は 1 時間で 1〜2 GB
					ほど使います。空きが少なくなったら、書き出し済みの収録を整理してください。
				</p>
			</section>
		{/if}

		<section class="dialog__section">
			<h3 class="dialog__h">バックアップ</h3>
			<p class="muted">
				保存先フォルダーを丸ごと、選んだ場所へコピーします（「やさしい図解レコーダー バックアップ
				日付」というフォルダーができます）。戻すときは、そのフォルダーを「保存先」に指定するだけです。
			</p>
			<div class="dialog__actions">
				<button type="button" class="btn btn--sm btn--yellow" onclick={makeBackup} disabled={busy}>
					{busy ? '処理中…' : 'バックアップを作る'}
				</button>
			</div>
		</section>

		<section class="dialog__section">
			<h3 class="dialog__h">テロップ（文字起こし）</h3>
			<p class="muted">
				編集画面の「テロップを作る」は OpenAI の文字起こし（whisper-1）を使います。API キーはこの
				Mac の設定ファイルにだけ保存し、ほかへは送りません。料金は 1 時間の収録で 1 ドルほどです。
			</p>
			<label class="dialog__field">
				<span>OpenAI API キー</span>
				<input
					class="input"
					type="password"
					placeholder="sk-…"
					autocomplete="off"
					value={settings.value?.openaiApiKey ?? ''}
					onchange={(e) => void saveApiKey(e.currentTarget.value)}
				/>
			</label>
			<p class="muted">
				{settings.value?.openaiApiKey ? 'キーは保存されています。' : 'まだ設定されていません。'}
			</p>
		</section>

		<section class="dialog__section">
			<h3 class="dialog__h">書き起こしの言葉</h3>
			<p class="muted">
				固有名詞など、書き方を決めたい言葉を 1 行 1
				語で入れると、テロップの書き起こしがその書き方に寄ります。
				そのノートのタイトルとノードの文字も自動で一緒に渡します。確実に直したいものは下の「置き換え」に。
			</p>
			<label class="dialog__field">
				<span>言葉の辞書（1 行 1 語）</span>
				<textarea
					class="input dialog__textarea"
					rows="5"
					placeholder={'亀井ゆき\nやさしいバイブコーディング'}
					value={settings.value?.transcriptTerms ?? ''}
					onchange={(e) => void settings.save({ transcriptTerms: e.currentTarget.value })}
				></textarea>
			</label>
			<label class="dialog__field">
				<span>置き換え（誤り → 正しい、1 行 1 組）</span>
				<textarea
					class="input dialog__textarea"
					rows="5"
					placeholder={'仮面雪 → 亀井ゆき\n優しい → やさしい'}
					value={settings.value?.transcriptReplacements ?? ''}
					onchange={(e) => void settings.save({ transcriptReplacements: e.currentTarget.value })}
				></textarea>
			</label>
			<p class="muted">置き換えは、次に「テロップを作る」を押したときから効きます。</p>
		</section>

		<section class="dialog__section">
			<h3 class="dialog__h">YouTube</h3>
			<p class="muted">
				Google Cloud で作った「デスクトップ アプリ」の OAuth クライアントの値を入れて、「YouTube
				に接続」を押します。ブラウザーで Google にログインして許可すると、この Mac
				の設定ファイルにだけトークンを保存します。
			</p>
			<label class="dialog__field">
				<span>クライアント ID</span>
				<input
					class="input"
					type="text"
					autocomplete="off"
					placeholder="xxxx.apps.googleusercontent.com"
					value={settings.value?.youtubeClientId ?? ''}
					onchange={(e) =>
						void settings.save({ youtubeClientId: e.currentTarget.value.trim() || null })}
				/>
			</label>
			<label class="dialog__field">
				<span>クライアント シークレット</span>
				<input
					class="input"
					type="password"
					autocomplete="off"
					placeholder="GOCSPX-…"
					value={settings.value?.youtubeClientSecret ?? ''}
					onchange={(e) =>
						void settings.save({ youtubeClientSecret: e.currentTarget.value.trim() || null })}
				/>
			</label>
			<div class="dialog__row">
				{#if settings.value?.youtubeAuth}
					<span
						>接続中: <strong
							>{settings.value.youtubeAuth.channelTitle || '（チャンネル名なし）'}</strong
						></span
					>
					<button type="button" class="btn btn--sm" onclick={() => void ytDisconnect()}
						>接続を切る</button
					>
					{#if !youtubeCanDelete(settings.value.youtubeAuth)}
						<span class="muted" style="color: var(--alert)"
							>予約の取り消し（動画の削除）の許可がまだありません。「接続を切る」→「YouTube
							に接続」でつなぎ直してください</span
						>
					{/if}
				{:else}
					<button
						type="button"
						class="btn btn--sm btn--yellow"
						disabled={ytBusy ||
							!settings.value?.youtubeClientId ||
							!settings.value?.youtubeClientSecret}
						onclick={() => void ytConnect()}
						>{ytBusy ? 'ブラウザーで許可を待っています…' : 'YouTube に接続'}</button
					>
					<span class="muted">まだ接続していません。</span>
				{/if}
			</div>
		</section>

		<section class="dialog__section">
			<h3 class="dialog__h">投稿ハブ（X・Threads・Instagram・TikTok）</h3>
			<p class="muted">
				hub/ を Cloudflare に配置したときの URL と、そのとき決めた合言葉（HUB_TOKEN）を入れます。X
				などへの投稿と予約は、このハブが受け持ちます。
			</p>
			<label class="dialog__field">
				<span>ハブの URL</span>
				<input
					class="input"
					type="url"
					autocomplete="off"
					placeholder="https://yasashii-hub.xxxx.workers.dev"
					value={settings.value?.hubUrl ?? ''}
					onchange={(e) => void saveHub({ hubUrl: e.currentTarget.value.trim() || null })}
				/>
			</label>
			<label class="dialog__field">
				<span>合言葉（HUB_TOKEN）</span>
				<input
					class="input"
					type="password"
					autocomplete="off"
					value={settings.value?.hubToken ?? ''}
					onchange={(e) => void saveHub({ hubToken: e.currentTarget.value.trim() || null })}
				/>
			</label>
			{#if hub === null}
				<p class="muted">ハブの様子を見ています…</p>
			{:else if !hub.ok}
				<p class="muted">{hub.error}</p>
			{:else}
				{#each hub.platforms as p (p.platform)}
					<div class="dialog__row">
						<strong>{PLATFORMS.find((x) => x.id === p.platform)?.label ?? p.platform}</strong>
						{#if !p.configured}
							<span class="muted">ハブ側にクライアント ID がまだありません（wrangler secret）</span>
						{:else if p.account}
							<span>接続中: <strong>@{p.account.username}</strong></span>
							<button
								type="button"
								class="btn btn--sm"
								onclick={() => void hubDisconnect(p.platform)}>接続を切る</button
							>
						{:else}
							<button
								type="button"
								class="btn btn--sm btn--yellow"
								onclick={() => void hubConnect(p.platform)}>ブラウザーで接続</button
							>
							<span class="muted">許可したら、このパネルを開き直すと反映されます</span>
						{/if}
					</div>
				{/each}
				<button type="button" class="chip" onclick={() => void loadHub()}>様子を見直す</button>
			{/if}
		</section>

		<section class="dialog__section">
			<h3 class="dialog__h">字幕の外国語版</h3>
			<p class="muted">
				YouTube に上げるとき、日本語の字幕と一緒に、ここで選んだ言語の字幕も自動で付けます（OpenAI
				で翻訳。1 時間の収録で数円ほど）。
			</p>
			<div class="dialog__langs">
				{#each SUBTITLE_LANGS as l (l.code)}
					<label class="dialog__lang">
						<input
							type="checkbox"
							checked={(settings.value?.subtitleLanguages ?? []).includes(l.code)}
							onchange={(e) => void toggleLang(l.code, e.currentTarget.checked)}
						/>
						<span>{l.label}</span>
					</label>
				{/each}
			</div>
		</section>

		<section class="dialog__section">
			<h3 class="dialog__h">初期版（ブラウザー版）からの取り込み</h3>
			<p class="muted">
				初期版の「バックアップを書き出す」で作った JSON
				を選ぶと、録音とメモをこのフォルダーへ取り込みます。
			</p>
			<div class="dialog__actions">
				<button type="button" class="btn btn--sm" onclick={importLegacy} disabled={busy}>
					{busy ? '処理中…' : 'バックアップ JSON を選ぶ'}
				</button>
			</div>
		</section>

		<p class="muted dialog__version">やさしい図解レコーダー {version}</p>
	</div>
</dialog>

<style>
	.dialog {
		border: var(--border);
		border-radius: 20px;
		background: var(--cream);
		color: var(--ink);
		padding: 0;
		width: min(92vw, 640px);
		box-shadow: 6px 6px 0 var(--ink);
	}
	.dialog::backdrop {
		background: rgba(28, 24, 18, 0.45);
	}
	.dialog__inner {
		padding: 0 26px 24px;
		display: grid;
		gap: 20px;
		max-height: 80vh;
		overflow-y: auto;
	}
	.dialog__head {
		position: sticky;
		top: 0;
		z-index: 2;
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 18px 0 10px;
		background: var(--cream);
		border-bottom: 2px solid var(--rule);
	}
	.dialog__close {
		width: 38px;
		height: 38px;
		border-radius: 50%;
		border: 2.5px solid var(--ink);
		background: var(--yellow);
		color: var(--ink);
		font-size: 22px;
		font-weight: 900;
		line-height: 1;
		cursor: pointer;
		box-shadow: 2px 2px 0 var(--ink);
	}
	.dialog__close:hover {
		transform: translate(1px, 1px);
		box-shadow: 1px 1px 0 var(--ink);
	}
	.dialog__close:focus-visible {
		outline: 3px solid var(--gold);
		outline-offset: 2px;
	}
	.dialog__section {
		display: grid;
		gap: 8px;
		padding-top: 16px;
		border-top: 2px solid var(--rule);
	}
	.dialog__h {
		font-size: 14px;
		font-weight: 900;
		letter-spacing: 0.06em;
	}
	.dialog__path {
		font-size: 13.5px;
		font-weight: 700;
		background: var(--yellow);
		border: 2px solid var(--ink);
		border-radius: 10px;
		padding: 8px 12px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		user-select: text;
	}
	.dialog__field {
		display: grid;
		gap: 4px;
		font-size: 13px;
		font-weight: 700;
	}
	.dialog__field input {
		font-family: ui-monospace, monospace;
		font-size: 13px;
	}
	.dialog__actions {
		display: flex;
		gap: 10px;
		flex-wrap: wrap;
	}
	.dialog__dl {
		display: grid;
		gap: 6px;
		font-size: 13.5px;
	}
	.dialog__dl div {
		display: grid;
		grid-template-columns: 120px 1fr;
		gap: 10px;
	}
	.dialog__dl dt {
		font-weight: 900;
	}
	.dialog__version {
		text-align: right;
	}
	.dialog__textarea {
		font: inherit;
		line-height: 1.6;
		resize: vertical;
		min-height: 96px;
	}
	.dialog__langs {
		display: flex;
		flex-wrap: wrap;
		gap: 8px 16px;
	}
	.dialog__lang {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-weight: 700;
		font-size: 14px;
	}
	.dialog__row {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}
</style>
