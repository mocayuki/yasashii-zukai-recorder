import type { Cue } from '../../shared/types';
import { parseProofread, proofreadPrompt, type ProofSuggestion } from '../../shared/proofread';

/** 聞き違いの判断は難しいので、字幕の翻訳より上のモデルを使う（117 行で 3 円ほど） */
const MODEL = 'gpt-4o';
const BATCH = 80;

/** テロップを AI に見せて、誤りの候補を返す（当てるのは画面側でユーザーがチェックしてから） */
export async function proofreadCues(
	apiKey: string,
	cues: Cue[],
	context: string[],
	terms: string[]
): Promise<ProofSuggestion[]> {
	const out: ProofSuggestion[] = [];
	for (let i = 0; i < cues.length; i += BATCH) {
		const chunk = cues.slice(i, i + BATCH);
		const res = await fetch('https://api.openai.com/v1/chat/completions', {
			method: 'POST',
			headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: MODEL,
				temperature: 0.1,
				response_format: { type: 'json_object' },
				messages: [
					{ role: 'system', content: proofreadPrompt(context, terms) },
					{
						role: 'user',
						content: JSON.stringify({ items: chunk.map((c) => ({ id: c.id, text: c.text })) })
					}
				]
			})
		});
		if (!res.ok) {
			const body = await res.text().catch(() => '');
			if (res.status === 401)
				throw new Error('API キーが正しくありません。設定で確かめてください。');
			throw new Error(`候補を出せませんでした（${res.status}）。${body.slice(0, 200)}`);
		}
		const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
		out.push(...parseProofread(json.choices?.[0]?.message?.content ?? '', chunk));
	}
	return out;
}
