<script lang="ts">
	import { onDestroy } from 'svelte';
	import type { BgmTrack } from '$shared/types';
	import { api } from '$lib/api';
	import { settings } from '$lib/stores/settings.svelte';
	import { toast } from '$lib/stores/toast.svelte';

	/**
	 * 書き出しに重ねる BGM を選ぶ。曲は保存先の bgm/ にあるもの。
	 * ▶ で試し聞き（選んだ音量で、設定のスピーカーから）。曲の追加もここから。
	 */
	let { disabled = false }: { disabled?: boolean } = $props();

	let tracks = $state<BgmTrack[]>([]);
	/** 試聴中の曲（null = 止まっている） */
	let previewing = $state<string | null>(null);
	let busy = $state(false);
	let audio: HTMLAudioElement | null = null;

	const cfg = $derived(settings.value);
	const selected = $derived(cfg?.bgmFile ?? null);

	async function refresh() {
		tracks = await api().bgm.list();
		// 選んでいた曲が消えていたら「なし」に戻す
		if (cfg?.bgmFile && !tracks.some((t) => t.fileName === cfg.bgmFile)) {
			await settings.save({ bgmFile: null });
		}
	}

	$effect(() => {
		void (async () => {
			if (!settings.value) await settings.load();
			await refresh();
		})();
	});

	async function choose(fileName: string | null) {
		await settings.save({ bgmFile: fileName });
	}

	async function setVolume(v: number) {
		await settings.save({ bgmVolume: v });
		if (audio) audio.volume = v;
	}

	/** その曲を試しに流す。もう一度押すと止まる。別の曲を押すと切り替わる */
	async function togglePreview(fileName: string) {
		if (previewing === fileName) return stop();
		stop();
		const el = new Audio(await api().bgm.url(fileName));
		el.loop = true;
		el.volume = cfg?.bgmVolume ?? 0.2;
		const sinkable = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
		if (sinkable.setSinkId && cfg?.speakerDeviceId) {
			await sinkable.setSinkId(cfg.speakerDeviceId).catch(() => {});
		}
		audio = el;
		try {
			await el.play();
			previewing = fileName;
		} catch (err) {
			toast.error(`再生できませんでした。${(err as Error)?.message ?? ''}`);
		}
	}

	function stop() {
		audio?.pause();
		audio = null;
		previewing = null;
	}

	async function addFiles() {
		busy = true;
		try {
			const n = await api().bgm.add();
			await refresh();
			toast.show(n > 0 ? `${n} 曲を追加しました` : '追加した曲はありません');
		} finally {
			busy = false;
		}
	}

	async function importDownloads() {
		busy = true;
		try {
			const n = await api().bgm.importDownloads();
			await refresh();
			toast.show(
				n > 0
					? `ダウンロードフォルダーから ${n} 曲を移動して取り込みました`
					: 'ダウンロードフォルダーに新しい音楽ファイルはありませんでした'
			);
		} finally {
			busy = false;
		}
	}

	onDestroy(stop);
</script>

<div class="bgm">
	<p class="muted bgm__hint">▶ で試し聞き。「使う」を押した曲を書き出しに重ねます。</p>
	{#if selected}
		<label class="bgm__field">
			<span>BGM の音量 {Math.round((cfg?.bgmVolume ?? 0.2) * 100)}%</span>
			<input
				type="range"
				min="0"
				max="1"
				step="0.02"
				value={cfg?.bgmVolume ?? 0.2}
				{disabled}
				oninput={(e) => void setVolume(Number(e.currentTarget.value))}
			/>
		</label>
		<label class="bgm__check">
			<input
				type="checkbox"
				checked={cfg?.bgmDuck ?? true}
				{disabled}
				onchange={(e) => void settings.save({ bgmDuck: e.currentTarget.checked })}
			/>
			<span>話している間は BGM を自動で下げる</span>
		</label>
		{#if cfg?.bgmDuck ?? true}
			<label class="bgm__field bgm__sub">
				<span
					>話している間の BGM の音量 {Math.round(
						(cfg?.bgmDuckLevel ?? 0.3) * 100
					)}%（元の音量に対して）</span
				>
				<input
					type="range"
					min="0"
					max="1"
					step="0.05"
					value={cfg?.bgmDuckLevel ?? 0.3}
					{disabled}
					oninput={(e) => void settings.save({ bgmDuckLevel: Number(e.currentTarget.value) })}
				/>
			</label>
		{/if}
	{/if}
	<ul class="bgm__tracks" aria-label="BGM の一覧">
		<li class="bgm__track" class:bgm__track--on={!selected}>
			<span class="bgm__play bgm__play--none" aria-hidden="true"></span>
			<span class="bgm__name">BGM なし</span>
			<button
				type="button"
				class="chip"
				class:chip--on={!selected}
				{disabled}
				onclick={() => void choose(null)}>{!selected ? '使う ✓' : '使う'}</button
			>
		</li>
		{#each tracks as t (t.fileName)}
			{@const on = selected === t.fileName}
			<li class="bgm__track" class:bgm__track--on={on}>
				<button
					type="button"
					class="bgm__play"
					class:bgm__play--on={previewing === t.fileName}
					title={previewing === t.fileName ? '止める' : '試し聞き'}
					aria-label={previewing === t.fileName ? '止める' : `${t.fileName} を試し聞き`}
					onclick={() => void togglePreview(t.fileName)}
				>
					{previewing === t.fileName ? '■' : '▶'}
				</button>
				<span class="bgm__name" title={t.fileName}>{t.fileName.replace(/\.[^.]+$/, '')}</span>
				<button
					type="button"
					class="chip"
					class:chip--on={on}
					{disabled}
					onclick={() => void choose(t.fileName)}>{on ? '使う ✓' : '使う'}</button
				>
			</li>
		{/each}
	</ul>
	<div class="bgm__actions">
		<button type="button" class="chip" onclick={addFiles} disabled={busy || disabled}
			>曲を追加</button
		>
		<button type="button" class="chip" onclick={importDownloads} disabled={busy || disabled}>
			ダウンロードフォルダーの曲を取り込む
		</button>
	</div>
	<p class="muted bgm__hint">
		YouTube オーディオライブラリの曲は YouTube
		動画で無料で使えます（曲によっては概要欄にクレジットが必要）。
	</p>
</div>

<style>
	.bgm {
		display: grid;
		gap: 10px;
		min-width: 0;
	}
	.bgm__field {
		display: grid;
		gap: 4px;
		font-size: 13px;
		font-weight: 700;
	}
	.bgm__field input[type='range'] {
		width: 100%;
		accent-color: var(--ink);
	}
	.bgm__tracks {
		min-width: 0;
		list-style: none;
		display: grid;
		gap: 4px;
		border: 2px solid var(--ink);
		border-radius: 12px;
		background: #fff;
		padding: 6px;
		margin: 0;
	}
	.bgm__track {
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 6px;
		border-radius: 10px;
		font-size: 13px;
	}
	.bgm__track--on {
		background: var(--yellow);
	}
	.bgm__track .chip {
		min-height: 28px;
		padding: 2px 10px;
		font-size: 12px;
	}
	.bgm__name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 700;
	}
	.bgm__play {
		flex: none;
		width: 30px;
		height: 30px;
		border-radius: 50%;
		border: 2px solid var(--ink);
		background: var(--cream);
		font-size: 12px;
		font-weight: 900;
		cursor: pointer;
		padding: 0;
		line-height: 1;
	}
	.bgm__play:hover {
		background: var(--paper);
	}
	.bgm__play--on {
		background: var(--ink);
		color: var(--yellow);
	}
	.bgm__play--none {
		border-color: transparent;
		background: transparent;
	}
	.bgm__sub {
		padding-left: 26px;
	}
	.bgm__check {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 13px;
		font-weight: 700;
	}
	.bgm__check input {
		width: 18px;
		height: 18px;
		accent-color: var(--ink);
	}
	.bgm__actions {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}
	.bgm__hint {
		font-size: 12px;
	}
</style>
