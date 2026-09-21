/**
 * テロップの校正（AI に誤りの候補を出してもらい、ユーザーがチェックしたものだけ直す）。
 * 音声認識の聞き違い（Claude → くろうと、画像生成 → 画像先生 など）や助詞の抜けを、
 * 文脈（ノートの題名・ノードの文字・言葉の辞書）を見て見つける。候補は「その行の中のこの部分をこう」という最小の置き換え
 */
import type { Cue } from './types';

export interface ProofSuggestion {
	/** テロップの id */
	id: string;
	/** 確信度 1〜5（5 が最も確か）。4 以上だけ画面に出す */
	confidence: number;
	/** 直す前の部分（その行の文にそのまま含まれる文字列） */
	before: string;
	/** 直した後 */
	after: string;
	/** 理由（短く） */
	reason: string;
}

export function proofreadPrompt(context: string[], terms: string[]): string {
	const ctx = context
		.filter((s) => s.trim())
		.slice(0, 80)
		.join('、');
	const glossary = terms.length ? terms.join('、') : '（なし）';
	return (
		'あなたは日本語の YouTube 字幕の校正者です。以下は音声認識（whisper）で自動生成された字幕です。' +
		'見つけてほしいのは「音声認識の聞き違い」だけです。聞き違いには特徴があります: 元の言葉と「読み（音）」がほぼ同じか、とてもよく似ている別の言葉に置き換わっています' +
		'（例: 「Claude」→「くろうと」、「画像生成」→「画像先生」、「起業家」→「企業家」、「ChatGPT」→「チャットGPD」）。' +
		'\n手順: まず、文脈に合わない・意味が通らない言葉を探す。次に、その言葉と読みが同じか近い言葉で、文脈（下の話の文脈と辞書）に合うものがあるかを考える。両方そろったときだけ候補にする。' +
		'\n次のものは絶対に候補にしないでください: 読みが大きく違う言葉への置き換え、略語を正式名に広げる（インプ→インプレッション など）、助詞や語尾の好み、「とか」「っていう」などの口語表現、言葉の追加・削除、読点や「・」の増減、言い換え、文の整理。' +
		'意味が通る文はそのままにしてください。話し手が本当に言った言葉は本人しか分からないので、迷うものは出さないでください。' +
		'\n各候補は「その行の文にそのまま含まれる部分文字列 before（12 文字以内。誤っている言葉だけ）」と「置き換え後 after」の最小の組にし、確信度 confidence を 1〜5 で付けてください（5 = 明らかな聞き違い、3 以下 = 迷う）。' +
		'reason には「読みが近い」「文脈のどこと合わない」を短く書いてください。' +
		'\n返事は JSON だけ: {"items":[{"id":"行のid","before":"…","after":"…","confidence":5,"reason":"短い理由"}]}。候補が無ければ {"items":[]}。' +
		`\n\n[話の文脈（ノートの題名とノードの文字）] ${ctx || '（なし）'}` +
		`\n[正しい書き方の辞書] ${glossary}`
	);
}

/** 返事を読み、実際に置き換えられるものだけ残す（id が無い・before が文に無い・変化が無いものは捨てる） */
export function parseProofread(json: string, cues: Cue[]): ProofSuggestion[] {
	const byId = new Map(cues.map((c) => [c.id, c]));
	const out: ProofSuggestion[] = [];
	try {
		const obj = JSON.parse(json) as { items?: Array<Partial<ProofSuggestion>> };
		for (const it of obj.items ?? []) {
			if (
				typeof it.id !== 'string' ||
				typeof it.before !== 'string' ||
				typeof it.after !== 'string'
			)
				continue;
			const cue = byId.get(it.id);
			const before = it.before;
			const after = it.after;
			if (!cue || !before || before === after || !cue.text.includes(before)) continue;
			// 言葉の入れ替えだけを扱う: 長すぎる範囲（文の書き換え）と、記号の増減だけのものは捨てる
			if ([...before].length > 12) continue;
			const strip = (v: string) => v.replace(/[\s、。，．・！？!?「」『』（）()]/g, '');
			if (strip(before) === strip(after)) continue;
			// 元の言葉を含む形に伸ばす（インプ → インプレッション）・削る（か を足す・取る）は聞き違いではないので捨てる
			if (after.includes(before) || before.includes(after)) continue;
			// 文字を挟み込むだけ・抜くだけ（法律制度 → 法律や制度 など）も、読みの近い置き換えではないので捨てる
			if (isSubsequence(before, after) || isSubsequence(after, before)) continue;
			if (out.some((o) => o.id === it.id && o.before === before)) continue;
			const c = typeof it.confidence === 'number' ? it.confidence : 3;
			// 迷っているもの（3 以下）は出さない。出すのは聞き違いとして確からしいものだけ
			if (c < 4) continue;
			out.push({
				id: it.id,
				before,
				after,
				confidence: c,
				reason: typeof it.reason === 'string' ? it.reason : ''
			});
		}
	} catch {
		/* 形が違う */
	}
	return out;
}

/** a の文字が順番どおり b に全部現れるか（a に文字を足しただけで b になるか） */
function isSubsequence(a: string, b: string): boolean {
	const ac = [...a];
	const bc = [...b];
	let i = 0;
	for (const ch of bc) if (i < ac.length && ac[i] === ch) i++;
	return i === ac.length;
}

/** チェックした候補を当てる（同じ行に複数あれば順に。before が見つからなくなったものは飛ばす） */
export function applySuggestions(
	cues: Cue[],
	picked: ProofSuggestion[]
): { cues: Cue[]; applied: number } {
	let applied = 0;
	const next = cues.map((c) => {
		let text = c.text;
		for (const s of picked) {
			if (s.id !== c.id) continue;
			const i = text.indexOf(s.before);
			if (i < 0) continue;
			text = text.slice(0, i) + s.after + text.slice(i + s.before.length);
			applied++;
		}
		return text === c.text ? c : { ...c, text };
	});
	return { cues: next, applied };
}
