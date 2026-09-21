/**
 * 実際に 1 件投稿（または予約）する。SNS 投稿の画面の欄からも、投稿管理のドラッグからも、ここを通る。
 * YouTube はアプリから直接、ほかは投稿ハブ経由
 */
import type { ExportInfo, Note, PostDraft, PostRecord, Recording } from '$shared/types';
import {
	parseTags,
	type HubJob,
	type HubPlatform,
	type Platform,
	type TikTokPostOptions,
	DURATION_LIMITS
} from '$shared/publish';
import { api } from '$lib/api';

export interface PostOutcome {
	record: PostRecord;
	/** ハブ経由のときの仕事（すぐ投稿なら終わるまで hubStep で追いかける） */
	job?: HubJob;
	/** YouTube のサムネの注意など */
	warning?: string;
}

/** 進み具合の id（publish:progress の id）。欄はこれで自分の分を拾う */
export const progressId = (recordingId: string, platform: Platform) => `${recordingId}:${platform}`;

export async function postOne(
	platform: Platform,
	recording: Recording,
	ex: ExportInfo,
	draft: PostDraft,
	note: Note | null,
	publishAtIso: string | null
): Promise<PostOutcome> {
	if (platform === 'note')
		throw new Error(
			'note は自動では投稿できません。SNS投稿の note の欄からコピーして貼ってください'
		);
	const info = await api().recordings.exportInfo(recording.id, ex.id);
	if (!info) throw new Error('書き出した動画が見つかりません');
	const orientation = note?.orientation === 'portrait' ? 'portrait' : 'landscape';
	const at = Date.now();
	if (platform === 'youtube') {
		const r = await api().publish.youtubeUpload(recording.id, {
			filePath: info.path,
			recordingId: recording.id,
			title: draft.title.trim(),
			description: draft.text,
			tags: parseTags(draft.tagsText),
			privacy: publishAtIso ? 'private' : draft.privacy,
			publishAt: publishAtIso,
			thumbnailPath: draft.thumbMode === 'auto' ? null : draft.thumbnailPath,
			orientation
		});
		return {
			record: {
				platform,
				at,
				scheduledAt: publishAtIso,
				url: r.url,
				videoId: r.videoId,
				exportId: ex.id
			},
			warning: r.thumbnailWarning
		};
	}
	// 何秒から何秒までを送るか。終わりは、動画の長さが分かっていてそれより十分短いときだけ切る。
	// 長さが分からない（古い書き出し）なら、指定があればそのまま切る（動画より長い指定は ffmpeg が最後で止まるだけ）。
	// 投稿先の上限（X 140 秒など）を超えるものは、指定が無くても上限で切る（始まりから数える）
	const durSec = info.durationMs ? info.durationMs / 1000 : null;
	const limit = DURATION_LIMITS[platform].max;
	const startSec = draft.startSec && draft.startSec > 0 ? draft.startSec : null;
	const from = startSec ?? 0;
	let trimSec: number | null =
		draft.trimSec && (durSec === null || draft.trimSec < durSec - 0.5) ? draft.trimSec : null;
	if (
		limit &&
		(trimSec === null || trimSec - from > limit) &&
		(durSec === null || durSec - from > limit + 0.5)
	)
		trimSec = from + limit;
	const job = await api().publish.hubPost(progressId(recording.id, platform), info.path, {
		platform: platform as HubPlatform,
		text: draft.text.trim(),
		scheduledAt: publishAtIso,
		orientation,
		ref: recording.id,
		startSec,
		trimSec,
		...(platform === 'threads' && draft.topic?.trim() ? { topic: draft.topic.trim() } : {}),
		// 画面の draft は Svelte の proxy なので、IPC に渡す前に素のオブジェクトにする（そのままだと "could not be cloned"）
		...(platform === 'tiktok' && draft.tiktok
			? { tiktok: JSON.parse(JSON.stringify(draft.tiktok)) as TikTokPostOptions }
			: {})
	});
	return {
		record: {
			platform,
			at,
			scheduledAt: publishAtIso,
			jobId: job.id,
			exportId: ex.id,
			...(trimSec ? { seconds: trimSec } : {}),
			...(startSec ? { fromSec: startSec } : {})
		},
		job
	};
}
