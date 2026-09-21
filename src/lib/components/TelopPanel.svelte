<script lang="ts">
	import { onDestroy } from 'svelte';
	import type { Cue, Recording, TranscribeProgress, Transcript } from '$shared/types';
	import { normalizeCues, splitLongCue, TELOP_MAX_CHARS } from '$shared/cues';
	import { applySuggestions, type ProofSuggestion } from '$shared/proofread';
	import { makeId } from '$shared/notes';
	import { api } from '$lib/api';
	import { settings } from '$lib/stores/settings.svelte';
	import { toast } from '$lib/stores/toast.svelte';
	import { formatDuration } from '$lib/utils/format';

	/**
	 * テロップ（字幕）の一覧と編集。
	 * 「テロップを作る」で文字起こし（OpenAI）→ 文ごとのテロップ。文字と始まり・終わりを直せる。
	 * 時刻は元の収録の時刻で持ち、書き出しのときにカット分を詰める。
	 */
	let {
		recording,
		transcript = $bindable(null),
		currentMs,
		paused = true,
		onSeek,
		onTogglePlay,
		onPause,
		onStep
	}: {
		recording: Recording;
		transcript: Transcript | null;
		currentMs: number;
		/** 動画が止まっているか */
		paused?: boolean;
		onSeek: (ms: number) => void;
		onTogglePlay?: () => void;
		onPause?: () => void;
		/** コマ送り（負で戻す。30 = 1 秒） */
		onStep?: (frames: number) => void;
	} = $props();
	/** いま読み上げているテロップ（無ければ直前のもの） */
	const nowCue = $derived.by(() => {
		const cues = transcript?.cues ?? [];
		return (
			cues.find((c) => currentMs >= c.startMs && currentMs < c.endMs) ??
			[...cues].reverse().find((c) => c.startMs <= currentMs) ??
			null
		);
	});
	const nowIndex = $derived(
		nowCue ? (transcript?.cues.findIndex((c) => c.id === nowCue.id) ?? -1) : -1
	);
	function goNeighbor(dir: -1 | 1) {
		const cues = transcript?.cues ?? [];
		const target = cues[nowIndex + dir];
		if (target) onSeek(target.startMs);
	}

	let generating = $state(false);
	let phase = $state<TranscribeProgress['phase'] | null>(null);
	let saveTimer: number | null = null;

	const hasKey = $derived(!!settings.value?.openaiApiKey);
	const activeId = $derived(
		transcript?.cues.find((c) => currentMs >= c.startMs && currentMs < c.endMs)?.id ?? null
	);

	const off = api().transcripts.onProgress((p) => {
		if (p.recordingId === recording.id) phase = p.phase;
	});
	onDestroy(() => {
		off();
		if (saveTimer !== null) window.clearTimeout(saveTimer);
	});

	async function generate() {
		if (generating) return;
		if (transcript && transcript.cues.length > 0) {
			if (!window.confirm('いまのテロップを捨てて、作り直します。よろしいですか？')) return;
		}
		generating = true;
		phase = 'extracting';
		try {
			transcript = await api().transcripts.generate(recording.id);
			toast.show(`テロップを ${transcript.cues.length} 件作りました`);
		} catch (err) {
			toast.error((err as Error).message);
		} finally {
			generating = false;
			phase = null;
		}
	}

	/** 変更をまとめて保存する（入力のたびに書かない） */
	function scheduleSave() {
		if (!transcript) return;
		if (saveTimer !== null) window.clearTimeout(saveTimer);
		const t = transcript;
		saveTimer = window.setTimeout(() => {
			void api()
				.transcripts.save(JSON.parse(JSON.stringify(t)) as Transcript)
				.catch((err: Error) => toast.error(`テロップを保存できませんでした。${err.message}`));
		}, 500);
	}

	/** 待たずにいま保存する（入力欄を離れたとき、書き出しの前） */
	function flush() {
		if (saveTimer !== null) window.clearTimeout(saveTimer);
		saveTimer = null;
		if (!transcript) return;
		void api()
			.transcripts.save(JSON.parse(JSON.stringify(transcript)) as Transcript)
			.catch((err: Error) => toast.error(`テロップを保存できませんでした。${err.message}`));
	}

	function ensureTranscript(): Transcript {
		if (!transcript) {
			transcript = {
				recordingId: recording.id,
				cues: [],
				source: 'manual',
				language: 'ja',
				createdAt: Date.now(),
				updatedAt: Date.now()
			};
		}
		return transcript;
	}

	// ---- 戻す／やり直す（⌘Z / ⌘⇧Z）----
	// 消す・足す・分ける・文字を書き直す前に、テロップ全体の写しを取っておく。文字は入力欄に入ったときに 1 回だけ
	let history = $state<Cue[][]>([]);
	let future = $state<Cue[][]>([]);
	const copyCues = (cues: Cue[]) => JSON.parse(JSON.stringify(cues)) as Cue[];
	function remember() {
		const t = ensureTranscript();
		history = [...history.slice(-49), copyCues(t.cues)];
		future = [];
	}
	function undo() {
		const t = ensureTranscript();
		const prev = history[history.length - 1];
		if (!prev) return toast.show('戻す変更はありません');
		history = history.slice(0, -1);
		future = [...future, copyCues(t.cues)];
		t.cues = prev;
		flush();
	}
	function redo() {
		const t = ensureTranscript();
		const next = future[future.length - 1];
		if (!next) return toast.show('やり直す変更はありません');
		future = future.slice(0, -1);
		history = [...history, copyCues(t.cues)];
		t.cues = next;
		flush();
	}
	function onWindowKeydown(e: KeyboardEvent) {
		if (!(e.metaKey || e.ctrlKey) || (e.key !== 'z' && e.key !== 'Z')) return;
		// 文字を書いている最中は、その入力欄の取り消し（ブラウザーのもの）に任せる
		const tag = (e.target as HTMLElement | null)?.tagName ?? '';
		if (tag === 'INPUT' || tag === 'TEXTAREA') return;
		e.preventDefault();
		if (e.shiftKey) redo();
		else undo();
	}
	window.addEventListener('keydown', onWindowKeydown);
	onDestroy(() => window.removeEventListener('keydown', onWindowKeydown));

	// ---- 誤りの候補（AI）。出すだけで、当てるのはチェックしたものだけ ----
	let suggestions = $state<ProofSuggestion[] | null>(null);
	let picked = $state<Set<number>>(new Set());
	let proofing = $state(false);
	async function proofread() {
		const t = ensureTranscript();
		if (t.cues.length === 0 || proofing) return;
		proofing = true;
		try {
			flush();
			const items = await api().transcripts.proofread(
				recording.id,
				JSON.parse(JSON.stringify(t.cues)) as Cue[]
			);
			suggestions = items;
			picked = new Set();
			toast.show(
				items.length
					? `候補が ${items.length} 件あります。チェックして「直す」を押してください`
					: '直したほうがよさそうな所は見つかりませんでした'
			);
		} catch (err) {
			toast.error(`候補を出せませんでした。${(err as Error)?.message ?? ''}`);
		} finally {
			proofing = false;
		}
	}
	function togglePick(i: number, on: boolean) {
		const next = new Set(picked);
		if (on) next.add(i);
		else next.delete(i);
		picked = next;
	}
	function applyPicked() {
		const t = ensureTranscript();
		if (!suggestions || picked.size === 0) return;
		remember();
		const chosen = suggestions.filter((_, i) => picked.has(i));
		const r = applySuggestions(t.cues, chosen);
		t.cues = r.cues;
		flush();
		toast.show(`${r.applied} か所を直しました（⌘Z で戻せます）`);
		suggestions = suggestions.filter((_, i) => !picked.has(i));
		picked = new Set();
		if (suggestions.length === 0) suggestions = null;
	}
	const cueOf = (id: string) => transcript?.cues.find((c) => c.id === id) ?? null;

	// 文字の欄は日本語入力の変換中（isComposing）には状態に入れない。変換中に状態を変えると Svelte が欄の value を
	// 書き戻して変換が確定し、打った文字が二重に入った（「どっか」→「どっかどっか」2026-09-17）。確定（compositionend）で入れる
	const composing = (e: Event) => (e as { isComposing?: boolean }).isComposing === true;
	function update(id: string, patch: Partial<Cue>) {
		const t = ensureTranscript();
		const i = t.cues.findIndex((c) => c.id === id);
		if (i === -1) return;
		t.cues[i] = { ...t.cues[i], ...patch };
		scheduleSave();
	}

	function remove(id: string) {
		const t = ensureTranscript();
		remember();
		t.cues = t.cues.filter((c) => c.id !== id);
		scheduleSave();
	}

	/** いまの位置に 3 秒のテロップを足す（次のテロップがあれば、その始まりまで） */
	function addAtCurrent() {
		const t = ensureTranscript();
		const startMs = Math.round(currentMs);
		const next = t.cues.filter((c) => c.startMs > startMs).sort((a, b) => a.startMs - b.startMs)[0];
		const endMs = Math.min(recording.durationMs, next ? next.startMs : startMs + 3000);
		if (endMs - startMs < 200)
			return toast.error('ここには入れられません（次のテロップと近すぎます）');
		remember();
		t.cues = normalizeCues([...t.cues, { id: makeId(), startMs, endMs, text: '（ここに文字）' }]);
		scheduleSave();
	}

	/** 長いテロップを「、」で分けて、時間を文字数の割合で配る（文字起こしからの作り直しより粗い近似） */
	function splitLong() {
		const t = ensureTranscript();
		const before = t.cues.length;
		remember();
		t.cues = normalizeCues(t.cues.flatMap((c) => splitLongCue(c, TELOP_MAX_CHARS, makeId)));
		const added = t.cues.length - before;
		flush();
		toast.show(
			added > 0
				? `長いテロップを分けて ${added} 件増えました`
				: '分ける必要のある長いテロップはありません'
		);
	}
	const hasLong = $derived(!!transcript?.cues.some((c) => [...c.text].length > TELOP_MAX_CHARS));

	function tenth(ms: number): string {
		return `${formatDuration(ms)}.${Math.floor((Math.max(0, ms) % 1000) / 100)}`;
	}

	function phaseText(p: TranscribeProgress['phase'] | null): string {
		switch (p) {
			case 'extracting':
				return '声を取り出しています…';
			case 'uploading':
				return '文字起こしをしています（1 分の収録で 10 秒ほど）…';
			default:
				return '準備しています…';
		}
	}
</script>

<!-- いま読み上げているテロップ。動画を見ながら、その場で止めて直せる -->
<section class="now card" aria-label="いまのテロップ">
	<div class="now__bar">
		<span class="ed__now now__time">いま {tenth(currentMs)}</span>
		<button
			type="button"
			class="btn btn--sm"
			onclick={() => onTogglePlay?.()}
			title="再生 / 一時停止（スペース）">{paused ? '▶ 再生' : '❚❚ 一時停止'}</button
		>
		<span class="now__steps">
			<button type="button" class="chip" onclick={() => onStep?.(-30)} title="1 秒戻す（Shift+←）"
				>−1秒</button
			>
			<button type="button" class="chip" onclick={() => onStep?.(-1)} title="1 コマ戻す（←）"
				>−1コマ</button
			>
			<button type="button" class="chip" onclick={() => onStep?.(1)} title="1 コマ進める（→）"
				>+1コマ</button
			>
			<button type="button" class="chip" onclick={() => onStep?.(30)} title="1 秒進める（Shift+→）"
				>+1秒</button
			>
		</span>
		<span class="now__nav">
			<button type="button" class="chip" disabled={nowIndex <= 0} onclick={() => goNeighbor(-1)}
				>← 前のテロップ</button
			>
			<button
				type="button"
				class="chip"
				disabled={!transcript || nowIndex < 0 || nowIndex >= transcript.cues.length - 1}
				onclick={() => goNeighbor(1)}>次のテロップ →</button
			>
		</span>
	</div>
	{#if nowCue}
		<div class="now__row">
			<button type="button" class="chip telop__time" onclick={() => onSeek(nowCue.startMs)}
				>{tenth(nowCue.startMs)}〜{tenth(nowCue.endMs)}</button
			>
			<input
				class="input now__text"
				value={nowCue.text}
				aria-label="いまのテロップの文字"
				onfocus={() => {
					onPause?.();
					remember();
				}}
				oninput={(e) => {
					if (!composing(e)) update(nowCue.id, { text: e.currentTarget.value });
				}}
				oncompositionend={(e) => update(nowCue.id, { text: e.currentTarget.value })}
				onchange={() => flush()}
				onkeydown={(e) => {
					// Enter か Esc で欄から出る（そのあとスペースで再生できる）。
					// 日本語入力の変換を確定・取り消す Enter / Esc（isComposing）では出ない: 変換中に欄を離れると
					// 変換中の文字が確定と一緒に二重に入った
					if ((e.key === 'Escape' || e.key === 'Enter') && !e.isComposing) {
						e.stopPropagation();
						e.currentTarget.blur();
					}
				}}
			/>
		</div>
		<p class="muted now__hint">
			動画で読み上げている所のテロップです。欄をクリックすると動画が止まり、そのまま直せます（⌘Z
			で戻せます）。Enter か Esc で欄から出て、スペースで再生を続けられます。
		</p>
	{:else}
		<p class="muted now__hint">
			{transcript && transcript.cues.length > 0
				? 'この位置にはテロップがありません。'
				: 'テロップを作ると、動画で読み上げている所の文がここに出ます。'}
		</p>
	{/if}
</section>

<section class="telop card">
	<div class="telop__head">
		<h2 class="card__title">
			テロップ
			{#if transcript}<span class="muted">{transcript.cues.length} 件</span>{/if}
		</h2>
		<div class="telop__actions">
			<button
				type="button"
				class="chip"
				title="テロップの編集を戻す（⌘Z）"
				onclick={undo}
				disabled={history.length === 0}>戻す</button
			>
			<button
				type="button"
				class="chip"
				title="やり直す（⌘⇧Z）"
				onclick={redo}
				disabled={future.length === 0}>やり直す</button
			>
			<button
				type="button"
				class="chip"
				title="AI に文脈を見せて、聞き違いなどの候補を出してもらう（チェックしたものだけ直る）"
				onclick={proofread}
				disabled={generating || proofing || !transcript || transcript.cues.length === 0}
			>
				{proofing ? '候補を探しています…' : '誤りの候補を出す（AI）'}
			</button>
			<button type="button" class="chip" onclick={addAtCurrent} disabled={generating}>
				＋ いまの位置に足す
			</button>
			{#if hasLong}
				<button
					type="button"
					class="chip"
					onclick={splitLong}
					disabled={generating}
					title="{TELOP_MAX_CHARS} 文字を超えるテロップを「、」で分けます"
				>
					長い文を分ける
				</button>
			{/if}
			<button
				type="button"
				class="btn btn--sm btn--yellow"
				onclick={generate}
				disabled={generating || !hasKey}
				title={hasKey ? '' : '設定で OpenAI の API キーを入れると使えます'}
			>
				{generating
					? phaseText(phase)
					: transcript && transcript.cues.length > 0
						? 'テロップを作り直す'
						: 'テロップを作る（文字起こし）'}
			</button>
		</div>
	</div>
	{#if !hasKey}
		<p class="muted telop__hint">
			文字起こしには OpenAI の API
			キーが要ります。設定（右上）で入力してください。手で足すだけなら、キーは要りません。
		</p>
	{/if}
	{#if suggestions}
		<div class="proof">
			<div class="proof__head">
				<strong>誤りの候補 {suggestions.length} 件</strong>
				<span class="muted"
					>チェックしたものだけ直します。本当に何と言ったかは、ご自身で確かめてください。</span
				>
				<span class="proof__tools">
					<button
						type="button"
						class="chip"
						onclick={() => (picked = new Set(suggestions!.map((_, i) => i)))}>全部チェック</button
					>
					<button type="button" class="chip" onclick={() => (picked = new Set())}>全部外す</button>
					<button type="button" class="chip" onclick={() => (suggestions = null)}
						>候補を閉じる</button
					>
					<button
						type="button"
						class="btn btn--sm btn--yellow"
						disabled={picked.size === 0}
						onclick={applyPicked}>チェックした {picked.size} 件を直す</button
					>
				</span>
			</div>
			<ol class="proof__list">
				{#each suggestions as s, i (s.id + ':' + s.before + ':' + i)}
					{@const cue = cueOf(s.id)}
					<li class="proof__row">
						<label class="proof__pick">
							<input
								type="checkbox"
								checked={picked.has(i)}
								onchange={(e) => togglePick(i, e.currentTarget.checked)}
							/>
						</label>
						<button
							type="button"
							class="chip telop__time"
							title="この位置を再生"
							onclick={() => cue && onSeek(cue.startMs)}>{cue ? tenth(cue.startMs) : '—'}</button
						>
						<div class="proof__body">
							<div class="proof__diff">
								<span class="proof__before">{s.before}</span>
								<span class="proof__arrow">→</span>
								<span class="proof__after">{s.after}</span>
								<span class="muted proof__reason"
									>{s.confidence >= 5 ? '確信 高' : '確信 中'}{s.reason
										? '・' + s.reason
										: ''}</span
								>
							</div>
							{#if cue}
								<div class="muted proof__context">{cue.text}</div>
							{/if}
						</div>
					</li>
				{/each}
			</ol>
		</div>
	{/if}
	{#if transcript && transcript.cues.length > 0}
		<p class="muted telop__hint">
			文字はその場で直せます。間違えたら ⌘Z で戻せます（⌘⇧Z
			でやり直し）。消した範囲のテロップは書き出しに入りません。
		</p>
		<ol class="telop__list">
			{#each transcript.cues as c (c.id)}
				<li class="telop__row" class:telop__row--on={activeId === c.id}>
					<button type="button" class="chip telop__time" onclick={() => onSeek(c.startMs)}
						>{tenth(c.startMs)}</button
					>
					<input
						class="input telop__text"
						value={c.text}
						onfocus={() => remember()}
						oninput={(e) => {
							if (!composing(e)) update(c.id, { text: e.currentTarget.value });
						}}
						oncompositionend={(e) => update(c.id, { text: e.currentTarget.value })}
						onchange={() => flush()}
					/>
					<span class="muted telop__len">{tenth(c.endMs - c.startMs)}</span>
					<button
						type="button"
						class="chip telop__del"
						title="消す"
						aria-label="このテロップを消す"
						onclick={() => remove(c.id)}>×</button
					>
				</li>
			{/each}
		</ol>
	{:else if !generating}
		<p class="muted telop__hint">
			まだテロップはありません。「テロップを作る」で声を文字にして、文ごとに出します（話し始めに出て、次の文で切り替わります）。
		</p>
	{/if}
</section>

<style>
	.telop {
		display: grid;
		gap: 10px;
		min-width: 0;
	}
	.telop__head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
	}
	.telop__actions {
		display: flex;
		gap: 8px;
		align-items: center;
		flex-wrap: wrap;
	}
	.telop__hint {
		font-size: 12.5px;
	}
	.telop__list {
		list-style: none;
		padding: 0;
		margin: 0;
		display: grid;
		gap: 6px;
	}
	.telop__row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 6px;
		border-radius: 12px;
	}
	.telop__row--on {
		background: var(--yellow);
	}
	.telop__time {
		font-variant-numeric: tabular-nums;
		min-width: 76px;
		justify-content: center;
	}
	.telop__text {
		flex: 1;
		min-width: 0;
		font-size: 14px;
		min-height: 36px;
		padding: 4px 12px;
	}
	.telop__len {
		font-size: 12px;
		font-variant-numeric: tabular-nums;
		min-width: 52px;
		text-align: right;
	}
	.telop__del {
		min-height: 26px;
		padding: 0 9px;
	}
	/* 誤りの候補 */
	.proof {
		border: var(--border);
		border-radius: 14px;
		background: #fff;
		padding: 12px 14px;
		display: grid;
		gap: 10px;
	}
	.proof__head {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}
	.proof__tools {
		margin-left: auto;
		display: flex;
		gap: 6px;
		align-items: center;
	}
	.proof__list {
		margin: 0;
		padding: 0;
		list-style: none;
		display: grid;
		gap: 8px;
	}
	.proof__row {
		display: flex;
		align-items: flex-start;
		gap: 10px;
	}
	.proof__pick input {
		width: 20px;
		height: 20px;
		accent-color: var(--ink);
		margin-top: 4px;
	}
	.proof__body {
		min-width: 0;
		display: grid;
		gap: 2px;
	}
	.proof__diff {
		display: flex;
		align-items: baseline;
		gap: 8px;
		flex-wrap: wrap;
		font-weight: 700;
	}
	.proof__before {
		color: var(--alert);
		text-decoration: line-through;
	}
	.proof__after {
		color: var(--ink);
		background: var(--yellow);
		padding: 0 6px;
		border-radius: 6px;
	}
	.proof__reason {
		font-size: 12px;
		font-weight: 500;
	}
	.proof__context {
		font-size: 13px;
	}
	/* いまのテロップ */
	.now {
		display: grid;
		gap: 10px;
	}
	.now__bar {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}
	.now__time {
		font-weight: 900;
		font-variant-numeric: tabular-nums;
	}
	.now__steps,
	.now__nav {
		display: flex;
		gap: 6px;
	}
	.now__nav {
		margin-left: auto;
	}
	.now__row {
		display: flex;
		align-items: center;
		gap: 12px;
	}
	.now__text {
		flex: 1;
		min-width: 0;
		font-size: 22px;
		font-weight: 900;
		line-height: 1.4;
		padding: 10px 14px;
	}
	.now__hint {
		font-size: 12.5px;
	}
</style>
