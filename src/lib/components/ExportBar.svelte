<script lang="ts">
	import { exports } from '$lib/stores/exports.svelte';
	import { ui } from '$lib/stores/ui.svelte';
	import { schedule } from '$lib/stores/schedule.svelte';

	/** 進んでいる書き出しのうち、いま開いている編集画面のもの以外（そちらには編集画面の中に出る） */
	const shown = $derived(exports.active.filter((j) => j.id !== ui.editingRecordingId));
	/** 投稿管理の「確定する」の送信中（投稿管理を閉じているときだけ。開いていればそちらに出る） */
	const sending = $derived(!ui.scheduleOpen && schedule.applying ? schedule.applying : null);
</script>

{#if shown.length > 0 || sending}
	<div class="xbar" role="status" aria-live="polite">
		{#if sending}
			<div class="xbar__job xbar__job--green">
				<span class="xbar__dot" aria-hidden="true"></span>
				<span class="xbar__text">
					予約を送っています: {sending}
					{schedule.ratio > 0 ? `${Math.round(schedule.ratio * 100)}%` : ''}
				</span>
				<div class="xbar__track" aria-hidden="true">
					<div class="xbar__bar" style="transform: scaleX({schedule.ratio})"></div>
				</div>
				<button type="button" class="xbar__cancel" onclick={() => (ui.scheduleOpen = true)}
					>投稿管理</button
				>
			</div>
		{/if}
		{#each shown as j (j.id)}
			<div class="xbar__job">
				<span class="xbar__dot" aria-hidden="true"></span>
				<span class="xbar__text">
					{j.trial ? '試し書き出し' : '書き出し'}「{j.title}」
					{j.phase === 'preparing' ? '準備中…' : `${Math.round(j.ratio * 100)}%`}
				</span>
				<div class="xbar__track" aria-hidden="true">
					<div class="xbar__bar" style="transform: scaleX({j.ratio})"></div>
				</div>
				<button type="button" class="xbar__cancel" onclick={() => exports.cancel(j.id)}>中止</button
				>
			</div>
		{/each}
	</div>
{/if}

<style>
	/* 画面の右下に固定。編集画面を閉じても書き出しが続いていることが分かる */
	.xbar {
		position: fixed;
		right: 22px;
		bottom: 22px;
		z-index: 90;
		display: grid;
		gap: 8px;
		pointer-events: none;
	}
	.xbar__job {
		pointer-events: auto;
		display: flex;
		align-items: center;
		gap: 10px;
		background: var(--ink);
		color: var(--cream);
		border: var(--border);
		border-radius: 999px;
		padding: 8px 10px 8px 14px;
		box-shadow: var(--shadow);
		font-size: 13px;
		font-weight: 700;
		max-width: min(92vw, 560px);
	}
	/* SNS 投稿の送信は緑（投稿の画面と同じ決まり） */
	.xbar__job--green {
		--yellow: var(--green);
	}
	.xbar__dot {
		flex: none;
		width: 10px;
		height: 10px;
		border-radius: 50%;
		background: var(--yellow);
		animation: blink 1.1s ease-in-out infinite;
	}
	.xbar__text {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
	}
	.xbar__track {
		flex: none;
		width: 90px;
		height: 8px;
		border-radius: 999px;
		background: rgba(255, 253, 246, 0.25);
		overflow: hidden;
	}
	.xbar__bar {
		height: 100%;
		width: 100%;
		background: var(--yellow);
		transform-origin: left;
		transition: transform 0.2s linear;
	}
	.xbar__cancel {
		flex: none;
		border: 2px solid var(--cream);
		border-radius: 999px;
		background: transparent;
		color: var(--cream);
		font: inherit;
		font-weight: 900;
		padding: 2px 10px;
		cursor: pointer;
	}
	@keyframes blink {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.35;
		}
	}
</style>
