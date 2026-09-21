<script lang="ts">
	/**
	 * キー操作の一覧。ワークスペース（図の編集・収録）と編集画面（カット）で内容を切り替える。
	 * 実装されているキーだけを載せる（MindMap / Workspace / MindNode / RecordingEditor の keydown と合わせて保つ）
	 */
	let { kind, onClose }: { kind: 'map' | 'editor'; onClose: () => void } = $props();
	let dialog = $state<HTMLDialogElement | null>(null);
	$effect(() => {
		dialog?.showModal();
	});

	type Row = [keys: string, what: string];
	const mapSections: Array<{ title: string; rows: Row[] }> = [
		{
			title: '話しながら（収録中も同じ）',
			rows: [
				['スペース', '次の閉じているノードを開く（選んでいる所から順に。無ければ先頭から）'],
				['Shift + スペース', '直前にスペースで開いたものを閉じる'],
				['↑ / ↓', '上・下のノードを選ぶ'],
				['→', '子へ進む（閉じていれば開く）'],
				['←', '親へ戻る'],
				['⌘ + Enter', 'チェックの 未 ↔ 済（収録中は Enter だけでも）'],
				['画像をクリック', '画像を大きく表示（もう一度押すか Esc で戻る）'],
				['Esc', '選択を外す。全画面なら全画面をやめる。カウントダウン中なら取りやめ']
			]
		},
		{
			title: 'ノードを足す・書く（収録していないとき）',
			rows: [
				['Tab', '子を足す'],
				['Enter', '下に足す（縦の動画では右に）'],
				['Shift + Enter', '上に足す'],
				['文字キー / F2 / ダブルクリック', '文字を書き始める'],
				['書いている間の Enter', '確定して次を足す'],
				['書いている間の Tab', '確定して子を足す'],
				['書いている間の Esc', '書き直しを取り消す'],
				['Delete / Backspace', 'ノードを削除（子があれば確認）']
			]
		},
		{
			title: '並び替え・つなぎ直し',
			rows: [
				['Option + ↑ / ↓', '兄弟の並びを入れ替える'],
				['Shift + Tab', '一段上げる（親と同じ並びへ）'],
				[
					'ノードをドラッグ',
					'位置を動かす。別のノードに重ねると子になり、前後の隙間に落とすとそこに並ぶ'
				],
				['線の付け根の丸をドラッグ', '別のノードに落とすと、そのノードにつなぎ直す'],
				['画像ファイルを落とす', 'そのノードに画像を付ける']
			]
		},
		{
			title: '画面',
			rows: [
				['⌘ + Z / ⌘ + Shift + Z', '戻す / やり直す'],
				['⌘ + プラス / ⌘ + マイナス', '拡大 / 縮小'],
				['⌘ + 0', '全体を収める'],
				['ホイール / ドラッグ', '拡大縮小 / 面の移動']
			]
		}
	];
	const editorSections: Array<{ title: string; rows: Row[] }> = [
		{
			title: '編集画面（カット）',
			rows: [
				['スペース', '再生 / 一時停止（文字を打っている欄の中では空白）'],
				['Enter / Esc（いまのテロップの欄で）', '直し終えて欄から出る（そのあとスペースで再生）'],
				['← / →', '1 コマ戻る / 進む'],
				['Shift + ← / →', '30 コマ戻る / 進む'],
				[
					'⌘ + Z / ⌘ + Shift + Z',
					'テロップの編集を戻す / やり直す（文字の入力中はその欄の取り消し）'
				],
				['Esc', '編集画面を閉じる']
			]
		}
	];
	const sections = $derived(kind === 'map' ? mapSections : editorSections);
</script>

<dialog
	bind:this={dialog}
	class="dialog"
	onclose={onClose}
	onkeydown={(e) => {
		// Esc はこの一覧を閉じるだけ（全画面をやめる処理まで届かせない）
		if (e.key === 'Escape') e.stopPropagation();
	}}
	aria-labelledby="shortcuts-heading"
>
	<div class="dialog__head">
		<h2 id="shortcuts-heading" class="dialog__title">キー操作</h2>
		<button type="button" class="dialog__close" aria-label="閉じる" onclick={() => dialog?.close()}
			>×</button
		>
	</div>
	<div class="dialog__body">
		{#each sections as s (s.title)}
			<section class="keys">
				<h3 class="keys__title">{s.title}</h3>
				<dl class="keys__list">
					{#each s.rows as [keys, what] (keys)}
						<dt><kbd>{keys}</kbd></dt>
						<dd>{what}</dd>
					{/each}
				</dl>
			</section>
		{/each}
	</div>
</dialog>

<style>
	.dialog {
		width: min(92vw, 720px);
		max-height: 88vh;
		padding: 0;
		border: var(--border);
		border-radius: 20px;
		background: var(--cream);
		color: var(--ink);
		box-shadow: var(--shadow);
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}
	.dialog::backdrop {
		background: rgba(28, 24, 18, 0.45);
	}
	.dialog__head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 16px 20px;
		background: var(--yellow);
		border-bottom: var(--border);
	}
	.dialog__title {
		margin: 0;
		font-size: 18px;
		font-weight: 900;
	}
	.dialog__close {
		width: 36px;
		height: 36px;
		border: var(--border);
		border-radius: 50%;
		background: var(--cream);
		font-size: 20px;
		font-weight: 900;
		cursor: pointer;
		line-height: 1;
	}
	.dialog__body {
		overflow: auto;
		padding: 16px 20px 24px;
		display: grid;
		gap: 18px;
	}
	.keys__title {
		margin: 0 0 8px;
		font-size: 14px;
		font-weight: 900;
		color: var(--brown);
	}
	.keys__list {
		margin: 0;
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr);
		column-gap: 16px;
		row-gap: 8px;
		align-items: baseline;
	}
	.keys__list dt,
	.keys__list dd {
		margin: 0;
	}
	.keys__list dd {
		font-size: 14px;
		line-height: 1.6;
	}
	kbd {
		display: inline-block;
		font: inherit;
		font-size: 13px;
		font-weight: 900;
		padding: 2px 10px;
		border: 2px solid var(--ink);
		border-bottom-width: 4px;
		border-radius: 8px;
		background: #fff;
		white-space: nowrap;
	}
</style>
