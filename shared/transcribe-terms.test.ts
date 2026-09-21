import { describe, expect, it } from 'vitest';
import { applyReplacements, buildPrompt, parseReplacements, parseTerms } from './transcribe-terms';

describe('書き起こしの言葉', () => {
	it('辞書は 1 行 1 語。空行と重複は除く', () => {
		expect(parseTerms('亀井ゆき\n\n やさしいバイブコーディング \n亀井ゆき\n')).toEqual([
			'亀井ゆき',
			'やさしいバイブコーディング'
		]);
	});
	it('置き換えは「誤り → 正しい」。矢印の種類は問わない', () => {
		expect(parseReplacements('仮面雪 → 亀井ゆき\n優しい->やさしい\nabc = abc\nだけ\n')).toEqual([
			['仮面雪', '亀井ゆき'],
			['優しい', 'やさしい']
		]);
	});
	it('置き換えは全部の出現に当たる', () => {
		expect(applyReplacements('仮面雪と仮面雪', [['仮面雪', '亀井ゆき']])).toBe(
			'亀井ゆきと亀井ゆき'
		);
	});
	it('prompt はノートの言葉が先、辞書が後。あふれたらノートの言葉を後ろから削る', () => {
		const p = buildPrompt(['題名', 'ノード 1', 'ノード 2'], ['亀井ゆき']);
		expect(p).toBe(
			'この動画では、題名、ノード 1、ノード 2などについて話します。亀井ゆきという言葉も出てきます。'
		);
		const short = buildPrompt(['あいうえお', 'かきくけこ', 'さしすせそ'], ['辞書'], 40);
		expect(short).toBe(
			'この動画では、あいうえおなどについて話します。辞書という言葉も出てきます。'
		);
		expect(buildPrompt([], [])).toBe('');
		expect(buildPrompt([], ['辞書'])).toBe('辞書という言葉も出てきます。');
	});
});
