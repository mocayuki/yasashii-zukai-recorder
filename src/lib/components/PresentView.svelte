<script lang="ts">
	import { onDestroy } from 'svelte';
	import type { Note, PresentCamera, PresentState } from '$shared/types';
	import { api } from '$lib/api';
	import MindMap from './MindMap.svelte';

	/**
	 * プレゼン用の窓の中身。黄色い枠だけを窓いっぱいに出す（Zoom や Meet で「この窓」を共有する）。
	 * ワークスペースの編集（開閉・文字・選択）は IPC で届き、そのまま映る。この窓では操作できない
	 */
	let { noteId }: { noteId: string } = $props();

	let note = $state<Note | null>(null);
	let selectedId = $state<string | null>(null);
	let openImage = $state<string | null>(null);
	let camera = $state<PresentCamera | null>(null);
	let error = $state<string | null>(null);

	// 最初はファイルから読む（ワークスペースからの更新が来れば、そちらで上書きされる）
	$effect(() => {
		void api()
			.notes.list()
			.then((notes) => {
				const found = notes.find((n) => n.id === noteId);
				if (!found && !note) error = 'ノートが見つかりません。';
				else if (found && !note) note = found;
			})
			.catch((err: Error) => (error = err.message));
	});

	// 向き（横／縦）が変わったら、窓の形も合わせる
	let lastPortrait: boolean | null = null;
	$effect(() => {
		if (!note) return;
		const portrait = note.orientation === 'portrait';
		if (lastPortrait !== portrait) {
			lastPortrait = portrait;
			void api().present.setOrientation(portrait);
		}
	});

	const off = api().present.onUpdate((state: PresentState) => {
		note = state.note;
		selectedId = state.selectedId;
		openImage = state.openImage ?? null;
		error = null;
	});
	const offCam = api().present.onCamera((c) => (camera = c));
	onDestroy(() => {
		off();
		offCam();
	});
</script>

<div class="present" class:present--portrait={note?.orientation === 'portrait'}>
	{#if note}
		{#key note.id}
			<MindMap
				{note}
				stageMode
				presenting
				mirror
				remoteSelectedId={selectedId}
				remoteOpenImage={openImage}
				remoteCamera={camera}
			/>
		{/key}
	{:else if error}
		<p class="present__msg">{error}</p>
	{:else}
		<p class="present__msg">読み込んでいます…</p>
	{/if}
</div>

<style>
	.present {
		width: 100vw;
		height: 100vh;
		display: grid;
		background: var(--yellow);
		overflow: hidden;
	}
	.present__msg {
		align-self: center;
		justify-self: center;
		font-weight: 900;
	}
</style>
