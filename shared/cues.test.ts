import { describe, expect, it } from 'vitest';
import {
	assTime,
	cueAt,
	cuesForExport,
	layoutTelop,
	splitLongCue,
	splitSentence,
	srtTime,
	toAss,
	toSrt,
	wrapTelop
} from './cues';

const cue = (startMs: number, endMs: number, text: string, id = `${startMs}`) => ({
	id,
	startMs,
	endMs,
	text
});
const cut = (startMs: number, endMs: number) => ({ id: `${startMs}-${endMs}`, startMs, endMs });

describe('cueAt', () => {
	it('いまの時刻のテロップを返す', () => {
		const cues = [cue(0, 1000, 'a'), cue(1000, 2500, 'b')];
		expect(cueAt(cues, 500)?.text).toBe('a');
		expect(cueAt(cues, 1000)?.text).toBe('b');
		expect(cueAt(cues, 2500)).toBeNull();
	});
});

describe('cuesForExport', () => {
	it('カットの中のものは落ち、あとのものは前にずれる', () => {
		const cues = [cue(0, 1000, 'a'), cue(1200, 1800, 'b'), cue(3000, 4000, 'c')];
		const out = cuesForExport(cues, [cut(1000, 2000)], 10000);
		expect(out.map((c) => [c.text, c.startMs, c.endMs])).toEqual([
			['a', 0, 1000],
			['c', 2000, 3000]
		]);
	});
	it('カットにまたがるものは詰める', () => {
		const out = cuesForExport([cue(500, 3000, 'x')], [cut(1000, 2000)], 10000);
		expect(out.map((c) => [c.startMs, c.endMs])).toEqual([[500, 2000]]);
	});
});

describe('時刻の書式', () => {
	it('SRT と ASS', () => {
		expect(srtTime(3723456)).toBe('01:02:03,456');
		expect(assTime(3723456)).toBe('1:02:03.46');
	});
	it('SRT の本文', () => {
		expect(toSrt([cue(0, 1500, 'こんにちは')])).toBe(
			'1\n00:00:00,000 --> 00:00:01,500\nこんにちは\n'
		);
	});
	it('ASS には Style と Dialogue が入る', () => {
		const ass = toAss([cue(0, 1500, 'a{b}')]);
		expect(ass).toContain('Style: Telop,Zen Maru Gothic Black,84');
		expect(ass).toContain('Dialogue: 0,0:00:00.00,0:00:01.50,Telop,,0,0,0,,ab');
	});
});

describe('wrapTelop / layoutTelop', () => {
	it('上限を超える手前の句読点で折る', () => {
		const lines = wrapTelop('AIで作れるものが多すぎて、ものづくりが好きな私としては困ります。', 16);
		expect(lines).toEqual([
			'AIで作れるものが多すぎて、',
			'ものづくりが好きな私としては困り',
			'ます。'
		]);
	});
	it('短い文はそのまま', () => {
		expect(layoutTelop('こんにちは。')).toEqual({ fontSize: 60, lines: ['こんにちは。'] });
	});
	it('最後の行が数文字だけ余るときは、字を小さくせず行の長さをそろえる', () => {
		// 60px・幅 1920・余白 120 → 1 行 28 文字。34 文字なら 28 + 6 になるところを、17 + 17 のように折る
		const t = layoutTelop('あ'.repeat(30) + 'いう。');
		expect(t.fontSize).toBe(60);
		expect(t.lines.length).toBe(2);
		expect([...t.lines[1]].length).toBeGreaterThanOrEqual(6);
	});
	it('2 行まで。基本の大きさで 2 行に入らないときだけ小さくする', () => {
		// 60px・幅 1920・余白 120 → 1 行 30 文字。60 文字までは 60px のまま 2 行
		const two = layoutTelop('あ'.repeat(58));
		expect(two.fontSize).toBe(60);
		expect(two.lines.length).toBe(2);
		const long = layoutTelop('あ'.repeat(66));
		expect(long.fontSize).toBe(51);
		expect(long.lines.length).toBe(2);
	});
	it('ASS では \\N で行を分け、小さくするときは \\fs を付ける', () => {
		// 84px・余白 70 → 1 行 23 文字。70 文字はどの大きさでも 2 行に入らないので、行数が最も少なくなる最初の大きさ（71px、3 行）
		const ass = toAss([cue(0, 3000, 'あ'.repeat(70))]);
		expect(ass).toContain('{\\fs71}');
		expect(ass).toContain('\\N');
	});
});

describe('splitSentence / splitLongCue', () => {
	it('長い文を「、」で分ける。区切りの無い長い節はそのまま（行の折り返しに任せる）', () => {
		const pieces = splitSentence(
			'AIで作れるものが多すぎて、ものづくりが好きな私としては、やさしいバイブコーディングというものがどういうものか説明したいと思います。',
			28
		);
		expect(pieces).toEqual([
			'AIで作れるものが多すぎて、ものづくりが好きな私としては、',
			'やさしいバイブコーディングというものがどういうものか説明したいと思います。'
		]);
	});
	it('短い文はそのまま', () => {
		expect(splitSentence('こんにちは。', 28)).toEqual(['こんにちは。']);
	});
	it('時間を文字数の割合で配る', () => {
		const out = splitLongCue(
			cue(1000, 5000, 'あ'.repeat(20) + '、' + 'い'.repeat(20)),
			28,
			() => 'x'
		);
		expect(out.length).toBe(2);
		expect(out[0].startMs).toBe(1000);
		expect(out[1].endMs).toBe(5000);
		expect(out[0].endMs).toBe(out[1].startMs);
		expect(out[0].endMs).toBeGreaterThan(2500);
	});
});
