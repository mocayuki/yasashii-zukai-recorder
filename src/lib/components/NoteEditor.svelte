<script lang="ts">
	import { exportsOf, type Note } from '$shared/types';
	import { library } from '$lib/stores/library.svelte';
	import { toast } from '$lib/stores/toast.svelte';
	import { ui } from '$lib/stores/ui.svelte';
	import { formatDateTime } from '$lib/utils/format';
	import MindMap from './MindMap.svelte';
	import RecordingRow from './RecordingRow.svelte';

	/**
	 * 一覧で選んだノートの中身。ここでは編集せず、全体像を見るだけ。
	 * 編集と収録は「ワークスペースを開く」で画面全体に移ってから行う。
	 */
	let { note }: { note: Note } = $props();

	const recordings = $derived(library.recordingsOf(note.id));

	/** フォルダーの選択。「新しいフォルダー…」なら名前を聞いて作る（フォルダーはノートに付く名前） */
	async function chooseFolder(value: string) {
		if (value === '__new__') {
			const name = window.prompt('新しいフォルダーの名前', '');
			if (name && name.trim()) library.setFolder(note.id, name.trim());
			return;
		}
		library.setFolder(note.id, value || null);
	}

	/** 一括削除用に選んだ収録の id。消えた収録は自動的に外れる */
	let picked = $state<string[]>([]);
	const pickedLive = $derived(picked.filter((id) => recordings.some((r) => r.id === id)));
	const allPicked = $derived(recordings.length > 0 && pickedLive.length === recordings.length);
	function pick(id: string, on: boolean) {
		picked = on ? [...new Set([...pickedLive, id])] : pickedLive.filter((x) => x !== id);
	}
	function pickAll() {
		picked = allPicked ? [] : recordings.map((r) => r.id);
	}
	let deleting = $state(false);
	async function removePicked() {
		const ids = pickedLive;
		if (ids.length === 0) return;
		if (
			!window.confirm(
				`選んだ ${ids.length} 件の収録を削除します。ファイルも消えます。元に戻せません。よろしいですか？`
			)
		)
			return;
		deleting = true;
		let done = 0;
		try {
			for (const id of ids) {
				await library.deleteRecording(id);
				done++;
			}
			toast.show(`収録を ${done} 件削除しました`);
		} catch (err) {
			toast.error(`${done} 件削除したところで失敗しました。${(err as Error).message}`);
		} finally {
			deleting = false;
			picked = [];
		}
	}

	async function duplicate() {
		try {
			const copy = await library.duplicateNote(note.id);
			if (copy) toast.show(`「${copy.title}」を作りました`);
		} catch (err) {
			toast.error(`複製できませんでした。${(err as Error).message}`);
		}
	}

	async function removeNote() {
		const count = recordings.length;
		const name = note.title || '無題のノート';
		const msg =
			count > 0
				? `「${name}」と、付いている ${count} 件の収録ファイルを削除します。元に戻せません。よろしいですか？`
				: `「${name}」を削除します。元に戻せません。よろしいですか？`;
		if (!window.confirm(msg)) return;
		try {
			await library.deleteNote(note.id);
			toast.show('ノートを削除しました');
		} catch (err) {
			toast.error((err as Error).message);
		}
	}
</script>

<article class="overview">
	<div class="overview__top">
		<h1 class="overview__title">{note.title.trim() || '無題のノート'}</h1>
		<div class="overview__actions">
			<label class="overview__folder">
				<span class="muted">フォルダー</span>
				<select
					class="input"
					value={note.folder ?? ''}
					onchange={(e) => void chooseFolder(e.currentTarget.value)}
				>
					<option value="">なし</option>
					{#each library.folders as f (f)}
						<option value={f}>{f}</option>
					{/each}
					<option value="__new__">新しいフォルダー…</option>
				</select>
			</label>
			<button type="button" class="btn btn--yellow" onclick={() => ui.enterWorkspace()}>
				ワークスペースを開く
			</button>
			<button
				type="button"
				class="btn btn--sm"
				title="このノートを複製する（木・フォルダー・向きを写す。収録は写さない）"
				onclick={duplicate}
			>
				複製
			</button>
		</div>
	</div>
	<p class="muted">
		全体像です。編集や収録はワークスペースで行います（プレビューをクリックしても開けます）。
	</p>

	<div class="overview__body">
		<!-- プレビューは大きさ固定（動画と同じ 16:9）。収録の一覧はいつもこの下（ウィンドウの広さで横に並ぶことはない） -->
		<button
			type="button"
			class="overview__preview"
			class:overview__preview--portrait={note.orientation === 'portrait'}
			onclick={() => ui.enterWorkspace()}
			aria-label="ワークスペースを開く"
		>
			<MindMap {note} readonly />
		</button>

		<section class="overview__recordings" aria-labelledby="rec-heading">
			<div class="overview__rec-head">
				<h2 id="rec-heading" class="card__title">
					収録 <span class="muted">{recordings.length} 件</span>
				</h2>
				{#if recordings.length > 0}
					<div class="overview__rec-tools">
						<button type="button" class="btn btn--sm" onclick={pickAll}>
							{allPicked ? '全部外す' : '全部選ぶ'}
						</button>
						<button
							type="button"
							class="btn btn--sm btn--danger"
							disabled={pickedLive.length === 0 || deleting}
							onclick={removePicked}
						>
							{deleting ? '削除しています…' : `選んだ ${pickedLive.length} 件を削除`}
						</button>
					</div>
				{/if}
			</div>
			{#if recordings.length === 0}
				<p class="muted">このノートにはまだ収録がありません。</p>
			{:else}
				<div class="overview__rec-list">
					{#each [...recordings].reverse() as r (r.id)}
						<RecordingRow
							recording={r}
							selected={pickedLive.includes(r.id)}
							onSelect={(on) => pick(r.id, on)}
							onOpen={() => (ui.editingRecordingId = r.id)}
							onPublish={() =>
								(ui.publishing = { recordingId: r.id, exportId: exportsOf(r).at(-1)!.id })}
						/>
					{/each}
				</div>
				<p class="muted">
					行を押すと編集画面が開きます。左のチェックで選んで、まとめて削除できます。
				</p>
			{/if}
		</section>
	</div>

	<div class="overview__foot">
		<span class="muted">作成 {formatDateTime(note.createdAt)}</span>
		<button type="button" class="btn btn--sm btn--danger" onclick={removeNote}
			>このノートを削除</button
		>
	</div>
</article>

<style>
	.overview {
		display: grid;
		gap: 12px;
		align-content: start;
		padding: 20px 28px 40px;
	}
	/* 題名が 1 行目、その下の 2 行目に「フォルダー」と「ワークスペースを開く」を固定で置く（題名の長さで動かない） */
	.overview__top {
		display: grid;
		gap: 12px;
	}
	.overview__actions {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
	}
	.overview__folder {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 13px;
		font-weight: 700;
		white-space: nowrap;
	}
	.overview__folder select {
		min-height: 38px;
		padding: 4px 12px;
		font-size: 13.5px;
		max-width: 220px;
	}
	.overview__title {
		font-size: 28px;
		font-weight: 900;
		letter-spacing: 0.02em;
		line-height: 1.4;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	/* プレビューの下に収録の一覧。ウィンドウが広くても横に並べない（探す場所をいつも同じにする） */
	.overview__body {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 20px;
		align-items: start;
		justify-items: start;
		margin-top: 6px;
	}
	.overview__preview {
		display: grid; /* 中のマップが高さいっぱいに広がるように */
		grid-template-columns: minmax(0, 1fr); /* 長い題名でも箱の幅を超えない */
		flex: none;
		width: 520px;
		height: 292px; /* 16:9 */
		max-width: 100%;
		min-width: 0;
		overflow: hidden;
		padding: 0;
		border: 0;
		background: transparent;
		cursor: pointer;
		text-align: left;
		font: inherit;
	}
	/* 縦の動画のノートは、縦長のプレビュー */
	.overview__preview--portrait {
		width: 250px;
		height: 444px;
	}
	.overview__preview:focus-visible {
		outline: 3px solid var(--gold);
		outline-offset: 4px;
		border-radius: var(--radius);
	}
	.overview__recordings {
		width: 100%;
		max-width: 920px;
		min-width: 0;
		display: grid;
		gap: 12px;
		align-content: start;
	}
	.overview__rec-list {
		display: grid;
		gap: 10px;
	}
	.overview__rec-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		flex-wrap: wrap;
	}
	.overview__rec-tools {
		display: flex;
		gap: 8px;
	}
	.overview__foot {
		margin-top: 16px;
		padding-top: 16px;
		border-top: 2px solid var(--ink);
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
	}
</style>
