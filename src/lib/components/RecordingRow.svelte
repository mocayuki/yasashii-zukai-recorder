<script lang="ts">
	import { exportsOf, type Recording } from '$shared/types';
	import { formatBytes, formatDateTime, formatDuration } from '$lib/utils/format';

	/** 収録 1 件を 1 行で。クリックで編集画面へ。onSelect を渡すと左にチェックが付く（一括削除用） */
	let {
		recording,
		onOpen,
		selected = false,
		onSelect,
		onPublish
	}: {
		recording: Recording;
		onOpen: () => void;
		selected?: boolean;
		onSelect?: (checked: boolean) => void;
		/** SNS 投稿の画面へ（書き出し済みのときだけボタンが出る） */
		onPublish?: () => void;
	} = $props();

	const kindLabel = $derived(
		recording.kind === 'stage'
			? '枠の収録'
			: recording.kind === 'mic'
				? 'マイク'
				: recording.kind === 'screen'
					? '画面'
					: '画面＋マイク'
	);
</script>

<div class="row" class:row--selected={selected}>
	{#if onSelect}
		<input
			type="checkbox"
			class="row__pick"
			checked={selected}
			aria-label="この収録を選ぶ"
			onchange={(e) => onSelect?.(e.currentTarget.checked)}
		/>
	{/if}
	<button type="button" class="row__btn" onclick={onOpen}>
		<span class="row__thumb" class:row__thumb--video={recording.hasVideo} aria-hidden="true"></span>
		<span class="row__main">
			<span class="row__title">
				<span class="chip chip--static row__kind">{kindLabel}</span>
				{formatDateTime(recording.createdAt)}
				{#if recording.status === 'recovered'}
					<span class="row__warn">途中で終了した分</span>
				{/if}
			</span>
			<span class="row__meta">
				{formatDuration(recording.durationMs)}・{formatBytes(recording.size)}
				{#if recording.markers.length > 0}
					・しるし {recording.markers.length}
				{/if}
			</span>
		</span>
		<span class="row__open">開く →</span>
	</button>
	{#if onPublish && exportsOf(recording).length > 0}
		<button
			type="button"
			class="btn btn--sm btn--green row__publish"
			onclick={onPublish}
			title="書き出し済み。SNS 投稿の画面へ">SNS投稿</button
		>
	{/if}
</div>

<style>
	.row {
		width: 100%;
		display: flex;
		align-items: center;
		gap: 12px;
		background: var(--cream);
		border: var(--border);
		border-radius: 14px;
		padding: 10px 16px 10px 12px;
		box-shadow: 3px 3px 0 var(--ink);
		transition:
			transform 0.08s ease,
			box-shadow 0.08s ease;
	}
	.row--selected {
		background: var(--yellow);
	}
	.row:hover {
		transform: translate(1px, 1px);
		box-shadow: 2px 2px 0 var(--ink);
	}
	.row__pick {
		flex: none;
		width: 22px;
		height: 22px;
		margin: 0;
		accent-color: var(--ink);
		cursor: pointer;
	}
	.row__btn {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 14px;
		text-align: left;
		background: none;
		border: 0;
		padding: 0;
		font: inherit;
		color: inherit;
		cursor: pointer;
	}
	.row__btn:focus-visible {
		outline: 3px solid var(--gold);
		outline-offset: 2px;
		border-radius: 8px;
	}
	.row__thumb {
		flex: none;
		width: 44px;
		height: 28px;
		border: 2px solid var(--ink);
		border-radius: 6px;
		background: var(--yellow);
		position: relative;
	}
	.row__thumb--video::after {
		content: '';
		position: absolute;
		left: 50%;
		top: 50%;
		transform: translate(-40%, -50%);
		border-left: 10px solid var(--ink);
		border-top: 6px solid transparent;
		border-bottom: 6px solid transparent;
	}
	.row__main {
		flex: 1;
		min-width: 0;
		display: grid;
		gap: 2px;
	}
	.row__title {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 14px;
		font-weight: 900;
		flex-wrap: wrap;
	}
	.row__kind {
		min-height: 24px;
		padding: 1px 9px;
		font-size: 11.5px;
	}
	.row__warn {
		font-size: 11.5px;
		font-weight: 900;
		color: var(--alert);
	}
	.row__meta {
		font-size: 12.5px;
		color: var(--brown);
		font-weight: 700;
	}
	.row__open {
		flex: none;
		font-size: 13px;
		font-weight: 900;
		white-space: nowrap;
	}
	.row__publish {
		flex: none;
		align-self: center;
	}
</style>
