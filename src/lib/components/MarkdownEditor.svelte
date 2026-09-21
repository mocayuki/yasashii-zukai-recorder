<script lang="ts">
	import type { Note } from '$shared/types';
	import { fromMarkdown, toMarkdown } from '$shared/notes';
	import { library } from '$lib/stores/library.svelte';
	import { toast } from '$lib/stores/toast.svelte';

	let { note }: { note: Note } = $props();

	// 入力中はカーソルが飛ばないよう、文字列はこの部品が持つ。
	// 図の側で変わったとき（チェック、文字、開閉の並びなど）は、こちらの文も作り直して追従する（双方向）。
	// 自分で書いて木に反映した直後は、木から作った文が lastApplied と同じになるので上書きしない
	// svelte-ignore state_referenced_locally
	let lastApplied = toMarkdown(note.title, note.root);
	let text = $state(lastApplied);
	let el = $state<HTMLTextAreaElement | null>(null);
	$effect(() => {
		const md = toMarkdown(note.title, note.root);
		if (md === lastApplied) return;
		lastApplied = md;
		const t = el;
		const s = t?.selectionStart ?? 0;
		const e = t?.selectionEnd ?? 0;
		text = md;
		if (t && document.activeElement === t) {
			requestAnimationFrame(() =>
				t.setSelectionRange(Math.min(s, md.length), Math.min(e, md.length))
			);
		}
	});
	let showHelp = $state(false);

	const sample = `# 事前確定届出給与のメリット
社会保険料のはなし

- 社会保険料の節約になる
  - 標準報酬月額22万円×保険料率11.82%＝26,004円
  - [ ] 賞与が573万円を超えると保険料がかからない
- 今日は計算方法は覚えなくてOK
  > 細かい計算は覚えなくて大丈夫です。`;

	function apply(next: string) {
		text = next;
		const { title, root } = fromMarkdown(next, note.root);
		library.replaceDocument(note.id, title, root);
		lastApplied = toMarkdown(note.title, note.root);
	}

	function lineStart(value: string, pos: number) {
		return value.lastIndexOf('\n', pos - 1) + 1;
	}

	function onKeydown(e: KeyboardEvent) {
		const t = el;
		if (!t || e.isComposing) return;
		const { selectionStart: s, selectionEnd: eEnd, value } = t;

		if (e.key === 'Tab') {
			e.preventDefault();
			const first = lineStart(value, s);
			const lastLineStart = lineStart(value, Math.max(s, eEnd - (eEnd > s ? 1 : 0)));
			const endIdx = value.indexOf('\n', lastLineStart);
			const last = endIdx === -1 ? value.length : endIdx;
			const block = value.slice(first, last);
			const lines = block.split('\n');
			const next = e.shiftKey
				? lines.map((l) => l.replace(/^(\t|  )/, '')).join('\n')
				: lines.map((l) => '  ' + l).join('\n');
			const delta = next.length - block.length;
			apply(value.slice(0, first) + next + value.slice(last));
			requestAnimationFrame(() => {
				const firstDelta = e.shiftKey ? (/^(\t|  )/.test(lines[0]) ? -2 : 0) : 2;
				t.setSelectionRange(Math.max(first, s + firstDelta), eEnd + delta);
			});
			return;
		}

		if (e.key === 'Enter' && !e.shiftKey) {
			const start = lineStart(value, s);
			const line = value.slice(start, s);
			const m = /^([ \t]*)(- (?:\[( |x)\] )?|> )?/.exec(line);
			if (!m || !m[2]) return; // 普通の行は通常の改行
			e.preventDefault();
			const prefix = m[2].startsWith('- ') ? (m[3] !== undefined ? '- [ ] ' : '- ') : '> ';
			const insert = '\n' + m[1] + prefix;
			apply(value.slice(0, s) + insert + value.slice(eEnd));
			const pos = s + insert.length;
			requestAnimationFrame(() => t.setSelectionRange(pos, pos));
		}
	}

	async function copyAll() {
		try {
			await navigator.clipboard.writeText(text);
			toast.show('Markdown をコピーしました');
		} catch {
			toast.error('コピーできませんでした');
		}
	}
</script>

<div class="md">
	<div class="md__top">
		<div class="md__bar">
			<p class="muted">
				「# タイトル」、その次の行が中心のことば（省くとタイトルと同じ）、「-
				ノード」、字下げで子、「- [ ]」でチェックです。AI に作らせたものをそのまま貼れます。
			</p>
			<div class="md__tools">
				<button
					type="button"
					class="chip"
					aria-pressed={showHelp}
					onclick={() => (showHelp = !showHelp)}
				>
					書き方の例
				</button>
				<button type="button" class="chip" onclick={copyAll}>全部コピー</button>
			</div>
		</div>

		{#if showHelp}
			<pre class="md__sample">{sample}</pre>
		{/if}
	</div>

	<textarea
		bind:this={el}
		class="md__text"
		value={text}
		oninput={(e) => apply(e.currentTarget.value)}
		onkeydown={onKeydown}
		spellcheck="false"
		placeholder={sample}></textarea>
</div>

<style>
	.md {
		display: grid;
		grid-template-rows: auto 1fr;
		gap: 10px;
		height: 100%;
		min-height: 0;
	}
	.md__top {
		display: grid;
		gap: 10px;
	}
	.md__bar {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
	}
	.md__tools {
		display: flex;
		gap: 6px;
	}
	.md__sample {
		margin: 0;
		background: var(--thead);
		border: 2px solid var(--ink);
		border-radius: 14px;
		padding: 12px 16px;
		font-family: inherit;
		font-size: 13px;
		line-height: 1.8;
		white-space: pre-wrap;
		user-select: text;
	}
	.md__text {
		width: 100%;
		height: 100%;
		min-height: 360px;
		background: var(--cream);
		border: var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow-lg);
		padding: 18px 20px;
		font-size: 15px;
		line-height: 1.9;
		font-weight: 500;
		resize: none;
		tab-size: 2;
	}
	.md__text:focus {
		outline: none;
		background: #fff;
	}
	.md__text::placeholder {
		color: var(--placeholder);
	}
</style>
