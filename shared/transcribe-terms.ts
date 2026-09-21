/**
 * 書き起こし（whisper-1）に渡す「言葉の辞書」と、書き起こし後の「置き換え」。
 *
 * - 辞書: 固有名詞や書き方を決めたい言葉を 1 行 1 語で持つ。whisper の prompt に入れると、その書き方に寄る
 *   （確実ではない）。prompt は末尾のおよそ 224 トークンしか使われないので、辞書は末尾に置き、
 *   ノートの言葉（タイトルとノードの文字）は先頭に置いて、あふれた分は削る
 * - 置き換え: 「誤り → 正しい」を 1 行 1 組で持ち、書き起こしの文に機械的に当てる（確実に直す保険）
 */

/** 1 行 1 語の文字列を、空行を除いて重複なしの配列にする */
export function parseTerms(text: string): string[] {
	const out: string[] = [];
	for (const raw of (text ?? '').split(/\r?\n/)) {
		const t = raw.trim();
		if (t && !out.includes(t)) out.push(t);
	}
	return out;
}

/** 「誤り → 正しい」の行を組にする。矢印は → / -> / => / ＝ / = / タブ のどれでもよい */
export function parseReplacements(text: string): Array<[string, string]> {
	const out: Array<[string, string]> = [];
	for (const raw of (text ?? '').split(/\r?\n/)) {
		const m = /^(.*?)\s*(?:→|->|=>|＝|=|\t)\s*(.*?)\s*$/.exec(raw.trim());
		if (!m) continue;
		const from = m[1].trim();
		const to = m[2].trim();
		if (from && from !== to) out.push([from, to]);
	}
	return out;
}

/** 置き換えを順に当てる（前の組の結果に次の組が当たることもある） */
export function applyReplacements(text: string, pairs: Array<[string, string]>): string {
	let t = text;
	for (const [from, to] of pairs) t = t.split(from).join(to);
	return t;
}

/**
 * whisper に渡す prompt を作る。ノートの言葉と辞書を、ふつうの文に入れる。
 * 言葉を「、」で並べただけの prompt にすると、whisper がその書き方をまねて、話した動詞や語尾を落とし、
 * 名詞の羅列（「配達員、経営者、」）にしてしまう。文の形にしておくと、話したとおりの文になる。
 * 辞書は末尾に置く（末尾のおよそ 224 トークンが使われる）。全体が maxChars を超えるときはノートの言葉を後ろから削る
 */
export function buildPrompt(noteWords: string[], terms: string[], maxChars = 320): string {
	const seen = new Set<string>(terms);
	const head: string[] = [];
	for (const raw of noteWords) {
		const w = raw.trim();
		if (!w || seen.has(w) || w.length > 60) continue;
		seen.add(w);
		head.push(w);
	}
	const join = (h: string[]) => {
		const parts: string[] = [];
		if (h.length) parts.push(`この動画では、${h.join('、')}などについて話します。`);
		if (terms.length) parts.push(`${terms.join('、')}という言葉も出てきます。`);
		return parts.join('');
	};
	while (head.length > 0 && join(head).length > maxChars) head.pop();
	return join(head);
}
