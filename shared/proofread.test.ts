import { describe, expect, it } from 'vitest';
import { applySuggestions, parseProofread } from './proofread';

const cues = [
	{ id: 'a', startMs: 0, endMs: 1000, text: 'くろうとに画像先生を頼みました。' },
	{ id: 'b', startMs: 1000, endMs: 2000, text: 'これで完成です。' }
];

describe('テロップの校正', () => {
	it('返事から、実際に置き換えられる候補だけ残す', () => {
		const json = JSON.stringify({
			items: [
				{ id: 'a', before: 'くろうと', after: 'Claude', confidence: 5, reason: '固有名詞' },
				{ id: 'a', before: '画像先生', after: '画像生成', confidence: 4, reason: '聞き違い' },
				{ id: 'b', before: 'これで', after: 'それで', confidence: 2, reason: '迷う' },
				{ id: 'b', before: '完成です', after: '完成なのです', confidence: 5, reason: '挟み込み' },
				{ id: 'a', before: '頼みました', after: '頼みまし', confidence: 5, reason: '抜き' },
				{ id: 'a', before: '無い部分', after: 'x' },
				{ id: 'b', before: '完成', after: '完成' },
				{ id: 'b', before: 'これで完成です。', after: 'これで、完成です。' },
				{
					id: 'a',
					before: 'くろうとに画像先生を頼みました。',
					after: 'Claude に画像生成を頼みました。'
				},
				{ id: 'zzz', before: 'これ', after: 'それ' }
			]
		});
		const s = parseProofread(json, cues);
		expect(s.map((x) => x.after)).toEqual(['Claude', '画像生成']);
		expect(parseProofread('not json', cues)).toEqual([]);
	});
	it('チェックしたものだけ当てる', () => {
		const s = parseProofread(
			JSON.stringify({
				items: [
					{ id: 'a', before: 'くろうと', after: 'Claude', confidence: 5 },
					{ id: 'a', before: '画像先生', after: '画像生成', confidence: 5 }
				]
			}),
			cues
		);
		const r = applySuggestions(cues, [s[0]]);
		expect(r.applied).toBe(1);
		expect(r.cues[0].text).toBe('Claudeに画像先生を頼みました。');
		expect(r.cues[1]).toBe(cues[1]);
	});
});
