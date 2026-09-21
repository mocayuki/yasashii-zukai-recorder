<script lang="ts">
	import { onDestroy } from 'svelte';
	import { api } from '$lib/api';
	import { settings } from '$lib/stores/settings.svelte';
	import { toast } from '$lib/stores/toast.svelte';
	import { recorder } from '$lib/recording/recorder.svelte';
	import { buildVoiceChain, type VoiceChain } from '$lib/recording/voice-chain';

	/**
	 * 音の設定。マイクとスピーカーの選択、マイクの音量（倍率）とメーター（収録前の確認）。BGM は編集画面で選ぶ。
	 * 開いている間だけマイクを試しに開き、閉じると止める。
	 */
	let { disabled = false }: { disabled?: boolean } = $props();

	let mics = $state<MediaDeviceInfo[]>([]);
	let speakers = $state<MediaDeviceInfo[]>([]);
	let level = $state(0);
	/** 2 秒以上バーが動いていないとき true（案内文がチカチカしないよう、ゆっくり切り替える） */
	let quiet = $state(true);
	let quietSince = 0;
	let micError = $state<string | null>(null);

	let testStream: MediaStream | null = null;
	let testCtx: AudioContext | null = null;
	let testChain: VoiceChain | null = null;
	let testTimer: number | null = null;

	const cfg = $derived(settings.value);

	function micGainLabel(g: number): string {
		if (g === 1) return '×1（そのまま）';
		return `×${g.toFixed(1)}`;
	}

	async function refreshDevices() {
		try {
			const all = await navigator.mediaDevices.enumerateDevices();
			mics = all.filter((d) => d.kind === 'audioinput');
			speakers = all.filter((d) => d.kind === 'audiooutput');
		} catch {
			/* 取れなくても既定の装置で動く */
		}
	}

	/** 選んだマイクを試しに開いて、音量を出す */
	async function startMicTest() {
		stopMicTest();
		micError = null;
		try {
			const id = cfg?.micDeviceId ?? null;
			testStream = await navigator.mediaDevices.getUserMedia({
				audio: id ? { deviceId: { exact: id } } : true
			});
			// 装置の名前は許可の後に取れるようになる
			await refreshDevices();
			testCtx = new AudioContext();
			// ボタン操作を経ずに作った AudioContext は止まったままのことがあるので、必ず動かす
			if (testCtx.state === 'suspended') await testCtx.resume().catch(() => {});
			const src = testCtx.createMediaStreamSource(testStream);
			// 収録と同じ道（倍率 → 声を整える）を通してからメーターに出す（録れる音の大きさがそのまま見える）
			testChain = buildVoiceChain(testCtx, src, {
				gain: cfg?.micGain ?? 1,
				compressor: cfg?.micCompressor !== false
			});
			const analyser = testCtx.createAnalyser();
			analyser.fftSize = 1024;
			testChain.output.connect(analyser);
			const buf = new Uint8Array(analyser.fftSize);
			testTimer = window.setInterval(() => {
				analyser.getByteTimeDomainData(buf);
				let peak = 0;
				for (let i = 0; i < buf.length; i++) {
					const v = Math.abs((buf[i] - 128) / 128);
					if (v > peak) peak = v;
				}
				level = Math.min(1, peak * 1.6);
				const now = performance.now();
				if (peak >= 0.02) {
					quietSince = now;
					quiet = false;
				} else if (now - quietSince > 2000) {
					quiet = true;
				}
			}, 50);
		} catch (err) {
			micError = `マイクを開けませんでした。${(err as Error)?.message ?? ''}`;
		}
	}

	function stopMicTest() {
		if (testTimer !== null) window.clearInterval(testTimer);
		testTimer = null;
		testStream?.getTracks().forEach((t) => t.stop());
		testStream = null;
		if (testCtx) void testCtx.close().catch(() => {});
		testCtx = null;
		testChain = null;
		level = 0;
	}

	async function chooseMic(id: string) {
		await settings.save({ micDeviceId: id || null });
		await startMicTest();
	}

	/** マイクの音量の倍率。メーターにも、収録中ならその収録にもすぐ反映する */
	async function setMicGain(v: number) {
		testChain?.setGain(v);
		recorder.setGain(v);
		await settings.save({ micGain: v });
	}

	/** 声を整える（コンプレッサー）。メーターにも、収録中ならその収録にもすぐ反映する */
	async function setCompressor(on: boolean) {
		testChain?.setCompressor(on);
		recorder.setCompressor(on);
		await settings.save({ micCompressor: on });
	}

	async function chooseSpeaker(id: string) {
		await settings.save({ speakerDeviceId: id || null });
	}

	$effect(() => {
		void (async () => {
			if (!settings.value) await settings.load();
			await refreshDevices();
			if (!disabled) await startMicTest();
		})();
		navigator.mediaDevices.addEventListener('devicechange', refreshDevices);
		return () => navigator.mediaDevices.removeEventListener('devicechange', refreshDevices);
	});

	onDestroy(stopMicTest);
</script>

<div class="audio">
	<h2 class="card__title">音の設定</h2>

	<section class="audio__section">
		<label class="audio__label" for="mic-select">マイク</label>
		<select
			id="mic-select"
			class="input"
			value={cfg?.micDeviceId ?? ''}
			{disabled}
			onchange={(e) => void chooseMic(e.currentTarget.value)}
		>
			<option value="">OS の既定のマイク</option>
			{#each mics as d (d.deviceId)}
				{#if d.deviceId !== 'default'}
					<option value={d.deviceId}>{d.label || 'マイク'}</option>
				{/if}
			{/each}
		</select>
		<div class="audio__meter-row">
			<div class="audio__meter" aria-label="マイクの音量">
				<div class="audio__meter-bar" style="transform: scaleX({Math.max(0.02, level)})"></div>
			</div>
			<span class="muted">話してみて、バーが動けば声が入っています</span>
		</div>
		<label class="audio__vol">
			<span class="audio__vol-name">マイクの音量 {micGainLabel(cfg?.micGain ?? 1)}</span>
			<input
				type="range"
				min="0.5"
				max="6"
				step="0.1"
				value={cfg?.micGain ?? 1}
				aria-label="マイクの音量の倍率"
				oninput={(e) => void setMicGain(Number(e.currentTarget.value))}
			/>
			<button
				type="button"
				class="chip"
				disabled={(cfg?.micGain ?? 1) === 1}
				onclick={() => void setMicGain(1)}>そのまま</button
			>
		</label>
		<label class="audio__check">
			<input
				type="checkbox"
				checked={cfg?.micCompressor !== false}
				onchange={(e) => void setCompressor(e.currentTarget.checked)}
			/>
			<span>声を整える（小さい声を持ち上げ、大きい声は抑える）</span>
		</label>
		<p class="muted audio__hint">
			声が小さいときは上げます。話してバーが右端まで振り切れない程度が目安です。書き出しのときは、さらに声の大きさを
			YouTube 向けの標準にそろえます。
		</p>
		{#if micError}
			<p class="alert">{micError}</p>
		{:else if !disabled && quiet}
			<p class="muted audio__hint">
				バーが動かないときは、マイクのミュート（HyperX
				は上面をタッチ）や、選んでいる装置を確かめてください。
			</p>
		{/if}
	</section>

	<section class="audio__section">
		<label class="audio__label" for="spk-select">スピーカー（試し聞きの出力先）</label>
		<select
			id="spk-select"
			class="input"
			value={cfg?.speakerDeviceId ?? ''}
			onchange={(e) => void chooseSpeaker(e.currentTarget.value)}
		>
			<option value="">OS の既定のスピーカー</option>
			{#each speakers as d (d.deviceId)}
				{#if d.deviceId !== 'default'}
					<option value={d.deviceId}>{d.label || 'スピーカー'}</option>
				{/if}
			{/each}
		</select>
		<p class="muted audio__hint">
			編集画面での BGM の試し聞きをここから流します。BGM の選択は書き出しのときに行います。
		</p>
	</section>
</div>

<style>
	.audio {
		display: grid;
		gap: 16px;
		align-content: start;
		background: var(--cream);
		border: var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow-lg);
		padding: 18px 20px;
		overflow-y: auto;
		min-height: 0;
		user-select: text;
	}
	.audio__section {
		display: grid;
		gap: 8px;
		padding-top: 12px;
		border-top: 2px solid var(--rule);
	}
	.audio__label {
		font-size: 13px;
		font-weight: 900;
		letter-spacing: 0.06em;
	}
	.audio__meter-row {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.audio__meter {
		flex: 0 0 140px;
		height: 14px;
		border: 2px solid var(--ink);
		border-radius: 999px;
		background: #fff;
		overflow: hidden;
	}
	.audio__meter-bar {
		height: 100%;
		width: 100%;
		background: var(--ink);
		transform-origin: left center;
		transition: transform 0.06s linear;
	}
	.audio__hint {
		font-size: 12.5px;
	}
	.audio__check {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 13px;
		font-weight: 700;
	}
	.audio__check input {
		width: 18px;
		height: 18px;
		accent-color: var(--ink);
	}
	.audio__vol {
		display: flex;
		align-items: center;
		gap: 10px;
		font-size: 13px;
		font-weight: 700;
		flex: 1;
	}
	.audio__vol input {
		flex: 1;
		accent-color: var(--ink);
	}
	.audio__vol-name {
		flex: none;
		min-width: 150px;
	}
	.audio__vol .chip {
		min-height: 28px;
		padding: 2px 10px;
		font-size: 12px;
	}
	select.input {
		font-size: 14px;
		min-height: 40px;
		padding: 6px 12px;
	}
</style>
