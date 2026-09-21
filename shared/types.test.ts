import { describe, expect, it } from 'vitest';
import { isPosted, withPostRecords, type Recording } from './types';

describe('isPosted と取り消した予約', () => {
	const ex = { id: 'legacy', fileName: 'a.mp4', size: 1, createdAt: 1789430400000 };
	const rec = {
		posts: [
			{ platform: 'instagram' as const, at: 1789460040000, jobId: 'j1' },
			{ platform: 'x' as const, at: 1789460040000, jobId: 'j2' }
		]
	};
	it('仕事が取り消し・失敗なら投稿済みに数えない', () => {
		const jobs = { j1: { status: 'canceled' }, j2: { status: 'done' } };
		expect(isPosted(rec, ex, 'instagram', jobs)).toBe(false);
		expect(isPosted(rec, ex, 'x', jobs)).toBe(true);
		expect(isPosted(rec, ex, 'instagram', { j1: { status: 'failed' } })).toBe(false);
	});
	it('仕事の様子が分からなければ記録どおり', () => {
		expect(isPosted(rec, ex, 'instagram')).toBe(true);
		expect(isPosted(rec, ex, 'instagram', {})).toBe(true);
	});
	it('手で付けた印はハブの様子より優先', () => {
		const marked = { ...ex, posted: { instagram: true } };
		expect(isPosted(rec, marked, 'instagram', { j1: { status: 'canceled' } })).toBe(true);
	});
});

describe('withPostRecords', () => {
	it('記録を足し、その投稿先の手の印を消す（ほかの印は残す）', () => {
		const rec = {
			id: 'r',
			title: 't',
			posts: [],
			exports: [
				{
					id: 'e1',
					fileName: 'a.mp4',
					size: 1,
					createdAt: 1,
					posted: { instagram: false, x: false, youtube: true }
				}
			]
		} as unknown as Recording;
		const out = withPostRecords(rec, 'e1', [{ platform: 'instagram', at: 2, jobId: 'j' }]);
		expect(out.posts).toHaveLength(1);
		expect(out.posts?.[0].exportId).toBe('e1');
		expect(out.exports?.[0].posted).toEqual({ x: false, youtube: true });
		expect(out.export).toBeUndefined();
	});
});
