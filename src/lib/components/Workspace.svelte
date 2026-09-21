<script lang="ts">
	import type { Note } from '$shared/types';
	import { api } from '$lib/api';
	import { library } from '$lib/stores/library.svelte';
	import { toast } from '$lib/stores/toast.svelte';
	import { ui } from '$lib/stores/ui.svelte';
	import { recorder } from '$lib/recording/recorder.svelte';
	import { settings } from '$lib/stores/settings.svelte';
	import { formatDuration } from '$lib/utils/format';
	import AudioPanel from './AudioPanel.svelte';
	import MarkdownEditor from './MarkdownEditor.svelte';
	import MindMap from './MindMap.svelte';
	import SaveStatus from './SaveStatus.svelte';
	import ShortcutsPanel from './ShortcutsPanel.svelte';
	import ThumbnailPanel from './ThumbnailPanel.svelte';

	/**
	 * ワークスペース。16:9 の枠の中でマインドマップを編集し、その枠を収録する。
	 * 普通のウィンドウのまま開き、大きさは自由に変えられる。「全画面」で画面全体にもできる。
	 * 枠の外に、収録の状態・収録ボタン・Markdown 編集の切り替え・閉じるを置く。
	 */
	let { note, onExit }: { note: Note; onExit: () => void } = $props();

	let showScript = $state(false);
	/** キー操作の一覧を出しているか */
	let showKeys = $state(false);
	/** サムネイルを作る画面を出しているか */
	let showThumb = $state(false);
	let showAudio = $state(false);
	let frameEl = $state<HTMLDivElement | null>(null);
	let map = $state<MindMap | null>(null);
	/** プレゼン用の窓が開いているか */
	let presentOpen = $state(false);
	$effect(() => {
		void api()
			.present.isOpen()
			.then((v) => (presentOpen = v))
			.catch(() => {});
		return api().present.onOpenChange((v) => (presentOpen = v));
	});
	async function togglePresent() {
		if (presentOpen) await api().present.close();
		else {
			await api().present.open(note.id);
		}
	}
	/** 枠を置く場所の実際の大きさから、16:9 で収まる幅を決める（ボタンの列に食い込まないように） */
	let bodyEl = $state<HTMLDivElement | null>(null);
	let frameWidth = $state(960);
	/** 動画の向き（ノートに保存）。縦は 9:16 のショート動画 */
	const portrait = $derived(note.orientation === 'portrait');
	const frameRatio = $derived(portrait ? 9 / 16 : 16 / 9);
	$effect(() => {
		if (!bodyEl) return;
		const el = bodyEl;
		const measure = () => {
			// カウントダウンから収録が終わるまで、枠の大きさは変えない。
			// 収録が始まると下の列の案内文などが変わって本文の高さが変わり、枠が数十 px 大きくなっていた。
			// その一瞬、取り込んだ映像と切り出し位置がずれて枠の外の水色が映り、動画がブレて見えた（2026-09-12）
			if (recorder.status === 'starting' || recorder.status === 'recording') return;
			const w = el.clientWidth - (asideOpen ? 440 + 16 : 0);
			const h = el.clientHeight;
			frameWidth = Math.max(200, Math.floor(Math.min(w, h * frameRatio)));
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	});

	$effect(() => {
		if (!settings.value) void settings.load();
	});

	const recording = $derived(recorder.status === 'recording');
	const busy = $derived(recorder.status === 'starting' || recorder.status === 'stopping');
	const asideOpen = $derived((showScript && !recording) || showAudio);
	/** 脇の欄（Markdown・音の設定）の幅と余白。開くときはこの分ウィンドウを広げ、閉じるときに戻す（枠を縮めない） */
	const ASIDE_W = 440 + 16;
	let grown = 0;
	let asideWas = false;
	$effect(() => {
		const open = asideOpen;
		if (open === asideWas) return;
		asideWas = open;
		if (open) {
			void api()
				.app.resizeBy(ASIDE_W)
				.then((d) => (grown = d))
				.catch(() => {});
		} else if (grown !== 0) {
			const d = grown;
			grown = 0;
			void api()
				.app.resizeBy(-d)
				.catch(() => {});
		}
	});

	/** 収録前のカウントダウン（3, 2, 1）。null なら出ていない */
	let countdown = $state<number | null>(null);
	let countdownTimer: number | null = null;

	function cancelCountdown() {
		if (countdownTimer !== null) window.clearInterval(countdownTimer);
		countdownTimer = null;
		countdown = null;
	}

	async function toggleRecording() {
		if (countdown !== null) {
			cancelCountdown();
			toast.show('収録を取りやめました');
			return;
		}
		if (recorder.status === 'idle') {
			if (!frameEl) return;
			showScript = false;
			showAudio = false; // 音の設定のマイクの試し聞きを止めてから録る
			const cfg = settings.value ?? (await settings.load());
			// 3, 2, 1 と数えてから録り始める（心の準備と、ボタンを押す音が入らないように）
			const ok = await new Promise<boolean>((resolve) => {
				countdown = 3;
				countdownTimer = window.setInterval(() => {
					if (countdown === null) return resolve(false);
					if (countdown <= 1) {
						cancelCountdown();
						return resolve(true);
					}
					countdown -= 1;
				}, 1000);
				const stop = () => {
					if (countdown === null) resolve(false);
				};
				cancelWatchers.push(stop);
			});
			cancelWatchers.length = 0;
			if (!ok || !frameEl) return;
			// ノードは全部閉じ、チェックは全部「未」にしてから始める（話しながら開き、付けていく）
			const closed = library.collapseAll(note.id);
			const cleared = library.resetChecks(note.id);
			if (closed > 0 || cleared > 0) {
				map?.fitAll();
				const parts = [];
				if (closed > 0) parts.push(`ノードを ${closed} 件閉じました`);
				if (cleared > 0) parts.push(`チェックを ${cleared} 件、未に戻しました`);
				toast.show(parts.join('。'));
				await new Promise((r) => setTimeout(r, 350)); // 収め直しの動きが落ち着いてから録り始める
			}
			await recorder.start({
				noteId: note.id,
				title: note.title.trim() || '無題のノート',
				frameEl,
				micDeviceId: cfg.micDeviceId,
				micGain: cfg.micGain ?? 1,
				micCompressor: cfg.micCompressor !== false,
				width: portrait ? 1080 : 1920,
				height: portrait ? 1920 : 1080
			});
			if (recorder.error) toast.error(recorder.error);
			else toast.show('収録をはじめました。枠の中が動画になります');
			return;
		}
		if (recorder.status === 'recording') {
			const rec = await recorder.stop();
			if (rec) {
				await library.upsertRecording(rec);
				toast.show(`収録を保存しました（${formatDuration(rec.durationMs)}）`);
			} else if (recorder.error) {
				toast.error(recorder.error);
			}
		}
	}

	/** 取りやめ（Esc やボタン）を待っている Promise に知らせるため */
	const cancelWatchers: Array<() => void> = [];

	async function close() {
		if (countdown !== null) cancelCountdown();
		if (recording) {
			toast.error('収録中です。先に「停止する」を押してください');
			return;
		}
		// 脇の欄で広げた分は先に戻してから閉じる（広げた大きさをワークスペースの大きさとして覚えないように）
		showScript = false;
		showAudio = false;
		if (grown !== 0) {
			const d = grown;
			grown = 0;
			asideWas = false;
			await api()
				.app.resizeBy(-d)
				.catch(() => {});
		}
		onExit();
	}

	// Esc は「全画面をやめる」だけ。ワークスペースは閉じない（誤って閉じないように）。
	// ⌘Z / ⌘⇧Z で元に戻す・やり直す。文字を入力中は、その入力欄の取り消しを優先する
	function onWindowKeydown(e: KeyboardEvent) {
		if (e.isComposing) return;
		const t = e.target as HTMLElement | null;
		const typing = !!t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT');
		if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
			if (typing || recording) return;
			e.preventDefault();
			const done = e.shiftKey ? library.redo(note.id) : library.undo(note.id);
			if (!done) toast.show(e.shiftKey ? 'やり直す変更はありません' : '戻す変更はありません');
			return;
		}
		if (e.key === 'Escape' && countdown !== null) {
			e.preventDefault();
			cancelCountdown();
			cancelWatchers.forEach((f) => f());
			toast.show('収録を取りやめました');
			return;
		}
		if (e.key === 'Escape' && ui.fullscreen && !typing) {
			e.preventDefault();
			ui.setFullScreen(false);
		}
	}
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div class="ws" class:ws--recording={recording}>
	{#if countdown !== null}
		<!-- 枠の外に重ねる。数え終わってから録り始めるので、動画には入らない -->
		<div class="ws__count" role="status" aria-live="assertive">
			{#key countdown}
				<div class="ws__count-num" aria-label="あと {countdown} 秒で収録">{countdown}</div>
			{/key}
			<div class="ws__count-hint">まもなく収録がはじまります（Esc で取りやめ）</div>
		</div>
	{/if}
	<div class="ws__top">
		<div class="ws__top-left">
			<button
				type="button"
				class="btn btn--sm"
				title="元に戻す（⌘Z）"
				disabled={!library.canUndo(note.id) || recording}
				onclick={() => library.undo(note.id)}
			>
				<svg class="btn__svg" viewBox="0 0 20 20" aria-hidden="true">
					<path d="M8 4.5 3.5 9 8 13.5" />
					<path d="M4 9h8.5a4 4 0 0 1 0 8H10" />
				</svg>
				戻す
			</button>
			<button
				type="button"
				class="btn btn--sm"
				title="やり直す（⌘⇧Z）"
				disabled={!library.canRedo(note.id) || recording}
				onclick={() => library.redo(note.id)}
			>
				<svg class="btn__svg" viewBox="0 0 20 20" aria-hidden="true">
					<path d="m12 4.5 4.5 4.5L12 13.5" />
					<path d="M16 9H7.5a4 4 0 0 0 0 8H10" />
				</svg>
				やり直す
			</button>
		</div>
		<div class="ws__top-right">
			<SaveStatus status={library.saveStatus} onRetry={() => void library.retrySave()} />
			<div class="ws__status" class:ws__status--on={recording} role="status" aria-live="polite">
				<span class="ws__dot" aria-hidden="true"></span>
				{#if recording}
					収録中 {formatDuration(recorder.elapsedMs)}
				{:else if recorder.status === 'starting'}
					準備中…
				{:else if recorder.status === 'stopping'}
					保存しています…
				{:else}
					収録していません
				{/if}
			</div>
			{#if recording && recorder.silent}
				<span class="ws__silent" role="alert">声が入っていません。マイクのミュートを確認</span>
			{/if}
			{#if recording}
				<div class="ws__meter" aria-label="マイクの音量" title="マイクの音量">
					<div
						class="ws__meter-bar"
						style="transform: scaleX({Math.max(0.03, recorder.level)})"
					></div>
				</div>
			{/if}
			<button
				type="button"
				class="btn btn--sm"
				aria-pressed={ui.fullscreen}
				onclick={() => ui.toggleFullScreen()}
			>
				{ui.fullscreen ? '全画面をやめる（Esc）' : '全画面'}
			</button>
			<button type="button" class="btn btn--sm" onclick={close} disabled={recording}>閉じる</button>
		</div>
	</div>

	<div class="ws__body" bind:this={bodyEl}>
		<div
			class="ws__frame"
			style="width: {frameWidth}px; aspect-ratio: {portrait ? '9 / 16' : '16 / 9'}"
		>
			<MindMap {note} stageMode presenting={recording || busy} bind:frameEl bind:this={map} />
		</div>
		{#if showScript && !recording}
			<aside class="ws__script" aria-label="Markdown で編集">
				{#key note.id}
					<MarkdownEditor {note} />
				{/key}
			</aside>
		{:else if showAudio}
			<aside class="ws__script" aria-label="音の設定">
				<AudioPanel disabled={recording} />
			</aside>
		{/if}
	</div>

	<div class="ws__bottom">
		<button
			type="button"
			class="btn btn--sm"
			aria-pressed={showScript}
			disabled={recording}
			onclick={() => {
				showScript = !showScript;
				if (showScript) showAudio = false;
			}}
		>
			Markdown で編集
		</button>
		<button
			type="button"
			class="btn btn--sm"
			title="キー操作の一覧"
			onclick={() => (showKeys = true)}
		>
			キー操作
		</button>
		<button
			type="button"
			class="btn btn--sm"
			title="YouTube 用のサムネイル（1280×720 の PNG）を作る"
			disabled={recording}
			onclick={() => (showThumb = true)}
		>
			サムネ
		</button>
		<button
			type="button"
			class="btn btn--sm"
			aria-pressed={showAudio}
			disabled={recording || busy}
			title={recording ? '収録中は開けません（枠が縮んで枠の外が動画に入るため）' : '音の設定'}
			onclick={() => {
				showAudio = !showAudio;
				if (showAudio) showScript = false;
			}}
		>
			音の設定
		</button>
		<button
			type="button"
			class="btn btn--sm"
			class:btn--ink={presentOpen}
			title="黄色い枠だけを別の窓に出します（Zoom や Meet で共有する用。編集に連動します）"
			onclick={togglePresent}
		>
			{presentOpen ? 'プレゼン用の窓を閉じる' : 'プレゼン用の窓'}
		</button>
		<div class="ws__orient" role="group" aria-label="動画の向き">
			<button
				type="button"
				class="btn btn--sm"
				class:btn--ink={!portrait}
				disabled={recording || busy}
				title="横 16:9（YouTube の通常の動画）"
				onclick={() => library.setOrientation(note.id, 'landscape')}>横</button
			>
			<button
				type="button"
				class="btn btn--sm"
				class:btn--ink={portrait}
				disabled={recording || busy}
				title="縦 9:16（ショート動画）。木は下に広がります"
				onclick={() => library.setOrientation(note.id, 'portrait')}>縦</button
			>
		</div>
		<button
			type="button"
			class="btn btn--sm"
			title="子のあるノードを全部閉じる（⌘Z で戻せます）"
			onclick={() => {
				library.collapseAll(note.id);
				map?.fitAll();
			}}
		>
			全部閉じる
		</button>
		<button
			type="button"
			class="btn btn--sm"
			title="閉じているノードを全部開く（⌘Z で戻せます）"
			onclick={() => {
				library.expandAll(note.id);
				map?.fitAll();
			}}
		>
			全部開く
		</button>
		<button
			type="button"
			class="btn btn--sm"
			title="手で動かしたノードを全部、自動の位置に戻す（⌘Z で戻せます）"
			disabled={!library.hasManualPositions(note.id) || recording}
			onclick={() => {
				library.resetAllPositions(note.id);
			}}
		>
			位置を全部戻す
		</button>
		<button
			type="button"
			class="btn ws__rec"
			class:btn--primary-rec={!recording}
			class:btn--ink={recording}
			onclick={toggleRecording}
			disabled={busy}
			aria-pressed={recording}
		>
			<span class="ws__rec-dot" class:ws__rec-dot--stop={recording} aria-hidden="true"></span>
			{recording
				? '停止する'
				: countdown !== null
					? '取りやめる'
					: busy
						? '少しお待ちください…'
						: '収録をはじめる'}
		</button>
		<span class="muted ws__note">
			{recording
				? 'ノードを選ぶと、その時刻がしるしとして残ります。'
				: '黄色い枠の中と、マイクの声が動画になります。BGM は書き出しのときに重ねます。'}
		</span>
	</div>
</div>

{#if showKeys}
	<ShortcutsPanel kind="map" onClose={() => (showKeys = false)} />
{/if}
{#if showThumb}
	<ThumbnailPanel {note} onClose={() => (showThumb = false)} />
{/if}

<style>
	.ws__count {
		position: fixed;
		inset: 0;
		z-index: 50;
		display: grid;
		place-content: center;
		gap: 18px;
		background: rgba(28, 24, 18, 0.55);
		text-align: center;
	}
	.ws__count-num {
		width: 220px;
		height: 220px;
		margin: 0 auto;
		border-radius: 50%;
		background: var(--yellow);
		border: 4px solid var(--ink);
		box-shadow: 8px 8px 0 var(--ink);
		display: grid;
		place-items: center;
		font-size: 140px;
		font-weight: 900;
		line-height: 1;
		color: var(--ink);
		animation: ws-pop 0.35s ease-out;
	}
	.ws__count-hint {
		color: var(--cream);
		font-weight: 900;
		font-size: 16px;
		letter-spacing: 0.04em;
	}
	@keyframes ws-pop {
		from {
			transform: scale(0.7);
			opacity: 0;
		}
		to {
			transform: scale(1);
			opacity: 1;
		}
	}
	/* 枠の外は水色。枠（黄色）だけが動画になる */
	.ws {
		height: 100vh;
		display: grid;
		grid-template-rows: auto minmax(0, 1fr) auto;
		background: var(--sky);
		color: var(--ink);
		padding: 0 24px 18px;
		gap: 18px; /* 枠とボタンの列が触れないように、少し空ける */
	}
	.ws :global(.muted) {
		color: var(--ink);
		opacity: 0.8;
	}
	.ws :global(.status) {
		color: var(--ink);
	}
	.ws__top {
		height: var(--titlebar);
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		padding-left: 60px; /* 信号機ボタンの分 */
		-webkit-app-region: drag; /* ここを掴んでウィンドウを動かせる */
	}
	.ws__top-left {
		display: flex;
		gap: 10px;
		-webkit-app-region: no-drag;
	}
	.ws__top-right {
		display: flex;
		align-items: center;
		gap: 14px;
		-webkit-app-region: no-drag;
	}
	.ws__status {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		border: 2px solid var(--ink);
		border-radius: 999px;
		padding: 4px 14px;
		font-size: 12.5px;
		font-weight: 900;
		letter-spacing: 0.08em;
		background: var(--cream);
		color: var(--ink);
		font-variant-numeric: tabular-nums;
	}
	.ws__status--on {
		background: var(--ink);
		color: var(--yellow);
	}
	.ws__dot {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		background: var(--sand);
	}
	.ws__status--on .ws__dot {
		background: var(--rec);
		animation: blink 1.1s ease-in-out infinite;
	}
	.ws__silent {
		font-size: 12.5px;
		font-weight: 900;
		color: var(--cream);
		background: var(--alert);
		border-radius: 999px;
		padding: 4px 12px;
		animation: blink 1.1s ease-in-out infinite;
	}
	.ws__meter {
		width: 90px;
		height: 12px;
		border: 2px solid var(--ink);
		border-radius: 999px;
		background: var(--cream);
		overflow: hidden;
	}
	.ws__meter-bar {
		height: 100%;
		width: 100%;
		background: var(--ink);
		transform-origin: left center;
		transition: transform 0.08s linear;
	}
	.ws__body {
		min-height: 0;
		/* 中身（枠＋脇の欄）に合わせて広がらないようにする。広がると枠の幅の計算が自分の幅を見てしまい、
		   全画面のときに脇の欄が画面の外に出る */
		min-width: 0;
		max-width: 100%;
		overflow: hidden;
		display: flex;
		gap: 16px;
		justify-content: center;
		align-items: stretch;
	}
	/* 16:9 の枠。画面に収まる最大の大きさで、本文の上に寄せる（中央寄せだと下の列の高さが変わったとき枠が動く） */
	.ws__frame {
		align-self: flex-start;
		/* 幅は JS で決める（置き場所の高さと幅から 16:9 で収まる最大） */
		min-height: 0;
		min-width: 0;
		flex: 0 0 auto;
	}
	.ws__script {
		flex: 0 0 440px;
		min-height: 0;
		display: grid;
	}
	.ws__orient {
		display: inline-flex;
		gap: 4px;
		padding: 3px;
		border: 2px solid var(--ink);
		border-radius: 999px;
		background: var(--cream);
	}
	.ws__orient .btn {
		min-height: 30px;
		padding: 2px 14px;
		box-shadow: none;
	}
	.ws__bottom {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 14px;
		flex-wrap: wrap;
		/* 高さを 2 行分に固定する。収録の前後で案内文の長さが変わって高さが変わると、本文の高さも変わってしまう */
		min-height: 88px;
		align-content: center;
		padding-top: 4px; /* 影（4px）の分。ウィンドウが小さくても枠に触れない */
	}
	/* 案内文は 1 行に収める（折り返しで列の高さが変わらないように） */
	.ws__note {
		flex: 0 1 auto;
		min-width: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.ws__rec {
		min-width: 200px;
	}
	.ws__rec-dot {
		width: 12px;
		height: 12px;
		border-radius: 50%;
		background: var(--rec);
		box-shadow: 0 0 0 2px var(--yellow);
	}
	.ws__rec-dot--stop {
		border-radius: 2px;
		background: var(--yellow);
		box-shadow: none;
	}
	@keyframes blink {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.25;
		}
	}
</style>
