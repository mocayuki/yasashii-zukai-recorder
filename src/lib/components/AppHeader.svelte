<script lang="ts">
	import StorageBadge from './StorageBadge.svelte';

	let {
		onOpenSettings,
		onOpenSchedule
	}: { onOpenSettings: () => void; onOpenSchedule: () => void } = $props();
</script>

<header class="header">
	<div class="header__logo">
		<!-- アプリのアイコン（resources/icon.png）と同じ絵 -->
		<svg class="header__mark" viewBox="0 0 1024 1024" aria-hidden="true">
			<rect x="108" y="108" width="860" height="860" rx="210" fill="#1c1812" />
			<rect
				x="82"
				y="82"
				width="860"
				height="860"
				rx="210"
				fill="#ffd95c"
				stroke="#1c1812"
				stroke-width="34"
			/>
			<path
				d="M460 512 C 521 512, 521 372, 582 372 M460 512 C 521 512, 521 652, 582 652"
				fill="none"
				stroke="#1c1812"
				stroke-width="22"
				stroke-linecap="round"
			/>
			<rect x="214" y="448" width="260" height="156" rx="78" fill="#1c1812" />
			<rect
				x="200"
				y="434"
				width="260"
				height="156"
				rx="78"
				fill="#fff"
				stroke="#1c1812"
				stroke-width="20"
			/>
			<circle cx="330" cy="512" r="34" fill="#ffd95c" stroke="#1c1812" stroke-width="16" />
			<rect x="596" y="324" width="236" height="124" rx="62" fill="#1c1812" />
			<rect
				x="582"
				y="310"
				width="236"
				height="124"
				rx="62"
				fill="#fff"
				stroke="#1c1812"
				stroke-width="20"
			/>
			<rect x="596" y="604" width="236" height="124" rx="62" fill="#1c1812" />
			<rect
				x="582"
				y="590"
				width="236"
				height="124"
				rx="62"
				fill="#fff"
				stroke="#1c1812"
				stroke-width="20"
			/>
		</svg>
		<span>やさしい図解レコーダー</span>
	</div>
	<div class="header__right">
		<button type="button" class="btn btn--sm btn--green" onclick={onOpenSchedule}>投稿管理</button>
		<StorageBadge onclick={onOpenSettings} />
		<button type="button" class="btn btn--sm" onclick={onOpenSettings}>設定</button>
	</div>
</header>

<style>
	.header {
		height: var(--titlebar);
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		padding: 0 16px 0 84px; /* 左は Mac の信号機ボタンの分 */
		background: var(--yellow);
		border-bottom: 3px solid var(--ink);
		-webkit-app-region: drag; /* ヘッダーでウィンドウを動かせる */
	}
	.header__logo {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		font-size: 17px;
		font-weight: 900;
		letter-spacing: 0.04em;
		white-space: nowrap;
	}
	.header__mark {
		width: 30px;
		height: 30px;
		flex: none;
	}
	.header__right {
		display: flex;
		align-items: center;
		gap: 10px;
		-webkit-app-region: no-drag;
	}
</style>
