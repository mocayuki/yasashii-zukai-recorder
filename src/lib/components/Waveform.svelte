<script lang="ts">
	import type { Cut, Marker } from '$shared/types';

	/**
	 * 音声の波形（時間軸）。収録時に計算した山の高さ（0〜1）を並べて描く。
	 * - クリック: その位置へ頭出し（再生は始めない。再生中ならそのまま続く）
	 * - ドラッグ: 消す範囲を選ぶ（始まり・終わりの取っ手はあとから動かせる）
	 * - 消した範囲は斜線、しるしは金色の線、再生位置は赤い線
	 */
	let {
		peaks,
		peaksPerSecond,
		durationMs,
		currentMs = 0,
		markers = [],
		cuts = [],
		inMs = null,
		outMs = null,
		onSeek,
		onRange
	}: {
		peaks: number[];
		peaksPerSecond: number;
		durationMs: number;
		currentMs?: number;
		markers?: Marker[];
		/** 消す範囲（斜線で塗る） */
		cuts?: Cut[];
		/** 選びかけの範囲の始まりと終わり */
		inMs?: number | null;
		outMs?: number | null;
		onSeek?: (ms: number) => void;
		/** ドラッグで範囲が変わったとき（両方 null で解除） */
		onRange?: (inMs: number | null, outMs: number | null) => void;
	} = $props();

	let canvas = $state<HTMLCanvasElement | null>(null);
	let width = $state(0);
	let cursor = $state('pointer');
	const HEIGHT = 72;
	const HANDLE_PX = 7;

	/** ドラッグの状態 */
	let drag: { kind: 'new' | 'in' | 'out'; anchorMs: number; moved: boolean } | null = null;

	$effect(() => {
		if (!canvas) return;
		const el = canvas;
		const ro = new ResizeObserver(() => (width = el.clientWidth));
		ro.observe(el);
		width = el.clientWidth;
		return () => ro.disconnect();
	});

	$effect(() => {
		const el = canvas;
		if (!el || width === 0) return;
		const dpr = window.devicePixelRatio || 1;
		el.width = Math.round(width * dpr);
		el.height = Math.round(HEIGHT * dpr);
		const ctx = el.getContext('2d')!;
		ctx.scale(dpr, dpr);
		ctx.clearRect(0, 0, width, HEIGHT);
		const toX = (ms: number) => (durationMs > 0 ? (ms / durationMs) * width : 0);

		// 波形の山（左右対称）
		const total = Math.max(1, Math.round((durationMs / 1000) * peaksPerSecond));
		const n = Math.max(1, Math.min(total, peaks.length));
		const bars = Math.max(1, Math.min(Math.floor(width / 3), n));
		const per = n / bars;
		const barW = width / bars;
		const playedX = toX(currentMs);
		for (let b = 0; b < bars; b++) {
			let peak = 0;
			const from = Math.floor(b * per);
			const to = Math.max(from + 1, Math.floor((b + 1) * per));
			for (let i = from; i < to && i < peaks.length; i++) if (peaks[i] > peak) peak = peaks[i];
			const h = Math.max(2, peak * (HEIGHT - 10));
			const x = Math.round(b * barW) + 0.5;
			ctx.fillStyle = x <= playedX ? '#1c1812' : '#c9bc96';
			ctx.fillRect(
				x,
				Math.round((HEIGHT - h) / 2),
				Math.max(1, Math.floor(barW) - 1),
				Math.round(h)
			);
		}
		// 消した範囲: 薄い赤に斜線
		for (const c of cuts) {
			const x0 = toX(c.startMs);
			const x1 = toX(c.endMs);
			ctx.fillStyle = 'rgba(229, 72, 77, 0.22)';
			ctx.fillRect(x0, 0, x1 - x0, HEIGHT);
			ctx.save();
			ctx.beginPath();
			ctx.rect(x0, 0, x1 - x0, HEIGHT);
			ctx.clip();
			ctx.strokeStyle = 'rgba(229, 72, 77, 0.6)';
			ctx.lineWidth = 1.5;
			for (let x = x0 - HEIGHT; x < x1 + HEIGHT; x += 8) {
				ctx.beginPath();
				ctx.moveTo(x, HEIGHT);
				ctx.lineTo(x + HEIGHT, 0);
				ctx.stroke();
			}
			ctx.restore();
		}
		// 選んでいる範囲（ここから〜ここまで）と取っ手
		if (inMs !== null || outMs !== null) {
			const a = inMs ?? 0;
			const b = outMs ?? durationMs;
			if (inMs !== null && outMs !== null && b > a) {
				ctx.fillStyle = 'rgba(28, 24, 18, 0.12)';
				ctx.fillRect(toX(a), 0, toX(b) - toX(a), HEIGHT);
			}
			ctx.fillStyle = '#1c1812';
			for (const ms of [inMs, outMs]) {
				if (ms === null) continue;
				const x = toX(ms);
				ctx.fillRect(x - 1.5, 0, 3, HEIGHT);
				// 取っ手（上下の小さな丸）
				ctx.beginPath();
				ctx.arc(x, 7, 6, 0, Math.PI * 2);
				ctx.arc(x, HEIGHT - 7, 6, 0, Math.PI * 2);
				ctx.fill();
			}
		}
		// しるし
		ctx.fillStyle = '#c99f1e';
		for (const m of markers) {
			const x = toX(m.atMs);
			ctx.fillRect(x - 1, 0, 2, HEIGHT);
		}
		// 再生位置
		if (durationMs > 0) {
			ctx.fillStyle = '#e5484d';
			ctx.fillRect(playedX - 1, 0, 2, HEIGHT);
		}
	});

	function msAt(e: PointerEvent | MouseEvent): number {
		if (!canvas || durationMs <= 0) return 0;
		const r = canvas.getBoundingClientRect();
		const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
		return Math.round(ratio * durationMs);
	}

	function handleAt(e: PointerEvent | MouseEvent): 'in' | 'out' | null {
		if (!canvas || durationMs <= 0) return null;
		const r = canvas.getBoundingClientRect();
		const x = e.clientX - r.left;
		const toX = (ms: number) => (ms / durationMs) * r.width;
		if (inMs !== null && Math.abs(x - toX(inMs)) <= HANDLE_PX) return 'in';
		if (outMs !== null && Math.abs(x - toX(outMs)) <= HANDLE_PX) return 'out';
		return null;
	}

	function onPointerDown(e: PointerEvent) {
		if (e.button !== 0 || !canvas) return;
		canvas.setPointerCapture(e.pointerId);
		const h = handleAt(e);
		const ms = msAt(e);
		if (h === 'in') drag = { kind: 'in', anchorMs: outMs ?? ms, moved: false };
		else if (h === 'out') drag = { kind: 'out', anchorMs: inMs ?? ms, moved: false };
		else drag = { kind: 'new', anchorMs: ms, moved: false };
	}

	function onPointerMove(e: PointerEvent) {
		if (!drag) {
			cursor = handleAt(e) ? 'ew-resize' : 'pointer';
			return;
		}
		const ms = msAt(e);
		if (!drag.moved && Math.abs(ms - drag.anchorMs) < (durationMs / Math.max(1, width)) * 3) return; // 3px 動くまでは「クリック」
		drag.moved = true;
		const a = Math.min(drag.anchorMs, ms);
		const b = Math.max(drag.anchorMs, ms);
		onRange?.(a, b);
		onSeek?.(ms);
	}

	function onPointerUp(e: PointerEvent) {
		if (!drag) return;
		const d = drag;
		drag = null;
		if (!d.moved) {
			// ただのクリック: 頭出しだけ
			onSeek?.(msAt(e));
		}
	}

	function onKeydown(e: KeyboardEvent) {
		// 矢印などは編集画面側で扱う。ここでは Space で再生に割り込まないようにだけする
		if (e.key === ' ') e.preventDefault();
	}
</script>

<canvas
	bind:this={canvas}
	class="wave"
	style="height: {HEIGHT}px; cursor: {cursor}"
	onpointerdown={onPointerDown}
	onpointermove={onPointerMove}
	onpointerup={onPointerUp}
	onpointercancel={onPointerUp}
	onkeydown={onKeydown}
	role="slider"
	aria-label="時間軸（クリックで頭出し、ドラッグで消す範囲を選ぶ）"
	aria-valuemin="0"
	aria-valuemax={durationMs}
	aria-valuenow={currentMs}
	tabindex="0"
></canvas>

<style>
	.wave {
		display: block;
		width: 100%;
		border: 2px solid var(--ink);
		border-radius: 12px;
		background: var(--cream);
		touch-action: none;
		user-select: none;
	}
	.wave:focus {
		outline: none;
	}
	.wave:focus-visible {
		box-shadow: 0 0 0 3px var(--gold);
	}
</style>
