<script lang="ts">
	import type { SaveStatus } from '$lib/stores/library.svelte';
	import { formatTime } from '$lib/utils/format';

	let { status, onRetry }: { status: SaveStatus; onRetry: () => void } = $props();
</script>

<span class="status status--{status.state}" role="status" aria-live="polite">
	{#if status.state === 'saving'}
		<span class="status__dot" aria-hidden="true"></span>保存中…
	{:else if status.state === 'dirty'}
		<span class="status__dot" aria-hidden="true"></span>入力中…
	{:else if status.state === 'saved'}
		✓ 保存済み {formatTime(status.at)}
	{:else if status.state === 'error'}
		！ 保存に失敗しました
		<button type="button" class="status__retry" onclick={onRetry}>再試行</button>
	{:else}
		&nbsp;
	{/if}
</span>

<style>
	.status {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12.5px;
		font-weight: 900;
		letter-spacing: 0.04em;
		color: var(--brown);
		min-height: 24px;
	}
	.status--saved {
		color: var(--ink);
	}
	.status--error {
		color: var(--alert);
	}
	.status__dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--gold);
		animation: blink 1s ease-in-out infinite;
	}
	.status__retry {
		border: 2px solid var(--alert);
		border-radius: 999px;
		background: var(--cream);
		color: var(--alert);
		font-weight: 900;
		font-size: 12px;
		padding: 2px 10px;
		cursor: pointer;
	}
	@keyframes blink {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.3;
		}
	}
</style>
