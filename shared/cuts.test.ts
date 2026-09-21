import { describe, expect, it } from 'vitest';
import { keptDuration, keptSegments, normalizeCuts, skipTarget, toExportedTime } from './cuts';

const cut = (startMs: number, endMs: number, id = `${startMs}-${endMs}`) => ({
	id,
	startMs,
	endMs
});

describe('normalizeCuts', () => {
	it('重なりと接触をまとめ、範囲外を切る', () => {
		const r = normalizeCuts(
			[cut(5000, 8000), cut(1000, 3000), cut(3000, 4000), cut(-5, 500), cut(9000, 20000)],
			10000
		);
		expect(r.map((c) => [c.startMs, c.endMs])).toEqual([
			[0, 500],
			[1000, 4000],
			[5000, 8000],
			[9000, 10000]
		]);
	});
	it('長さ 0 や逆向きは捨てる／直す', () => {
		expect(normalizeCuts([cut(3000, 3000)], 10000)).toEqual([]);
		expect(normalizeCuts([cut(3000, 2000)], 10000).map((c) => [c.startMs, c.endMs])).toEqual([
			[2000, 3000]
		]);
	});
});

describe('keptSegments / keptDuration', () => {
	it('カットが無ければ全体', () => {
		expect(keptSegments([], 10000)).toEqual([{ startMs: 0, endMs: 10000 }]);
		expect(keptDuration([], 10000)).toBe(10000);
	});
	it('隙間が残る区間になる', () => {
		expect(keptSegments([cut(0, 1000), cut(4000, 6000)], 10000)).toEqual([
			{ startMs: 1000, endMs: 4000 },
			{ startMs: 6000, endMs: 10000 }
		]);
		expect(keptDuration([cut(0, 1000), cut(4000, 6000)], 10000)).toBe(7000);
	});
	it('全部消したら何も残らない', () => {
		expect(keptSegments([cut(0, 10000)], 10000)).toEqual([]);
	});
});

describe('skipTarget / toExportedTime', () => {
	it('カットの中なら終わりへ飛ぶ', () => {
		expect(skipTarget([cut(2000, 3000)], 2500, 10000)).toBe(3000);
		expect(skipTarget([cut(2000, 3000)], 3000, 10000)).toBeNull();
		expect(skipTarget([cut(2000, 3000)], 1000, 10000)).toBeNull();
	});
	it('書き出し後の時刻はカット分だけ前にずれる', () => {
		expect(toExportedTime([cut(2000, 3000)], 5000, 10000)).toBe(4000);
		expect(toExportedTime([cut(2000, 3000)], 2500, 10000)).toBe(2000);
		expect(toExportedTime([cut(2000, 3000)], 1000, 10000)).toBe(1000);
	});
});
