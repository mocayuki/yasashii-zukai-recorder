<script lang="ts">
	/**
	 * サムネの「写す範囲」（16:9）。上半分は大きな文字（黄色の地）、下半分は図。
	 * ThumbnailPanel（作る画面）と SNS 投稿の YouTube の欄（見せる・写す）の両方で使う。
	 * 幅に対する比（cqw）で描くので、小さく出しても同じ見た目になる
	 */
	import type { MapNode, Note, ThumbnailState } from '$shared/types';
	import { SvelteSet } from 'svelte/reactivity';
	import MindMap from './MindMap.svelte';

	let {
		note,
		text = $bindable(''),
		size = 9,
		editable = false,
		saved = null,
		onOpenChange = null
	}: {
		note: Note;
		/** 上半分の文字 */
		text?: string;
		/** 文字の大きさ（幅に対する %） */
		size?: number;
		/** 文字をその場で直せるか */
		editable?: boolean;
		/** 前に作ったときの状態（図の位置・開閉） */
		saved?: ThumbnailState | null;
		/** 図のノードを開閉したとき（覚えるため） */
		onOpenChange?: (() => void) | null;
	} = $props();

	let sheet = $state<HTMLDivElement | null>(null);
	let textEl = $state<HTMLDivElement | null>(null);
	let map = $state<MindMap | null>(null);

	// サムネの図の開閉は、ノート本体の開閉とは別に自分で持つ（サムネで閉じてもノートの図は変わらないし、
	// ノートで開閉してもサムネは変わらない）。最初は前回の状態、無ければ「中心とその子」だけ。
	// 以前はノート本体の collapsed を書き換えて閉じるときに戻していたので、後ろの図が連動して動き、
	// 閉じたときに戻す順で覚えた開閉が消えることがあった（2026-09-17）
	// svelte-ignore state_referenced_locally
	const open = new SvelteSet<string>(saved ? saved.open : [note.root.id]);
	/** 開閉だけをサムネ用に差し替えたノート（ほかはノート本体のまま。文字や位置の変更はそのまま映る） */
	const viewNote = $derived.by((): Note => {
		const walk = (n: MapNode): MapNode => ({
			...n,
			collapsed: n.children.length > 0 && !open.has(n.id),
			children: n.children.map(walk)
		});
		return { ...note, root: walk(note.root) };
	});
	function toggleOpen(id: string) {
		if (open.has(id)) open.delete(id);
		else open.add(id);
		onOpenChange?.();
	}

	/** 実際に使う大きさ。size を上限に、上半分に収まるまで小さくする（切れないように） */
	let fitSize = $state(9);
	$effect(() => {
		void text;
		const el = textEl;
		const box = el?.parentElement;
		if (!el || !box) return;
		let s = size;
		fitSize = s;
		const check = () => {
			el.style.fontSize = `${s}cqw`;
			const room = box.clientHeight - parseFloat(getComputedStyle(box).paddingTop) * 2;
			while (s > 3 && el.scrollHeight > room + 1) {
				s -= 0.25;
				el.style.fontSize = `${s}cqw`;
			}
			fitSize = s;
		};
		requestAnimationFrame(check);
	});

	/** 写す範囲（画面の px）。capturePage に渡す */
	export function rect(): { x: number; y: number; width: number; height: number } | null {
		if (!sheet) return null;
		const r = sheet.getBoundingClientRect();
		return {
			x: Math.round(r.left),
			y: Math.round(r.top),
			width: Math.round(r.width),
			height: Math.round(r.height)
		};
	}
	export function getCamera() {
		return map?.getCamera() ?? null;
	}
	/** 開いているノードの id（子のあるノードで、サムネで開いているもの） */
	export function openIds(): string[] {
		const ids: string[] = [];
		const walk = (n: MapNode) => {
			if (n.children.length > 0 && open.has(n.id)) ids.push(n.id);
			n.children.forEach(walk);
		};
		walk(note.root);
		return ids;
	}
	/** 画面のこの範囲が見えるようにして、入力中の枠線が写らないようにする */
	export async function prepareCapture(): Promise<void> {
		(document.activeElement as HTMLElement | null)?.blur();
		sheet?.scrollIntoView({ block: 'center' });
		await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
	}
</script>

<div class="sheet" bind:this={sheet}>
	<div class="sheet__top">
		{#if editable}
			<div
				class="sheet__text"
				contenteditable="true"
				role="textbox"
				aria-multiline="true"
				aria-label="サムネイルの文字"
				style="font-size: {fitSize}cqw"
				bind:this={textEl}
				bind:innerText={text}
			></div>
		{:else}
			<div
				class="sheet__text sheet__text--still"
				style="font-size: {fitSize}cqw"
				bind:this={textEl}
			>
				{text}
			</div>
		{/if}
	</div>
	<div class="sheet__map">
		<MindMap
			bind:this={map}
			note={viewNote}
			frameOnly
			presenting
			onToggleCollapse={toggleOpen}
			initialCamera={saved?.camera ?? null}
			initialFocusId={saved ? null : note.root.id}
		/>
	</div>
</div>

<style>
	/* 写す範囲。幅いっぱいの 16:9。文字の大きさは cqw（この幅に対する %）で決める */
	/* 上下の高さは幅から決める（16:9 の半分 = 幅の 28.125%）。
	   aspect-ratio と 1fr だけだと、中の図の高さ（%）が 0 に解決されて全体表示が最小になった */
	.sheet {
		/* サムネはどの画面（緑の SNS 投稿の画面でも）に出しても同じ黄色 */
		--yellow: var(--yellow-brand);
		container-type: inline-size;
		width: 100%;
		aspect-ratio: 16 / 9;
		display: block;
		overflow: hidden;
		/* 枠線は幅に対する比で太く（0.7% ≒ 1280px で 9px）。サムネは小さく表示されるので線は太めに */
		border: 0.7cqw solid var(--ink);
		border-radius: 4px;
		background: var(--cream);
	}
	.sheet__top {
		height: 28.125cqw;
		box-sizing: border-box;
		background: var(--yellow);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 3cqw 5cqw;
		min-height: 0;
	}
	.sheet__text {
		width: 100%;
		text-align: center;
		font-weight: 900;
		line-height: 1.25;
		color: var(--ink);
		white-space: pre-wrap;
		word-break: break-word;
		outline: none;
		max-height: 100%;
		overflow: hidden;
		cursor: text;
	}
	.sheet__text--still {
		cursor: default;
		pointer-events: none;
	}
	.sheet__text:focus {
		box-shadow: 0 0 0 2px rgba(28, 24, 18, 0.25);
		border-radius: 8px;
	}
	.sheet__map {
		height: 28.125cqw;
		box-sizing: border-box;
		min-height: 0;
		position: relative;
		border-top: 0.7cqw solid var(--ink);
	}
	/* 図の枠の余白と線は無し（サムネでは枠いっぱいに図を出す） */
	.sheet__map :global(.mindmap--framed .mindmap__frame) {
		padding: 0;
		border: 0;
		border-radius: 0;
		background: var(--cream);
	}
	.sheet__map :global(.mindmap--framed .mindmap__view) {
		border: 0;
		border-radius: 0;
		/* height: 100% だと 0 に解決されることがあるので、グリッドの行いっぱいに伸ばす */
		height: auto;
		align-self: stretch;
	}
	.sheet__map :global(.mindmap--framed .mindmap__frame) {
		grid-template-rows: minmax(0, 1fr);
		gap: 0;
	}
	/* サムネの下半分は図だけ（枠の中の題名の行は出さない） */
	.sheet__map :global(.mindmap__head) {
		display: none;
	}
</style>
