<script lang="ts">
	import type { Note } from '$shared/types';

	/** ノート 1 件。題名だけの 1 行（数が増えても一覧が長くならないように）。フォルダーへドラッグできる */
	let {
		note,
		selected,
		hasRecording = false,
		hasExport = false,
		onclick
	}: {
		note: Note;
		selected: boolean;
		hasRecording?: boolean;
		/** 書き出し済みの収録がある（SNS 投稿の準備ができている）→ 丸は緑 */
		hasExport?: boolean;
		onclick: () => void;
	} = $props();
</script>

<button
	type="button"
	class="item"
	class:item--selected={selected}
	role="option"
	aria-selected={selected}
	draggable="true"
	ondragstart={(e) => {
		e.dataTransfer?.setData('text/note-id', note.id);
		if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
	}}
	{onclick}
>
	{#if note.orientation === 'portrait'}
		<span class="item__mark" title="縦の動画（ショート）" aria-label="縦">縦</span>
	{/if}
	<span class="item__title">{note.title.trim() || '無題のノート'}</span>
	{#if hasExport}
		<span
			class="item__dot item__dot--ready"
			title="SNS 投稿の準備あり"
			aria-label="SNS 投稿の準備あり"
		></span>
	{:else if hasRecording}
		<span class="item__dot" title="収録あり" aria-label="収録あり"></span>
	{/if}
</button>

<style>
	.item {
		width: 100%;
		min-width: 0;
		max-width: 100%;
		display: flex;
		align-items: center;
		gap: 8px;
		text-align: left;
		background: var(--cream);
		border: 2.5px solid var(--ink);
		border-radius: 12px;
		padding: 8px 12px;
		cursor: pointer;
		box-shadow: 2px 2px 0 var(--ink);
		transition:
			transform 0.08s ease,
			box-shadow 0.08s ease;
	}
	.item:hover {
		transform: translate(1px, 1px);
		box-shadow: 1px 1px 0 var(--ink);
	}
	.item:focus-visible {
		outline: 3px solid var(--gold);
		outline-offset: 2px;
	}
	.item--selected {
		background: var(--ink);
		color: var(--cream);
	}
	.item__title {
		flex: 1;
		min-width: 0;
		font-size: 14px;
		font-weight: 900;
		line-height: 1.4;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.item__mark {
		flex: none;
		font-size: 10.5px;
		font-weight: 900;
		line-height: 1;
		padding: 3px 5px;
		border-radius: 6px;
		border: 2px solid currentColor;
	}
	/* 収録あり = 黄色、書き出し済み（SNS 投稿の準備あり）= 緑。縁は無し */
	.item__dot {
		flex: none;
		width: 12px;
		height: 12px;
		border-radius: 50%;
		background: var(--gold);
	}
	.item__dot--ready {
		background: var(--green);
	}
</style>
