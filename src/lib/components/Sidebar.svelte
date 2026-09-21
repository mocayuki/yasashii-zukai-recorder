<script lang="ts">
	import { exportsOf, type Note } from '$shared/types';
	import { library } from '$lib/stores/library.svelte';
	import { toast } from '$lib/stores/toast.svelte';
	import NoteListItem from './NoteListItem.svelte';

	/**
	 * 左のノート一覧。題名だけの 1 行で並べ、フォルダーでまとめられる。
	 * - フォルダーはノートに付く名前（1 段）。見出しを押すと開閉（開閉の状態はこの Mac に覚える）
	 * - ノートをフォルダーの見出しへドラッグすると入る。「フォルダーなし」へ戻すこともできる
	 * - 検索中はフォルダーに関係なく、合うノートを平らに並べる
	 */
	let { onNewNote }: { onNewNote: () => void } = $props();

	const COLLAPSED_KEY = 'yasashii.collapsedFolders';
	let collapsed = $state<Set<string>>(new Set());
	try {
		const raw = localStorage.getItem(COLLAPSED_KEY);
		if (raw) collapsed = new Set(JSON.parse(raw) as string[]);
	} catch {
		/* 覚えていなくても動く */
	}
	function toggleFolder(name: string) {
		const next = new Set(collapsed);
		if (next.has(name)) next.delete(name);
		else next.add(name);
		collapsed = next;
		try {
			localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
		} catch {
			/* 保存できなくても動く */
		}
	}

	const searching = $derived(library.query.trim() !== '');
	const loose = $derived(library.notes.filter((n) => !n.folder));
	const inFolder = (name: string): Note[] => library.notes.filter((n) => n.folder === name);

	/** ドラッグ中に上に乗っているフォルダー（'' = フォルダーなし） */
	let dropOver = $state<string | null>(null);

	function onDrop(e: DragEvent, folder: string | null) {
		e.preventDefault();
		dropOver = null;
		const id = e.dataTransfer?.getData('text/note-id');
		if (!id) return;
		library.setFolder(id, folder);
		toast.show(folder ? `「${folder}」に入れました` : 'フォルダーから出しました');
	}

	/** フォルダーの見出し自体もドラッグでき、ほかの見出しの上半分に落とすと前、下半分なら後ろに並ぶ */
	const isFolderDrag = (e: DragEvent) => !!e.dataTransfer?.types.includes('text/folder-name');
	let folderDrop = $state<{ name: string; place: 'before' | 'after' } | null>(null);
	/** いまドラッグしているフォルダー（薄く表示して、どれを動かしているか分かるように） */
	let draggingFolder = $state<string | null>(null);
	function onFolderDragOver(e: DragEvent, name: string) {
		e.preventDefault();
		if (isFolderDrag(e)) {
			if (name === draggingFolder) return; // 自分の上では何も示さない
			const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
			const place = e.clientY < r.top + r.height / 2 ? 'before' : 'after';
			// dragover は 1 秒に何十回も来るので、変わったときだけ状態を更新する（描き直しを減らす）
			if (folderDrop?.name !== name || folderDrop.place !== place) folderDrop = { name, place };
			if (dropOver !== null) dropOver = null;
		} else {
			if (dropOver !== name) dropOver = name;
			if (folderDrop !== null) folderDrop = null;
		}
	}
	/** 見出しの中の文字や矢印に移っただけの dragleave は無視する（バーがちらつかないように） */
	function leftElement(e: DragEvent): boolean {
		const el = e.currentTarget as HTMLElement;
		return !(e.relatedTarget instanceof Node && el.contains(e.relatedTarget));
	}
	function onFolderDrop(e: DragEvent, name: string) {
		const from = e.dataTransfer?.getData('text/folder-name');
		if (from) {
			e.preventDefault();
			const place = folderDrop?.place ?? 'before';
			folderDrop = null;
			dropOver = null;
			void library.moveFolder(from, name, place);
			return;
		}
		onDrop(e, name);
	}

	/** その場で名前を書き換え中のフォルダー（元の名前） */
	let editingFolder = $state<string | null>(null);
	let editingValue = $state('');

	function startRename(name: string) {
		editingFolder = name;
		editingValue = name;
	}

	async function commitRename() {
		const from = editingFolder;
		editingFolder = null;
		if (!from) return;
		const next = editingValue.trim();
		if (!next || next === from) return;
		if (library.folders.includes(next)) {
			toast.error('同じ名前のフォルダーがあります');
			return;
		}
		await library.renameFolder(from, next);
	}

	async function renameFolder(name: string) {
		startRename(name);
	}

	/** 名前の入力欄が出たら、すぐ書けるように全選択する */
	function focusSelect(el: HTMLInputElement) {
		requestAnimationFrame(() => {
			el.focus();
			el.select();
		});
	}

	async function dissolveFolder(name: string) {
		const n = inFolder(name).length;
		if (
			!window.confirm(
				`フォルダー「${name}」をなくします。中の ${n} 件のノートはフォルダーなしに戻ります（消えません）。`
			)
		)
			return;
		await library.dissolveFolder(name);
	}

	/** 空のフォルダーを作る。ノートは見出しへドラッグして入れる */
	/** 押した瞬間に「新しいフォルダー」を作り、その場で名前を書き換えられるようにする（Finder と同じ） */
	async function newFolder() {
		let name = '新しいフォルダー';
		for (let i = 2; library.folders.includes(name); i++) name = `新しいフォルダー ${i}`;
		const ok = await library.createFolder(name);
		if (!ok) return;
		startRename(name);
	}
</script>

<aside class="sidebar">
	<div class="sidebar__top">
		<div class="sidebar__buttons">
			<button type="button" class="btn btn--ink sidebar__new" onclick={onNewNote}
				>＋ 新しいノート</button
			>
			<button
				type="button"
				class="btn btn--sm"
				title="空のフォルダーを作ります（ノートはドラッグで入れます）"
				onclick={newFolder}>＋ フォルダー</button
			>
		</div>
		<label class="sidebar__search">
			<span class="visually-hidden">ノートを検索</span>
			<input
				class="input input--search"
				type="search"
				placeholder="タイトル・ノードで検索"
				bind:value={library.query}
			/>
		</label>
	</div>

	<div class="sidebar__list" role="listbox" aria-label="ノート一覧">
		{#if library.loading}
			<p class="muted sidebar__msg">読み込んでいます…</p>
		{:else if library.loadError}
			<p class="alert sidebar__msg">{library.loadError}</p>
		{:else if library.notes.length === 0}
			<div class="sidebar__empty">
				<p class="sidebar__empty-title">まだノートがありません</p>
				<p class="muted">「新しいノート」から始めましょう。</p>
			</div>
		{:else if searching}
			{#if library.filtered.length === 0}
				<div class="sidebar__empty">
					<p class="sidebar__empty-title">「{library.query}」に合うノートはありません</p>
				</div>
			{:else}
				{#each library.filtered as note (note.id)}
					<NoteListItem
						{note}
						selected={note.id === library.selectedId}
						hasRecording={library.recordingsOf(note.id).length > 0}
						hasExport={library.recordingsOf(note.id).some((r) => exportsOf(r).length > 0)}
						onclick={() => library.select(note.id)}
					/>
				{/each}
			{/if}
		{:else}
			{#each library.folders as name (name)}
				{@const notes = inFolder(name)}
				{@const open = !collapsed.has(name)}
				<section
					class="folder"
					class:folder--over={dropOver === name}
					class:folder--before={folderDrop?.name === name && folderDrop.place === 'before'}
					class:folder--after={folderDrop?.name === name && folderDrop.place === 'after'}
					class:folder--dragging={draggingFolder === name}
				>
					<div
						class="folder__head"
						role="button"
						tabindex="0"
						aria-expanded={open}
						draggable="true"
						ondragstart={(e) => {
							e.dataTransfer?.setData('text/folder-name', name);
							if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
							draggingFolder = name;
						}}
						ondragend={() => {
							folderDrop = null;
							dropOver = null;
							draggingFolder = null;
						}}
						ondragover={(e) => onFolderDragOver(e, name)}
						ondragleave={(e) => {
							if (!leftElement(e)) return;
							dropOver = null;
							folderDrop = null;
						}}
						ondrop={(e) => onFolderDrop(e, name)}
						onclick={() => toggleFolder(name)}
						ondblclick={() => {
							// ダブルクリックは 2 回の開閉で元に戻るので、そのまま名前の書き換えへ
							startRename(name);
						}}
						onkeydown={(e) => {
							if (e.key === 'Enter' || e.key === ' ') {
								e.preventDefault();
								toggleFolder(name);
							}
						}}
					>
						<span class="folder__arrow" class:folder__arrow--open={open} aria-hidden="true">▶</span>
						{#if editingFolder === name}
							<!-- svelte-ignore a11y_autofocus -->
							<input
								class="folder__input"
								type="text"
								bind:value={editingValue}
								use:focusSelect
								onclick={(e) => e.stopPropagation()}
								onkeydown={(e) => {
									e.stopPropagation();
									if (e.key === 'Enter' && !e.isComposing) {
										e.preventDefault();
										void commitRename();
									} else if (e.key === 'Escape') {
										editingFolder = null;
									}
								}}
								onblur={() => void commitRename()}
							/>
						{:else}
							<span class="folder__name" title="ダブルクリックで名前を変えます">{name}</span>
						{/if}
						<span class="folder__count muted">{notes.length}</span>
						<span class="folder__menu">
							<button
								type="button"
								class="chip"
								title="名前を変える"
								aria-label="フォルダーの名前を変える"
								onclick={(e) => {
									e.stopPropagation();
									void renameFolder(name);
								}}>名前</button
							>
							<button
								type="button"
								class="chip"
								title="フォルダーをなくす（ノートは消えません）"
								aria-label="フォルダーをなくす"
								onclick={(e) => {
									e.stopPropagation();
									void dissolveFolder(name);
								}}>×</button
							>
						</span>
					</div>
					{#if open}
						<div class="folder__body">
							{#each notes as note (note.id)}
								<NoteListItem
									{note}
									selected={note.id === library.selectedId}
									hasRecording={library.recordingsOf(note.id).length > 0}
									hasExport={library.recordingsOf(note.id).some((r) => exportsOf(r).length > 0)}
									onclick={() => library.select(note.id)}
								/>
							{/each}
						</div>
					{/if}
				</section>
			{/each}
			<!-- フォルダーなし（ドロップで出せる）。フォルダーの下に置く -->
			{#if library.folders.length > 0}
				<p class="muted sidebar__section">フォルダーなし</p>
			{/if}
			<div
				class="sidebar__loose"
				class:sidebar__loose--over={dropOver === ''}
				role="group"
				aria-label="フォルダーなし"
				ondragover={(e) => {
					e.preventDefault();
					dropOver = '';
				}}
				ondragleave={() => (dropOver = null)}
				ondrop={(e) => onDrop(e, null)}
			>
				{#each loose as note (note.id)}
					<NoteListItem
						{note}
						selected={note.id === library.selectedId}
						hasRecording={library.recordingsOf(note.id).length > 0}
						hasExport={library.recordingsOf(note.id).some((r) => exportsOf(r).length > 0)}
						onclick={() => library.select(note.id)}
					/>
				{/each}
				{#if loose.length === 0 && library.folders.length > 0}
					<p class="muted sidebar__hint">ここにドラッグするとフォルダーから出せます</p>
				{/if}
			</div>
		{/if}
	</div>

	<p class="sidebar__count muted">
		{library.notes.length} 件のノート{library.folders.length
			? `・${library.folders.length} フォルダー`
			: ''}
	</p>
</aside>

<style>
	.sidebar {
		display: grid;
		grid-template-rows: auto 1fr auto;
		min-height: 0;
		border-right: 3px solid var(--ink);
		background: var(--yellow);
	}
	.sidebar__top {
		display: grid;
		gap: 12px;
		padding: 16px 16px 12px;
	}
	.sidebar__buttons {
		display: flex;
		gap: 8px;
		align-items: center;
	}
	.sidebar__new {
		flex: 1;
		min-width: 0;
	}
	.sidebar__search {
		display: block;
	}
	.input--search {
		border-radius: 999px;
		padding-left: 40px;
		font-size: 14px;
		background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%231C1812' stroke-width='3' stroke-linecap='round'%3E%3Ccircle cx='10.5' cy='10.5' r='6.5'/%3E%3Cpath d='M15.5 15.5 21 21'/%3E%3C/svg%3E");
		background-repeat: no-repeat;
		background-size: 17px 17px;
		background-position: 14px center;
	}
	.sidebar__list {
		overflow-y: auto;
		overflow-x: hidden;
		padding: 4px 16px 16px;
		display: grid;
		grid-template-columns: minmax(0, 1fr); /* 長い題名でも横にはみ出さない */
		gap: 10px;
		align-content: start;
	}
	.sidebar__loose {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		min-width: 0;
		gap: 8px;
		min-height: 24px;
		border-radius: 12px;
		padding: 2px;
	}
	.sidebar__loose--over {
		outline: 3px dashed var(--ink);
		outline-offset: 2px;
	}
	.sidebar__section {
		font-size: 11.5px;
		font-weight: 900;
		letter-spacing: 0.08em;
		padding: 6px 4px 0;
	}
	.sidebar__hint {
		font-size: 12px;
		text-align: center;
		padding: 6px;
	}
	.folder {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		min-width: 0;
		gap: 8px;
		border-radius: 14px;
	}
	.folder--over .folder__head {
		background: var(--ink);
		color: var(--cream);
	}
	/* フォルダーの並び替え: 落とす位置に太い挿入バーを出し、動かしているフォルダーは薄くする。
	   バーは上下の隙間に重ねて出し、レイアウトを動かさない（動かすと見出しがずれて判定が前後に揺れ、カクつく） */
	.folder {
		position: relative;
	}
	.folder--before::before,
	.folder--after::after {
		content: '';
		position: absolute;
		left: 0;
		right: 0;
		height: 8px;
		border-radius: 999px;
		background: var(--ink);
		box-shadow: 0 0 0 3px var(--yellow);
		pointer-events: none;
		z-index: 1;
	}
	.folder--before::before {
		top: -10px;
	}
	.folder--after::after {
		bottom: -10px;
	}
	.folder--dragging {
		opacity: 0.35;
	}
	.folder__head {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 10px;
		border: 2.5px solid var(--ink);
		border-radius: 12px;
		background: var(--yellow);
		cursor: pointer;
		font-weight: 900;
		font-size: 13.5px;
		user-select: none;
	}
	.folder__head:focus-visible {
		outline: 3px solid var(--gold);
		outline-offset: 2px;
	}
	.folder__arrow {
		font-size: 11px;
		transition: transform 0.12s ease;
	}
	.folder__arrow--open {
		transform: rotate(90deg);
	}
	.folder__name {
		flex: 1;
		min-width: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.folder__input {
		flex: 1;
		min-width: 0;
		font: inherit;
		font-weight: 900;
		border: 2px solid var(--ink);
		border-radius: 8px;
		padding: 2px 8px;
		background: var(--cream);
		color: var(--ink);
	}
	.folder__input:focus {
		outline: 3px solid var(--gold);
		outline-offset: 1px;
	}
	.folder__count {
		font-size: 12px;
	}
	.folder__menu {
		display: none;
		gap: 4px;
	}
	.folder__head:hover .folder__menu,
	.folder__head:focus-within .folder__menu {
		display: inline-flex;
	}
	.folder__menu .chip {
		min-height: 24px;
		padding: 0 8px;
		font-size: 11.5px;
	}
	.folder__body {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		min-width: 0;
		gap: 8px;
		padding-left: 14px;
	}
	.sidebar__msg {
		padding: 8px 4px;
	}
	.sidebar__empty {
		border: 2.5px dashed var(--ink);
		border-radius: 16px;
		padding: 24px 16px;
		text-align: center;
		display: grid;
		gap: 4px;
	}
	.sidebar__empty-title {
		font-size: 14px;
		font-weight: 900;
	}
	.sidebar__count {
		padding: 8px 16px;
		border-top: 2px solid var(--ink);
		font-weight: 700;
	}
</style>
