import { describe, expect, it } from 'vitest';
import { markdownToHtml } from './note-html';

describe('markdownToHtml（note に貼る用）', () => {
	it('見出し・段落・太字・箇条書き・区切り線', () => {
		const md =
			'# 題\n\n導入です。**大事**ですよね。\n二行目\n\n## 見出し\n\n- ひとつ\n- ふたつ\n\n---\n\nこの話は YouTube でも。\nhttps://youtu.be/x';
		const html = markdownToHtml(md);
		expect(html).toContain('<h1>題</h1>');
		expect(html).toContain('<p>導入です。<strong>大事</strong>ですよね。<br>二行目</p>');
		expect(html).toContain('<h2>見出し</h2>');
		expect(html).toContain('<ul><li>ひとつ</li><li>ふたつ</li></ul>');
		expect(html).toContain('<hr>');
		expect(html).toContain('<a href="https://youtu.be/x">https://youtu.be/x</a>');
	});
	it('HTML の記号は逃がす', () => {
		expect(markdownToHtml('a < b & c')).toBe('<p>a &lt; b &amp; c</p>');
	});
});
