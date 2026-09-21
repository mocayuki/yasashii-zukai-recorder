import { describe, expect, it } from 'vitest';
import { newNode } from '../../../shared/notes';
import { connectorPath, layoutMap } from './layout';

function tree() {
	const root = newNode('root');
	const a = newNode('a');
	const b = newNode('b');
	root.children.push(a, b);
	return { root, a, b };
}
const sizes = { root: { w: 100, h: 40 }, a: { w: 80, h: 40 }, b: { w: 80, h: 40 } };
const withIds = (t: ReturnType<typeof tree>) => {
	t.root.id = 'root';
	t.a.id = 'a';
	t.b.id = 'b';
	return t;
};

describe('layoutMap', () => {
	it('right: 子は右、兄弟は縦に並ぶ', () => {
		const { root } = withIds(tree());
		const l = layoutMap(root, sizes, { direction: 'right' });
		const p = Object.fromEntries(l.placed.map((x) => [x.id, x]));
		expect(p.a.x).toBe(p.root.x + 100 + 88);
		expect(p.b.x).toBe(p.a.x);
		expect(p.b.y).toBeGreaterThan(p.a.y);
	});
	it('down: 子は下、兄弟は横に並ぶ', () => {
		const { root } = withIds(tree());
		const l = layoutMap(root, sizes, { direction: 'down' });
		const p = Object.fromEntries(l.placed.map((x) => [x.id, x]));
		expect(p.a.y).toBe(p.root.y + 40 + 64);
		expect(p.b.y).toBe(p.a.y);
		expect(p.b.x).toBeGreaterThan(p.a.x);
		// 兄弟のブロックは親の中央
		const mid = (p.a.x + p.b.x + 80) / 2;
		expect(Math.abs(mid - (p.root.x + 50))).toBeLessThan(1);
	});
	it('down: 手で動かした位置（pos）はそのまま使う', () => {
		const t = withIds(tree());
		t.a.pos = { x: 300, y: 500 };
		const p = Object.fromEntries(
			layoutMap(t.root, sizes, { direction: 'down' }).placed.map((x) => [x.id, x])
		);
		expect([p.a.x, p.a.y]).toEqual([300, 500]);
	});
});

describe('connectorPath', () => {
	it('down は下端の中央から上端の中央へ', () => {
		const d = connectorPath(
			{ x: 0, y: 0, w: 100, h: 40 },
			{ x: 200, y: 104, w: 80, h: 40 },
			'down'
		);
		expect(d.startsWith('M 50 40')).toBe(true);
		expect(d.endsWith('240 104')).toBe(true);
	});
});

describe('手で置いた子の連結線', () => {
	const parent = { x: 100, y: 100, w: 120, h: 40 };
	it('左に離して置いた子は、親の左辺から線が出る', () => {
		const d = connectorPath(parent, { x: -100, y: 100, w: 80, h: 40 }, 'right', true);
		expect(d.startsWith('M 100 120')).toBe(true); // 親の左辺の中央
		expect(d.endsWith('-20 120')).toBe(true); // 子の右辺の中央
	});
	it('上に離して置いた子は、親の上辺から線が出る', () => {
		const d = connectorPath(parent, { x: 120, y: -50, w: 80, h: 40 }, 'right', true);
		expect(d.startsWith('M 160 100')).toBe(true);
	});
	it('手で置いていない子や、右にある子は普段どおり右辺から', () => {
		expect(
			connectorPath(parent, { x: -100, y: 100, w: 80, h: 40 }, 'right', false).startsWith(
				'M 220 120'
			)
		).toBe(true);
		expect(
			connectorPath(parent, { x: 300, y: 100, w: 80, h: 40 }, 'right', true).startsWith('M 220 120')
		).toBe(true);
	});
});

describe('outline（箇条書き型）', () => {
	it('子は親のすぐ下に字下げして縦に並び、後ろの兄弟はその下に来る', () => {
		const root = newNode('root');
		root.id = 'root';
		const a = newNode('a');
		a.id = 'a';
		const a1 = newNode('a1');
		a1.id = 'a1';
		const b = newNode('b');
		b.id = 'b';
		a.children.push(a1);
		root.children.push(a, b);
		const sz = {
			root: { w: 100, h: 40 },
			a: { w: 80, h: 40 },
			a1: { w: 80, h: 40 },
			b: { w: 80, h: 40 }
		};
		const p = Object.fromEntries(
			layoutMap(root, sz, { direction: 'outline' }).placed.map((x) => [x.id, x])
		);
		expect(p.a.x).toBe(p.root.x + 56);
		expect(p.a.y).toBe(p.root.y + 40 + 18);
		expect(p.a1.x).toBe(p.a.x + 56);
		expect(p.a1.y).toBe(p.a.y + 40 + 18);
		expect(p.b.x).toBe(p.a.x);
		expect(p.b.y).toBe(p.a1.y + 40 + 18);
	});
	it('閉じた子は場所を取らない', () => {
		const root = newNode('root');
		root.id = 'root';
		const a = newNode('a', { collapsed: true });
		a.id = 'a';
		a.children.push(newNode('hidden'));
		const b = newNode('b');
		b.id = 'b';
		root.children.push(a, b);
		const sz = { root: { w: 100, h: 40 }, a: { w: 80, h: 40 }, b: { w: 80, h: 40 } };
		const p = Object.fromEntries(
			layoutMap(root, sz, { direction: 'outline' }).placed.map((x) => [x.id, x])
		);
		expect(p.b.y).toBe(p.a.y + 40 + 18);
	});
});
