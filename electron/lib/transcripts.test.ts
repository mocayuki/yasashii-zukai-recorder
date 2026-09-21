import { describe, expect, it, vi } from 'vitest';

vi.mock('./library', () => ({
	ensureLibrary: async () => '/tmp',
	mediaFilePath: async () => '/tmp/x.webm',
	safeId: (s: string) => s
}));
vi.mock('./ffmpeg', () => ({ runFfmpeg: async () => {} }));
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }));

const { toCues, dropHallucinations, cleanTranscriptText, termsTail, locateFuzzy } =
	await import('./transcripts');

describe('toCues', () => {
	it('word の時刻で文ごとに切る（segment の粗い時刻は使わない）', () => {
		const segments = [
			{ start: 0, end: 13, text: 'はい、こんにちは。これはテストです。' },
			{ start: 0, end: 13, text: 'まず、この4つです。' }
		];
		const words = [
			{ word: 'はい', start: 0.4, end: 0.8 },
			{ word: '、', start: 0.8, end: 0.9 },
			{ word: 'こんにちは', start: 0.9, end: 1.6 },
			{ word: '。', start: 1.6, end: 1.7 },
			{ word: 'これは', start: 2.2, end: 2.6 },
			{ word: 'テストです', start: 2.6, end: 3.4 },
			{ word: '。', start: 3.4, end: 3.5 },
			{ word: 'まず', start: 5.0, end: 5.4 },
			{ word: '、この', start: 5.4, end: 5.8 },
			{ word: '4つです。', start: 5.8, end: 6.6 }
		];
		const cues = toCues(segments, words);
		expect(cues.map((c) => [c.startMs, c.endMs, c.text])).toEqual([
			[400, 1700, 'はい、こんにちは。'],
			[2200, 3500, 'これはテストです。'],
			[5000, 6600, 'まず、この4つです。']
		]);
	});
	it('長い文は「、」でも分け、時刻は単語から取る', () => {
		const long =
			'AIで作れるものが多すぎて、ものづくりが好きな私としては、やさしいバイブコーディングというものが好きです。';
		const words = [...long].map((ch, i) => ({ word: ch, start: i * 0.1, end: i * 0.1 + 0.1 }));
		const cues = toCues([{ start: 0, end: 10, text: long }], words);
		expect(cues.length).toBe(2);
		expect(cues[0].text).toBe('AIで作れるものが多すぎて、ものづくりが好きな私としては、');
		expect(cues[1].startMs).toBe(cues[0].endMs);
		expect(cues[1].text).toBe('やさしいバイブコーディングというものが好きです。');
	});
	it('間の segment が落ちていても（word はそのまま残る）、あとの文は自分の segment の時刻から探す', () => {
		// 落ちた segment の word が 40 文字を超えると、以前は探す範囲の外になって近くの似た並びに当たり、
		// あとのテロップが全部前にずれていった（2026-09-17）
		const gap =
			'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん';
		const texts = ['はい、始めます。', gap + 'です。', '次の話です。', '終わります。'];
		const words: { word: string; start: number; end: number }[] = [];
		const segs: { start: number; end: number; text: string }[] = [];
		let t = 0;
		for (const text of texts) {
			const start = t;
			for (const ch of text) {
				words.push({ word: ch, start: t, end: t + 0.2 });
				t += 0.2;
			}
			segs.push({ start, end: t, text });
			t += 3;
		}
		// 2 つ目の segment は落ちた（作り話として捨てた）ことにする
		const cues = toCues(
			segs.filter((_, i) => i !== 1),
			words
		);
		expect(cues.map((c) => c.text)).toEqual(['はい、始めます。', '次の話です。', '終わります。']);
		expect(cues[1].startMs).toBe(Math.round(segs[2].start * 1000));
		expect(cues[2].startMs).toBe(Math.round(segs[3].start * 1000));
	});
	it('word が無ければ segment の時刻で、始まりの重複は前の終わりから', () => {
		const cues = toCues([
			{ start: 0, end: 4, text: 'あ。' },
			{ start: 0, end: 9, text: 'い。' },
			{ start: 13, end: 18, text: 'う。' }
		]);
		expect(cues.map((c) => [c.startMs, c.endMs])).toEqual([
			[0, 4000],
			[4000, 9000],
			[13000, 18000]
		]);
	});
});

/** 「文 + 記号」の segment と、記号の無い word を作る（whisper-1 の日本語の返り方に合わせる） */
function make(sentences: string[], secPerChar = 0.2) {
	const words: { word: string; start: number; end: number }[] = [];
	let t = 0;
	for (const s of sentences) {
		const plain = s.replace(/[。、！？]/g, '');
		// 2 文字ずつの単語にする
		for (let i = 0; i < plain.length; i += 2) {
			const w = plain.slice(i, i + 2);
			words.push({ word: w, start: t, end: t + w.length * secPerChar });
			t += w.length * secPerChar;
		}
	}
	const segments = [{ id: 0, start: 0, end: t, text: sentences.join('') }];
	return { segments, words, total: t };
}

describe('toCues: 単語の時刻を文に当てる', () => {
	it('文の記号（。、）があっても、後の文ほど遅れていかない', () => {
		const sentences = Array.from({ length: 200 }, (_, i) => `これは、${i}番目の、文です。`);
		const { segments, words } = make(sentences);
		const cues = toCues(segments, words);
		expect(cues.length).toBe(sentences.length);
		// 各文の始まりは、その文の最初の単語の始まりと一致する
		let expected = 0;
		for (let i = 0; i < sentences.length; i++) {
			expect(cues[i].startMs).toBe(Math.round(expected * 1000));
			expected += sentences[i].replace(/[。、！？]/g, '').length * 0.2;
		}
	});
	it('見つからない文があっても、次の文で合わせ直す', () => {
		const sentences = ['はじめの文です。', 'つぎの文です。', 'さいごの文です。'];
		const { segments, words } = make(sentences);
		// 真ん中の文だけ表記が違う（言い直しなど）
		segments[0].text = 'はじめの文です。つぎのぶんだよ。さいごの文です。';
		const cues = toCues(segments, words);
		expect(cues[2].startMs).toBe(
			Math.round(('はじめの文です' + 'つぎの文です').length * 0.2 * 1000)
		);
	});
});

describe('dropHallucinations（prompt の言葉をそのまま吐いた作り話を落とす）', () => {
	const prompt =
		'AIに奪われない仕事、亀井ゆき、やさしいバイブコーディング、やさしい図解レコーダー。';
	it('無音の確からしさが高い prompt そのままの文は落とす', () => {
		const segs = [
			{
				start: 0,
				end: 5,
				text: 'AIに奪われない仕事は何、パート2、',
				no_speech_prob: 0.01,
				avg_logprob: -0.2
			},
			{
				start: 30,
				end: 30.5,
				text: 'やさしいバイブコーディング、',
				no_speech_prob: 0.6,
				avg_logprob: -0.9
			},
			{
				start: 33.5,
				end: 34,
				text: 'やさしい図解レコーダー。',
				no_speech_prob: 0.4,
				avg_logprob: -0.8
			}
		];
		const r = dropHallucinations(segs, prompt);
		expect(r.kept.map((s) => s.text)).toEqual(['AIに奪われない仕事は何、パート2、']);
		expect(r.dropped).toHaveLength(2);
	});
	it('本当に話している辞書の言葉（確信が高く十分長い）は残す', () => {
		const segs = [
			{ start: 0, end: 3, text: '亀井ゆきです。', no_speech_prob: 0.02, avg_logprob: -0.15 },
			{
				start: 3,
				end: 6,
				text: 'やさしい図解レコーダー。',
				no_speech_prob: 0.05,
				avg_logprob: -0.2
			}
		];
		expect(dropHallucinations(segs, prompt).kept).toHaveLength(2);
	});
	it('無音の確からしさが高くて確信も低いものと、繰り返しの壊れたものは落とす', () => {
		const segs = [
			{
				start: 0,
				end: 3,
				text: 'ご視聴ありがとうございました',
				no_speech_prob: 0.95,
				avg_logprob: -1.3
			},
			{ start: 3, end: 9, text: 'はいはいはいはいはいはいはい', compression_ratio: 3.1 },
			{ start: 9, end: 12, text: 'ふつうの文です。', no_speech_prob: 0.1 }
		];
		expect(dropHallucinations(segs, prompt).kept.map((s) => s.text)).toEqual(['ふつうの文です。']);
	});
	it('無音の確からしさが高くても、確信が高い（本当に話している）文は残す', () => {
		const segs = [
			{
				start: 144,
				end: 150,
				text: 'これ3日くらいで作れたんですよ。',
				no_speech_prob: 0.851,
				avg_logprob: -0.21
			}
		];
		expect(dropHallucinations(segs, '').kept).toHaveLength(1);
	});
});

describe('cleanTranscriptText', () => {
	it('未定義のコード（U+FF00 など）を落とし、ふつうの文字は残す', () => {
		expect(cleanTranscriptText('AIに奪われない仕事は何＀パート2、')).toBe(
			'AIに奪われない仕事は何パート2、'
		);
		expect(cleanTranscriptText('何？　パート2\n次')).toBe('何？　パート2\n次');
	});
});

describe('dropHallucinations: 辞書の言葉が末尾に連なる作り話', () => {
	const terms = ['亀井ゆき', 'やさしいバイブコーディング', 'やさしい図解レコーダー'];
	const prompt =
		'AIに奪われない仕事、配達員、経営者、亀井ゆき、やさしいバイブコーディング、やさしい図解レコーダー。';
	it('最後の segment の末尾に辞書の言葉が付いていたら、その前までを残す', () => {
		const segs = [
			{ start: 0, end: 25, text: 'AIに奪われない仕事は何、配達員、経営者、' },
			{ start: 29, end: 33.6, text: '経営者、やさしいバイブコーディング、やさしい図解レコーダー。' }
		];
		const r = dropHallucinations(segs, prompt, terms);
		expect(r.kept.map((s) => s.text)).toEqual([
			'AIに奪われない仕事は何、配達員、経営者、',
			'経営者'
		]);
	});
	it('辞書の言葉だけの segment は落とす。言葉が文の中にあるものは残す', () => {
		const segs = [
			{ start: 0, end: 3, text: '亀井ゆきです。今日はやさしい図解レコーダーの話をします。' },
			{ start: 5, end: 8, text: 'やさしいバイブコーディング、やさしい図解レコーダー。' },
			{ start: 9, end: 12, text: 'ではまた。' }
		];
		const r = dropHallucinations(segs, prompt, terms);
		expect(r.kept.map((s) => s.text)).toEqual([
			'亀井ゆきです。今日はやさしい図解レコーダーの話をします。',
			'ではまた。'
		]);
	});
	it('termsTail', () => {
		const t = termsTail('経営者、やさしいバイブコーディング、やさしい図解レコーダー。', terms);
		expect(t.rest).toBe('経営者');
		expect(t.stripped).toContain('やさしいバイブコーディング');
		expect(t.stripped).toContain('やさしい図解レコーダー');
		expect(termsTail('ではまた。', terms)).toEqual({ rest: 'ではまた。', stripped: '' });
	});
});

describe('locateFuzzy（多少違う文を単語の列から探す）', () => {
	it('表記が少し違っても位置が見つかる', () => {
		const hay = 'はいAIに奪われない仕事は何パート2です建設業奪われますエンジニア奪われます';
		expect(locateFuzzy(hay, '建設業は奪われます', 0)).toEqual({ start: 20, end: 27 });
		expect(locateFuzzy(hay, 'エンジニアは奪われます', 28)).toEqual({ start: 28, end: 37 });
	});
	it('全然違う文は見つからない', () => {
		expect(locateFuzzy('あいうえおかきくけこ', 'まみむめもやゆよ', 0)).toBeNull();
	});
});

describe('toCues: 別のモデルの文でも単語の時刻に当たる', () => {
	it('動詞を落とした単語列に、動詞の付いた文を合わせる', () => {
		const words = [
			'配達員',
			'経営者',
			'詳しく',
			'見て',
			'みたい',
			'方は',
			'動画を',
			'見て',
			'ください'
		].map((w, i) => ({ word: w, start: 20 + i, end: 21 + i }));
		const cues = toCues(
			[
				{
					start: 0,
					end: 30,
					text: '配達員奪われます、経営者残ります。詳しく見てみたい方は動画を見てください。'
				}
			],
			words
		);
		expect(cues.map((c) => c.text)).toEqual([
			'配達員奪われます、経営者残ります。',
			'詳しく見てみたい方は動画を見てください。'
		]);
		expect(cues[0].startMs).toBe(20000);
		expect(cues[1].startMs).toBe(22000);
	});
});
