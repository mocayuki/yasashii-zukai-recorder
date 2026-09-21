import { describe, expect, it } from 'vitest';
import {
	fromMarkdown,
	locate,
	newNode,
	normalizeNote,
	plainText,
	toMarkdown,
	visibleList
} from './notes';

describe('fromMarkdown', () => {
	it('# がタイトル、箇条書きが中心の子、字下げが孫になる', () => {
		const { title, root } = fromMarkdown(
			'# 題\n\n- 親\n  - 子1\n  - [ ] 子2\n    - [x] 孫\n- 次\n'
		);
		expect(title).toBe('題');
		expect(root.text).toBe('題'); // 中心の文字が無ければタイトル
		expect(root.children.map((n) => n.text)).toEqual(['親', '次']);
		expect(root.children[0].children.map((n) => [n.text, n.checked])).toEqual([
			['子1', null],
			['子2', false]
		]);
		expect(root.children[0].children[1].children[0]).toMatchObject({ text: '孫', checked: true });
	});

	it('タイトルと中心の文字を分けて書ける。中心の注釈も持てる', () => {
		const { title, root } = fromMarkdown('# 動画の題名\n中心のことば\n> 中心の注釈\n\n- a');
		expect(title).toBe('動画の題名');
		expect(root.text).toBe('中心のことば');
		expect(root.annotation).toBe('中心の注釈');
		expect(root.children.map((n) => n.text)).toEqual(['a']);
	});

	it('見出しもノードになり、その下の箇条書きは子になる', () => {
		const { root } = fromMarkdown('# 題\n## 章1\n- a\n- b\n### 節\n- c\n## 章2\n- d');
		const nodes = root.children;
		expect(nodes.map((n) => n.text)).toEqual(['章1', '章2']);
		expect(nodes[0].children.map((n) => n.text)).toEqual(['a', 'b', '節']);
		expect(nodes[0].children[2].children.map((n) => n.text)).toEqual(['c']);
		expect(nodes[1].children.map((n) => n.text)).toEqual(['d']);
	});

	it('> は直前のノードの注釈になる。本文行も注釈になる', () => {
		const { root } = fromMarkdown('- a\n  > こんにちは\n  > 今日は\n- b\nそのまま本文');
		expect(root.children[0].annotation).toBe('こんにちは\n今日は');
		expect(root.children[1].annotation).toBe('そのまま本文');
	});

	it('4 スペースやタブの字下げも 1 段として読む', () => {
		expect(fromMarkdown('- a\n    - b').root.children[0].children[0].text).toBe('b');
		expect(fromMarkdown('- a\n\t- b').root.children[0].children[0].text).toBe('b');
		expect(fromMarkdown('* a\n  * b').root.children[0].children[0].text).toBe('b');
		expect(fromMarkdown('1. a\n   2. b').root.children[0].children[0].text).toBe('b');
	});

	it('以前の木から id・折りたたみ・位置を引き継ぐ', () => {
		const prev = newNode('中心', {
			pos: { x: 1, y: 2 },
			children: [newNode('親', { collapsed: true, children: [newNode('子')] })]
		});
		const { root } = fromMarkdown('# 題\n中心\n- 親\n  - 子\n  - 新しい子', prev);
		expect(root.id).toBe(prev.id);
		expect(root.pos).toEqual({ x: 1, y: 2 });
		const nodes = root.children;
		expect(nodes[0].id).toBe(prev.children[0].id);
		expect(nodes[0].collapsed).toBe(true);
		expect(nodes[0].children[0].id).toBe(prev.children[0].children[0].id);
		expect(nodes[0].children[1].id).not.toBe(prev.children[0].children[0].id);
	});
});

describe('toMarkdown', () => {
	it('往復しても同じになる（中心がタイトルと同じとき）', () => {
		const md =
			'# 題\n\n- 親\n  > 注釈の1行目\n  > 2行目\n  - 子1\n  - [ ] 子2\n    - [x] 孫\n- 次\n';
		const { title, root } = fromMarkdown(md);
		expect(toMarkdown(title ?? '', root)).toBe(md);
	});

	it('中心の文字と注釈があるときはタイトルの後に出す', () => {
		const md = '# 題\n\n中心\n> 中心の注釈\n\n- a\n';
		const { title, root } = fromMarkdown(md);
		expect(toMarkdown(title ?? '', root)).toBe(md);
	});
});

describe('locate / visibleList / plainText', () => {
	it('ノードと親・位置を見つける', () => {
		const { root } = fromMarkdown('- a\n  - b\n  - c');
		const nodes = root.children;
		const c = locate([root], nodes[0].children[1].id)!;
		expect(c.node.text).toBe('c');
		expect(c.index).toBe(1);
		expect(c.parent?.text).toBe('a');
		expect(locate([root], root.id)?.parent).toBeNull();
		expect(locate([root], 'nope')).toBeNull();
	});

	it('折りたたんだ子は表示順に含めない', () => {
		const { root } = fromMarkdown('- a\n  - b\n- c');
		root.children[0].collapsed = true;
		expect(visibleList(root.children).map((n) => n.text)).toEqual(['a', 'c']);
	});

	it('中心と同じ文字の子は中心の id を引き継がない（id が重複しない）', () => {
		const first = fromMarkdown('# 題\n\nショート動画\n\n- ショート動画\n- ああ\n');
		const second = fromMarkdown('# 題\n\nショート動画２\n\n- ショート動画\n- ああ\n', first.root);
		const ids = [second.root.id, ...second.root.children.map((c) => c.id)];
		expect(new Set(ids).size).toBe(ids.length);
		expect(second.root.id).toBe(first.root.id);
	});

	it('normalizeNote は重複した id を直す', () => {
		const note = normalizeNote({
			id: 'n1',
			title: 't',
			root: {
				id: 'a',
				text: 'x',
				children: [
					{ id: 'a', text: 'y', children: [] },
					{ id: 'b', text: 'z', children: [] }
				]
			}
		});
		expect(note).not.toBeNull();
		const ids = [note!.root.id, ...note!.root.children.map((c) => c.id)];
		expect(new Set(ids).size).toBe(3);
		expect(note!.root.id).toBe('a');
	});

	it('plainText は注釈も含む', () => {
		const { root } = fromMarkdown('- a\n  > 話す\n- b');
		expect(plainText(root.children)).toBe('a\n話す\nb');
	});
});

describe('normalizeNote', () => {
	it('旧形式（nodes 配列 + rootCollapsed）を根に直す', () => {
		const n = normalizeNote({
			id: 'x',
			title: 't',
			nodes: [{ text: 'a', narration: '注' }],
			rootCollapsed: true,
			createdAt: 1,
			updatedAt: 2
		})!;
		expect(n.root.text).toBe('t');
		expect(n.root.collapsed).toBe(true);
		expect(n.root.children[0]).toMatchObject({ text: 'a', annotation: '注' });
	});

	it('さらに古い形式（本文が文字列）も根に直す', () => {
		const n = normalizeNote({ id: 'x', title: 't', body: '- 項目\n- [x] 済', createdAt: 1 })!;
		expect(n.root.text).toBe('t');
		expect(n.root.children.map((x) => [x.text, x.checked])).toEqual([
			['項目', null],
			['済', true]
		]);
	});

	it('欠けた項目を埋める', () => {
		const n = normalizeNote({ id: 'x', root: { text: 'a' } })!;
		expect(n.title).toBe('');
		expect(n.root).toMatchObject({
			text: 'a',
			annotation: '',
			checked: null,
			collapsed: false,
			pos: null,
			image: null,
			children: []
		});
		expect(typeof n.root.id).toBe('string');
	});
});

describe('画像', () => {
	it('Markdown に ![画像](images/...) として出て、読み戻せる', () => {
		const root = newNode('中心', { image: 'r.png' });
		root.children.push(newNode('子', { image: 'a.jpg', annotation: '説明' }));
		const md = toMarkdown('題', root);
		expect(md).toContain('![画像](images/r.png)');
		expect(md).toContain('  ![画像](images/a.jpg)');
		const back = fromMarkdown(md);
		expect(back.root.image).toBe('r.png');
		expect(back.root.children[0].image).toBe('a.jpg');
		expect(back.root.children[0].annotation).toBe('説明');
	});
});
