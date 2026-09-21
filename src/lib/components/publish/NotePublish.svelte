<script lang="ts">
	/**
	 * note の欄。note には投稿の API が無いので、AI が作った Markdown の記事を「コピーして note を開く」で
	 * クリップボードに入れ、ブラウザーで note の新規記事を開く。貼って公開するのは手で。
	 * 本文の下には「この話は YouTube でもお話ししています」と動画の URL（まだ無ければチャンネル）を付ける
	 */
	import type { Recording, PostRecord, ExportInfo } from '$shared/types';
	import { TEXT_LIMITS, noteClosing, parseTags } from '$shared/publish';
	import { toast } from '$lib/stores/toast.svelte';
	import { markdownToHtml } from '$lib/publish/note-html';
	import type { Draft } from './draft';

	let {
		recording,
		exportInfo,
		draft = $bindable(),
		onPosted,
		postedOn = false,
		onTogglePosted
	}: {
		recording: Recording;
		exportInfo: ExportInfo;
		draft: Draft;
		onPosted?: (record: PostRecord) => void;
		postedOn?: boolean;
		onTogglePosted?: () => void;
	} = $props();

	const NOTE_NEW_URL = 'https://note.com/notes/new';
	const count = $derived([...draft.text].length);
	const limit = TEXT_LIMITS.note.body;
	/** この書き出しの YouTube の投稿の URL（あれば結びに使う） */
	const youtubeUrl = $derived(
		(recording.posts ?? []).find(
			(p) => p.platform === 'youtube' && (p.exportId ?? 'legacy') === exportInfo.id && p.url
		)?.url ?? null
	);
	const closing = $derived(noteClosing(youtubeUrl));
	/** 記事の題は動画の題そのもの（AI には作らせない） */
	const title = $derived(recording.title.trim());
	/** 貼る全文: 題（# 見出し）+ 本文 + 結び */
	const full = $derived(
		[title ? `# ${title}` : '', draft.text.trim(), closing].filter(Boolean).join('\n\n')
	);

	/** note の別欄に入れるハッシュタグ（draft.tagsText に , 区切りで持つ。AI が作る） */
	const tags = $derived(parseTags(draft.tagsText));
	let copiedTag = $state<string | null>(null);
	async function copyTag(t: string) {
		try {
			await navigator.clipboard.writeText(t);
			copiedTag = t;
		} catch {
			toast.error('クリップボードに入れられませんでした');
		}
	}
	async function copyAllTags() {
		try {
			await navigator.clipboard.writeText(tags.map((t) => `#${t}`).join(' '));
			copiedTag = '*';
			toast.show('ハッシュタグをまとめてコピーしました');
		} catch {
			toast.error('クリップボードに入れられませんでした');
		}
	}
	let copied = $state(false);
	async function copyAndOpen() {
		if (!draft.text.trim()) return;
		try {
			// note の編集画面は Markdown の記号を文字のまま貼ってしまうので、HTML でも入れる（見出し・太字・箇条書きが効く）
			const html = markdownToHtml(full);
			await navigator.clipboard.write([
				new ClipboardItem({
					'text/html': new Blob([html], { type: 'text/html' }),
					'text/plain': new Blob([full], { type: 'text/plain' })
				})
			]);
		} catch {
			try {
				await navigator.clipboard.writeText(full);
			} catch {
				toast.error('クリップボードに入れられませんでした');
				return;
			}
		}
		copied = true;
		window.open(NOTE_NEW_URL, '_blank');
		toast.show('記事をコピーしました。note に貼り付けて公開してください');
		onPosted?.({ platform: 'note', at: Date.now(), exportId: exportInfo.id });
	}
</script>

<section class="np card" class:card--posted={postedOn}>
	{#if postedOn}<span class="stamp">投稿済み</span>{/if}
	<div class="np__head">
		<h2 class="card__title">note</h2>
		<span class="muted"
			>API が無いので、コピーして note
			に貼ります（見出し・太字・箇条書きはそのまま貼れる形で入れます）</span
		>
		{#if onTogglePosted}
			<button type="button" class="chip np__mark" onclick={onTogglePosted}
				>{postedOn ? '投稿済みを外す' : '投稿済みにする'}</button
			>
		{/if}
	</div>
	<div class="np__field">
		<span>記事の題 <span class="muted">（動画の題と同じ）</span></span>
		<div class="np__title">{title}</div>
	</div>
	<label class="np__field">
		<span
			>本文（Markdown） <span class="muted" class:np__over={count > limit}>{count}/{limit}</span
			></span
		>
		<textarea class="input np__text" rows="12" bind:value={draft.text}></textarea>
	</label>
	<label class="np__field">
		<span
			>ハッシュタグ <span class="muted"
				>（note の「ハッシュタグ」の欄に入れる。, や 、で区切る。{tags.length} 個）</span
			></span
		>
		<input class="input" bind:value={draft.tagsText} placeholder="AI, 生成AI, 働き方" />
	</label>
	{#if tags.length > 0}
		<div class="np__tags">
			{#each tags as t (t)}
				<button
					type="button"
					class="chip"
					class:chip--green={copiedTag === t}
					title="押すとこの 1 語をコピー（note の欄に 1 つずつ貼る）"
					onclick={() => void copyTag(t)}>#{t}</button
				>
			{/each}
			<button type="button" class="chip" onclick={() => void copyAllTags()}>全部コピー</button>
			<span class="muted"
				>押すと 1 語ずつコピーできます（note のハッシュタグの欄は 1 語ずつ入れる）</span
			>
		</div>
	{/if}
	<div class="np__closing">
		<span class="np__label">結び（自動で付きます）</span>
		<pre class="np__pre">{closing}</pre>
		{#if !youtubeUrl}
			<span class="muted"
				>YouTube に投稿するとその動画の URL に変わります（今はチャンネルの URL）</span
			>
		{/if}
	</div>
	<div class="np__row">
		<button
			type="button"
			class="btn btn--sm btn--green"
			onclick={() => void copyAndOpen()}
			disabled={!draft.text.trim()}>コピーして note を開く</button
		>
		<span class="muted"
			>{copied
				? 'コピー済み。note の新規記事に貼り付けて公開してください'
				: '題・本文・結びをまとめてコピーし、ブラウザーで note の新規記事を開きます'}</span
		>
	</div>
</section>

<style>
	.np {
		display: grid;
		gap: 12px;
	}
	.np__head {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
	}
	.np__mark {
		margin-left: auto;
	}
	.np__field {
		display: grid;
		gap: 4px;
		font-weight: 900;
		font-size: 13px;
	}
	.np__title {
		font-size: 15px;
		font-weight: 900;
		padding: 6px 0;
	}
	.np__text {
		font: inherit;
		line-height: 1.6;
		resize: vertical;
		/* 中身に合わせて伸びる（欄の中でスクロールしない） */
		field-sizing: content;
		min-height: 12em;
	}
	.np__over {
		color: var(--alert);
	}
	.np__closing {
		display: grid;
		gap: 4px;
		font-size: 12.5px;
	}
	.np__label {
		font-weight: 900;
		font-size: 13px;
	}
	.np__pre {
		margin: 0;
		padding: 8px 10px;
		border: 2px dashed var(--ink);
		border-radius: 8px;
		background: #fff;
		font: inherit;
		white-space: pre-wrap;
		word-break: break-all;
	}
	.np__tags {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		font-size: 12.5px;
	}
	.np__row {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}
</style>
