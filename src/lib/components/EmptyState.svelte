<script lang="ts">
	let { onNewNote, onImportLegacy }: { onNewNote: () => void; onImportLegacy: () => void } =
		$props();
</script>

<div class="empty">
	<h1 class="empty__title">
		<span>ひらいて、</span><span>話して、</span><span>動画になる。</span>
	</h1>
	<p class="empty__lead">
		ノードの木を開きながら話すだけで、YouTube にそのまま上げられる動画ができます。<br />
		左の一覧からノートを選ぶか、新しいノートを作ってください。
	</p>
	<div class="empty__actions">
		<button type="button" class="btn btn--lg btn--ink" onclick={onNewNote}>＋ 新しいノート</button>
		<button type="button" class="btn btn--lg" onclick={onImportLegacy}
			>初期版のバックアップを取り込む</button
		>
	</div>
	<p class="muted empty__note">
		ノートは Markdown でも書けるので、AI に作らせた木をそのまま貼れます。収録・カット編集・BGM・mp4
		の書き出しまで、このアプリの中で終わります。
	</p>
</div>

<style>
	.empty {
		height: 100%;
		display: grid;
		align-content: center;
		justify-items: center;
		gap: 18px;
		padding: 40px 28px;
		text-align: center;
	}
	.empty__title {
		font-size: 30px;
		font-weight: 900;
		line-height: 1.5;
	}
	.empty__title span {
		display: inline-block;
	}
	.empty__lead {
		font-size: 15px;
		color: var(--ink-2);
	}
	.empty__actions {
		display: flex;
		gap: 16px;
		flex-wrap: wrap;
		justify-content: center;
		margin-top: 8px;
	}
	.empty__note {
		margin-top: 8px;
	}
</style>
