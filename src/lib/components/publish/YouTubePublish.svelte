<script lang="ts">
	/**
	 * YouTube への投稿（1 本）。題・説明・タグ・公開範囲は投稿の画面が持つ draft を直接編集する（確定で保存）。
	 * サムネの欄は投稿の画面の左（ThumbnailCard）にあり、投稿の直前に onCapture で写す。
	 * 予約の日時は画面で共通に決める（publishAtIso）。縦の動画は YouTube 側で自動的にショート扱いになる
	 */
	import type { Recording, Note, PostRecord, ExportInfo } from '$shared/types';
	import { parseTags, TEXT_LIMITS } from '$shared/publish';
	import { api } from '$lib/api';
	import { toast } from '$lib/stores/toast.svelte';
	import { postOne } from '$lib/publish/run';
	import type { Draft } from './draft';

	let {
		recording,
		exportInfo,
		note,
		draft = $bindable(),
		publishAtIso,
		schedErr,
		onPosted,
		postedOn = false,
		onTogglePosted,
		onCapture
	}: {
		recording: Recording;
		exportInfo: ExportInfo;
		note: Note | null;
		draft: Draft;
		publishAtIso: string | null;
		schedErr: string | null;
		onPosted?: (record: PostRecord) => void;
		/** この書き出しをこの投稿先に投稿済みか（判子と、二重投稿の確認）。自分で付け外しできる */
		postedOn?: boolean;
		onTogglePosted?: () => void;
		/** 投稿の直前に、サムネの欄を写して draft.thumbnailPath に入れる（サムネの欄は投稿の画面にある） */
		onCapture?: () => Promise<void>;
	} = $props();

	const portrait = $derived(note?.orientation === 'portrait');
	let status = $state<{
		connected: boolean;
		channelTitle: string | null;
		hasClient: boolean;
	} | null>(null);
	let uploading = $state(false);
	let progress = $state<{ phase: string; ratio: number } | null>(null);
	let result = $state<{ url: string; thumbnailWarning?: string } | null>(null);

	const tags = $derived(parseTags(draft.tagsText));
	const titleLen = $derived([...draft.title].length);
	const titleTooLong = $derived(titleLen > (TEXT_LIMITS.youtube.title ?? 100));
	const locked = $derived(uploading || !!result);
	export const canPost = () =>
		!!status?.connected &&
		!uploading &&
		!result &&
		draft.title.trim() !== '' &&
		!titleTooLong &&
		!schedErr;

	$effect(() => {
		void api()
			.publish.youtubeStatus()
			.then((s) => (status = s))
			.catch(() => (status = { connected: false, channelTitle: null, hasClient: false }));
		return api().publish.onProgress((p) => {
			if (p.id === recording.id) progress = { phase: p.phase, ratio: p.ratio };
		});
	});

	/** アップロードする。投稿の画面の「すべて投稿」からも呼ばれる */
	export async function post(): Promise<void> {
		if (!canPost()) return;
		if (
			postedOn &&
			!confirm(
				'この動画は YouTube にもう投稿済みです。もう一度投稿すると同じ動画が 2 本になります。投稿しますか？'
			)
		)
			return;
		uploading = true;
		progress = { phase: 'preparing', ratio: 0 };
		try {
			await onCapture?.();
			const r = await postOne('youtube', recording, exportInfo, draft, note, publishAtIso);
			result = { url: r.record.url ?? '', thumbnailWarning: r.warning };
			toast.show(publishAtIso ? 'YouTube に予約しました' : 'YouTube にアップロードしました');
			if (r.warning) toast.error(r.warning);
			onPosted?.(r.record);
		} catch (err) {
			toast.error(`アップロードできませんでした。${(err as Error).message}`);
		} finally {
			uploading = false;
		}
	}
	const phaseText = (p: string) =>
		p === 'preparing'
			? '準備しています…'
			: p === 'uploading'
				? 'アップロードしています…'
				: p === 'thumbnail'
					? 'サムネイルを設定しています…'
					: p === 'done'
						? '完了'
						: '';
</script>

<section class="yt card" class:card--posted={postedOn}>
	{#if postedOn}<span class="stamp">投稿済み</span>{/if}
	<div class="yt__head">
		<h2 class="card__title">YouTube{portrait ? '（縦なのでショートになります）' : ''}</h2>
		<span class="muted">
			{#if status === null}
				接続を確かめています…
			{:else if status.connected}
				チャンネル: {status.channelTitle}
			{:else if status.hasClient}
				まだ接続していません。設定の「YouTube」で接続してください。
			{:else}
				設定の「YouTube」にクライアント ID とシークレットを入れて、接続してください。
			{/if}
		</span>
		{#if onTogglePosted}
			<button type="button" class="chip yt__mark" onclick={onTogglePosted}
				>{postedOn ? '投稿済みを外す' : '投稿済みにする'}</button
			>
		{/if}
	</div>

	<div class="yt__grid">
		<div class="yt__fields">
			<label class="yt__field">
				<span>タイトル <span class="muted" class:yt__over={titleTooLong}>{titleLen}/100</span></span
				>
				<input class="input" bind:value={draft.title} disabled={locked} />
				{#if titleTooLong}<span class="yt__err">100 文字までです</span>{/if}
			</label>
			<label class="yt__field">
				<span>説明</span>
				<textarea class="input yt__desc" rows="6" bind:value={draft.text} disabled={locked}
				></textarea>
			</label>
			<label class="yt__field">
				<span>タグ <span class="muted">（, や 、で区切る。{tags.length} 個）</span></span>
				<input
					class="input"
					bind:value={draft.tagsText}
					placeholder="AI, 図解, やさしいバイブコーディング"
					disabled={locked}
				/>
			</label>
		</div>
	</div>

	<div class="yt__row">
		<span class="yt__label">公開範囲</span>
		{#each [['public', '公開'], ['unlisted', '限定公開'], ['private', '非公開']] as [v, label] (v)}
			<label
				class="chip yt__radio"
				class:chip--on={draft.privacy === v}
				class:yt__radio--off={(locked || !!publishAtIso) && draft.privacy !== v}
			>
				<input
					type="radio"
					name="yt-privacy-{recording.id}"
					value={v}
					bind:group={draft.privacy}
					disabled={locked || !!publishAtIso}
				/>
				{label}
			</label>
		{/each}
		{#if publishAtIso}<span class="muted"
				>予約は「公開」だけ。時刻までは非公開で、時刻に公開されます</span
			>{/if}
	</div>

	{#if uploading && progress}
		<div
			class="yt__progress"
			role="progressbar"
			aria-valuemin="0"
			aria-valuemax="100"
			aria-valuenow={Math.round(progress.ratio * 100)}
		>
			<div class="yt__bar" style="transform: scaleX({progress.ratio})"></div>
		</div>
		<span class="muted"
			>{phaseText(progress.phase)}
			{progress.phase === 'uploading' ? `${Math.round(progress.ratio * 100)}%` : ''}</span
		>
	{:else if result}
		<div class="yt__done">
			<strong>{publishAtIso ? '予約しました' : 'アップロードしました'}</strong>
			<a href={result.url} target="_blank" rel="noreferrer">{result.url}</a>
			{#if result.thumbnailWarning}<span class="yt__err">{result.thumbnailWarning}</span>{/if}
		</div>
	{:else}
		<div class="yt__row">
			<button
				type="button"
				class="btn btn--sm btn--green"
				onclick={() => void post()}
				disabled={!canPost()}
			>
				{publishAtIso ? 'YouTube に予約する' : 'YouTube にアップロードする'}
			</button>
			<span class="muted">1 日に上げられるのは 6 本ほどです（API の割り当て）</span>
		</div>
	{/if}
</section>

<style>
	.yt {
		display: grid;
		gap: 12px;
	}
	.yt__head {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
	}
	.yt__mark {
		margin-left: auto;
	}
	.yt__grid {
		display: grid;
		gap: 16px;
		align-items: start;
	}
	.yt__fields {
		display: grid;
		gap: 12px;
		min-width: 0;
	}
	.yt__field {
		display: grid;
		gap: 4px;
		font-weight: 900;
		font-size: 13px;
	}
	.yt__desc {
		font: inherit;
		line-height: 1.6;
		resize: vertical;
		/* 中身に合わせて伸びる（欄の中でスクロールしない） */
		field-sizing: content;
		min-height: 8em;
	}
	.yt__over {
		color: var(--alert);
	}
	.yt__row {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}
	.yt__label {
		font-weight: 900;
		font-size: 13px;
	}
	.yt__radio {
		cursor: pointer;
	}
	/* 押せないとき（予約・投稿中）は薄く */
	.yt__radio--off {
		opacity: 0.45;
		cursor: default;
	}
	.yt__radio input {
		position: absolute;
		opacity: 0;
		width: 1px;
		height: 1px;
	}
	.yt__err {
		color: var(--alert);
		font-weight: 700;
		font-size: 12.5px;
	}
	.yt__progress {
		height: 10px;
		border: 2px solid var(--ink);
		border-radius: 999px;
		overflow: hidden;
		background: var(--cream);
	}
	.yt__bar {
		height: 100%;
		width: 100%;
		background: var(--ink);
		transform-origin: left;
		transition: transform 0.2s linear;
	}
	.yt__done {
		display: flex;
		gap: 12px;
		align-items: center;
		flex-wrap: wrap;
	}
</style>
