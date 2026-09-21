/**
 * note に貼るための、ごく小さな Markdown → HTML。
 * note の編集画面は貼り付けた Markdown の記号（## や **）をそのまま文字にしてしまうので、
 * 見出し・太字・箇条書きが効くように HTML にしてクリップボードへ入れる（text/plain には Markdown も入れる）。
 * 扱うのは AI が作る記事に出る形だけ: # / ## / ### の見出し、段落、- の箇条書き、1. の番号付き、**太字**、---
 */
function esc(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 行の中の **太字** と URL */
function inline(s: string): string {
	let h = esc(s);
	h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
	h = h.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
	return h;
}

export function markdownToHtml(md: string): string {
	const lines = md.replace(/\r\n?/g, '\n').split('\n');
	const out: string[] = [];
	let para: string[] = [];
	let list: { kind: 'ul' | 'ol'; items: string[] } | null = null;
	const flushPara = () => {
		if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
		para = [];
	};
	const flushList = () => {
		if (list)
			out.push(
				`<${list.kind}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.kind}>`
			);
		list = null;
	};
	for (const raw of lines) {
		const line = raw.trimEnd();
		if (!line.trim()) {
			flushPara();
			flushList();
			continue;
		}
		const h = /^(#{1,3})\s+(.*)$/.exec(line);
		if (h) {
			flushPara();
			flushList();
			out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
			continue;
		}
		if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
			flushPara();
			flushList();
			out.push('<hr>');
			continue;
		}
		const ul = /^\s*[-*・]\s+(.*)$/.exec(line);
		const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
		if (ul || ol) {
			flushPara();
			const kind = ul ? 'ul' : 'ol';
			if (!list || list.kind !== kind) {
				flushList();
				list = { kind, items: [] };
			}
			list.items.push((ul ?? ol)![1]);
			continue;
		}
		flushList();
		para.push(line);
	}
	flushPara();
	flushList();
	return out.join('\n');
}
