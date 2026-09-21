<script lang="ts">
	/**
	 * サムネイル（YouTube 用 1280×720 の PNG）を作る。
	 * 上半分は大きな文字（黄色の地）、下半分は図。図はドラッグとホイールで好きな範囲に合わせられる。
	 * 見えているままを Electron 側で写して（capturePage）1280×720 に縮める。写す範囲は ThumbnailSheet
	 */
	import type { Note } from '$shared/types';
	import { api } from '$lib/api';
	import { toast } from '$lib/stores/toast.svelte';
	import { library } from '$lib/stores/library.svelte';
	import { onDestroy } from 'svelte';
	import ThumbnailSheet from './ThumbnailSheet.svelte';

	let { note, onClose }: { note: Note; onClose: () => void } = $props();

	// 前に作ったときの状態があれば、そこから始める
	// svelte-ignore state_referenced_locally
	const saved = note.thumbnail ?? null;
	// svelte-ignore state_referenced_locally
	let text = $state(saved?.text ?? (note.title.trim() || note.root.text.trim() || ''));
	/** 文字の大きさ（サムネの幅に対する %）。8% ≒ 1280px で 100px */
	let size = $state(saved?.size ?? 9);
	let saving = $state(false);
	let lastSaved = $state<string | null>(null);
	let sheet = $state<ThumbnailSheet | null>(null);

	/** いまの状態（文字・大きさ・図の位置・開いているノード）をノートに覚える */
	function remember() {
		const cam = sheet?.getCamera();
		if (!cam) return;
		library.setThumbnail(note.id, {
			text,
			size,
			camera: cam,
			open: sheet?.openIds() ?? [],
			file: lastSaved ?? note.thumbnail?.file
		});
	}
	onDestroy(() => {
		remember();
	});

	async function save() {
		if (!sheet || saving) return;
		saving = true;
		try {
			// 入力中の枠線やカーソルが写らないよう、いったんフォーカスを外して 1 コマ待つ
			await sheet.prepareCapture();
			const r = sheet.rect();
			if (!r) return;
			const dest = await api().app.saveThumbnail(r, note.title.trim() || 'サムネイル');
			if (dest) {
				lastSaved = dest;
				remember();
				toast.show(`サムネイルを保存しました: ${dest}`);
			}
		} catch (err) {
			toast.error(`サムネイルを保存できませんでした。${(err as Error)?.message ?? ''}`);
		} finally {
			saving = false;
		}
	}
</script>

<div class="thumb" role="dialog" aria-modal="true" aria-label="サムネイルを作る">
	<div class="thumb__inner">
		<div class="thumb__head">
			<h2 class="thumb__title">サムネイルを作る</h2>
			<span class="muted"
				>文字はノートの題名とは別に持ちます（短くしても題名は変わりません）。下の図はドラッグで動かし、ホイールで拡大縮小して、写したい所に合わせてください。SNS
				投稿の YouTube にはこのサムネが自動で付きます。</span
			>
		</div>
		<label class="thumb__textfield">
			<span>サムネの文字</span>
			<textarea
				class="input thumb__textarea"
				rows="2"
				placeholder="短い言葉に（例: 図解でしゃべるだけ）"
				bind:value={text}></textarea>
		</label>

		<!-- 写す範囲（16:9）。この見た目がそのまま PNG になる -->
		<ThumbnailSheet
			bind:this={sheet}
			{note}
			bind:text
			{size}
			editable
			{saved}
			onOpenChange={remember}
		/>

		<div class="thumb__tools">
			<label class="thumb__size">
				<span>文字の大きさ</span>
				<input type="range" min="5" max="14" step="0.5" bind:value={size} />
			</label>
			<button type="button" class="btn btn--yellow" onclick={save} disabled={saving}>
				{saving ? '保存しています…' : 'PNG を保存（1280×720）'}
			</button>
			{#if lastSaved}
				<button type="button" class="chip" onclick={() => api().app.revealPath(lastSaved!)}
					>Finder で表示</button
				>
			{/if}
			<button type="button" class="btn btn--sm" onclick={onClose}>閉じる</button>
		</div>
	</div>
</div>

<style>
	.thumb {
		--yellow: var(--yellow-brand);
		position: fixed;
		inset: 0;
		z-index: 80;
		background: rgba(28, 24, 18, 0.55);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 24px;
	}
	.thumb__inner {
		/* .sheet 自身の枠線の cqw の基準にする（.sheet の中身は .sheet が基準） */
		container-type: inline-size;
		background: var(--cream);
		border: var(--border);
		border-radius: 20px;
		box-shadow: var(--shadow);
		padding: 18px 22px 20px;
		display: grid;
		gap: 14px;
		max-width: min(96vw, 1040px);
		width: 100%;
	}
	.thumb__head {
		display: grid;
		gap: 4px;
	}
	.thumb__title {
		margin: 0;
		font-size: 18px;
		font-weight: 900;
	}
	.thumb__textfield {
		display: grid;
		gap: 4px;
		font-weight: 900;
		font-size: 13px;
	}
	.thumb__textarea {
		font: inherit;
		font-weight: 700;
		line-height: 1.5;
		resize: vertical;
	}
	.thumb__tools {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
	}
	.thumb__size {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		font-weight: 700;
		font-size: 13px;
	}
	.thumb__size input {
		width: 160px;
	}
</style>
