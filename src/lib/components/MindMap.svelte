<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import type { MapNode, Note, PresentCamera } from '$shared/types';
	import { locate, pathTo, visibleList } from '$shared/notes';
	import { api, imageUrl } from '$lib/api';
	import { library } from '$lib/stores/library.svelte';
	import { toast } from '$lib/stores/toast.svelte';
	import {
		connectorPath,
		connectorStart,
		DOWN_CROSS_GAP,
		fitCamera,
		layoutMap,
		V_GAP,
		type Direction,
		type Size
	} from '$lib/notes/layout';
	import { Motion } from '$lib/notes/motion';
	import { recorder } from '$lib/recording/recorder.svelte';
	import MindNode from './MindNode.svelte';

	let {
		note,
		stageMode = false,
		readonly = false,
		presenting = false,
		mirror = false,
		remoteSelectedId = null,
		remoteOpenImage = null,
		remoteCamera = null,
		frameOnly = false,
		initialCamera = null,
		initialFocusId = null,
		onToggleCollapse = null,
		frameEl = $bindable(null)
	}: {
		note: Note;
		stageMode?: boolean;
		readonly?: boolean;
		/** 収録中: 追加・編集のボタンを隠す（開閉と選択はできる） */
		presenting?: boolean;
		/** プレゼン用の窓: 見るだけ（操作は受け付けない）。選択はワークスペースから remoteSelectedId で届く */
		mirror?: boolean;
		remoteSelectedId?: string | null;
		/** プレゼン用の窓: 大きく見せている画像のノード id */
		remoteOpenImage?: string | null;
		/** プレゼン用の窓: ワークスペースのカメラ（届いたらそのまま同じ見え方にする） */
		remoteCamera?: PresentCamera | null;
		/** 枠だけの見た目にする（サムネイル用。上の説明の列を出さず、プレゼン用の窓へも送らない） */
		frameOnly?: boolean;
		/** 最初の表示で使うカメラ（覚えていた位置）。あれば全体表示の代わりに、動きなしでこの位置から始める */
		initialCamera?: { x: number; y: number; zoom: number; viewW: number } | null;
		/** 最初の表示で、このノードと開いている子孫が収まるように寄る（initialCamera が無いとき） */
		initialFocusId?: string | null;
		/** ノードの開閉を外で持つとき（サムネイル: ノート本体の開閉を変えない）。無ければノートの開閉を変える */
		onToggleCollapse?: ((id: string) => void) | null;
		/** 黄色い枠の要素（収録の切り出し範囲）。外から bind で受け取れる */
		frameEl?: HTMLDivElement | null;
	} = $props();

	const GRID = 26; // 背景の点の間隔。手で動かすときは点の上に吸い付く
	/** 収録の見た目（黄色の枠にタイトルとクリーム色の面）で出すか */
	const framed = $derived(stageMode || readonly || frameOnly);

	// ---- 状態 ----
	let sizes = $state<Record<string, Size>>({});
	let selectedId = $state<string | null>(null);
	let editingId = $state<string | null>(null);
	let freshId = $state<string | null>(null); // 作ったばかりで、まだ文字が無いノード
	let draggingId = $state<string | null>(null);
	/**
	 * ドラッグ中の「落とし先」。ノードの上に重ねると、そのノードの子になる。
	 * ノードのすぐ上・下に持っていくと、その兄弟として前・後ろに入る。どれでもなければ、ただ位置を動かす
	 */
	let dropTarget = $state<{ kind: 'child' | 'before' | 'after'; id: string } | null>(null);
	let panning = $state(false);
	let view = $state<HTMLDivElement | null>(null);
	let viewW = $state(0);
	let viewH = $state(0);

	const root = $derived(note.root);
	/** 木の向き: 横の動画なら右へ、縦の動画なら下へ広がる */
	// 縦の動画は箇条書き型（親の下に子を字下げして縦に並べる）。ノードの操作の置き場所は横の木と同じ
	const direction = $derived<Direction>(note.orientation === 'portrait' ? 'outline' : 'right');
	const vertical = $derived(direction === 'down');
	const outline = $derived(direction === 'outline');
	const isRoot = (id: string) => id === root.id;

	// 開閉で先祖が動かないよう、前回の配置と「操作中のノードまでの道筋」を配置計算へ渡す
	let prevCenters = new Map<string, number>();
	const layout = $derived.by(() => {
		const anchorPath = new Set<string>([root.id]);
		if (selectedId) for (const n of pathTo([root], selectedId)) anchorPath.add(n.id);
		const result = layoutMap(root, sizes, { anchorPath, prevCenters, direction });
		// 「兄弟が並ぶ向き」の中心を覚える（右に広がる木なら y、下に広がる木なら x）
		prevCenters = new Map(
			result.placed.map((p) => [p.id, direction === 'right' ? p.y + p.h / 2 : p.x + p.w / 2])
		);
		return result;
	});
	const byId = $derived(new Map(layout.placed.map((p) => [p.id, p])));
	// 向きが変わったら、前回の中心は意味が変わるので捨てて、全体を収め直す
	let lastDirection: Direction | null = null;
	$effect(() => {
		if (lastDirection !== null && lastDirection !== direction) {
			prevCenters = new Map();
			requestAnimationFrame(() => fit());
		}
		lastDirection = direction;
	});

	/**
	 * まだ大きさを測っていないノード（閉じた枝の中など）。見えない所に一度描いて測っておくと、
	 * 開いた瞬間から正しい位置に出る（仮の大きさで置いてから動く、ということが無くなる）
	 */
	const unmeasured = $derived.by(() => {
		const out: MapNode[] = [];
		const walk = (n: MapNode) => {
			if (!sizes[n.id] && !byId.has(n.id)) out.push(n);
			n.children.forEach(walk);
		};
		walk(root);
		return out;
	});
	const noop = () => {};

	/** 兄弟の中での位置（順番の入れ替えボタンの有効・無効に使う） */
	function siblingIndex(id: string): number {
		return locate([root], id)?.index ?? 0;
	}
	function siblingCount(id: string): number {
		return locate([root], id)?.siblings.length ?? 1;
	}
	/** 根からの深さ（根 = 0、根の子 = 1）。階層を上げられるのは深さ 2 以上 */
	function depthOf(id: string): number {
		return Math.max(0, pathTo([root], id).length - 1);
	}

	// ---- なめらかな動き（カメラとノードの位置） ----
	let anim = $state<Record<string, number>>({});
	const motion = new Motion(0.16, (values) => {
		const next: Record<string, number> = {};
		for (const [k, v] of values) next[k] = v;
		anim = next;
	});
	onDestroy(() => motion.stop());

	const camX = $derived(anim['cam:x'] ?? 0);
	const camY = $derived(anim['cam:y'] ?? 0);
	const camZ = $derived(anim['cam:z'] ?? 1);

	/** いま画面に出ている位置（アニメーション中の値）。未登録なら配置計算の値 */
	function shown(id: string): { x: number; y: number } {
		const p = byId.get(id);
		return { x: anim[`${id}:x`] ?? p?.x ?? 0, y: anim[`${id}:y`] ?? p?.y ?? 0 };
	}

	// 配置が変わったら、各ノードの目標位置を更新する。
	// 新しく現れるノードは最終位置にそのまま出す（見た目のふわっとした出現は CSS 側）。
	let known = new Set<string>();
	$effect(() => {
		const current = new Set<string>();
		for (const p of layout.placed) {
			current.add(p.id);
			const immediate = p.id === draggingId || !known.has(p.id);
			motion.set(`${p.id}:x`, p.x, immediate);
			motion.set(`${p.id}:y`, p.y, immediate);
		}
		for (const id of known) {
			if (!current.has(id)) {
				motion.remove(`${id}:x`);
				motion.remove(`${id}:y`);
			}
		}
		known = current;
	});

	// ワークスペースでは、開いた直後からキー操作が効くようにマップへフォーカスを移す
	$effect(() => {
		if (stageMode && view) view.focus({ preventScroll: true });
	});

	// 画面の大きさを追う
	$effect(() => {
		if (!view) return;
		const el = view;
		const ro = new ResizeObserver(() => {
			resizedAt = performance.now();
			viewW = el.clientWidth;
			viewH = el.clientHeight;
			if (frameOnly) {
				// サムネイル: 面の大きさが変わっても全体表示はせず、同じ見え方になるよう比で合わせる
				// （開いた直後の大きさ確定でも全体表示に戻らないように。覚えていた位置を保つ）。
				// 比は「いまのカメラがどの幅のときに決まったか」（camViewW）に対して取る。
				// 直前の幅に対して取ると、その間にカメラが当て直されていたときに 2 重に掛かってずれる
				if (camViewW > 0 && viewW > 0 && fittedOnce && camViewW !== viewW) {
					const s = viewW / camViewW;
					const t = cameraTarget();
					setCamera(t.x * s, t.y * s, t.z * s, true);
				}
				camViewW = viewW;
				return;
			}
			// 枠の大きさはウィンドウに追従するので、そのたびに全体を収める（プレゼン用の窓はカメラが届いていれば従う）
			if (framed && !(mirror && cameraReceived)) fit(true);
		});
		ro.observe(el);
		viewW = el.clientWidth;
		viewH = el.clientHeight;
		return () => ro.disconnect();
	});

	// 最初に全部のノードの大きさが分かったら、全体が見えるようにする。
	// フォントの読み込みでノードの幅があとから変わるので、しばらくは大きさの変化に追従する。
	let fittedOnce = false;
	let autoFitUntil = 0;
	let fontsReady = $state(false);
	$effect(() => {
		let alive = true;
		document.fonts.ready.then(() => {
			if (alive) fontsReady = true;
		});
		return () => {
			alive = false;
		};
	});
	$effect(() => {
		if (viewW === 0 || !fontsReady) return;
		const measured = layout.placed.every((p) => sizes[p.id]);
		if (!measured) return;
		void layout.bounds; // 大きさが変わったら再計算する
		if (mirror && cameraReceived) return;
		if (!fittedOnce) {
			fittedOnce = true;
			if (initialCamera) {
				// 覚えていた位置から、動きなしで始める（開いた瞬間に見え方が変わらないように）
				autoFitUntil = 0;
				applyCamera(initialCamera);
			} else if (initialFocusId) {
				autoFitUntil = 0;
				focusOn(initialFocusId, true);
			} else {
				autoFitUntil = performance.now() + 1500;
				fit(true);
			}
		} else if (readonly || performance.now() < autoFitUntil) {
			// 見るだけの全体像は、中身が変わっても常に全体を収める
			fit(true);
		}
	});

	/** いまのカメラが決まったときの面の幅（サムネイルで面の大きさが変わったとき、比で合わせる基準） */
	let camViewW = 0;
	function setCamera(x: number, y: number, z: number, immediate = false) {
		camViewW = viewW;
		motion.set('cam:x', x, immediate);
		motion.set('cam:y', y, immediate);
		motion.set('cam:z', z, immediate);
		sendCamera(x, y, z, immediate);
	}

	/**
	 * ワークスペース: カメラの「目標」をプレゼン用の窓へ送る（1 コマに 1 回まで）。
	 * 目標を送るので、プレゼン用の窓は自分のなめらかな動きで追い、こちらの描画が止まっていても動く。
	 * immediate（ドラッグの移動や全体を収め直したとき）は、向こうも即座に合わせる
	 */
	let camFrame: number | null = null;
	let resizedAt = 0;
	let resizeSend: number | null = null;
	function sendCamera(x: number, y: number, z: number, immediate: boolean) {
		if (!stageMode || mirror || viewW === 0) return;
		const cam = { x, y, z, viewW, viewH, immediate };
		// ウィンドウの大きさを変えている最中は、動画の中での見え方は変わらない（倍率は動画基準）ので、
		// 1 コマごとに送らず、落ち着いてから 1 回だけ送る（プレゼン用の窓の描き直しを減らし、カクつきを抑える）
		if (performance.now() - resizedAt < 200) {
			if (resizeSend !== null) clearTimeout(resizeSend);
			resizeSend = window.setTimeout(() => {
				resizeSend = null;
				api().present.updateCamera({ ...cam, x: camX, y: camY, z: camZ, viewW, viewH });
			}, 220);
			return;
		}
		if (camFrame !== null) cancelAnimationFrame(camFrame);
		camFrame = requestAnimationFrame(() => {
			camFrame = null;
			api().present.updateCamera(cam);
		});
	}

	function cameraTarget() {
		return {
			x: motion.target('cam:x') ?? camX,
			y: motion.target('cam:y') ?? camY,
			z: motion.target('cam:z') ?? camZ
		};
	}

	/** 外から（ワークスペースの収録開始など）全体を収め直す */
	export function fitAll() {
		selectedId = null;
		fit();
	}

	/** 外から: いまのカメラ（目標）と面の幅。サムネイルの状態を覚える用 */
	export function getCamera(): { x: number; y: number; zoom: number; viewW: number } {
		const t = cameraTarget();
		return { x: t.x, y: t.y, zoom: t.z, viewW };
	}
	/** 外から: 覚えていたカメラに合わせる。面の幅が違えば比で合わせる（見え方が同じになる） */
	export function applyCamera(c: { x: number; y: number; zoom: number; viewW: number }) {
		if (viewW === 0) return;
		fittedOnce = true;
		autoFitUntil = 0;
		const s = c.viewW > 0 ? viewW / c.viewW : 1;
		setCamera(c.x * s, c.y * s, c.zoom * s, true);
	}

	/** 外から: そのノードと開いている子孫が収まるように寄る（サムネイルの初期表示など） */
	export function focusNode(id: string) {
		// 最初の自動の全体表示（しばらく追従する）に上書きされないように、そこで打ち切る
		fittedOnce = true;
		autoFitUntil = 0;
		focusOn(id);
	}

	/**
	 * 枠の画面上の幅。動画は枠を 1920px（縦は 1080px）に拡大したものなので、
	 * 「動画の中での見え方」を一定にするには、倍率や余白を枠の幅に対する比で決める必要がある
	 */
	let frameW = $state(0);
	$effect(() => {
		if (!frameEl) return;
		const el = frameEl;
		const ro = new ResizeObserver(() => (frameW = el.clientWidth));
		ro.observe(el);
		frameW = el.clientWidth;
		return () => ro.disconnect();
	});
	/** 動画の 1px が画面の何 px か（枠が無いときは 1。枠が広いほど小さい） */
	const videoPx = $derived.by(() => {
		if (!framed || frameW <= 0) return 1;
		const videoW = vertical || outline ? 1080 : 1920;
		return frameW / videoW;
	});
	// 動画基準の定数（基準にした画面: 枠 1114px、動画 1920px → 動画 1px = 画面 0.58px）
	const REF = 1114 / 1920;
	const FIT_PAD = 64 / REF; // 全体を収めるときの余白（動画 px）
	const FIT_MAX = 1.4 / REF; // 全体を収めるときの倍率の上限（動画基準）
	const FOCUS_PAD = 90 / REF; // 開閉で寄るときの余白（動画 px）
	const FOCUS_MAX = 1.6 / REF; // 開閉で寄るときの倍率の上限（動画基準）

	function fit(immediate = false) {
		if (viewW === 0) return;
		const pad = framed ? FIT_PAD * videoPx : 48;
		const maxZoom = framed ? FIT_MAX * videoPx : 1.4;
		const c = fitCamera(layout.bounds, viewW, viewH, pad, maxZoom);
		setCamera(c.x, c.y, c.zoom, immediate);
	}

	function zoomBy(factor: number, cx = viewW / 2, cy = viewH / 2) {
		const t = cameraTarget();
		const z = Math.max(0.15, Math.min(3, t.z * factor));
		// カーソルの下の点が動かないように平行移動を補正する
		const x = cx - ((cx - t.x) * z) / t.z;
		const y = cy - ((cy - t.y) * z) / t.z;
		setCamera(x, y, z);
	}

	function onWheel(e: WheelEvent) {
		e.preventDefault();
		const rect = view!.getBoundingClientRect();
		const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018));
		zoomBy(factor, e.clientX - rect.left, e.clientY - rect.top);
	}

	// ---- 選択・編集 ----
	function onSize(id: string, w: number, h: number) {
		const cur = sizes[id];
		if (cur && cur.w === w && cur.h === h) return;
		sizes[id] = { w, h };
	}

	function select(id: string | null) {
		selectedId = id;
		view?.focus({ preventScroll: true });
		// 録りながら選んだノードは、その時刻のしるしとして残す
		if (id && recorder.status === 'recording') {
			const hit = locate([root], id);
			if (hit) recorder.mark(hit.node.text);
		}
	}

	// プレゼン用の窓: 選んでいるノードの見た目だけ合わせる（寄る動きはカメラごと届く）
	$effect(() => {
		if (!mirror) return;
		selectedId = remoteSelectedId;
	});
	$effect(() => {
		if (!mirror) return;
		openImage = remoteOpenImage;
	});

	/** 画像を大きく見せているノードの id。枠の中に重ねて出すので、動画とプレゼン用の窓にもそのまま出る */
	let openImage = $state<string | null>(null);
	const openImageSrc = $derived.by(() => {
		if (!openImage) return null;
		const img = locate([root], openImage)?.node.image;
		return img ? imageUrl(img) : null;
	});
	// プレゼン用の窓: ワークスペースのカメラをそのまま使う。面の大きさが違うので、その比で拡大縮小する
	let cameraReceived = false;
	$effect(() => {
		if (!mirror || !remoteCamera || viewW === 0) return;
		const c = remoteCamera;
		const s = c.viewW > 0 ? viewW / c.viewW : 1;
		cameraReceived = true;
		motion.set('cam:x', c.x * s, c.immediate);
		motion.set('cam:y', c.y * s, c.immediate);
		motion.set('cam:z', c.z * s, c.immediate);
	});

	// ワークスペース: 面の大きさが変わったときも、いまの目標を送り直す（比の計算が変わるため）
	$effect(() => {
		if (!stageMode || mirror || viewW === 0) return;
		void viewH;
		const t = cameraTarget();
		sendCamera(t.x, t.y, t.z, true);
	});

	// ワークスペース: 中身と選択が変わるたびに、プレゼン用の窓へ送る（開いていなければ Electron 側で覚えるだけ）
	let sendTimer: number | null = null;
	$effect(() => {
		if (!stageMode || mirror) return;
		const payload = { note: JSON.parse(JSON.stringify(note)) as Note, selectedId, openImage };
		if (sendTimer !== null) window.clearTimeout(sendTimer);
		sendTimer = window.setTimeout(() => api().present.update(payload), 60);
	});

	/**
	 * そのノードと、開いている子孫が収まるように寄る。
	 * 余白と倍率の上限は動画基準なので、ウィンドウの大きさが違っても動画では同じ寄り方になる
	 */
	function focusOn(id: string, immediate = false) {
		if (viewW === 0) return;
		const hit = locate([root], id);
		if (!hit) return;
		const ids = new Set<string>();
		const walk = (n: MapNode) => {
			ids.add(n.id);
			if (!n.collapsed) n.children.forEach(walk);
		};
		walk(hit.node);
		const ps = layout.placed.filter((p) => ids.has(p.id));
		if (ps.length === 0) return;
		const b = {
			minX: Math.min(...ps.map((p) => p.x)),
			minY: Math.min(...ps.map((p) => p.y)),
			maxX: Math.max(...ps.map((p) => p.x + p.w)),
			maxY: Math.max(...ps.map((p) => p.y + p.h))
		};
		const pad = framed ? FOCUS_PAD * videoPx : 60;
		const maxZoom = framed ? FOCUS_MAX * videoPx : 1.6;
		const whole = fitCamera(
			layout.bounds,
			viewW,
			viewH,
			framed ? FIT_PAD * videoPx : 48,
			framed ? FIT_MAX * videoPx : 1.4
		).zoom;
		const bw = Math.max(1, b.maxX - b.minX);
		const bh = Math.max(1, b.maxY - b.minY);
		// 全体より引かない。1 つのノードだけのときは上限まで
		const z = Math.max(whole, Math.min(maxZoom, (viewW - pad * 2) / bw, (viewH - pad * 2) / bh));
		setCamera((viewW - bw * z) / 2 - b.minX * z, (viewH - bh * z) / 2 - b.minY * z, z, immediate);
	}

	/**
	 * 開閉。収録中は、開いた分が見えるように寄り直す（配置が変わったあとで）。
	 * クリックして選ぶだけでは寄らない（色が付くだけ）
	 */
	function toggleCollapse(id: string) {
		if (onToggleCollapse) onToggleCollapse(id);
		else library.toggleCollapsed(note.id, id);
		if (presenting) {
			selectedId = id;
			requestAnimationFrame(() => requestAnimationFrame(() => focusOn(id)));
		}
	}

	// ノードの画像は、閉じている間は DOM から消えるので、開いたときに読み直しになる。
	// 先に全部読んでおき（メモリーに保持）、開いた瞬間に出るようにする
	const warmImages = new Map<string, HTMLImageElement>();
	/** 画像の表示サイズ（先読みで分かった実寸を、ノード内の上限 300×220 に収めたもの）。最初の描画から正しい大きさで出す */
	let imageSizes = $state<Record<string, { w: number; h: number }>>({});
	const IMG_MAX_W = 140;
	const IMG_MAX_H = 105;
	$effect(() => {
		const files: string[] = [];
		const walk = (n: MapNode) => {
			if (n.image) files.push(n.image);
			n.children.forEach(walk);
		};
		walk(root);
		for (const f of files) {
			if (warmImages.has(f)) continue;
			const img = new Image();
			img.decoding = 'async';
			img.src = imageUrl(f);
			void img
				.decode()
				.then(() => {
					if (!img.naturalWidth || !img.naturalHeight) return;
					const k = Math.min(1, IMG_MAX_W / img.naturalWidth, IMG_MAX_H / img.naturalHeight);
					imageSizes[f] = {
						w: Math.round(img.naturalWidth * k),
						h: Math.round(img.naturalHeight * k)
					};
				})
				.catch(() => {});
			warmImages.set(f, img);
		}
	});

	/** 題名の入力欄を中身の高さに合わせる（1 行〜数行） */
	function growTitle(el: HTMLTextAreaElement) {
		el.style.height = 'auto';
		el.style.height = `${el.scrollHeight}px`;
	}
	function autoGrow(el: HTMLTextAreaElement) {
		growTitle(el);
		const ro = new ResizeObserver(() => growTitle(el));
		ro.observe(el);
		return { destroy: () => ro.disconnect() };
	}

	/** 収録中は中身を変えない（開閉・選択・チェックだけ）。文字の編集や追加・削除・移動はしない */
	const locked = $derived(presenting);

	function startEdit(id: string) {
		selectedId = id;
		if (locked) return;
		editingId = id;
	}

	/** 画像を選んでノードに付ける */
	async function attachImage(id: string) {
		if (locked) return;
		try {
			const file = await api().images.add();
			if (file) library.setNodeImage(note.id, id, file);
		} catch (err) {
			toast.error((err as Error).message);
		}
	}

	/** 画像ファイルをノードに落として付ける */
	async function dropImage(id: string, file: File) {
		if (locked || readonly) return;
		try {
			const name = await api().images.importFile(file);
			library.setNodeImage(note.id, id, name);
			toast.show('画像を付けました');
		} catch (err) {
			toast.error((err as Error).message);
		}
	}

	function detachImage(id: string) {
		if (locked) return;
		library.setNodeImage(note.id, id, null);
	}

	function commit(id: string, text: string, then: 'none' | 'child' | 'sibling') {
		const trimmed = text.replace(/\s+$/g, '');
		const wasFresh = freshId === id;
		if (editingId === id) editingId = null;
		if (wasFresh) freshId = null;
		if (wasFresh && trimmed === '' && then === 'none') {
			library.removeNode(note.id, id);
			return;
		}
		library.updateNodeText(note.id, id, trimmed);
		if (then === 'child') addChild(id);
		else if (then === 'sibling' && !isRoot(id)) addSibling(id);
		else select(id);
	}

	function cancel(id: string) {
		editingId = null;
		if (freshId === id) {
			library.removeNode(note.id, id);
			freshId = null;
			select(null);
		} else {
			select(id);
		}
	}

	/**
	 * 足したばかりのノードが画面の外や端にあれば、中央へ寄せる（見えていればそのまま）。
	 * 足した直後は配置が何度か動く（大きさが決まって並び直す）ので、しばらくの間、何度か見直す。
	 * 判定は実際に描かれている位置（DOM の矩形）で行う。書き込む所が見えないまま画面を動かして、空のノードが消える無駄をなくす
	 */
	function revealNode(id: string) {
		const check = () => {
			if (!view) return;
			const el = view.querySelector<HTMLElement>(`.mindmap__canvas [data-id="${CSS.escape(id)}"]`);
			if (!el) return;
			const vr = view.getBoundingClientRect();
			const r = el.getBoundingClientRect();
			const m = 80; // これより端に近ければ「見えていない」とみなす
			const inside =
				r.left >= vr.left + m &&
				r.top >= vr.top + m &&
				r.right <= vr.right - m &&
				r.bottom <= vr.bottom - m;
			if (inside) return;
			// いま描かれているカメラ（camX/camY）に、ノードの中心と面の中心のずれを足した所を目標にする
			const dx = vr.left + vr.width / 2 - (r.left + r.width / 2);
			const dy = vr.top + vr.height / 2 - (r.top + r.height / 2);
			setCamera(camX + dx, camY + dy, cameraTarget().z);
		};
		for (const ms of [30, 250, 500, 900, 1400]) window.setTimeout(check, ms);
	}

	function addChild(parentId: string) {
		if (locked) return;
		const node = library.addChild(note.id, parentId);
		if (!node) return;
		freshId = node.id;
		startEdit(node.id);
		revealNode(node.id);
	}

	function addSibling(id: string, before = false) {
		if (locked) return;
		if (isRoot(id)) return addChild(id);
		const node = library.addSibling(note.id, id, '', before);
		if (!node) return;
		// 元のノードが手で動かした位置にあるなら、自動の位置だと重なるので、その真下に置く
		const ref = layout.placed.find((p) => p.id === id);
		if (ref && ref.node.pos) {
			const snap = (v: number) => Math.round(v / GRID) * GRID;
			if (vertical) {
				const x = before ? ref.x - DOWN_CROSS_GAP - 140 : ref.x + ref.w + DOWN_CROSS_GAP;
				library.setNodePos(note.id, node.id, { x: snap(x), y: snap(ref.y) });
			} else {
				const y = before ? ref.y - V_GAP - 44 : ref.y + ref.h + V_GAP;
				library.setNodePos(note.id, node.id, { x: snap(ref.x), y: snap(y) });
			}
		}
		freshId = node.id;
		startEdit(node.id);
		revealNode(node.id);
	}

	function remove(id: string) {
		if (isRoot(id) || locked) return;
		const hit = locate([root], id);
		if (!hit) return;
		const count = hit.node.children.length;
		if (
			count > 0 &&
			!window.confirm(
				`「${hit.node.text || '（空）'}」と、その下の ${count} 件を削除します。よろしいですか？`
			)
		) {
			return;
		}
		const next = hit.siblings[hit.index + 1] ?? hit.siblings[hit.index - 1] ?? hit.parent;
		library.removeNode(note.id, id);
		select(next ? next.id : root.id);
	}

	// ---- ドラッグ（ノードの移動）とパン（画面の移動） ----
	interface DragState {
		id: string | null; // null = パン
		startX: number;
		startY: number;
		originX: number;
		originY: number;
		moved: boolean;
	}
	let drag: DragState | null = null;

	// ---- 線の付け根をつかんで、別のノードへつなぎ直す（親を変える） ----
	/** つかんでいる線の子ノードの id と、いまのマウス位置（キャンバス座標） */
	let lineDrag = $state<{ id: string; x: number; y: number } | null>(null);
	/** 選んでいる子ノードの線の付け根（丸を出す位置）。中心・読むだけ・収録中は出さない */
	const lineGrip = $derived.by(() => {
		if (!selectedId || readonly || locked || mirror || draggingId) return null;
		const me = byId.get(selectedId);
		if (!me || !me.parentId) return null;
		const parent = byId.get(me.parentId);
		if (!parent) return null;
		const a = shown(parent.id);
		const b = shown(me.id);
		return connectorStart(
			{ x: a.x, y: a.y, w: parent.w, h: parent.h },
			{ x: b.x, y: b.y, w: me.w, h: me.h },
			direction,
			!!me.node.pos
		);
	});
	function toCanvas(e: PointerEvent): { x: number; y: number } {
		const r = view!.getBoundingClientRect();
		return {
			x: (e.clientX - r.left - view!.clientLeft - camX) / camZ,
			y: (e.clientY - r.top - view!.clientTop - camY) / camZ
		};
	}
	function onGripPointerDown(e: PointerEvent) {
		if (e.button !== 0 || !selectedId) return;
		e.stopPropagation();
		const p = toCanvas(e);
		lineDrag = { id: selectedId, x: p.x, y: p.y };
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	}
	function onGripPointerMove(e: PointerEvent) {
		if (!lineDrag) return;
		const p = toCanvas(e);
		lineDrag = { ...lineDrag, x: p.x, y: p.y };
		// 自分と自分の子孫以外で、マウスの下にあるノードがつなぎ先
		const mine = new Set<string>();
		const hit = locate([root], lineDrag.id);
		if (hit) {
			const walk = (n: MapNode) => {
				mine.add(n.id);
				n.children.forEach(walk);
			};
			walk(hit.node);
		}
		const over = layout.placed.find((q) => {
			if (mine.has(q.id)) return false;
			const s = shown(q.id);
			return p.x >= s.x && p.x <= s.x + q.w && p.y >= s.y && p.y <= s.y + q.h;
		});
		const next = over ? { kind: 'child' as const, id: over.id } : null;
		if (next?.id !== dropTarget?.id || next?.kind !== dropTarget?.kind) dropTarget = next;
	}
	function onGripPointerUp() {
		if (!lineDrag) return;
		const id = lineDrag.id;
		const target = dropTarget;
		lineDrag = null;
		dropTarget = null;
		if (!target) return;
		const parent = locate([root], target.id);
		if (!parent) return;
		// 位置は手で置いたまま。つなぎ先だけ変える（線は新しい親から出る）
		library.moveNodeTo(note.id, id, target.id, parent.node.children.length);
		select(id);
	}

	function onNodePointerDown(e: PointerEvent, id: string) {
		if (e.button !== 0 || readonly) return;
		if (editingId === id) return;
		e.stopPropagation();
		const pos = shown(id);
		drag = {
			id,
			startX: e.clientX,
			startY: e.clientY,
			originX: pos.x,
			originY: pos.y,
			moved: false
		};
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	}

	function onStagePointerDown(e: PointerEvent) {
		if (e.button !== 0) return;
		// 文字を書いている最中に画面を動かしても、入力欄からフォーカスが外れないようにする
		// （外れると空のノードが消えてしまう）。動かさずに押しただけなら pointerup で確定する
		if (editingId) e.preventDefault();
		const t = cameraTarget();
		drag = {
			id: null,
			startX: e.clientX,
			startY: e.clientY,
			originX: t.x,
			originY: t.y,
			moved: false
		};
		panning = true;
		view?.setPointerCapture(e.pointerId);
	}

	function onPointerMove(e: PointerEvent) {
		if (!drag) return;
		const dx = e.clientX - drag.startX;
		const dy = e.clientY - drag.startY;
		if (!drag.moved && Math.hypot(dx, dy) < 4) return;
		drag.moved = true;
		if (drag.id === null) {
			setCamera(drag.originX + dx, drag.originY + dy, cameraTarget().z, true);
			return;
		}
		if (isRoot(drag.id) || locked) return; // 中心は動かさない。収録中も動かさない
		draggingId = drag.id;
		// 点の格子に吸い付く（点は GRID の倍数の位置にある）
		const snap = (v: number) => Math.round(v / GRID) * GRID;
		const nx = snap(drag.originX + dx / camZ);
		const ny = snap(drag.originY + dy / camZ);
		library.setNodePos(note.id, drag.id, { x: nx, y: ny });
		dropTarget = findDropTarget(drag.id, nx, ny);
	}

	/**
	 * ドラッグ中のノードの中心が、どのノードのどこにあるかで落とし先を決める。
	 * 「兄弟が並ぶ向き」（横の動画なら上下、縦の動画なら左右）の前後の隙間なら before / after、
	 * ノードの真ん中なら child
	 */
	function findDropTarget(
		id: string,
		nx: number,
		ny: number
	): { kind: 'child' | 'before' | 'after'; id: string } | null {
		const me = byId.get(id);
		if (!me) return null;
		const cx = nx + me.w / 2;
		const cy = ny + me.h / 2;
		// 自分と自分の子孫は対象外
		const mine = new Set<string>();
		const hit = locate([root], id);
		if (hit) {
			const walk = (n: MapNode) => {
				mine.add(n.id);
				n.children.forEach(walk);
			};
			walk(hit.node);
		}
		const NEAR = 22; // 前後の「隙間」とみなす幅
		// cross = 兄弟が並ぶ向きの座標、main = 親→子の向きの座標
		const cross = vertical ? cx : cy;
		const main = vertical ? cy : cx;
		let best: { kind: 'child' | 'before' | 'after'; id: string; d: number } | null = null;
		for (const p of layout.placed) {
			if (mine.has(p.id)) continue;
			const mainStart = vertical ? p.y : p.x;
			const mainEnd = vertical ? p.y + p.h : p.x + p.w;
			const start = vertical ? p.x : p.y;
			const len = vertical ? p.w : p.h;
			const end = start + len;
			if (main < mainStart - 40 || main > mainEnd + 40) continue;
			let kind: 'child' | 'before' | 'after' | null = null;
			let d = 0;
			if (cross >= start + len * 0.25 && cross <= end - len * 0.25) {
				kind = 'child';
				d = Math.abs(cross - (start + end) / 2);
			} else if (!isRoot(p.id) && cross >= start - NEAR && cross < start + len * 0.25) {
				kind = 'before';
				d = Math.abs(cross - start);
			} else if (!isRoot(p.id) && cross > end - len * 0.25 && cross <= end + NEAR) {
				kind = 'after';
				d = Math.abs(cross - end);
			}
			if (kind && (!best || d < best.d)) best = { kind, id: p.id, d };
		}
		return best ? { kind: best.kind, id: best.id } : null;
	}

	/** 落とし先へ入れる。入れられなければ、ただ位置が動いたまま */
	function applyDrop(id: string, target: { kind: 'child' | 'before' | 'after'; id: string }) {
		if (target.kind === 'child') {
			const parent = locate([root], target.id);
			if (parent) library.moveNodeTo(note.id, id, target.id, parent.node.children.length);
			return;
		}
		const sib = locate([root], target.id);
		if (!sib || !sib.parent) return;
		library.moveNodeTo(note.id, id, sib.parent.id, sib.index + (target.kind === 'after' ? 1 : 0));
	}

	function onPointerUp(e: PointerEvent) {
		if (!drag) return;
		const d = drag;
		drag = null;
		panning = false;
		draggingId = null;
		const target = dropTarget;
		dropTarget = null;
		if (d.moved) {
			if (d.id && target) applyDrop(d.id, target);
			return;
		}
		// 動かしていなければクリック扱い。クリックは選ぶだけ（開閉は右端の丸いボタン）
		if (d.id === null) {
			const t = e.target as HTMLElement;
			if (t === view || t.classList.contains('mindmap__canvas')) {
				// 書いている最中に何もない所を押したら、そこで確定する（入力欄の blur が commit を呼ぶ）
				if (editingId) (document.activeElement as HTMLElement | null)?.blur();
				select(null);
			}
			return;
		}
		if (editingId && editingId !== d.id) editingId = null;
		select(d.id);
	}

	// ---- スペースで順に開く ----
	/** この操作で開いたノードの id（Shift+スペースで戻す用） */
	let openedByKey: string[] = [];
	/** 選んでいるノード（無ければ先頭）から見て、次の「閉じていて子のある」ノードを開いて選ぶ。無ければ先頭から探す */
	function openNext() {
		const list = visibleList([root]);
		if (list.length === 0) return;
		const from = selectedId ? list.findIndex((n) => n.id === selectedId) : -1;
		const pick = (start: number, end: number) =>
			list.slice(start, end).find((n) => n.collapsed && n.children.length > 0) ?? null;
		const next = pick(Math.max(0, from), list.length) ?? pick(0, Math.max(0, from));
		if (!next) {
			toast.show('全部開いています');
			return;
		}
		openedByKey.push(next.id);
		toggleCollapse(next.id);
		select(next.id);
	}
	function closeLastOpened() {
		while (openedByKey.length > 0) {
			const id = openedByKey.pop()!;
			const hit = locate([root], id);
			if (hit && !hit.node.collapsed) {
				toggleCollapse(id);
				select(id);
				return;
			}
		}
	}

	// ---- キーボード ----
	function onKeydown(e: KeyboardEvent) {
		if (editingId || e.isComposing) return;
		if (e.key === 'Escape') {
			if (openImage) {
				openImage = null;
				return;
			}
			select(null);
			return; // 全画面をやめる処理はワークスペース側で行う
		}
		if ((e.metaKey || e.ctrlKey) && (e.key === '=' || e.key === '+')) {
			e.preventDefault();
			zoomBy(1.2);
			return;
		}
		if ((e.metaKey || e.ctrlKey) && e.key === '-') {
			e.preventDefault();
			zoomBy(1 / 1.2);
			return;
		}
		if ((e.metaKey || e.ctrlKey) && e.key === '0') {
			e.preventDefault();
			fit();
			return;
		}
		// スペース: 次の閉じているノードを順に開く（話しながらマウスで狙わなくて済む）。
		// Shift+スペース: 直前にこの操作で開いたものを閉じる
		if (e.key === ' ' && !e.metaKey && !e.ctrlKey && !e.altKey) {
			e.preventDefault();
			if (e.shiftKey) closeLastOpened();
			else openNext();
			return;
		}
		const id = selectedId;
		if (!id) return;
		const order = visibleList([root]).map((n) => n.id);
		const idx = order.indexOf(id);
		if (locked) {
			// 収録中: 選ぶ・開閉・チェックだけ（Enter でチェックの 未 ↔ 済）
			switch (e.key) {
				case 'Enter':
					e.preventDefault();
					library.toggleChecked(note.id, id);
					break;
				case 'ArrowDown':
					e.preventDefault();
					if (idx < order.length - 1) select(order[idx + 1]);
					break;
				case 'ArrowUp':
					e.preventDefault();
					if (idx > 0) select(order[idx - 1]);
					break;
				case 'ArrowRight': {
					e.preventDefault();
					const hit = locate([root], id);
					if (hit && hit.node.children.length) {
						if (hit.node.collapsed) toggleCollapse(id);
						select(hit.node.children[0].id);
					}
					break;
				}
				case 'ArrowLeft': {
					e.preventDefault();
					const hit = locate([root], id);
					if (hit?.parent) select(hit.parent.id);
					break;
				}
			}
			return;
		}
		if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
			e.preventDefault();
			if (locate([root], id)?.node.checked === null) library.setHasCheck(note.id, id, true);
			else library.toggleChecked(note.id, id);
			return;
		}
		switch (e.key) {
			case 'Tab':
				e.preventDefault();
				if (e.shiftKey) library.outdentNode(note.id, id);
				else addChild(id);
				break;
			case 'Enter':
				e.preventDefault();
				addSibling(id, e.shiftKey); // Shift+Enter は上に足す
				break;
			case 'F2':
				e.preventDefault();
				startEdit(id);
				break;
			case 'Enter':
				// ⌘Enter: チェックボタンがあれば 未 ↔ 済。無ければ付ける（外すのは操作の並びのチェック印）
				// （普通の Enter は上の case で「下に足す」。ここには来ない）
				e.preventDefault();
				if (locate([root], id)?.node.checked === null) library.setHasCheck(note.id, id, true);
				else library.toggleChecked(note.id, id);
				break;
			case 'Backspace':
			case 'Delete':
				e.preventDefault();
				remove(id);
				break;
			case 'ArrowDown':
				e.preventDefault();
				if (e.altKey) library.moveNode(note.id, id, 1);
				else if (idx < order.length - 1) select(order[idx + 1]);
				break;
			case 'ArrowUp':
				e.preventDefault();
				if (e.altKey) library.moveNode(note.id, id, -1);
				else if (idx > 0) select(order[idx - 1]);
				break;
			case 'ArrowRight': {
				e.preventDefault();
				const hit = locate([root], id);
				if (hit && hit.node.children.length) {
					if (hit.node.collapsed) toggleCollapse(id);
					select(hit.node.children[0].id);
				}
				break;
			}
			case 'ArrowLeft': {
				e.preventDefault();
				const hit = locate([root], id);
				if (hit?.parent) select(hit.parent.id);
				break;
			}
			default:
				// 文字キーを押したら、そのまま書き始める
				if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) startEdit(id);
		}
	}
</script>

<div
	class="mindmap"
	class:mindmap--framed={framed}
	class:mindmap--stage={stageMode}
	class:mindmap--readonly={readonly}
	class:mindmap--portrait={outline || vertical}
	class:mindmap--mirror={mirror}
>
	{#if !framed}
		<div class="mindmap__bar">
			<span class="muted"
				>右端の丸いボタンで開閉、ダブルクリックで文字を直せます。ドラッグで移動、ホイールで拡大縮小。</span
			>
			<div class="mindmap__tools" role="group" aria-label="表示">
				<button type="button" class="chip" onclick={() => zoomBy(1 / 1.2)} aria-label="縮小"
					>−</button
				>
				<button type="button" class="chip" onclick={() => fit()} title="全体を表示（⌘0）"
					>{Math.round(camZ * 100)}%</button
				>
				<button type="button" class="chip" onclick={() => zoomBy(1.2)} aria-label="拡大">＋</button>
			</div>
		</div>
	{/if}

	<!-- 収録の見た目: 黄色の枠。上にタイトル、中にクリーム色のマップの面。この要素の範囲が動画になる -->
	<div class="mindmap__frame" bind:this={frameEl}>
		{#if framed}
			<div class="mindmap__head">
				{#if readonly || presenting}
					<h2 class="mindmap__title">{note.title.trim() || '無題のノート'}</h2>
				{:else}
					<!-- 長い題名は折り返す（動画と同じ見え方で書けるように textarea。改行は入れない） -->
					<textarea
						class="mindmap__title mindmap__title--input"
						rows="1"
						value={note.title}
						placeholder="タイトル（動画の上に出ます）"
						maxlength="120"
						oninput={(e) => {
							const el = e.currentTarget;
							const v = el.value.replace(/\r?\n/g, ' ');
							if (v !== el.value) el.value = v;
							library.updateTitle(note.id, v);
							growTitle(el);
						}}
						onkeydown={(e) => {
							if (e.key === 'Enter' && !e.isComposing) {
								e.preventDefault();
								e.currentTarget.blur();
							}
						}}
						use:autoGrow></textarea>
				{/if}
			</div>
		{/if}

		<div
			bind:this={view}
			class="mindmap__view"
			class:mindmap__view--panning={panning}
			role="tree"
			aria-label="マインドマップ"
			tabindex={readonly ? -1 : 0}
			style="background-position: {camX - (GRID / 2) * camZ}px {camY -
				(GRID / 2) * camZ}px; background-size: {GRID * camZ}px {GRID * camZ}px"
			onkeydown={readonly ? undefined : onKeydown}
			onwheel={readonly ? undefined : onWheel}
			onpointerdown={readonly ? undefined : onStagePointerDown}
			onpointermove={readonly ? undefined : onPointerMove}
			onpointerup={readonly ? undefined : onPointerUp}
			onpointercancel={readonly ? undefined : onPointerUp}
		>
			{#if unmeasured.length > 0}
				<!-- 測るためだけの見えない層（測り終えたノードは消える） -->
				<div class="mindmap__measure" aria-hidden="true">
					{#each unmeasured as n (n.id)}
						<MindNode
							node={n}
							x={0}
							y={0}
							selected={false}
							editing={false}
							readonly
							{vertical}
							imageSize={n.image ? (imageSizes[n.image] ?? null) : null}
							{onSize}
							onPointerDown={noop}
							onDoubleClick={noop}
							onCommit={noop}
							onCancel={noop}
							onToggleCollapse={noop}
							onAddChild={noop}
							onAddSibling={noop}
							onAddSiblingAbove={noop}
							onMoveUp={noop}
							onMoveDown={noop}
							onOutdent={noop}
							onIndent={noop}
							onToggleChecked={noop}
							onToggleCheckbox={noop}
							onRemove={noop}
							onResetPos={noop}
							onAttachImage={noop}
							onDetachImage={noop}
						/>
					{/each}
				</div>
			{/if}
			<div class="mindmap__canvas" style="transform: translate({camX}px, {camY}px) scale({camZ})">
				<svg class="mindmap__lines" aria-hidden="true">
					{#each layout.placed as p (p.id)}
						{#if p.parentId && lineDrag?.id !== p.id}
							{@const parent = byId.get(p.parentId)}
							{#if parent}
								{@const a = shown(parent.id)}
								{@const b = shown(p.id)}
								<path
									d={connectorPath(
										{ x: a.x, y: a.y, w: parent.w, h: parent.h },
										{ x: b.x, y: b.y, w: p.w, h: p.h },
										direction,
										!!p.node.pos
									)}
								/>
							{/if}
						{/if}
					{/each}
					{#if lineDrag}
						{@const me = byId.get(lineDrag.id)}
						{#if me}
							{@const s = shown(me.id)}
							<path
								class="mindmap__linedrag"
								d="M {lineDrag.x} {lineDrag.y} L {s.x + me.w / 2} {s.y + me.h / 2}"
							/>
						{/if}
					{/if}
				</svg>
				{#if lineGrip}
					<!-- 線の付け根の丸。つかんで別のノードへ落とすと、そのノードの子になる -->
					<button
						type="button"
						class="mindmap__grip"
						class:mindmap__grip--active={!!lineDrag}
						style="transform: translate({lineGrip.x - 10}px, {lineGrip.y - 10}px)"
						title="線をつかんで別のノードへ落とすと、そこにつなぎ直せます"
						aria-label="線をつかんでつなぎ直す"
						onpointerdown={onGripPointerDown}
						onpointermove={onGripPointerMove}
						onpointerup={onGripPointerUp}
						onpointercancel={onGripPointerUp}
						ondblclick={(e) => e.stopPropagation()}
					></button>
				{/if}

				{#if dropTarget && (dropTarget.kind === 'before' || dropTarget.kind === 'after')}
					{@const t = byId.get(dropTarget.id)}
					{#if t}
						<!-- 兄弟として入る位置の目印 -->
						<div
							class="mindmap__drop-line"
							class:mindmap__drop-line--v={vertical}
							style={vertical
								? `transform: translate(${dropTarget.kind === 'before' ? t.x - DOWN_CROSS_GAP / 2 - 2 : t.x + t.w + DOWN_CROSS_GAP / 2 - 2}px, ${t.y}px); height: ${t.h}px`
								: `transform: translate(${t.x}px, ${dropTarget.kind === 'before' ? t.y - V_GAP / 2 - 2 : t.y + t.h + V_GAP / 2 - 2}px); width: ${t.w}px`}
						></div>
					{/if}
				{/if}
				{#each layout.placed as p (p.id)}
					{@const pos = shown(p.id)}
					<MindNode
						node={p.node}
						dropHint={dropTarget?.kind === 'child' && dropTarget.id === p.id}
						isRoot={isRoot(p.id)}
						x={pos.x}
						y={pos.y}
						selected={selectedId === p.id}
						editing={editingId === p.id}
						imageSize={p.node.image ? (imageSizes[p.node.image] ?? null) : null}
						dragging={draggingId === p.id}
						{readonly}
						{presenting}
						{vertical}
						{onSize}
						onPointerDown={(e) => onNodePointerDown(e, p.id)}
						onDoubleClick={() => startEdit(p.id)}
						onCommit={(text, then) => commit(p.id, text, then)}
						onCancel={() => cancel(p.id)}
						onToggleCollapse={() => toggleCollapse(p.id)}
						onAddChild={() => addChild(p.id)}
						onImageClick={readonly || mirror ? undefined : () => (openImage = p.id)}
						onDropImage={readonly || mirror || locked
							? undefined
							: (file) => void dropImage(p.id, file)}
						onAddSibling={() => addSibling(p.id)}
						onAddSiblingAbove={() => addSibling(p.id, true)}
						onMoveUp={() => library.moveNode(note.id, p.id, -1)}
						onMoveDown={() => library.moveNode(note.id, p.id, 1)}
						canMoveUp={siblingIndex(p.id) > 0}
						canMoveDown={siblingIndex(p.id) < siblingCount(p.id) - 1}
						onOutdent={() => library.outdentNode(note.id, p.id)}
						onIndent={() => library.indentNode(note.id, p.id)}
						canOutdent={depthOf(p.id) >= 2}
						canIndent={siblingIndex(p.id) > 0}
						onToggleChecked={() => library.toggleChecked(note.id, p.id)}
						onToggleCheckbox={() => library.setHasCheck(note.id, p.id, p.node.checked === null)}
						onRemove={() => remove(p.id)}
						onResetPos={() => library.setNodePos(note.id, p.id, null)}
						onAttachImage={() => void attachImage(p.id)}
						onDetachImage={() => detachImage(p.id)}
					/>
				{/each}
			</div>

			{#if root.children.length === 0 && !readonly && !presenting}
				<p class="mindmap__hint">
					中心のノードを選んで ＋ を押すか Tab を押すと、最初のノードを足せます
				</p>
			{/if}
			{#if openImageSrc}
				<!-- 画像の拡大表示。もう一度押すか Esc で戻る。プレゼン用の窓では向こうの操作に従う -->
				<div
					class="mindmap__lightbox"
					role="button"
					tabindex="-1"
					aria-label="画像を閉じる"
					onpointerdown={(e) => e.stopPropagation()}
					onclick={(e) => {
						e.stopPropagation();
						if (!mirror) openImage = null;
					}}
					onwheel={(e) => e.stopPropagation()}
					onkeydown={(e) => {
						if (!mirror && (e.key === 'Escape' || e.key === 'Enter')) openImage = null;
					}}
				>
					<img src={openImageSrc} alt="" draggable="false" />
				</div>
			{/if}
		</div>
	</div>
</div>

<style>
	.mindmap {
		display: grid;
		grid-template-rows: auto 1fr;
		gap: 10px;
		min-height: 0;
		height: 100%;
	}
	.mindmap--framed {
		grid-template-rows: 1fr;
		gap: 0;
	}
	.mindmap__bar {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
	}
	.mindmap__tools {
		display: flex;
		gap: 4px;
	}
	.mindmap__frame {
		min-height: 0;
		height: 100%;
		display: grid;
		grid-template-rows: 1fr;
	}
	/* 収録の見た目: 黄色の枠 */
	.mindmap--framed .mindmap__frame {
		grid-template-rows: auto 1fr;
		gap: 10px;
		color: var(--ink);
		background: var(--yellow);
		border: 3px solid var(--ink);
		border-radius: 20px;
		padding: 14px 18px 18px;
	}
	/* ワークスペース（収録の切り出し範囲）は、線も丸角も無しの四角。動画の縁に外の色が映らないように */
	.mindmap--stage .mindmap__frame {
		border: 0;
		border-radius: 0;
		padding: 14px 20px 20px;
		gap: 8px;
		container-type: inline-size; /* 題名の大きさを枠の幅から決める（cqw） */
	}
	/* 動画の題名は枠の幅に対する割合で決める。横: 3.3%（1920px の動画で約 63px）、縦: 5%（1080px で約 54px）。
	   枠は画面上の大きさに関係なく動画で拡大されるので、割合で決めないと縦で巨大になる */
	.mindmap--stage .mindmap__title {
		font-size: clamp(16px, 3.3cqw, 48px);
		letter-spacing: 0.06em;
		line-height: 1.3;
	}
	/* 縦（ショート）の収録の枠: iPhone の Shorts で上のカメラまわり・下のボタンや説明に重ならないよう、上下に黄色の余白を広く取る。
	   % は枠の幅に対する値（幅 1080 なら 上 17% ≒ 184px = 高さの 9.6%、下 6% ≒ 65px = 高さの 3.4%。下はそれほど隠れないとのことで小さめ） */
	.mindmap--stage.mindmap--portrait .mindmap__frame {
		padding: 17% 14px 6%;
	}
	/* 縦は大きく（1080px の動画で約 76px）。長ければ 2 行に折り返す */
	.mindmap--stage.mindmap--portrait .mindmap__title {
		font-size: clamp(12px, 7cqw, 56px);
		white-space: normal;
		line-height: 1.3;
		letter-spacing: 0.04em;
	}
	/* 縦は幅が狭いので、切らずに何行でも折り返す（3〜4 行になってもよい） */
	.mindmap--stage.mindmap--portrait h2.mindmap__title {
		display: block;
		overflow: visible;
	}
	.mindmap--stage.mindmap--portrait .mindmap__title--input {
		max-height: none;
	}
	/* 横も長ければ 2 行まで */
	.mindmap--stage .mindmap__title {
		white-space: normal;
	}
	.mindmap--stage h2.mindmap__title {
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.mindmap__head {
		display: flex;
		justify-content: center;
		min-width: 0; /* 題名が長くても枠を広げない（切り詰める） */
	}
	.mindmap--readonly .mindmap__frame,
	.mindmap--readonly .mindmap__head {
		min-width: 0;
		overflow: hidden;
	}
	.mindmap__title {
		width: 100%;
		text-align: center;
		font-size: 22px;
		font-weight: 900;
		letter-spacing: 0.04em;
		line-height: 1.4;
		margin: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	/* 一覧側の小さなプレビューでは題名も小さく */
	.mindmap--readonly .mindmap__title {
		font-size: 15px;
	}
	.mindmap--readonly .mindmap__frame {
		padding: 10px 12px 12px;
		gap: 6px;
		border-radius: 14px;
	}
	.mindmap__title--input {
		border: 0;
		background: transparent;
		padding: 2px 8px;
		border-radius: 12px;
		/* font の一括指定は太さまで戻してしまう（収録中の h2 と同じ太さにする） */
		font-family: inherit;
		font-weight: 900;
		letter-spacing: inherit;
		line-height: inherit;
		color: inherit;
		text-align: center;
		resize: none;
		overflow: hidden;
		display: block;
		width: 100%;
		max-height: 2.7em; /* 2 行まで */
	}
	.mindmap__title--input::placeholder {
		color: var(--brown);
		opacity: 0.55;
	}
	/* マウスを乗せても、書いている間も見た目は変えない（収録中もそのまま） */
	.mindmap__title--input:focus {
		outline: none;
	}
	/* 画像の拡大表示: 面いっぱいに暗い幕を掛け、画像を中央に大きく出す */
	.mindmap__lightbox {
		position: absolute;
		inset: 0;
		z-index: 6;
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgba(28, 24, 18, 0.86);
		cursor: zoom-out;
	}
	.mindmap__lightbox img {
		max-width: 94%;
		max-height: 94%;
		object-fit: contain;
		border: 3px solid var(--cream);
		border-radius: 12px;
		box-shadow: 6px 6px 0 rgba(0, 0, 0, 0.35);
	}
	.mindmap__view {
		position: relative;
		overflow: hidden;
		min-height: 0;
		height: 100%;
		background-color: var(--cream);
		border: var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow-lg);
		background-image: radial-gradient(rgba(28, 24, 18, 0.12) 1.3px, transparent 1.3px);
		cursor: grab;
		touch-action: none;
	}
	.mindmap--framed .mindmap__view {
		box-shadow: none;
		border-radius: 14px;
	}
	.mindmap__view--panning {
		cursor: grabbing;
	}
	.mindmap__view:focus-visible {
		outline: 3px solid var(--gold);
		outline-offset: -3px;
	}
	.mindmap--readonly .mindmap__view {
		cursor: pointer;
		pointer-events: none; /* 外側のボタンがクリックを受ける */
	}
	.mindmap__drop-line--v {
		width: 4px !important;
		height: auto;
	}
	.mindmap__drop-line {
		position: absolute;
		left: 0;
		top: 0;
		height: 4px;
		border-radius: 2px;
		background: var(--ink);
		box-shadow: 0 0 0 3px var(--yellow);
		pointer-events: none;
		z-index: 6;
	}
	/* プレゼン用の窓: 見るだけ */
	.mindmap--mirror .mindmap__view {
		pointer-events: none;
	}
	.mindmap__measure {
		position: absolute;
		left: -20000px;
		top: 0;
		width: 0;
		height: 0;
		visibility: hidden;
		pointer-events: none;
	}
	.mindmap__canvas {
		position: absolute;
		left: 0;
		top: 0;
		width: 0;
		height: 0;
		transform-origin: 0 0;
		will-change: transform;
	}
	.mindmap__lines {
		position: absolute;
		left: 0;
		top: 0;
		width: 1px;
		height: 1px;
		overflow: visible;
		pointer-events: none;
	}
	.mindmap__lines path {
		fill: none;
		stroke: var(--ink);
		stroke-width: 2.5;
		stroke-linecap: round;
	}
	.mindmap__lines .mindmap__linedrag {
		stroke-dasharray: 8 6;
		stroke-width: 3;
	}
	/* 線の付け根の丸（選んだ子ノードの線の親側）。つかんで別のノードへ */
	.mindmap__grip {
		position: absolute;
		left: 0;
		top: 0;
		width: 20px;
		height: 20px;
		padding: 0;
		border: 2.5px solid var(--ink);
		border-radius: 50%;
		background: var(--yellow);
		box-shadow: 2px 2px 0 var(--ink);
		cursor: grab;
		z-index: 3;
		touch-action: none;
	}
	.mindmap__grip:hover {
		background: var(--gold);
	}
	.mindmap__grip--active {
		cursor: grabbing;
		background: var(--ink);
	}
	.mindmap__hint {
		position: absolute;
		left: 50%;
		bottom: 18px;
		transform: translateX(-50%);
		color: var(--brown);
		font-size: 13px;
		font-weight: 700;
		white-space: nowrap;
		pointer-events: none;
	}
</style>
