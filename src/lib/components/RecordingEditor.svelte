<script lang="ts">
	import { onDestroy } from 'svelte';
	import { exportsOf, type Cut, type Recording, type Transcript } from '$shared/types';
	import { exportStatus } from '$shared/publish';
	import { cueAt } from '$shared/cues';
	import { keptDuration, normalizeCuts, skipTarget } from '$shared/cuts';
	import { makeId } from '$shared/notes';
	import { api } from '$lib/api';
	import ShortcutsPanel from './ShortcutsPanel.svelte';
	import { exports } from '$lib/stores/exports.svelte';
	import { SUBTITLE_LANGS } from '$shared/subtitles';
	import { library } from '$lib/stores/library.svelte';
	import { settings } from '$lib/stores/settings.svelte';
	import { toast } from '$lib/stores/toast.svelte';
	import { ui } from '$lib/stores/ui.svelte';
	import { formatBytes, formatDateTime, formatDuration } from '$lib/utils/format';
	import BgmPicker from './BgmPicker.svelte';
	import TelopPanel from './TelopPanel.svelte';
	import Waveform from './Waveform.svelte';

	/**
	 * 収録の編集画面。
	 * - 動画を見ながら、波形としるしで頭出し
	 * - カット編集の欄は 2026-09-14 に外した（使わないため）。以前に消した範囲があれば一覧だけ出し、書き出しには効く
	 * - mp4 の書き出し: カットを外し、BGM を重ねて保存（同梱の ffmpeg）
	 */
	let { recording, onClose }: { recording: Recording; onClose: () => void } = $props();

	let url = $state<string | null>(null);
	let loadError = $state<string | null>(null);
	let player = $state<HTMLVideoElement | null>(null);
	let paused = $state(true);
	function togglePlay() {
		if (!player) return;
		if (player.paused) void player.play().catch(() => {});
		else player.pause();
	}
	let currentMs = $state(0);
	const exporting = $derived(exports.isRunning(recording.id));
	let savingWebm = $state(false);
	/** 書き出しの様子は exports ストアが持つ（編集画面を閉じても続く。閉じている間は右下の帯に出る） */
	const job = $derived(exports.jobs[recording.id] ?? null);
	const progress = $derived(
		job && (job.phase === 'preparing' || job.phase === 'encoding') ? job : null
	);
	/** テロップ（無ければ null）。TelopPanel が編集する */
	let transcript = $state<Transcript | null>(null);
	let burnTelop = $state(true);
	const currentCue = $derived(transcript ? cueAt(transcript.cues, currentMs) : null);
	const hasTelop = $derived(!!transcript && transcript.cues.length > 0);

	/** 選びかけの範囲 */
	let inMs = $state<number | null>(null);
	let outMs = $state<number | null>(null);

	const cfg = $derived(settings.value);
	const cuts = $derived(normalizeCuts(recording.cuts ?? [], recording.durationMs));
	const keptMs = $derived(keptDuration(cuts, recording.durationMs));
	const rangeReady = $derived(inMs !== null && outMs !== null && outMs - inMs >= 100);

	$effect(() => {
		const id = recording.id;
		url = null;
		loadError = null;
		inMs = null;
		outMs = null;
		transcript = null;
		void api()
			.transcripts.get(id)
			.then((t) => (transcript = t))
			.catch(() => {});
		api()
			.recordings.fileUrl(id)
			.then((u) => {
				if (!u) loadError = '収録ファイルが見つかりません。';
				else url = u;
			})
			.catch((err: Error) => (loadError = err.message));
	});

	$effect(() => {
		if (!settings.value) void settings.load();
	});

	// Chrome の webm は長さ情報を持たないことがあるので、一度末尾へ飛ばして確定させる
	function fixDuration() {
		const a = player;
		if (!a || Number.isFinite(a.duration)) return;
		const onTime = () => {
			a.removeEventListener('timeupdate', onTime);
			a.currentTime = 0;
		};
		a.addEventListener('timeupdate', onTime);
		a.currentTime = 1e101;
	}

	/** 飛ばし再生のシークが終わるまで true（古い timeupdate で二重に飛ばないように） */
	let skipping = false;

	function onTimeUpdate() {
		if (!player || skipping) return;
		const ms = player.currentTime * 1000;
		// 消した範囲に入ったら、その終わりへ飛ぶ（書き出し後と同じ流れで見られる）
		const jump = skipTarget(cuts, ms, recording.durationMs);
		if (jump !== null && !player.paused) {
			skipping = true;
			player.currentTime = jump / 1000;
			currentMs = jump;
			return;
		}
		currentMs = ms;
	}
	function onSeeked() {
		skipping = false;
	}

	/** 頭出しだけ。再生は始めない（再生中ならそのまま続く） */
	function seek(ms: number) {
		if (!player) return;
		const clamped = Math.max(0, Math.min(recording.durationMs, ms));
		player.currentTime = clamped / 1000;
		currentMs = clamped;
	}

	/** しるしなどから: 頭出しして再生する */
	function seekAndPlay(ms: number) {
		seek(ms);
		void player?.play().catch(() => {});
	}

	const FRAME_MS = 1000 / 30;
	/** 1 コマ（1/30 秒）ずつ動かす。再生中なら止める */
	function step(frames: number) {
		if (!player) return;
		player.pause();
		seek(Math.round(player.currentTime * 1000 + frames * FRAME_MS));
	}

	function onRange(a: number | null, b: number | null) {
		player?.pause();
		inMs = a;
		outMs = b;
	}

	// ---- カット ----
	/** いまの再生位置（timeupdate を待たず、プレイヤーから直接読む） */
	function nowMs(): number {
		const ms = player ? player.currentTime * 1000 : currentMs;
		currentMs = ms;
		return Math.round(ms);
	}
	function setIn() {
		inMs = nowMs();
		if (outMs !== null && outMs <= inMs) outMs = null;
	}
	function setOut() {
		outMs = nowMs();
		if (inMs !== null && inMs >= outMs) inMs = null;
	}
	function clearRange() {
		inMs = null;
		outMs = null;
	}
	async function applyCut() {
		if (!rangeReady || inMs === null || outMs === null) return;
		const [a, b] = [inMs, outMs];
		const next: Cut[] = [...(recording.cuts ?? []), { id: makeId(), startMs: a, endMs: b }];
		await saveCuts(next);
		clearRange();
		seek(a);
		toast.show(`${formatTime(a)}〜${formatTime(b)} を消しました`);
	}
	async function restoreCut(id: string) {
		await saveCuts((recording.cuts ?? []).filter((c) => c.id !== id));
	}
	async function saveCuts(next: Cut[]) {
		try {
			await library.updateRecording(recording.id, {
				cuts: normalizeCuts(next, recording.durationMs)
			});
		} catch (err) {
			toast.error(`保存できませんでした。${(err as Error).message}`);
		}
	}

	// ---- 書き出し ----
	/** 履歴の日時は短く（9/15 15:55） */
	const shortDate = (ms: number) => {
		const d = new Date(ms);
		const pad = (n: number) => String(n).padStart(2, '0');
		return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
	};
	/** 書き出し履歴から 1 本消す（ファイルと記録） */
	async function removeExport(exportId: string) {
		if (!confirm('この書き出しを消しますか？（投稿済みの動画は SNS 側に残ります）')) return;
		try {
			await api().recordings.removeExport(recording.id, exportId);
			const rest = exportsOf(recording).filter((e) => e.id !== exportId);
			await library.updateRecording(recording.id, { exports: rest, export: undefined });
		} catch (err) {
			toast.error((err as Error).message);
		}
	}
	/** limitMs を渡すと、最初のその長さだけ書き出す（BGM などの試し用） */
	async function exportMp4(limitMs?: number) {
		if (exporting) return;
		// 直したテロップがまだ書き込まれていない（入力直後）ことがあるので、書き出しの前に必ず保存する
		if (transcript) {
			await api().transcripts.save(JSON.parse(JSON.stringify(transcript)) as Transcript);
		}
		const saved = await exports.start(recording.id, recording.title || '収録', {
			bgmFile: cfg?.bgmFile ?? null,
			bgmVolume: cfg?.bgmVolume ?? 0.2,
			duck: cfg?.bgmDuck ?? true,
			duckLevel: cfg?.bgmDuckLevel ?? 0.3,
			burnTelop: hasTelop && burnTelop,
			writeSrt: false,
			noiseReduction: cfg?.noiseReduction ?? 'off',
			...(limitMs ? { limitMs } : {})
		});
		void saved;
	}
	function cancelExport() {
		exports.cancel(recording.id);
	}

	async function saveWebm() {
		savingWebm = true;
		try {
			const saved = await api().recordings.exportFile(recording.id);
			if (saved) toast.show(`保存しました: ${saved}`);
		} catch (err) {
			toast.error(`保存に失敗しました。${(err as Error)?.message ?? ''}`);
		} finally {
			savingWebm = false;
		}
	}

	async function remove() {
		if (!window.confirm('この収録を削除します。ファイルも消えます。よろしいですか？')) return;
		try {
			await library.deleteRecording(recording.id);
			toast.show('収録を削除しました');
			onClose();
		} catch (err) {
			toast.error((err as Error).message);
		}
	}

	let showKeys = $state(false);
	function onWindowKeydown(e: KeyboardEvent) {
		if (e.isComposing || showKeys) return;
		const tag = (e.target as HTMLElement | null)?.tagName ?? '';
		if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
		if (e.key === 'Escape') return onClose();
		if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
			e.preventDefault();
			const dir = e.key === 'ArrowLeft' ? -1 : 1;
			return step(dir * (e.shiftKey ? 30 : 1));
		}
		if (e.key === ' ' && player) {
			// スペース = 再生 / 一時停止。ボタンにフォーカスが残っていると、そのボタンが押されてしまうので外す
			e.preventDefault();
			if (tag === 'BUTTON' || tag === 'VIDEO') (e.target as HTMLElement).blur();
			togglePlay();
		}
	}

	/** 編集用の時刻。0:05.4 のように 1/10 秒まで */
	function formatTime(ms: number): string {
		const tenth = Math.floor((Math.max(0, ms) % 1000) / 100);
		return `${formatDuration(ms)}.${tenth}`;
	}

	const bgmName = $derived(cfg?.bgmFile ? cfg.bgmFile.replace(/\.[^.]+$/, '') : 'なし');
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div class="ed">
	<div class="ed__top">
		<div class="ed__title">
			<h1>{recording.title || '収録'}</h1>
			<span class="muted">
				{formatDateTime(recording.createdAt)}・{formatDuration(recording.durationMs)}・{formatBytes(
					recording.size
				)}
				{#if recording.width && recording.height}
					・{recording.width}×{recording.height}
				{/if}
				{#if recording.status === 'recovered'}
					・<span class="ed__warn">途中で終了した分</span>
				{/if}
			</span>
		</div>
		<div class="ed__actions">
			<button
				type="button"
				class="btn btn--sm"
				onclick={() => api().recordings.revealInFinder(recording.id)}>Finder で表示</button
			>
			<button type="button" class="btn btn--sm" onclick={() => (showKeys = true)}>キー操作</button>
			<button type="button" class="btn btn--sm" onclick={onClose}>閉じる（Esc）</button>
		</div>
	</div>

	<div class="ed__body">
		<div class="ed__player">
			{#if loadError}
				<p class="alert">{loadError}</p>
			{:else if !url}
				<p class="muted">読み込んでいます…</p>
			{:else if recording.hasVideo}
				<!-- svelte-ignore a11y_media_has_caption -->
				<div class="ed__stage">
					<video
						class="ed__video"
						bind:this={player}
						src={url}
						controls
						preload="metadata"
						onloadedmetadata={fixDuration}
						ontimeupdate={onTimeUpdate}
						onseeked={onSeeked}
						onplay={() => (paused = false)}
						onpause={() => (paused = true)}
					></video>
					{#if currentCue}
						<!-- 書き出しと同じ位置に、テロップの見え方を重ねる（実際の焼き込みは ffmpeg） -->
						<div class="ed__telop" aria-hidden="true">{currentCue.text}</div>
					{/if}
				</div>
			{:else}
				<audio
					class="ed__audio"
					src={url}
					controls
					preload="metadata"
					ontimeupdate={(e) => (currentMs = e.currentTarget.currentTime * 1000)}
				></audio>
			{/if}

			{#if recording.peaks && recording.peaks.length > 0 && recording.peaksPerSecond}
				<Waveform
					peaks={recording.peaks}
					peaksPerSecond={recording.peaksPerSecond}
					durationMs={recording.durationMs}
					{currentMs}
					markers={recording.markers}
					{cuts}
					{inMs}
					{outMs}
					onSeek={seek}
					{onRange}
				/>
			{/if}

			{#if cuts.length > 0}
				<!-- 以前に消した範囲があるときだけ（カット編集の欄は外した。書き出しには引き続き効く） -->
				<section class="card ed__cut">
					<h2 class="card__title">消してある範囲 <span class="muted">{cuts.length} 件</span></h2>
					<ul class="ed__cuts" aria-label="消した範囲">
						{#each cuts as c (c.id)}
							<li>
								<button type="button" class="chip" onclick={() => seek(c.startMs)}
									>{formatTime(c.startMs)}〜{formatTime(c.endMs)}</button
								>
								<span class="muted">{formatTime(c.endMs - c.startMs)} 消す</span>
								<button type="button" class="chip" onclick={() => void restoreCut(c.id)}
									>戻す</button
								>
							</li>
						{/each}
					</ul>
				</section>
			{/if}

			<TelopPanel
				{recording}
				bind:transcript
				{currentMs}
				{paused}
				onSeek={seek}
				onTogglePlay={togglePlay}
				onPause={() => player?.pause()}
				onStep={step}
			/>
		</div>

		<aside class="ed__side">
			{#if exportsOf(recording).length > 0}
				{@const latest = exportsOf(recording).at(-1)!}
				<section class="card ed__publish">
					<button
						type="button"
						class="btn btn--lg btn--green ed__publish-btn"
						onclick={() => (ui.publishing = { recordingId: recording.id, exportId: latest.id })}
						>SNS投稿</button
					>
					<h2 class="card__title">
						書き出し履歴 <span class="muted">{exportsOf(recording).length} 本</span>
					</h2>
					<ul class="ed__exports">
						{#each [...exportsOf(recording)].reverse() as ex (ex.id)}
							{@const st = exportStatus(recording, ex)}
							<li>
								<span
									class="ed__export-dot"
									class:ed__export-dot--latest={ex.id === latest.id}
									title={ex.id === latest.id ? '最新（上の SNS投稿 が開くもの）' : '古い書き出し'}
								></span>
								<div
									class="ed__export-info"
									title="{shortDate(ex.createdAt)} 書き出し・{formatBytes(ex.size)}{ex.durationMs
										? `・${formatDuration(ex.durationMs)}`
										: ''}{st === 'scheduled' ? '・予約投稿済み' : ''}"
								>
									<span class="ed__export-when">{shortDate(ex.createdAt)}</span>
									{#if st === 'scheduled'}
										<!-- 予約してあれば、長さ・大きさの代わりに札を出す（1 行に収めるため。全文はホバーで） -->
										<span class="ed__stamp">予約済み</span>
									{:else}
										<span class="muted ed__export-size"
											>{ex.durationMs ? `${formatDuration(ex.durationMs)}・` : ''}{formatBytes(
												ex.size
											)}</span
										>
									{/if}
								</div>
								<div class="ed__export-btns">
									<button
										type="button"
										class="chip chip--sm"
										onclick={() => (ui.publishing = { recordingId: recording.id, exportId: ex.id })}
										>SNS投稿</button
									>
									<button
										type="button"
										class="chip chip--sm"
										onclick={() => void removeExport(ex.id)}>削除</button
									>
								</div>
							</li>
						{/each}
					</ul>
				</section>
			{/if}
			<section class="card ed__export">
				<h2 class="card__title">書き出し（mp4）</h2>
				<p class="muted ed__hint">
					カットを外し、BGM「{bgmName}」{cfg?.bgmFile
						? `（音量 ${Math.round((cfg?.bgmVolume ?? 0.2) * 100)}%${(cfg?.bgmDuck ?? true) ? `・話す間は ${Math.round((cfg?.bgmDuckLevel ?? 0.3) * 100)}% に` : ''}）`
						: ''}を重ねて、YouTube にそのまま上げられる mp4（H.264 / AAC、1920×1080）にします。
				</p>
				<div class="ed__noise" role="group" aria-label="ノイズを抑える">
					<span class="ed__noise-label">ノイズを抑える</span>
					{#each [['off', 'しない'], ['light', '弱'], ['strong', '強']] as [v, label] (v)}
						<label class="chip ed__noise-opt" class:chip--on={(cfg?.noiseReduction ?? 'off') === v}>
							<input
								type="radio"
								name="noise"
								value={v}
								checked={(cfg?.noiseReduction ?? 'off') === v}
								disabled={exporting}
								onchange={() =>
									void settings.save({ noiseReduction: v as 'off' | 'light' | 'strong' })}
							/>
							{label}
						</label>
					{/each}
					<span class="muted ed__noise-hint">
						低い唸りと一定のノイズを声から引きます。「30
						秒だけ試す」で聞き比べてから選ぶのがおすすめ
					</span>
				</div>
				{#if hasTelop}
					<label class="ed__check">
						<input type="checkbox" bind:checked={burnTelop} disabled={exporting} />
						<span>テロップを動画に焼き込む</span>
					</label>
					<span class="muted"
						>字幕は YouTube に上げるときに自動で付きます（日本語と、設定で選んだ外国語）</span
					>
				{/if}
				{#if exporting}
					<div
						class="ed__progress"
						role="progressbar"
						aria-valuemin="0"
						aria-valuemax="100"
						aria-valuenow={Math.round((progress?.ratio ?? 0) * 100)}
					>
						<div class="ed__progress-bar" style="transform: scaleX({progress?.ratio ?? 0})"></div>
					</div>
					<div class="ed__cut-row">
						<span class="muted">
							{progress?.phase === 'preparing'
								? '準備しています…'
								: `書き出しています… ${Math.round((progress?.ratio ?? 0) * 100)}%`}
						</span>
						<button type="button" class="chip" onclick={cancelExport}>中止</button>
					</div>
				{:else}
					<button
						type="button"
						class="btn btn--yellow"
						onclick={() => void exportMp4()}
						disabled={keptMs <= 0}
					>
						mp4 に書き出す
					</button>
					<button
						type="button"
						class="btn btn--sm"
						title="最初の 30 秒だけ書き出す（BGM やテロップの見え方を短い動画で確かめる用）"
						onclick={() => void exportMp4(30_000)}
						disabled={keptMs <= 0}
					>
						30 秒だけ試す
					</button>
				{/if}
				<button type="button" class="chip" onclick={saveWebm} disabled={savingWebm}>
					{savingWebm ? '保存しています…' : '元の webm をそのまま保存'}
				</button>
			</section>

			<section class="card ed__export">
				<h2 class="card__title">BGM を選ぶ</h2>
				<BgmPicker disabled={exporting} />
			</section>

			<section class="card">
				<h2 class="card__title">しるし <span class="muted">{recording.markers.length} 件</span></h2>
				{#if recording.markers.length === 0}
					<p class="muted">収録中にノードを選ぶと、その時刻がここに並びます。</p>
				{:else}
					<ul class="ed__markers">
						{#each recording.markers as m (m.id)}
							<li>
								<button type="button" class="chip" onclick={() => seekAndPlay(m.atMs)}
									>▶ {formatDuration(m.atMs)}</button
								>
								<span>{m.text}</span>
							</li>
						{/each}
					</ul>
				{/if}
				<div class="ed__danger">
					<button type="button" class="btn btn--sm btn--danger" onclick={remove}
						>この収録を削除</button
					>
				</div>
			</section>
		</aside>
	</div>
</div>

{#if showKeys}
	<ShortcutsPanel kind="editor" onClose={() => (showKeys = false)} />
{/if}

<style>
	.ed {
		height: 100vh;
		display: grid;
		grid-template-rows: auto minmax(0, 1fr);
		background: var(--yellow);
		padding: 0 24px 20px;
		gap: 14px;
	}
	.ed__top {
		min-height: var(--titlebar);
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		padding: 8px 0 0 60px; /* 信号機ボタンの分 */
		-webkit-app-region: drag;
		flex-wrap: wrap;
	}
	.ed__title {
		display: grid;
		gap: 2px;
		min-width: 0;
	}
	.ed__title h1 {
		font-size: 20px;
		font-weight: 900;
		letter-spacing: 0.02em;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.ed__warn {
		color: var(--alert);
		font-weight: 900;
	}
	.ed__actions {
		display: flex;
		gap: 10px;
		flex-wrap: wrap;
		-webkit-app-region: no-drag;
	}
	.ed__body {
		min-height: 0;
		display: grid;
		grid-template-columns: minmax(0, 1fr) 380px;
		gap: 16px;
	}
	.ed__player {
		min-height: 0;
		display: grid;
		grid-template-rows: auto auto auto auto;
		gap: 12px;
		align-content: start;
		overflow-y: auto;
		padding: 2px 8px 10px 2px; /* 影が切れないように */
	}
	/* 動画は画面の高さの半分ほどを確保する（下のカードが増えても小さくならないように） */
	.ed__stage {
		position: relative;
		height: clamp(260px, 52vh, 640px);
		display: grid;
		justify-items: center;
	}
	.ed__telop {
		position: absolute;
		left: 50%;
		bottom: 9%;
		transform: translateX(-50%);
		max-width: 88%;
		padding: 0.15em 0.45em;
		font-size: clamp(14px, 2.6vw, 30px);
		font-weight: 900;
		line-height: 1.35;
		text-align: center;
		color: var(--ink);
		/* 焼き込みと同じ見た目: 白い帯の上に墨色の文字 */
		background: rgba(255, 255, 255, 0.92);
		border-radius: 4px;
		pointer-events: none;
	}
	.ed__check {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 13px;
		font-weight: 700;
	}
	.ed__check input {
		width: 18px;
		height: 18px;
		accent-color: var(--ink);
	}
	.ed__video {
		/* 動画そのものの比率（16:9）を保ったまま、幅と高さの両方に収める。余白の黒帯を出さない */
		width: auto;
		height: auto;
		max-width: 100%;
		max-height: 100%;
		min-height: 0;
		justify-self: center;
		border: var(--border);
		border-radius: 14px;
		background: var(--yellow);
		object-fit: contain;
	}
	.ed__audio {
		width: 100%;
		border: var(--border);
		border-radius: 999px;
		background: var(--cream);
		min-height: 46px;
	}
	.ed__cut {
		display: grid;
		gap: 10px;
	}
	.ed__cut-row {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}
	.ed__hint {
		font-size: 12.5px;
	}
	.ed__cuts {
		list-style: none;
		padding: 0;
		display: grid;
		gap: 6px;
		font-size: 13px;
	}
	.ed__cuts li {
		display: flex;
		gap: 10px;
		align-items: center;
	}
	.ed__side {
		display: grid;
		gap: 14px;
		align-content: start;
		overflow-y: auto;
		min-height: 0;
		padding: 2px 8px 10px 2px; /* 影が切れないように */
	}
	.ed__publish {
		display: grid;
		gap: 8px;
		justify-items: stretch;
	}
	.ed__publish-btn {
		width: 100%;
		font-size: 17px;
	}
	.ed__exports {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 8px;
		container-type: inline-size;
	}
	/*
	 * 1 本は必ず 1 行: 丸・日付・（長さと大きさ、または「予約済み」の札）・SNS投稿・削除。
	 * 右の列は狭い（300px ほど）ので、ボタンは小さめ、予約してあれば長さ・大きさの代わりに札を出す。
	 * 長さ・大きさの文字は入りきらなければ省略（全文はホバーで）
	 */
	.ed__exports li {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: center;
		column-gap: 6px;
		font-size: 12.5px;
	}
	.ed__export-btns {
		display: flex;
		gap: 5px;
	}
	.ed__export-btns .chip--sm {
		padding: 3px 9px;
		font-size: 12px;
		letter-spacing: 0.02em;
	}
	.ed__export-info {
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 6px;
		white-space: nowrap;
		overflow: hidden;
	}
	.ed__export-size {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.ed__export-btns .chip {
		white-space: nowrap;
	}
	/* 左の丸: 最新（上の大きな「SNS投稿」が開くもの）は緑、古いものはグレー。消せば次に新しいものが最新になる */
	.ed__export-dot {
		flex: none;
		width: 12px;
		height: 12px;
		border-radius: 50%;
		background: #c9c2ad;
	}
	.ed__export-dot--latest {
		background: var(--green);
	}

	.ed__export-when {
		font-weight: 900;
	}
	/* 「予約済み」の札: 横の小さいボタンと同じ形で、赤い縁と赤い字。斜めにしない */
	.ed__stamp {
		flex: none;
		display: inline-flex;
		align-items: center;
		border: 2px solid #c4302b;
		color: #c4302b;
		background: #fff;
		border-radius: 999px;
		padding: 3px 9px;
		font-weight: 900;
		font-size: 12px;
		letter-spacing: 0.02em;
		line-height: normal;
	}
	.ed__export {
		display: grid;
		gap: 10px;
		min-width: 0;
	}
	.ed__export > :global(*) {
		min-width: 0;
	}
	.ed__progress {
		height: 14px;
		border: 2px solid var(--ink);
		border-radius: 999px;
		background: #fff;
		overflow: hidden;
	}
	.ed__progress-bar {
		height: 100%;
		width: 100%;
		background: var(--ink);
		transform-origin: left center;
		transition: transform 0.2s linear;
	}
	.ed__markers {
		list-style: none;
		padding: 0;
		display: grid;
		gap: 6px;
		font-size: 14px;
	}
	.ed__markers li {
		display: flex;
		gap: 10px;
		align-items: center;
	}
	.ed__danger {
		margin-top: 12px;
		padding-top: 12px;
		border-top: 2px solid var(--rule);
	}
	@media (max-width: 1000px) {
		.ed__body {
			grid-template-columns: 1fr;
		}
	}
	.ed__noise {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}
	.ed__noise-label {
		font-weight: 900;
		font-size: 13px;
	}
	.ed__noise-opt {
		cursor: pointer;
	}
	.ed__noise-opt input {
		position: absolute;
		opacity: 0;
		width: 1px;
		height: 1px;
	}
	.ed__noise-hint {
		flex-basis: 100%;
		font-size: 12px;
	}
</style>
