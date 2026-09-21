/**
 * ノートの中身（マインドマップのノードの木）と、その操作。
 * 画面と Electron の両方から使うので、ブラウザー専用・Node 専用の機能は使わない。
 *
 * Markdown との相互変換（AI に書いてもらう前提の決まり）:
 *
 *   # タイトル              最初の見出し 1 がノートのタイトル（動画の上に出る）
 *   中心の文字               箇条書きより前の本文行が、中心ノードの文字（省略時はタイトルと同じ）
 *   > 注釈                   直前のノードの注釈（複数行可）。画面には出さない（昔のノートのために読み書きだけ残す）
 *   - ノード                 箇条書きがノード。字下げ（2 スペース / 4 スペース / タブ）で子になる
 *   - [ ] ノード / - [x] ノード   チェック（未 / 済）
 *   ## 見出し / ### 小見出し   見出しもノードになる（## が中心の直下、### はその子）
 *
 * 書き出すときは常に「# タイトル」、中心の文字（タイトルと違うときだけ）、
 * 字下げした箇条書き、注釈は「>」で出す。
 */
import type { MapNode, Note, ThumbnailState } from './types';

export function makeId(): string {
	if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function newNode(text = '', patch: Partial<MapNode> = {}): MapNode {
	return {
		id: makeId(),
		text,
		annotation: '',
		image: null,
		checked: null,
		collapsed: false,
		pos: null,
		children: [],
		...patch
	};
}

export interface Located {
	node: MapNode;
	siblings: MapNode[];
	index: number;
	parent: MapNode | null;
}

/** id のノードと、その兄弟配列・位置・親を返す */
export function locate(
	nodes: MapNode[],
	id: string,
	parent: MapNode | null = null
): Located | null {
	for (let i = 0; i < nodes.length; i++) {
		const n = nodes[i];
		if (n.id === id) return { node: n, siblings: nodes, index: i, parent };
		const found = locate(n.children, id, n);
		if (found) return found;
	}
	return null;
}

/** 先頭から id までの道筋（先祖 … 自分）。見つからなければ空 */
export function pathTo(nodes: MapNode[], id: string): MapNode[] {
	for (const n of nodes) {
		if (n.id === id) return [n];
		const rest = pathTo(n.children, id);
		if (rest.length) return [n, ...rest];
	}
	return [];
}

/** 表示順（深さ優先）に並べたノード。折りたたみ中の子は含めない */
export function visibleList(nodes: MapNode[]): MapNode[] {
	const out: MapNode[] = [];
	const walk = (list: MapNode[]) => {
		for (const n of list) {
			out.push(n);
			if (!n.collapsed) walk(n.children);
		}
	};
	walk(nodes);
	return out;
}

export function countDescendants(node: MapNode): number {
	return node.children.reduce((s, c) => s + 1 + countDescendants(c), 0);
}

function flatten(nodes: MapNode[]): MapNode[] {
	return nodes.flatMap((n) => [n, ...flatten(n.children)]);
}

/** 検索・抜粋用の文字だけ（深さ優先、注釈も含む） */
export function plainText(nodes: MapNode[]): string {
	const lines: string[] = [];
	for (const n of flatten(nodes)) {
		if (n.text.trim()) lines.push(n.text.trim());
		if (n.annotation.trim()) lines.push(n.annotation.trim());
	}
	return lines.join('\n');
}

// ---------- Markdown へ ----------

export function toMarkdown(title: string, root: MapNode): string {
	const lines: string[] = [`# ${title.trim() || '無題のノート'}`, ''];
	const rootText = root.text.trim();
	if (rootText && rootText !== title.trim()) lines.push(rootText);
	for (const l of root.annotation.split('\n')) if (l.trim()) lines.push(`> ${l}`);
	if (root.image) lines.push(`![画像](images/${root.image})`);
	if (lines.length > 2) lines.push('');
	const walk = (list: MapNode[], depth: number) => {
		for (const n of list) {
			const indent = '  '.repeat(depth);
			const mark = n.checked === null ? '' : n.checked ? '[x] ' : '[ ] ';
			lines.push(`${indent}- ${mark}${n.text.replace(/\n/g, ' ')}`);
			for (const l of n.annotation.split('\n')) {
				if (l.trim()) lines.push(`${indent}  > ${l}`);
			}
			if (n.image) lines.push(`${indent}  ![画像](images/${n.image})`);
			walk(n.children, depth + 1);
		}
	};
	walk(root.children, 0);
	return lines.join('\n').replace(/\n+$/, '') + '\n';
}

// ---------- Markdown から ----------

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const LIST_RE = /^([ \t]*)(?:[-*+]|\d+[.)])\s+(?:\[( |x|X)\]\s+)?(.*)$/;
const QUOTE_RE = /^[ \t]*>\s?(.*)$/;
/** 画像の行: ![画像](images/xxx.png)。直前のノード（または根）の画像になる */
const IMAGE_RE = /^[ \t]*!\[[^\]]*\]\(([^)]+)\)\s*$/;

export interface ParsedDocument {
	title: string | null;
	root: MapNode;
}

/**
 * Markdown から木を作る。
 * 以前の根を渡すと、同じ文字のノードの id・折りたたみ・位置をできるだけ引き継ぐ。
 */
export function fromMarkdown(text: string, previous?: MapNode): ParsedDocument {
	const pool = previous ? flatten([previous]) : [];
	const used = new Set<string>();
	// 中心の id は中心が引き継ぐ。子が中心と同じ文字でも中心の id を取らないようにする（id の重複を防ぐ）
	if (previous) used.add(previous.id);
	const takePrev = (t: string): MapNode | undefined => {
		const hit = pool.find((p) => !used.has(p.id) && p.text === t);
		if (hit) used.add(hit.id);
		return hit;
	};

	const lines = text.replace(/\r\n?/g, '\n').split('\n');

	// 字下げの単位（2 か 4 スペース）を、箇条書き行の最小の字下げから決める
	let unit = 2;
	const spaceIndents = lines
		.map((l) => LIST_RE.exec(l)?.[1] ?? '')
		.filter((i) => i.length > 0 && !i.includes('\t'))
		.map((i) => i.length);
	if (spaceIndents.length > 0 && Math.min(...spaceIndents) >= 4) unit = 4;

	const indentLevel = (indent: string): number => {
		const tabs = (indent.match(/\t/g) ?? []).length;
		const spaces = indent.replace(/\t/g, '').length;
		return tabs + Math.floor(spaces / unit);
	};

	let title: string | null = null;
	// 根は最後に文字を決める（本文行が無ければタイトル）
	const root = newNode('', { collapsed: previous?.collapsed ?? false, pos: previous?.pos ?? null });
	if (previous) root.id = previous.id;
	let rootTextSet = false;

	// 深さごとの「いま開いている子の配列」
	const stack: Array<{ depth: number; list: MapNode[] }> = [{ depth: -1, list: root.children }];
	let headingDepth = -1; // 直近の見出しの深さ（-1 = 見出しなし）
	let last: MapNode = root;
	let anyNode = false;

	const push = (depth: number, body: string, checked: boolean | null): MapNode => {
		while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop();
		const prev = takePrev(body);
		const node = newNode(body, {
			checked,
			collapsed: prev?.collapsed ?? false,
			pos: prev?.pos ?? null
		});
		if (prev) node.id = prev.id;
		stack[stack.length - 1].list.push(node);
		stack.push({ depth, list: node.children });
		last = node;
		anyNode = true;
		return node;
	};

	for (const raw of lines) {
		if (raw.trim() === '') continue;

		let m = HEADING_RE.exec(raw);
		if (m) {
			const level = m[1].length;
			const body = m[2].trim();
			if (level === 1 && title === null) {
				title = body;
				continue;
			}
			// ## → 深さ 0、### → 深さ 1 …（# が 2 つ目以降なら深さ 0）
			headingDepth = Math.max(0, level - 2);
			push(headingDepth, body, null);
			continue;
		}

		m = LIST_RE.exec(raw);
		if (m) {
			const depth = headingDepth + 1 + indentLevel(m[1]);
			const checked = m[2] ? m[2].toLowerCase() === 'x' : null;
			push(depth, m[3].trim(), checked);
			continue;
		}

		m = IMAGE_RE.exec(raw);
		if (m) {
			const file = m[1].trim().split('/').pop() ?? '';
			if (file) last.image = file;
			continue;
		}

		m = QUOTE_RE.exec(raw);
		if (m) {
			last.annotation = last.annotation ? `${last.annotation}\n${m[1]}` : m[1];
			continue;
		}

		// 本文行: 最初のノードより前なら中心の文字、それ以降は直前のノードの注釈
		if (!anyNode && !rootTextSet) {
			root.text = raw.trim();
			rootTextSet = true;
		} else {
			last.annotation = last.annotation ? `${last.annotation}\n${raw.trim()}` : raw.trim();
		}
	}
	if (!rootTextSet) root.text = title ?? previous?.text ?? '';
	return { title, root };
}

// ---------- 読み込み時の正規化 ----------

/** 旧形式（本文が文字列、nodes 配列、narration）や欠けた項目のあるノートを、いまの形に直す */
function isThumbnailState(v: unknown): v is ThumbnailState {
	if (!v || typeof v !== 'object') return false;
	const t = v as Partial<ThumbnailState>;
	const c = t.camera;
	return (
		typeof t.text === 'string' &&
		typeof t.size === 'number' &&
		!!c &&
		[c.x, c.y, c.zoom, c.viewW].every((n) => typeof n === 'number' && Number.isFinite(n)) &&
		Array.isArray(t.open) &&
		t.open.every((id) => typeof id === 'string')
	);
}

export function normalizeNote(raw: unknown): Note | null {
	if (!raw || typeof raw !== 'object') return null;
	const o = raw as Record<string, unknown>;
	if (typeof o.id !== 'string') return null;
	const title = typeof o.title === 'string' ? o.title : '';
	let root: MapNode;
	if (o.root && typeof o.root === 'object') {
		root = normalizeNode(o.root as Partial<MapNode>);
	} else if (Array.isArray(o.nodes)) {
		// 旧: タイトルが根で、nodes がその子
		root = newNode(title, {
			children: (o.nodes as Partial<MapNode>[]).map(normalizeNode),
			collapsed: o.rootCollapsed === true
		});
	} else if (typeof o.body === 'string') {
		root = fromMarkdown(o.body).root;
		if (!root.text) root.text = title;
	} else {
		root = newNode(title);
	}
	dedupeIds(root);
	return {
		id: o.id,
		title,
		root,
		orientation: o.orientation === 'portrait' ? 'portrait' : 'landscape',
		...(isThumbnailState(o.thumbnail) ? { thumbnail: o.thumbnail } : {}),
		folder: typeof o.folder === 'string' && o.folder.trim() ? o.folder.trim() : null,
		createdAt: typeof o.createdAt === 'number' ? o.createdAt : Date.now(),
		updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : Date.now()
	};
}

/**
 * 同じ id のノードが 2 つ以上あれば、後のものに新しい id を振る。
 * 以前の取り込みで、中心と同じ文字の子が中心の id を引き継いでしまうことがあった（2026-09-12 修正）。
 * id が重複すると図の描画（key 付きの each）が失敗して画面が古いままになるので、読み込み時に直す
 */
export function dedupeIds(root: MapNode): number {
	const seen = new Set<string>();
	let fixed = 0;
	const walk = (n: MapNode) => {
		if (seen.has(n.id)) {
			n.id = makeId();
			fixed++;
		}
		seen.add(n.id);
		n.children.forEach(walk);
	};
	walk(root);
	return fixed;
}

function normalizeNode(n: Partial<MapNode> & { narration?: string }): MapNode {
	return {
		id: typeof n.id === 'string' ? n.id : makeId(),
		text: typeof n.text === 'string' ? n.text : '',
		annotation:
			typeof n.annotation === 'string'
				? n.annotation
				: typeof n.narration === 'string'
					? n.narration
					: '',
		checked: typeof n.checked === 'boolean' ? n.checked : null,
		collapsed: n.collapsed === true,
		pos:
			n.pos && typeof n.pos.x === 'number' && typeof n.pos.y === 'number'
				? { x: n.pos.x, y: n.pos.y }
				: null,
		image: typeof n.image === 'string' && n.image ? n.image : null,
		children: Array.isArray(n.children) ? n.children.map(normalizeNode) : []
	};
}
