/**
 * 投稿管理の「確定する」が送る文（運用保守 K228）。
 * 確定したときの文と、いまの文が同じものだけを送る。本物の SNS・ハブ・YouTube には送らない（postOne を作り物にする）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExportInfo, PostDraft, Recording } from '$shared/types';

const lib = vi.hoisted(() => ({
	recordings: [] as Recording[],
	notes: [] as unknown[],
	updateRecording: vi.fn(async () => null)
}));
const postOne = vi.hoisted(() => vi.fn());
vi.mock('$lib/api', () => ({
	api: () => ({ publish: { onProgress: () => {}, cancel: async () => {} } })
}));
vi.mock('$lib/stores/library.svelte', () => ({ library: lib }));
vi.mock('$lib/stores/toast.svelte', () => ({ toast: { show: vi.fn(), error: vi.fn() } }));
vi.mock('$lib/publish/run', () => ({
	postOne,
	progressId: (r: string, p: string) => `${r}:${p}`
}));

import { schedule } from './schedule.svelte';

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
const exportOf = (over: Partial<ExportInfo>): ExportInfo => ({
	id: 'e1',
	fileName: 'r1-e1.mp4',
	size: 1,
	createdAt: 1,
	...over
});
const recordingWith = (ex: ExportInfo) =>
	({ id: 'r1', title: '収録', noteId: 'n1', exports: [ex], posts: [] }) as unknown as Recording;
/** 確定したときの書き出し */
const confirmed = (text: string) =>
	exportOf({ drafts: { x: draft(text) }, confirmedAt: 1000, confirmedDrafts: { x: draft(text) } });

/** 投稿管理で、ex を X に置いてから、いまの収録を latest にして「確定する」を押す */
async function placeAndApply(placed: ExportInfo, latest: ExportInfo) {
	schedule.pendings = [
		{
			id: 'p1',
			kind: 'place',
			recording: recordingWith(placed),
			ex: placed,
			remaining: ['x'],
			when: new Date(Date.now() + 86_400_000)
		}
	];
	lib.recordings = [recordingWith(latest)];
	await schedule.applyAll();
}

describe('投稿管理の「確定する」（運用保守 K228）', () => {
	beforeEach(() => {
		postOne.mockReset();
		postOne.mockImplementation(async (platform: string) => ({
			record: { platform, at: Date.now(), exportId: 'e1' }
		}));
		schedule.lastErrors = [];
	});

	it('確定したときのままの文は送る', async () => {
		await placeAndApply(confirmed('確定した文'), confirmed('確定した文'));
		expect(postOne).toHaveBeenCalledTimes(1);
		expect(postOne.mock.calls[0][3].text).toBe('確定した文');
		expect(schedule.lastErrors).toEqual([]);
	});

	it('確定の印が残ったまま文が変わっている（前の版で、AI で作り直した文が印つきで保存された）ときは送らない', async () => {
		const stale = exportOf({
			drafts: { x: draft('AI で作り直した文') },
			confirmedAt: 1000,
			confirmedDrafts: { x: draft('確定した文') }
		});
		await placeAndApply(stale, stale);
		expect(postOne).not.toHaveBeenCalled();
		expect(schedule.lastErrors.join()).toMatch(/もう一度「投稿文を確定する」/);
	});

	it('写しの無い、前の版で確定したもの（いまの文が確定のときのままか分からない）は送らない', async () => {
		const legacy = exportOf({ drafts: { x: draft('文') }, confirmedAt: 1000 });
		await placeAndApply(legacy, legacy);
		expect(postOne).not.toHaveBeenCalled();
		expect(schedule.lastErrors).toHaveLength(1);
	});

	it('置いたあとで文を直した（確定の印が外れた）ときは、置いたときの文も、直した文も送らない', async () => {
		const edited = exportOf({ drafts: { x: draft('あとで直した文') } });
		await placeAndApply(confirmed('確定した文'), edited);
		expect(postOne).not.toHaveBeenCalled();
		expect(schedule.lastErrors).toHaveLength(1);
	});

	it('置いたあとで直して、もう一度確定したときは、新しく確定した文を送る', async () => {
		await placeAndApply(confirmed('前に確定した文'), confirmed('もう一度確定した文'));
		expect(postOne).toHaveBeenCalledTimes(1);
		expect(postOne.mock.calls[0][3].text).toBe('もう一度確定した文');
	});
});
