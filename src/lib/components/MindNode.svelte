<script lang="ts">
	import type { MapNode } from '$shared/types';
	import { untrack } from 'svelte';
	import { imageUrl } from '$lib/api';

	let {
		node,
		isRoot = false,
		x,
		y,
		selected,
		editing,
		dragging = false,
		readonly = false,
		presenting = false,
		imageSize = null,
		dropHint = false,
		vertical = false,
		onSize,
		onPointerDown,
		onDoubleClick,
		onCommit,
		onCancel,
		onToggleCollapse,
		onAddChild,
		onImageClick,
		onDropImage,
		onAddSibling,
		onAddSiblingAbove,
		onMoveUp,
		onMoveDown,
		onOutdent,
		onIndent,
		canMoveUp = false,
		canMoveDown = false,
		canOutdent = false,
		canIndent = false,
		onToggleChecked,
		onToggleCheckbox,
		onRemove,
		onResetPos,
		onAttachImage,
		onDetachImage
	}: {
		node: MapNode;
		/** 中心のノード（消せない・兄弟を持たない・動かせない） */
		isRoot?: boolean;
		x: number;
		y: number;
		selected: boolean;
		editing: boolean;
		dragging?: boolean;
		/** 見るだけ（開閉・追加・編集のボタンを出さない） */
		readonly?: boolean;
		/** 収録中（追加・編集のボタンだけ出さない。開閉と選択はできる） */
		presenting?: boolean;
		/** 画像の表示サイズ（先読み済みなら）。最初の描画から場所を確保して、あとで伸びないようにする */
		imageSize?: { w: number; h: number } | null;
		/** ドラッグ中のノードを落とすと、このノードの子になる（目印を出す） */
		dropHint?: boolean;
		/** 縦の動画（木が下に広がる）: 開閉ボタンは下端、子は下に、兄弟は左右に足す */
		vertical?: boolean;
		onSize: (id: string, w: number, h: number) => void;
		onPointerDown: (e: PointerEvent) => void;
		onDoubleClick: () => void;
		onCommit: (text: string, then: 'none' | 'child' | 'sibling') => void;
		onCancel: () => void;
		onToggleCollapse: () => void;
		onAddChild: () => void;
		/** 画像を押したとき（大きく見せる）。無ければ何もしない */
		onImageClick?: () => void;
		/** 画像ファイルをこのノードに落としたとき */
		onDropImage?: (file: File) => void;
		onAddSibling: () => void;
		/** 上に足す（兄弟を前に） */
		onAddSiblingAbove: () => void;
		/** 兄弟の中で順番を入れ替える */
		onMoveUp: () => void;
		onMoveDown: () => void;
		canMoveUp?: boolean;
		canMoveDown?: boolean;
		/** 階層を上げる（親の隣へ）／下げる（1 つ上の兄弟の子へ） */
		onOutdent: () => void;
		onIndent: () => void;
		canOutdent?: boolean;
		canIndent?: boolean;
		/** ノードのチェックボタン: 未 ↔ 済 を切り替えるだけ（ボタンは消えない） */
		onToggleChecked: () => void;
		/** 操作の並びのチェック印: チェックボタンを付ける／外す */
		onToggleCheckbox: () => void;
		onRemove: () => void;
		onResetPos: () => void;
		onAttachImage: () => void;
		onDetachImage: () => void;
	} = $props();

	const hasChildren = $derived(node.children.length > 0);
	/** 閉じているときに丸に出す数 = 直下の子の数（孫までは数えない） */
	const collapsedCount = $derived(node.collapsed ? node.children.length : 0);

	let box = $state<HTMLDivElement | null>(null);
	let textarea = $state<HTMLTextAreaElement | null>(null);
	let draft = $state('');

	// 大きさを測って配置計算へ返す
	$effect(() => {
		if (!box) return;
		const el = box;
		const report = () => onSize(node.id, el.offsetWidth, el.offsetHeight);
		report();
		const ro = new ResizeObserver(report);
		ro.observe(el);
		return () => ro.disconnect();
	});

	// 編集が始まった瞬間だけ、いまの文字を入力欄に入れて全選択する。
	// node.text をここで追いかけると、入力中に何かの拍子で再実行されて全選択 → 次の入力で文字が消える。
	$effect(() => {
		if (!editing) return;
		untrack(() => {
			draft = node.text;
		});
		requestAnimationFrame(() => {
			textarea?.focus();
			textarea?.select();
			grow();
		});
	});

	function grow() {
		const t = textarea;
		if (!t) return;
		t.style.height = 'auto';
		t.style.height = `${t.scrollHeight}px`;
	}

	function onKeydown(e: KeyboardEvent) {
		// 入力中のキーはマップ側のショートカット（Enter で下に足す、など）に渡さない
		e.stopPropagation();
		if (e.isComposing) return;
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			onCommit(draft, isRoot ? 'none' : 'sibling');
		} else if (e.key === 'Tab') {
			e.preventDefault();
			onCommit(draft, 'child');
		} else if (e.key === 'Escape') {
			e.preventDefault();
			onCancel();
		}
	}

	const stop = (e: Event) => e.stopPropagation();
	/** 画像ファイルをドラッグして上に乗せている */
	let fileOver = $state(false);
</script>

<div
	bind:this={box}
	data-id={node.id}
	class="node"
	class:node--root={isRoot}
	class:node--selected={selected}
	class:node--editing={editing}
	class:node--dragging={dragging}
	class:node--drop={dropHint}
	class:node--vertical={vertical}
	class:node--done={node.checked === true}
	class:node--readonly={readonly}
	class:node--filedrop={fileOver}
	style="transform: translate({x}px, {y}px)"
	ondragover={(e) => {
		if (!onDropImage || !e.dataTransfer?.types.includes('Files')) return;
		e.preventDefault();
		e.dataTransfer.dropEffect = 'copy';
		fileOver = true;
	}}
	ondragleave={(e) => {
		const el = e.currentTarget as HTMLElement;
		if (!(e.relatedTarget instanceof Node && el.contains(e.relatedTarget))) fileOver = false;
	}}
	ondrop={(e) => {
		fileOver = false;
		if (!onDropImage) return;
		const file = [...(e.dataTransfer?.files ?? [])].find((f) => f.type.startsWith('image/'));
		if (!file) return;
		e.preventDefault();
		e.stopPropagation();
		onDropImage(file);
	}}
	role="treeitem"
	aria-selected={selected}
	aria-expanded={hasChildren ? !node.collapsed : undefined}
	tabindex="-1"
	onpointerdown={onPointerDown}
	ondblclick={onDoubleClick}
>
	{#if node.checked !== null}
		<!-- チェックの付け外し（ワークスペースでも収録中でもできる。収録の始めには全部「未」に戻る） -->
		<button
			type="button"
			class="node__check"
			class:node__check--on={node.checked}
			aria-label={node.checked ? 'チェック済み' : '未チェック'}
			disabled={readonly}
			onpointerdown={stop}
			ondblclick={stop}
			onclick={(e) => {
				e.stopPropagation();
				onToggleChecked();
			}}
		></button>
	{/if}

	<div class="node__body">
		{#if editing}
			<textarea
				bind:this={textarea}
				class="node__input"
				rows="1"
				bind:value={draft}
				oninput={grow}
				onkeydown={onKeydown}
				onblur={() => {
					// 編集が別の理由で終わった後の blur は無視する
					if (editing) onCommit(draft, 'none');
				}}
				onpointerdown={stop}
				ondblclick={stop}
				placeholder="ここに書く"></textarea>
		{:else}
			<span class="node__text" class:node__text--empty={!node.text}>
				{node.text || (isRoot ? '（中心のことば）' : '（空）')}
			</span>
		{/if}
		{#if node.image}
			<!-- ノードの下の画像。読み込み後に大きさが変わるのは ResizeObserver が拾う -->
			<img
				class="node__img"
				class:node__img--zoomable={!!onImageClick}
				src={imageUrl(node.image)}
				alt=""
				draggable="false"
				role={onImageClick ? 'button' : undefined}
				tabindex={onImageClick ? -1 : undefined}
				onpointerdown={onImageClick ? stop : undefined}
				ondblclick={onImageClick ? stop : undefined}
				onclick={(e) => {
					if (!onImageClick) return;
					e.stopPropagation();
					onImageClick();
				}}
				onkeydown={(e) => {
					if (onImageClick && (e.key === 'Enter' || e.key === ' ')) {
						e.preventDefault();
						onImageClick();
					}
				}}
				decoding="sync"
				width={imageSize?.w}
				height={imageSize?.h}
				style={imageSize ? `width:${imageSize.w}px;height:${imageSize.h}px` : ''}
			/>
		{/if}
	</div>

	{#if hasChildren && !readonly}
		<!-- 右端の中央。線はここから出る。閉じていれば件数、開いていれば − -->
		<button
			type="button"
			class="node__toggle"
			class:node__toggle--collapsed={node.collapsed}
			title={node.collapsed ? `子が ${collapsedCount} 件。開く` : '折りたたむ'}
			aria-label={node.collapsed ? `子が ${collapsedCount} 件。開く` : '折りたたむ'}
			onpointerdown={stop}
			ondblclick={stop}
			onclick={(e) => {
				e.stopPropagation();
				onToggleCollapse();
			}}
		>
			{node.collapsed ? collapsedCount : '−'}
		</button>
	{/if}

	{#if !editing && !dragging && !readonly && !presenting}
		<button
			type="button"
			class="node__add node__add--child"
			class:node__add--child-shift={hasChildren}
			class:node__add--always={selected}
			title="子を足す（Tab）"
			aria-label="子を足す"
			onpointerdown={stop}
			ondblclick={stop}
			onclick={(e) => {
				e.stopPropagation();
				onAddChild();
			}}>＋</button
		>
		{#if selected && !isRoot}
			<!-- ノードの上の中央: 上に足す -->
			<button
				type="button"
				class="node__add node__add--above"
				title={vertical ? '左に足す（Shift+Enter）' : '上に足す（Shift+Enter）'}
				aria-label={vertical ? '左に足す' : '上に足す'}
				onpointerdown={stop}
				ondblclick={stop}
				onclick={(e) => {
					e.stopPropagation();
					onAddSiblingAbove();
				}}>＋</button
			>
		{/if}
		{#if selected}
			<!-- ノードの下の列。左に「下に足す」、右に小さな操作。文字には被らない -->
			<div class="node__below" onpointerdown={stop}>
				{#if !isRoot}
					<button
						type="button"
						class="node__add"
						title={vertical ? '右に足す（Enter）' : '下に足す（Enter）'}
						aria-label={vertical ? '右に足す' : '下に足す'}
						onclick={(e) => {
							e.stopPropagation();
							onAddSibling();
						}}>＋</button
					>
				{/if}
				<div class="node__menu" role="toolbar" aria-label="ノードの操作">
					{#if !isRoot}
						<button
							type="button"
							class="node__mbtn"
							title={vertical
								? '左へ（順番を入れ替える。Alt+↑）'
								: '上へ（順番を入れ替える。Alt+↑）'}
							aria-label={vertical ? '左へ' : '上へ'}
							disabled={!canMoveUp}
							onclick={(e) => {
								e.stopPropagation();
								onMoveUp();
							}}
						>
							<svg viewBox="0 0 16 16" aria-hidden="true"
								><path d={vertical ? 'M13 8H3M7 4 3 8l4 4' : 'M8 13V3M4 7l4-4 4 4'} /></svg
							>
						</button>
						<button
							type="button"
							class="node__mbtn"
							title={vertical
								? '右へ（順番を入れ替える。Alt+↓）'
								: '下へ（順番を入れ替える。Alt+↓）'}
							aria-label={vertical ? '右へ' : '下へ'}
							disabled={!canMoveDown}
							onclick={(e) => {
								e.stopPropagation();
								onMoveDown();
							}}
						>
							<svg viewBox="0 0 16 16" aria-hidden="true"
								><path d={vertical ? 'M3 8h10M9 4l4 4-4 4' : 'M8 3v10M4 9l4 4 4-4'} /></svg
							>
						</button>
						<button
							type="button"
							class="node__mbtn"
							title={vertical
								? '上へ（階層を上げて、親の隣に並べる。Shift+Tab）'
								: '左へ（階層を上げて、親の隣に並べる。Shift+Tab）'}
							aria-label={vertical ? '上へ（階層を上げる）' : '左へ（階層を上げる）'}
							disabled={!canOutdent}
							onclick={(e) => {
								e.stopPropagation();
								onOutdent();
							}}
						>
							<svg viewBox="0 0 16 16" aria-hidden="true"
								><path d={vertical ? 'M8 13V3M4 7l4-4 4 4' : 'M13 8H3M7 4 3 8l4 4'} /></svg
							>
						</button>
						<button
							type="button"
							class="node__mbtn"
							title={vertical
								? '下へ（階層を下げて、1 つ前のノードの子にする）'
								: '右へ（階層を下げて、1 つ上のノードの子にする）'}
							aria-label={vertical ? '下へ（階層を下げる）' : '右へ（階層を下げる）'}
							disabled={!canIndent}
							onclick={(e) => {
								e.stopPropagation();
								onIndent();
							}}
						>
							<svg viewBox="0 0 16 16" aria-hidden="true"
								><path d={vertical ? 'M8 3v10M4 9l4 4 4-4' : 'M3 8h10M9 4l4 4-4 4'} /></svg
							>
						</button>
					{/if}
					<button
						type="button"
						class="node__mbtn"
						class:node__mbtn--on={node.checked !== null}
						title={node.checked !== null ? 'チェックボタンを外す' : 'チェックボタンを付ける'}
						aria-label={node.checked !== null ? 'チェックボタンを外す' : 'チェックボタンを付ける'}
						onclick={(e) => {
							e.stopPropagation();
							onToggleCheckbox();
						}}
					>
						<svg viewBox="0 0 16 16" aria-hidden="true">
							<rect x="2.5" y="2.5" width="11" height="11" rx="3" />
							<path d="M5 8.2 7.2 10.4 11.2 5.8" />
						</svg>
					</button>
					<button
						type="button"
						class="node__mbtn"
						title="文字を直す（ダブルクリック）"
						aria-label="文字を直す"
						onclick={(e) => {
							e.stopPropagation();
							onDoubleClick();
						}}
					>
						<svg viewBox="0 0 16 16" aria-hidden="true">
							<path d="M3 13 3.6 10.2 10.8 3a1.4 1.4 0 0 1 2 0l.2.2a1.4 1.4 0 0 1 0 2L5.8 12.4Z" />
						</svg>
					</button>
					<button
						type="button"
						class="node__mbtn"
						title={node.image ? '画像を外す' : '画像を付ける'}
						aria-label={node.image ? '画像を外す' : '画像を付ける'}
						onclick={(e) => {
							e.stopPropagation();
							if (node.image) onDetachImage();
							else onAttachImage();
						}}
					>
						<svg viewBox="0 0 16 16" aria-hidden="true">
							<rect x="2.5" y="3" width="11" height="10" rx="2" />
							<path d="M3 11.5 6.5 8l2.5 2.5L11 8.5l2.5 3" />
							<circle cx="6" cy="6" r="1" />
							{#if node.image}
								<path d="M2 2l12 12" />
							{/if}
						</svg>
					</button>
					{#if node.pos && !isRoot}
						<button
							type="button"
							class="node__mbtn"
							title="手で動かした位置を、自動の位置に戻す"
							aria-label="自動の位置に戻す"
							onclick={(e) => {
								e.stopPropagation();
								onResetPos();
							}}
						>
							<svg viewBox="0 0 16 16" aria-hidden="true">
								<path d="M4 8a4 4 0 1 1 1.2 2.8" />
								<path d="M3.5 5.5v3h3" />
							</svg>
						</button>
					{/if}
					{#if !isRoot}
						<button
							type="button"
							class="node__mbtn node__mbtn--danger"
							title="削除（Delete）"
							aria-label="削除"
							onclick={(e) => {
								e.stopPropagation();
								onRemove();
							}}
						>
							<svg viewBox="0 0 16 16" aria-hidden="true">
								<path d="M4 4l8 8M12 4l-8 8" />
							</svg>
						</button>
					{/if}
				</div>
			</div>
		{/if}
	{/if}
</div>

<style>
	/* すべてのノードは丸い枠。選択中は黄色、それ以外は白 */
	.node {
		position: absolute;
		left: 0;
		top: 0;
		display: flex;
		align-items: center;
		gap: 10px;
		/* 親のキャンバスは大きさ 0 なので、中身の幅で決める */
		width: max-content;
		max-width: 380px;
		min-width: 64px;
		min-height: 44px;
		padding: 8px 20px;
		border: var(--border);
		border-radius: 24px;
		background: #fff;
		color: var(--ink);
		font-size: 15.5px;
		font-weight: 700;
		line-height: 1.6;
		cursor: grab;
		user-select: none;
		box-shadow: 3px 3px 0 var(--ink);
		transition: background-color 0.12s ease;
		will-change: transform;
		animation: node-in 0.1s ease-out; /* 出現は短く。開いた瞬間に見えるように */
	}
	@keyframes node-in {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}
	.node--readonly {
		cursor: default;
	}
	.node:hover {
		background: var(--paper);
	}
	.node--selected,
	.node--selected:hover {
		background: var(--yellow);
		z-index: 3; /* 下の操作列が隣のノードに隠れないように */
	}
	/* 縦の動画（木が下に広がる）: 開閉ボタンは下端の中央、子の ＋ はその右、兄弟の ＋ は左右、操作の並びは上 */
	.node--vertical .node__toggle {
		right: auto;
		top: auto;
		left: 50%;
		bottom: -18px;
		transform: translateX(-50%);
	}
	.node--vertical .node__add--child {
		right: auto;
		top: auto;
		left: 50%;
		bottom: -38px;
		transform: translateX(-50%);
	}
	.node--vertical .node__add--child.node__add--child-shift {
		transform: translateX(calc(-50% + 38px));
	}
	.node--vertical .node__add--above {
		left: -38px;
		top: 50%;
		bottom: auto;
		transform: translateY(-50%);
	}
	.node--vertical .node__below {
		bottom: auto;
		top: -38px;
		transform: translateX(-50%);
	}
	.node--vertical .node__below .node__add {
		position: absolute;
		left: auto;
		right: -38px;
		top: calc(38px + 50%);
		transform: translateY(-50%);
	}
	/* 落とすと子になる目印 */
	.node--filedrop {
		outline: 4px dashed var(--gold);
		outline-offset: 4px;
	}
	.node--drop {
		background: var(--yellow);
		outline: 4px solid var(--ink);
		outline-offset: 3px;
	}
	.node--dragging {
		cursor: grabbing;
		box-shadow: 6px 6px 0 var(--ink);
		z-index: 5;
	}
	.node--editing {
		cursor: text;
	}
	.node--root {
		padding: 12px 28px;
		font-size: 19px;
		font-weight: 900;
		letter-spacing: 0.04em;
		max-width: 440px;
		border-width: 3px;
		box-shadow: 4px 4px 0 var(--ink);
		cursor: default;
	}
	.node__body {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 8px;
		min-width: 0;
	}
	/* 拡大できる画像はクリックを受ける（.node__img は pointer-events: none で素通りさせているため、ここで戻す） */
	.node__img.node__img--zoomable {
		pointer-events: auto;
		cursor: zoom-in;
	}
	.node__img {
		display: block;
		max-width: 300px;
		max-height: 220px;
		border: 2px solid var(--ink);
		border-radius: 10px;
		background: #fff;
		pointer-events: none;
	}
	.node__text {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.node__text--empty {
		color: var(--placeholder);
		font-weight: 500;
	}
	.node--done .node__text {
		color: var(--brown);
		text-decoration: line-through;
	}
	.node__input {
		width: 280px;
		border: 0;
		background: transparent;
		font: inherit;
		line-height: 1.6;
		padding: 0;
		resize: none;
		overflow: hidden;
		user-select: text;
		cursor: text;
	}
	.node__input:focus {
		outline: none;
	}
	.node__check {
		flex: none;
		width: 20px;
		height: 20px;
		border: 2.5px solid var(--ink);
		border-radius: 6px;
		background: var(--cream);
		cursor: pointer;
		position: relative;
		padding: 0;
	}
	.node__check:disabled {
		cursor: default;
	}
	.node__check--on {
		background: var(--ink);
	}
	.node__check--on::after {
		content: '';
		position: absolute;
		left: 5px;
		top: 1px;
		width: 5px;
		height: 9px;
		border: solid var(--yellow);
		border-width: 0 3px 3px 0;
		transform: rotate(45deg);
	}
	/* 右端の中央にある開閉ボタン。押しやすいよう大きめに */
	.node__toggle {
		position: absolute;
		right: -18px;
		top: 50%;
		transform: translateY(-50%);
		width: 32px;
		height: 32px;
		border-radius: 50%;
		border: 2.5px solid var(--ink);
		background: #fff;
		font-size: 14px;
		font-weight: 900;
		line-height: 1;
		padding: 0;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		box-shadow: 2px 2px 0 var(--ink);
		transition: background-color 0.12s ease;
	}
	.node__toggle:hover {
		background: var(--paper);
	}
	.node__toggle--collapsed {
		background: var(--yellow);
		min-width: 34px;
	}
	.node__toggle--collapsed:hover {
		background: #fff;
	}
	.node__add {
		position: absolute;
		width: 26px;
		height: 26px;
		border-radius: 50%;
		border: 2.5px solid var(--ink);
		background: var(--yellow);
		font-size: 15px;
		font-weight: 900;
		line-height: 1;
		padding: 0;
		cursor: pointer;
		box-shadow: 2px 2px 0 var(--ink);
	}
	.node__add:hover {
		background: #fff;
	}
	/* ノードの上の中央 */
	.node__add--above {
		left: 50%;
		top: -36px;
		transform: translateX(-50%);
	}
	.node__mbtn:disabled {
		opacity: 0.3;
		cursor: default;
	}
	.node__add--child {
		right: -38px;
		top: 50%;
		transform: translateY(-50%);
		/* 選んだときだけ出す（ホバーで出すと、押しに行く途中で消えて押せないため 2026-09-12 にやめた） */
		opacity: 0;
		pointer-events: none;
		transition: opacity 0.12s ease;
	}
	.node__add--always {
		opacity: 1;
		pointer-events: auto;
	}
	.node__add--child-shift {
		right: -56px;
	}
	/* 「下に足す」の ＋ をノードの中央の真下に置き、操作の並び（チェック・文字・画像・×）はその右に続ける */
	.node__below {
		position: absolute;
		left: 50%;
		bottom: -38px;
		transform: translateX(-13px); /* ＋ の半分（26px）の分だけ戻して、＋ の中心を合わせる */
		display: flex;
		align-items: center;
		gap: 8px;
		white-space: nowrap;
	}
	.node__below .node__add {
		position: static;
		transform: none;
	}
	/* 根には「下に足す」が無いので、並びそのものを中央に */
	.node--root .node__below {
		transform: translateX(-50%);
	}
	.node__menu {
		display: flex;
		gap: 2px;
		padding: 2px;
		border: 2px solid var(--ink);
		border-radius: 999px;
		background: var(--cream);
	}
	.node__mbtn {
		width: 20px;
		height: 20px;
		border: 0;
		border-radius: 50%;
		background: transparent;
		padding: 0;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		color: var(--ink);
	}
	.node__mbtn:hover {
		background: var(--yellow);
	}
	.node__mbtn svg {
		width: 13px;
		height: 13px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.8;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	/* チェックボタンが付いているノードでは、印を黄色にして「外す」ボタンだと分かるように */
	.node__mbtn--on {
		background: var(--yellow);
	}
	.node__mbtn--danger {
		color: var(--alert);
	}
</style>
