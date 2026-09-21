<script lang="ts">
	/**
	 * 動画のサムネ（1 枚）。YouTube に付けるのと、投稿管理の札に出すのに使う。
	 * 選び方（draft.thumbMode: sheet = 図つき、file = 選んだ画像。ノートが無ければ auto）は
	 * 投稿の画面が持つ YouTube の draft に入っている（YouTube を使わなくても札のために写す）。
	 * 既定は「サムネを作る」の図つきサムネ。欄にその見た目を出し、確定や投稿のときに写して付ける
	 */
	import type { Recording, Note, ExportInfo } from '$shared/types';
	import { api } from '$lib/api';
	import { toast } from '$lib/stores/toast.svelte';
	import ThumbnailSheet from '../ThumbnailSheet.svelte';
	import ThumbnailPanel from '../ThumbnailPanel.svelte';
	import type { Draft } from './draft';

	let {
		recording,
		exportInfo,
		note,
		draft = $bindable(),
		locked = false
	}: {
		recording: Recording;
		exportInfo: ExportInfo;
		note: Note | null;
		draft: Draft;
		locked?: boolean;
	} = $props();

	let sheet = $state<ThumbnailSheet | null>(null);
	let editingThumb = $state(false);
	let filePreview = $state<string | null>(null);
	/** ノートに覚えたサムネの状態（作り直したら変わる） */
	const savedThumb = $derived(note?.thumbnail ?? null);
	const sheetText = $derived(
		savedThumb?.text ?? (note?.title.trim() || note?.root.text.trim() || '')
	);
	const sheetSize = $derived(savedThumb?.size ?? 9);
	$effect(() => {
		if (!note && draft.thumbMode === 'sheet') draft.thumbMode = 'auto';
	});
	$effect(() => {
		const p = draft.thumbMode === 'file' ? draft.thumbnailPath : null;
		if (!p) {
			filePreview = null;
			return;
		}
		void api()
			.publish.imageDataUrl(p)
			.then((u) => (filePreview = u));
	});

	async function pickThumbnail() {
		try {
			const p = await api().publish.pickImage();
			if (p) {
				draft.thumbnailPath = p;
				draft.thumbMode = 'file';
			}
		} catch (err) {
			toast.error((err as Error).message);
		}
	}

	/** 図つきサムネなら、いま見えている欄を写して保存先に置き、draft.thumbnailPath に入れる（確定・投稿のときに呼ぶ） */
	export async function captureThumbnail(): Promise<void> {
		if (draft.thumbMode !== 'sheet' || !sheet) return;
		await sheet.prepareCapture();
		const r = sheet.rect();
		if (!r) return;
		const p = await api().publish.captureThumbnail(recording.id, r, exportInfo.id);
		if (p) draft.thumbnailPath = p;
	}
</script>

<section class="card tc">
	<h2 class="card__title">サムネイル</h2>
	{#if draft.thumbMode === 'sheet' && note}
		{#key JSON.stringify(savedThumb)}
			<div class="tc__sheet">
				<ThumbnailSheet
					bind:this={sheet}
					{note}
					text={sheetText}
					size={sheetSize}
					saved={savedThumb}
				/>
			</div>
		{/key}
		<span class="muted"
			>「サムネを作る」の図つきサムネ。確定のときにこの見た目を写して、YouTube
			と投稿管理の札に使います</span
		>
	{:else if draft.thumbMode === 'file' && draft.thumbnailPath}
		{#if filePreview}<img class="tc__img" src={filePreview} alt="選んだサムネイル" />{/if}
		<span class="muted tc__file">{draft.thumbnailPath}</span>
	{:else}
		<div class="tc__none muted">ノートが無いので、YouTube が自動で選びます（札は題名だけ）</div>
	{/if}
	<div class="tc__row">
		{#if note}
			<button type="button" class="chip" onclick={() => (editingThumb = true)} disabled={locked}
				>サムネを作る・直す</button
			>
			{#if draft.thumbMode !== 'sheet'}
				<button
					type="button"
					class="chip"
					onclick={() => (draft.thumbMode = 'sheet')}
					disabled={locked}>図つきサムネに戻す</button
				>
			{/if}
		{/if}
		<button type="button" class="chip" onclick={pickThumbnail} disabled={locked}>画像を選ぶ</button>
	</div>
</section>

{#if editingThumb && note}
	<ThumbnailPanel {note} onClose={() => (editingThumb = false)} />
{/if}

<style>
	.tc {
		display: grid;
		gap: 8px;
		align-content: start;
		font-size: 12.5px;
	}
	.tc__sheet {
		/* 中の枠線（cqw）の基準 */
		container-type: inline-size;
		width: 100%;
		/* ここでは絵として見せるだけ（図のボタンは押せない。直すのは「サムネを作る・直す」で） */
		pointer-events: none;
		user-select: none;
	}
	.tc__img {
		width: 100%;
		aspect-ratio: 16 / 9;
		object-fit: cover;
		border: 2px solid var(--ink);
		border-radius: 6px;
		background: #000;
	}
	.tc__none {
		width: 100%;
		aspect-ratio: 16 / 9;
		display: grid;
		place-items: center;
		border: 2px dashed var(--ink);
		border-radius: 6px;
		text-align: center;
		padding: 12px;
	}
	.tc__file {
		font-size: 12px;
		word-break: break-all;
	}
	.tc__row {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}
</style>
