import type { MapNode } from '$shared/types';

/**
 * マインドマップの配置計算。
 *
 * - 横の動画（right）: 根を左端に置き、子は右へ、兄弟は縦に並べる
 * - 縦の動画（down）: 根を上端に置き、子は下へ、兄弟は横に並べる（内部は向きを読み替えて同じ計算）
 * - 子の並びは親の中央に置く。ただし「いま操作したノード（anchor）とその先祖」は
 *   前回の位置から動かさない。開閉で場所を空けるのは兄弟の側
 * - 手で動かしたノード（pos あり）はその位置に置き、子孫もいっしょに動く
 * - 線は親の右端の中央から出て、子の左端の中央に入る
 */

export interface Size {
	w: number;
	h: number;
}

export interface Placed {
	id: string;
	node: MapNode;
	x: number;
	y: number;
	w: number;
	h: number;
	parentId: string | null;
	depth: number;
}

export interface Bounds {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

export interface Layout {
	placed: Placed[];
	bounds: Bounds;
}

/**
 * right = 子が右へ、兄弟は縦（横の動画）。down = 子が下へ、兄弟は横。
 * outline = 箇条書き型: 子は親の下に少し右へずらして縦に並ぶ（縦の動画。幅を使わず縦に伸びる）
 */
export type Direction = 'right' | 'down' | 'outline';

export interface LayoutOptions {
	/** 動かさないノードの id（操作したノードと、その先祖すべて） */
	anchorPath?: ReadonlySet<string>;
	/** 前回の配置での、各ノードの「兄弟が並ぶ向き」の中心（右に広がる木なら y、下に広がる木なら x） */
	prevCenters?: ReadonlyMap<string, number>;
	/** 木の向き。right = 子が右へ（横の動画）、down = 子が下へ（縦の動画） */
	direction?: Direction;
}

export const H_GAP = 88; // 親の右端から子の左端まで（右に広がる木）
export const V_GAP = 20; // 兄弟の間（右に広がる木）
export const DOWN_MAIN_GAP = 64; // 親の下端から子の上端まで（下に広がる木）
export const DOWN_CROSS_GAP = 28; // 兄弟の間（下に広がる木）
export const OUTLINE_INDENT = 56; // 箇条書き型の字下げ（親の左端から子の左端まで）
export const OUTLINE_GAP = 18; // 箇条書き型の行の間
const DEFAULT_SIZE: Size = { w: 140, h: 44 };

/** ノードの中心を 0 としたときの、部分木の（兄弟が並ぶ向きの）前端と後端 */
interface Extent {
	top: number;
	bottom: number;
}

/**
 * 配置計算。内部では「親→子の向き（main）」と「兄弟が並ぶ向き（cross）」で計算し、
 * 最後に向きに応じて x / y に戻す。right なら main = x、cross = y。down なら main = y、cross = x
 */
export function layoutMap(
	root: MapNode,
	sizes: Record<string, Size>,
	opts: LayoutOptions = {}
): Layout {
	const dir: Direction = opts.direction ?? 'right';
	if (dir === 'outline') return layoutOutline(root, sizes);
	const mainGap = dir === 'right' ? H_GAP : DOWN_MAIN_GAP;
	const crossGap = dir === 'right' ? V_GAP : DOWN_CROSS_GAP;
	// 向きに合わせて大きさと位置を読み替える
	const along = (id: string) => {
		const sz = sizes[id] ?? DEFAULT_SIZE;
		return dir === 'right' ? sz.w : sz.h;
	};
	const across = (id: string) => {
		const sz = sizes[id] ?? DEFAULT_SIZE;
		return dir === 'right' ? sz.h : sz.w;
	};
	const posOf = (n: MapNode): { main: number; cross: number } | null =>
		n.pos
			? dir === 'right'
				? { main: n.pos.x, cross: n.pos.y }
				: { main: n.pos.y, cross: n.pos.x }
			: null;
	const anchorPath = opts.anchorPath ?? new Set<string>();
	const prev = opts.prevCenters ?? new Map<string, number>();

	// 1 段目: 部分木の広がりと、子の相対位置（親の中心から見た cross）を下から決める
	const extents = new Map<string, Extent>();
	const childOffsets = new Map<string, number>(); // 子 id → 親の中心からの cross

	const measure = (id: string, own: number, kids: MapNode[]): Extent => {
		const ownExt: Extent = { top: -own / 2, bottom: own / 2 };
		if (kids.length === 0) {
			extents.set(id, ownExt);
			return ownExt;
		}
		const kidExts = kids.map((k) => measure(k.id, across(k.id), k.collapsed ? [] : k.children));
		// 兄弟を前から詰める（ブロック先頭を 0 とした各子の中心）
		const rel: number[] = [];
		let cursor = 0;
		kidExts.forEach((e) => {
			const c = cursor - e.top;
			rel.push(c);
			cursor = c + e.bottom + crossGap;
		});
		const blockH = cursor - crossGap;
		// ブロックの置き方: 動かさない子がいれば、その子の前回の相対位置に合わせる。なければ中央
		let origin = -blockH / 2;
		const ai = kids.findIndex((k) => anchorPath.has(k.id));
		if (ai >= 0) {
			const pk = prev.get(kids[ai].id);
			const pp = prev.get(id);
			if (pk !== undefined && pp !== undefined) origin = pk - pp - rel[ai];
		}
		let top = ownExt.top;
		let bottom = ownExt.bottom;
		kids.forEach((k, i) => {
			const off = origin + rel[i];
			childOffsets.set(k.id, off);
			top = Math.min(top, off + kidExts[i].top);
			bottom = Math.max(bottom, off + kidExts[i].bottom);
		});
		const ext = { top, bottom };
		extents.set(id, ext);
		return ext;
	};
	measure(root.id, across(root.id), root.collapsed ? [] : root.children);

	// 2 段目: 前から実際の座標を決める。pos があればそこへ置き、子孫も同じだけずらす（根は動かさない）
	const placed: Placed[] = [];
	const place = (
		n: MapNode,
		parentId: string | null,
		depth: number,
		main: number,
		cc: number,
		shift: { dm: number; dc: number }
	) => {
		const a = along(n.id);
		const b = across(n.id);
		const autoM = main + shift.dm;
		const autoC = cc - b / 2 + shift.dc;
		const manual = parentId !== null ? posOf(n) : null;
		const own = manual ? { dm: manual.main - autoM, dc: manual.cross - autoC } : { dm: 0, dc: 0 };
		const m = autoM + own.dm;
		const c = autoC + own.dc;
		const sz = sizes[n.id] ?? DEFAULT_SIZE;
		placed.push({
			id: n.id,
			node: n,
			x: dir === 'right' ? m : c,
			y: dir === 'right' ? c : m,
			w: sz.w,
			h: sz.h,
			parentId,
			depth
		});
		const kids = n.collapsed ? [] : n.children;
		const childShift = { dm: shift.dm + own.dm, dc: shift.dc + own.dc };
		for (const k of kids) {
			place(k, n.id, depth + 1, main + a + mainGap, cc + (childOffsets.get(k.id) ?? 0), childShift);
		}
	};
	const rootCenter = prev.get(root.id) ?? 0;
	place(root, null, 0, 0, rootCenter, { dm: 0, dc: 0 });

	const bounds: Bounds = {
		minX: Math.min(...placed.map((p) => p.x)),
		minY: Math.min(...placed.map((p) => p.y)),
		maxX: Math.max(...placed.map((p) => p.x + p.w)),
		maxY: Math.max(...placed.map((p) => p.y + p.h))
	};
	return { placed, bounds };
}

/**
 * 箇条書き型の配置。根を左上に置き、子は親のすぐ下に字下げして縦に並べる。
 * 開いたノードの下に子が入り、後ろの行はその分だけ下がる（開いたノード自身は動かない）。
 * 手で動かしたノード（pos）はその位置に置き、子孫もいっしょに動く
 */
function layoutOutline(root: MapNode, sizes: Record<string, Size>): Layout {
	const placed: Placed[] = [];
	const size = (id: string) => sizes[id] ?? DEFAULT_SIZE;
	// 戻り値: この部分木が使った高さ（自分の行から、最後の子孫の下端まで）
	const place = (
		n: MapNode,
		parentId: string | null,
		depth: number,
		x: number,
		y: number,
		shift: { dx: number; dy: number }
	): number => {
		const { w, h } = size(n.id);
		const autoX = x + shift.dx;
		const autoY = y + shift.dy;
		const own =
			n.pos && parentId !== null ? { dx: n.pos.x - autoX, dy: n.pos.y - autoY } : { dx: 0, dy: 0 };
		placed.push({ id: n.id, node: n, x: autoX + own.dx, y: autoY + own.dy, w, h, parentId, depth });
		const kids = n.collapsed ? [] : n.children;
		const childShift = { dx: shift.dx + own.dx, dy: shift.dy + own.dy };
		let cursor = y + h + OUTLINE_GAP;
		for (const k of kids) {
			const used = place(k, n.id, depth + 1, x + OUTLINE_INDENT, cursor, childShift);
			cursor += used + OUTLINE_GAP;
		}
		return kids.length ? cursor - OUTLINE_GAP - y : h;
	};
	place(root, null, 0, 0, 0, { dx: 0, dy: 0 });
	const bounds: Bounds = {
		minX: Math.min(...placed.map((p) => p.x)),
		minY: Math.min(...placed.map((p) => p.y)),
		maxX: Math.max(...placed.map((p) => p.x + p.w)),
		maxY: Math.max(...placed.map((p) => p.y + p.h))
	};
	return { placed, bounds };
}

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

/**
 * 親と子をつなぐ曲線。
 * right: 親の右端の中央 → 子の左端の中央。down: 親の下端の中央 → 子の上端の中央
 */
/**
 * 手で置いた子のための、親のどの辺から線を出すか。
 * 子が親の左に離れていれば左、上に離れていれば上、下に離れていれば下。それ以外は普段どおり
 */
export function anchorSide(parent: Rect, child: Rect): 'left' | 'top' | 'bottom' | null {
	const gap = 8;
	if (child.x + child.w < parent.x - gap) return 'left';
	if (child.x > parent.x + parent.w + gap) return null; // 右側（普段どおり）
	if (child.y + child.h < parent.y - gap) return 'top';
	if (child.y > parent.y + parent.h + gap) return 'bottom';
	return null;
}

/** 連結線の付け根（親側の端）の座標。線をつかむ丸をここに出す */
export function connectorStart(
	parent: Rect,
	child: Rect,
	direction: Direction = 'right',
	manual = false
): { x: number; y: number } {
	const side = manual && direction !== 'outline' ? anchorSide(parent, child) : null;
	if (side === 'left') return { x: parent.x, y: parent.y + parent.h / 2 };
	if (side === 'top') return { x: parent.x + parent.w / 2, y: parent.y };
	if (side === 'bottom' || direction === 'down')
		return { x: parent.x + parent.w / 2, y: parent.y + parent.h };
	if (direction === 'outline')
		return { x: parent.x + Math.min(28, parent.w / 2), y: parent.y + parent.h };
	return { x: parent.x + parent.w, y: parent.y + parent.h / 2 };
}

export function connectorPath(
	parent: Rect,
	child: Rect,
	direction: Direction = 'right',
	manual = false
): string {
	// 手で置いた子は、置いた側から線を出す（右に伸びる線が子を横切らないように）
	const side = manual && direction !== 'outline' ? anchorSide(parent, child) : null;
	if (side === 'left') {
		const x1 = parent.x;
		const y1 = parent.y + parent.h / 2;
		const x2 = child.x + child.w;
		const y2 = child.y + child.h / 2;
		const mid = x1 + (x2 - x1) / 2;
		return `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
	}
	if (side === 'top') {
		const x1 = parent.x + parent.w / 2;
		const y1 = parent.y;
		const x2 = child.x + child.w / 2;
		const y2 = child.y + child.h;
		const mid = y1 + (y2 - y1) / 2;
		return `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`;
	}
	if (side === 'bottom' && direction !== 'down') {
		const x1 = parent.x + parent.w / 2;
		const y1 = parent.y + parent.h;
		const x2 = child.x + child.w / 2;
		const y2 = child.y;
		const mid = y1 + (y2 - y1) / 2;
		return `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`;
	}
	if (direction === 'outline') {
		// 親の左端近くから下へ降り、子の左端の中央へ曲がって入る（箇条書きの罫線）
		const x1 = parent.x + Math.min(28, parent.w / 2);
		const y1 = parent.y + parent.h;
		const x2 = child.x;
		const y2 = child.y + child.h / 2;
		const r = Math.min(16, Math.max(0, x2 - x1), Math.max(0, y2 - y1));
		return `M ${x1} ${y1} V ${y2 - r} Q ${x1} ${y2} ${x1 + r} ${y2} H ${x2}`;
	}
	if (direction === 'down') {
		const x1 = parent.x + parent.w / 2;
		const y1 = parent.y + parent.h;
		const x2 = child.x + child.w / 2;
		const y2 = child.y;
		const mid = y1 + (y2 - y1) / 2;
		return `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`;
	}
	const x1 = parent.x + parent.w;
	const y1 = parent.y + parent.h / 2;
	const x2 = child.x;
	const y2 = child.y + child.h / 2;
	const mid = x1 + (x2 - x1) / 2;
	return `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
}

export interface Camera {
	x: number;
	y: number;
	zoom: number;
}

/** 全体が収まるカメラ（余白つき）。倍率は上限 maxZoom（既定 1.4） */
export function fitCamera(
	bounds: Bounds,
	viewW: number,
	viewH: number,
	pad = 48,
	maxZoom = 1.4
): Camera {
	const bw = Math.max(1, bounds.maxX - bounds.minX);
	const bh = Math.max(1, bounds.maxY - bounds.minY);
	const zoom = Math.max(0.15, Math.min(maxZoom, (viewW - pad * 2) / bw, (viewH - pad * 2) / bh));
	return {
		zoom,
		x: (viewW - bw * zoom) / 2 - bounds.minX * zoom,
		y: (viewH - bh * zoom) / 2 - bounds.minY * zoom
	};
}
