<script lang="ts">
	import { toast } from '$lib/stores/toast.svelte';
</script>

{#if toast.current}
	{@const t = toast.current}
	<div
		class="toast toast--{t.kind}"
		role={t.kind === 'error' ? 'alert' : 'status'}
		aria-live="polite"
	>
		<span class="toast__icon" aria-hidden="true">{t.kind === 'ok' ? '✓' : '！'}</span>
		<span class="toast__text">{t.text}</span>
		<button type="button" class="toast__close" onclick={() => toast.close()} aria-label="閉じる"
			>×</button
		>
	</div>
{/if}

<style>
	/* 通知が出ている間も下のボタンを押せるように、クリックは素通りさせる（× だけ押せる） */
	.toast {
		pointer-events: none;
		position: fixed;
		left: 50%;
		bottom: 22px;
		transform: translateX(-50%);
		z-index: 100;
		display: flex;
		align-items: center;
		gap: 12px;
		max-width: min(92vw, 560px);
		background: var(--ink);
		color: var(--paper);
		border: var(--border);
		border-radius: 999px;
		padding: 10px 12px 10px 16px;
		box-shadow: var(--shadow);
		font-size: 14px;
		font-weight: 700;
		animation: rise 0.18s ease-out;
	}
	.toast--error {
		background: var(--alert-bg);
		color: var(--ink);
		border-color: var(--alert);
		box-shadow: 4px 4px 0 var(--alert);
		border-radius: 18px;
	}
	.toast__icon {
		flex: none;
		width: 26px;
		height: 26px;
		border-radius: 50%;
		background: var(--yellow);
		color: var(--ink);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font-weight: 900;
		font-size: 14px;
	}
	.toast--error .toast__icon {
		background: var(--alert);
		color: var(--cream);
	}
	.toast__text {
		flex: 1;
		min-width: 0;
	}
	.toast__close {
		pointer-events: auto;
		flex: none;
		width: 32px;
		height: 32px;
		border-radius: 50%;
		border: 0;
		background: transparent;
		color: inherit;
		font-size: 20px;
		cursor: pointer;
		line-height: 1;
	}
	@keyframes rise {
		from {
			opacity: 0;
			transform: translate(-50%, 8px);
		}
		to {
			opacity: 1;
			transform: translate(-50%, 0);
		}
	}
</style>
