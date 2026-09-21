<script lang="ts">
	import { storage } from '$lib/stores/storage.svelte';
	import { formatBytes } from '$lib/utils/format';

	let { onclick }: { onclick: () => void } = $props();

	const folderName = $derived(storage.info?.libraryPath.split('/').filter(Boolean).pop() ?? '');
</script>

<button type="button" class="badge" {onclick} title={storage.info?.libraryPath ?? ''}>
	{#if storage.error}
		<span class="badge__warn">！</span>
		<span>保存先を確認できません</span>
	{:else if storage.info}
		<span class="badge__folder" aria-hidden="true"></span>
		<span class="badge__name">{folderName}</span>
		<span class="badge__sep" aria-hidden="true">・</span>
		<span>使用 {formatBytes(storage.info.usedBytes)}</span>
		{#if storage.info.freeBytes !== null}
			<span class="badge__sep" aria-hidden="true">・</span>
			<span>空き {formatBytes(storage.info.freeBytes)}</span>
		{/if}
	{:else}
		<span>保存先を確認中…</span>
	{/if}
</button>

<style>
	.badge {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		border: 2px solid var(--ink);
		border-radius: 999px;
		background: var(--cream);
		padding: 5px 14px;
		font-size: 12.5px;
		font-weight: 700;
		cursor: pointer;
		min-height: 34px;
		max-width: 46vw;
		white-space: nowrap;
		overflow: hidden;
	}
	.badge:hover {
		background: #fff;
	}
	.badge__folder {
		width: 14px;
		height: 11px;
		border: 2px solid var(--ink);
		border-radius: 3px;
		border-top-left-radius: 0;
		position: relative;
		flex: none;
	}
	.badge__folder::before {
		content: '';
		position: absolute;
		left: -2px;
		top: -5px;
		width: 6px;
		height: 3px;
		background: var(--ink);
		border-radius: 2px 2px 0 0;
	}
	.badge__name {
		font-weight: 900;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.badge__sep {
		color: var(--brown);
	}
	.badge__warn {
		color: var(--alert);
		font-weight: 900;
	}
</style>
