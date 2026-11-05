import { describe, expect, it } from 'vitest';
import { clipTranscript, fitX, postingHoursError, shortsTitle, trimBounds } from './publish';
import {
	defaultTargets,
	draftsStillConfirmed,
	exportStatus,
	parseTags,
	scheduleError,
	tidyDescription,
	withDrafts,
	xWeightedLength,
	hubTextError
} from './publish';
import type { ExportInfo, PostDraft } from './types';

describe('投稿の規則', () => {
	it('既定の投稿先は 5 つ（TikTok と note は既定でオフ）', () => {
		expect(defaultTargets('portrait')).not.toContain('tiktok');
		expect(defaultTargets('portrait')).not.toContain('note');
		expect(defaultTargets('landscape')).toContain('facebook');
		expect(defaultTargets('landscape')).toHaveLength(5);
		expect(defaultTargets('landscape')).toContain('x');
	});
	it('タグは区切りの種類を問わず配列にし、重複と空を除く', () => {
		expect(parseTags('AI, 図解、#YouTube\nAI')).toEqual(['AI', '図解', 'YouTube']);
	});
	it('予約は 15 分以上あとでなければならない', () => {
		const now = Date.parse('2026-09-15T00:00:00Z');
		expect(scheduleError(null, now)).toBeNull();
		expect(scheduleError('2026-09-15T00:10:00Z', now)).toMatch(/15 分/);
		expect(scheduleError('2026-09-15T01:00:00Z', now)).toBeNull();
		expect(scheduleError('not a date', now)).toMatch(/正しく/);
	});
	it('説明文の空行を整える', () => {
		expect(tidyDescription('a\r\n\r\n\r\n\r\nb  \n')).toBe('a\n\nb');
	});
});

describe('xWeightedLength', () => {
	it('日本語は 2、英数は 1、URL は 23', () => {
		expect(xWeightedLength('abc')).toBe(3);
		expect(xWeightedLength('あいう')).toBe(6);
		expect(xWeightedLength('見て https://example.com/very/long/path/that/goes/on')).toBe(
			4 + 1 + 23
		);
	});
	it('hubTextError は上限を超えたときだけ文句を言う', () => {
		expect(hubTextError('x', 'あ'.repeat(140))).toBeNull();
		expect(hubTextError('x', 'あ'.repeat(141))).toMatch(/280/);
		expect(hubTextError('threads', 'a'.repeat(500))).toBeNull();
		expect(hubTextError('threads', 'a'.repeat(501))).toMatch(/500/);
	});
});

describe('compose の小道具', () => {
	it('fitX は 280 に収める', () => {
		expect(fitX('あ'.repeat(100))).toBe('あ'.repeat(100));
		const t = fitX('あ'.repeat(200));
		expect(t.endsWith('…')).toBe(true);
		expect(xWeightedLength(t)).toBeLessThanOrEqual(280);
	});
	it('clipTranscript は長いときだけ切る', () => {
		expect(clipTranscript('abc')).toBe('abc');
		const c = clipTranscript('x'.repeat(20000), 1000);
		expect(c.length).toBeLessThan(1100);
		expect(c).toContain('中略');
	});
});

describe('trimBounds', () => {
	it('上限と既定を動画の長さで丸める', () => {
		expect(trimBounds('x', 300)).toEqual({ max: 140, initial: 60 });
		expect(trimBounds('x', 45.7)).toEqual({ max: 45, initial: 45 });
		expect(trimBounds('facebook', 300)).toEqual({ max: 300, initial: 300 });
		expect(trimBounds('instagram', 100)).toEqual({ max: 90, initial: 60 });
	});
});

describe('shortsTitle', () => {
	it('縦のときだけ「 #Shorts」を付け、二重には付けない。前の「 /ショート」は付け替える', () => {
		expect(shortsTitle('題', 'portrait')).toBe('題 #Shorts');
		expect(shortsTitle('題 #Shorts', 'portrait')).toBe('題 #Shorts');
		expect(shortsTitle('題 /ショート', 'portrait')).toBe('題 #Shorts');
		expect(shortsTitle('題', 'landscape')).toBe('題');
		expect(shortsTitle('題 /ショート', 'landscape')).toBe('題');
	});
});

describe('postingHoursError', () => {
	it('12:00〜23:30 だけ通す', () => {
		const at = (h: number, m: number) => {
			const d = new Date();
			d.setDate(d.getDate() + 1);
			d.setHours(h, m, 0, 0);
			return d.toISOString();
		};
		expect(postingHoursError(at(12, 0))).toBeNull();
		expect(postingHoursError(at(11, 30))).toMatch(/12:00/);
		expect(postingHoursError(at(23, 30))).toBeNull();
		expect(postingHoursError(at(23, 45))).toMatch(/12:00/);
		expect(postingHoursError(at(6, 0))).toMatch(/12:00/);
	});
});

describe('投稿文の確定（運用保守 K228: 確定のあとで変わった文を、投稿管理から送らない）', () => {
	const draft = (text: string): PostDraft => ({
		on: true,
		title: '題',
		text,
		tagsText: '',
		thumbMode: 'auto',
		thumbnailPath: null,
		startSec: null,
		trimSec: 60,
		privacy: 'public'
	});
	const ex = (over: Partial<ExportInfo> = {}): ExportInfo => ({
		id: 'e1',
		fileName: 'r1-e1.mp4',
		size: 1,
		createdAt: 1,
		...over
	});
	const noPosts = { posts: [] };

	it('確定すると、確定の印とそのときの文の写しが付く', () => {
		const saved = withDrafts(ex(), { x: draft('確定した文') }, true, 1000);
		expect(saved.confirmedAt).toBe(1000);
		expect(saved.confirmedDrafts).toEqual({ x: draft('確定した文') });
		expect(draftsStillConfirmed(saved)).toBe(true);
		expect(exportStatus(noPosts, saved)).toBe('ready');
	});
	it('確定のあとで文を直して自動で保存すると、確定の印が外れる', () => {
		const confirmed = withDrafts(ex(), { x: draft('確定した文') }, true, 1000);
		const edited = withDrafts(confirmed, { x: draft('AI で作り直した文') }, false);
		expect(edited.confirmedAt).toBeUndefined();
		expect(edited.confirmedDrafts).toBeUndefined();
		expect(edited.drafts?.x?.text).toBe('AI で作り直した文');
		expect(draftsStillConfirmed(edited)).toBe(false);
		expect(exportStatus(noPosts, edited)).toBe('writing');
	});
	it('文が同じままの自動の保存（キーの順番・空の値の有る無しだけちがう）では、確定の印は残る', () => {
		const confirmed = withDrafts(ex(), { x: draft('確定した文') }, true, 1000);
		const { startSec: _drop, ...rest } = draft('確定した文');
		const reordered = Object.fromEntries(Object.entries(rest).reverse()) as unknown as PostDraft;
		const saved = withDrafts(confirmed, { x: reordered }, false);
		expect(saved.confirmedAt).toBe(1000);
		expect(draftsStillConfirmed(saved)).toBe(true);
	});
	it('題・長さ・オンオフが変わっても、確定の印が外れる', () => {
		const confirmed = withDrafts(ex(), { x: draft('文') }, true, 1000);
		expect(
			withDrafts(confirmed, { x: { ...draft('文'), title: '別の題' } }, false).confirmedAt
		).toBeUndefined();
		expect(
			withDrafts(confirmed, { x: { ...draft('文'), trimSec: 30 } }, false).confirmedAt
		).toBeUndefined();
		expect(
			withDrafts(confirmed, { x: draft('文'), threads: draft('文') }, false).confirmedAt
		).toBeUndefined();
	});
	it('TikTok の設定は、画面を開くたびに入れなおされても同じなら印が残り、変わると外れる', () => {
		const tiktok = {
			privacy: 'SELF_ONLY',
			allowComment: true,
			allowDuet: false,
			allowStitch: false,
			commercial: false,
			brandOrganic: false,
			brandContent: false
		} as const;
		const withTikTok = { ...draft('文'), tiktok };
		const confirmed = withDrafts(ex(), { tiktok: withTikTok }, true, 1000);
		expect(
			withDrafts(confirmed, { tiktok: { ...withTikTok, tiktok: { ...tiktok } } }, false).confirmedAt
		).toBe(1000);
		expect(
			withDrafts(
				confirmed,
				{ tiktok: { ...withTikTok, tiktok: { ...tiktok, allowComment: false } } },
				false
			).confirmedAt
		).toBeUndefined();
	});
	it('確定の印が付いたまま文が変わっている書き出し（前の形のデータ）は、確定していないとみなす', () => {
		const stale = ex({
			drafts: { x: draft('あとで直した文') },
			confirmedAt: 1000,
			confirmedDrafts: { x: draft('確定した文') }
		});
		expect(draftsStillConfirmed(stale)).toBe(false);
		expect(exportStatus(noPosts, stale)).toBe('writing');
		// 写しの無い、前の版で確定したもの（いまの文が確定のときのままか分からない）
		const legacy = ex({ drafts: { x: draft('文') }, confirmedAt: 1000 });
		expect(draftsStillConfirmed(legacy)).toBe(false);
		expect(exportStatus(noPosts, legacy)).toBe('writing');
	});
	it('全部の投稿先に出し終わったものは、写しが無くても配信済みのまま', () => {
		const legacy = ex({ drafts: { x: draft('文') }, confirmedAt: 1000 });
		expect(exportStatus({ posts: [{ platform: 'x', at: 2000, exportId: 'e1' }] }, legacy)).toBe(
			'done'
		);
	});
});
