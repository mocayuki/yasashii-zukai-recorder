<script lang="ts">
	import { onMount } from 'svelte';
	import { api, hasApi } from '$lib/api';
	import { library } from '$lib/stores/library.svelte';
	import { storage } from '$lib/stores/storage.svelte';
	import { toast } from '$lib/stores/toast.svelte';
	import { ui } from '$lib/stores/ui.svelte';
	import AppHeader from '$lib/components/AppHeader.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import Workspace from '$lib/components/Workspace.svelte';
	import RecordingEditor from '$lib/components/RecordingEditor.svelte';
	import PublishScreen from '$lib/components/publish/PublishScreen.svelte';
	import ScheduleScreen from '$lib/components/publish/ScheduleScreen.svelte';
	import ExportBar from '$lib/components/ExportBar.svelte';
	import NoteEditor from '$lib/components/NoteEditor.svelte';
	import SettingsPanel from '$lib/components/SettingsPanel.svelte';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import PresentView from '$lib/components/PresentView.svelte';

	/** プレゼン用の窓として開かれたか（#present=<noteId>） */
	const presentNoteId = (() => {
		const h = typeof location === 'undefined' ? '' : location.hash;
		return h.startsWith('#present=') ? decodeURIComponent(h.slice('#present='.length)) : null;
	})();

	let settingsOpen = $state(false);
	const inApp = hasApi();

	onMount(() => {
		if (!inApp) return;
		void library.load();
		void storage.refresh();

		// 画面を隠す・閉じる前に、待っている自動保存を書き切る
		const flush = () => void library.flush();
		document.addEventListener('visibilitychange', () => {
			if (document.visibilityState === 'hidden') flush();
		});
		window.addEventListener('beforeunload', flush);
		const timer = setInterval(() => void storage.refresh(), 60_000);
		// ウィンドウが画面全体かどうかは OS の状態に追従する
		const offFs = api().app.onFullScreenChange((isFs) => {
			ui.fullscreen = isFs;
		});
		return () => {
			window.removeEventListener('beforeunload', flush);
			clearInterval(timer);
			offFs();
		};
	});

	async function newNote() {
		try {
			await library.createNote();
			// 新しいノートはそのままワークスペースで書き始める
			ui.enterWorkspace();
		} catch (err) {
			toast.error((err as Error).message);
		}
	}

	async function importLegacy() {
		try {
			const r = await api().legacy.importBackup();
			if (r) {
				await library.load();
				await storage.refresh();
				toast.show(`取り込みました：ノート ${r.notes} 件、収録 ${r.recordings} 件`);
			}
		} catch (err) {
			toast.error((err as Error).message);
		}
	}

	// ---- 左の一覧の幅（ドラッグで変えて、この Mac に覚える） ----
	const SIDEBAR_KEY = 'yasashii.sidebarWidth';
	const SIDEBAR_MIN = 220;
	const SIDEBAR_MAX = 600;
	let sidebarW = $state(320);
	let resizing = $state(false);
	try {
		const saved = Number(localStorage.getItem(SIDEBAR_KEY));
		if (saved >= SIDEBAR_MIN && saved <= SIDEBAR_MAX) sidebarW = saved;
	} catch {
		/* 覚えていなくても動く */
	}
	function startResize(e: PointerEvent) {
		if (e.button !== 0) return;
		e.preventDefault();
		resizing = true;
		const startX = e.clientX;
		const startW = sidebarW;
		const move = (ev: PointerEvent) => {
			sidebarW = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, startW + (ev.clientX - startX)));
		};
		const up = () => {
			resizing = false;
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			try {
				localStorage.setItem(SIDEBAR_KEY, String(sidebarW));
			} catch {
				/* 保存できなくても動く */
			}
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
	}
</script>

{#if !inApp}
	<main class="standalone">
		<div class="card">
			<h1 class="card__title">やさしい図解レコーダー</h1>
			<p>このアプリは Electron の中で動きます。ターミナルで次を実行してください。</p>
			<pre>npm run dev</pre>
		</div>
	</main>
{:else if presentNoteId}
	<!-- プレゼン用の窓: 黄色い枠だけ -->
	<PresentView noteId={presentNoteId} />
{:else if ui.scheduleOpen}
	<ScheduleScreen
		onBack={() => (ui.scheduleOpen = false)}
		onOpenPublish={(recordingId, exportId) => {
			ui.scheduleOpen = false;
			ui.publishing = { recordingId, exportId };
		}}
	/>
{:else if ui.publishing && library.recordings.find((r) => r.id === ui.publishing?.recordingId)}
	{@const rec = library.recordings.find((r) => r.id === ui.publishing?.recordingId)!}
	{#key rec.id + ui.publishing.exportId}
		<PublishScreen
			recording={rec}
			exportId={ui.publishing.exportId}
			note={library.notes.find((n) => n.id === rec.noteId) ?? null}
			onBack={() => (ui.publishing = null)}
			onEdit={() => {
				ui.editingRecordingId = rec.id;
				ui.publishing = null;
			}}
			onOpenSchedule={() => (ui.scheduleOpen = true)}
		/>
	{/key}
{:else if ui.editingRecordingId && library.recordings.find((r) => r.id === ui.editingRecordingId)}
	{@const rec = library.recordings.find((r) => r.id === ui.editingRecordingId)!}
	{#key rec.id}
		<RecordingEditor recording={rec} onClose={() => (ui.editingRecordingId = null)} />
	{/key}
{:else if ui.workspace && library.selected}
	{#key library.selected.id}
		<Workspace note={library.selected} onExit={() => ui.leaveWorkspace()} />
	{/key}
{:else}
	<div class="app">
		<AppHeader
			onOpenSettings={() => (settingsOpen = true)}
			onOpenSchedule={() => (ui.scheduleOpen = true)}
		/>
		<div class="app__body" style="--sidebar-w: {sidebarW}px">
			<Sidebar onNewNote={newNote} />
			<!-- 一覧の幅を変えるつまみ（幅はこの Mac に覚える） -->
			<div
				class="app__resizer"
				class:app__resizer--active={resizing}
				role="separator"
				aria-orientation="vertical"
				aria-label="一覧の幅"
				title="ドラッグで一覧の幅を変えます"
				onpointerdown={startResize}
			></div>
			<main class="main">
				{#if library.selected}
					{#key library.selected.id}
						<NoteEditor note={library.selected} />
					{/key}
				{:else}
					<EmptyState onNewNote={newNote} onImportLegacy={importLegacy} />
				{/if}
			</main>
		</div>
		<SettingsPanel open={settingsOpen} onClose={() => (settingsOpen = false)} />
	</div>
{/if}

<!-- 書き出しの進み具合（編集画面を閉じても右下に出る） -->
{#if !presentNoteId}
	<ExportBar />
{/if}

<style>
	.main {
		min-height: 0;
		overflow-y: auto;
		background: var(--yellow);
	}
	.standalone {
		display: grid;
		place-items: center;
		height: 100vh;
		padding: 24px;
	}
	.standalone pre {
		background: var(--ink);
		color: var(--yellow);
		padding: 12px 16px;
		border-radius: 12px;
		user-select: text;
	}
</style>
