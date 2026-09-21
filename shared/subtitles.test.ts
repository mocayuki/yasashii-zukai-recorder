import { describe, expect, it } from 'vitest';
import { applyTranslation, parseTranslation, pickUntranslated, srtFileName } from './subtitles';

const cues = [
	{ id: 'a', startMs: 0, endMs: 1000, text: 'こんにちは。' },
	{ id: 'b', startMs: 1000, endMs: 2000, text: '今日は晴れです。' }
];

describe('字幕の外国語版', () => {
	it('訳していないもの・元の文が変わったものだけを選ぶ', () => {
		const cache = { a: { src: 'こんにちは。', text: 'Hello.' }, b: { src: '昔の文', text: 'old' } };
		expect(pickUntranslated(cues, cache).map((c) => c.id)).toEqual(['b']);
		expect(pickUntranslated(cues, undefined).map((c) => c.id)).toEqual(['a', 'b']);
	});
	it('訳を当てる。無いものは元のまま', () => {
		const cache = { a: { src: 'こんにちは。', text: 'Hello.' } };
		expect(applyTranslation(cues, cache).map((c) => c.text)).toEqual([
			'Hello.',
			'今日は晴れです。'
		]);
	});
	it('返事の JSON を読む。壊れていれば空', () => {
		expect([
			...parseTranslation('{"items":[{"id":"a","text":"Hello."},{"id":"b","text":""}]}')
		]).toEqual([['a', 'Hello.']]);
		expect(parseTranslation('not json').size).toBe(0);
	});
	it('ファイル名', () => {
		expect(srtFileName('題名', 'ja')).toBe('題名.ja.srt');
		expect(srtFileName('題名', 'pt-BR')).toBe('題名.pt-BR.srt');
	});
});
