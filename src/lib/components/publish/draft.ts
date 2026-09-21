import type { ExportInfo, PostDraft } from '$shared/types';
import { defaultTargets, PLATFORMS, shortsTitle, type Platform } from '$shared/publish';
import type { Orientation } from '$shared/types';

/** 投稿先 1 つぶんの下書き（画面で編集する。確定すると ExportInfo.drafts に保存） */
export type Draft = PostDraft;

export function emptyDraft(on: boolean, title: string, thumbnailPath: string | null = null): Draft {
	return {
		on,
		title,
		text: title,
		tagsText: '',
		thumbMode: thumbnailPath ? 'file' : 'sheet',
		thumbnailPath,
		startSec: null,
		trimSec: null,
		privacy: 'public'
	};
}

export type Drafts = Record<Platform, Draft>;

/** 保存してある投稿文があればそこから、無ければ既定で作る */
export function initialDrafts(
	ex: ExportInfo | null,
	orientation: Orientation,
	title: string,
	thumbnailPath: string | null
): Drafts {
	const targets = defaultTargets(orientation);
	return Object.fromEntries(
		PLATFORMS.map((p) => {
			const saved = ex?.drafts?.[p.id];
			return [
				p.id,
				saved
					? {
							...emptyDraft(saved.on, title),
							...saved,
							// 縦の YouTube の題は「 #Shorts」に付け替える（前に保存した「 /ショート」も）
							...(p.id === 'youtube' && orientation === 'portrait'
								? { title: shortsTitle(saved.title, orientation) }
								: {})
						}
					: {
							...emptyDraft(
								targets.includes(p.id),
								title,
								p.id === 'youtube' ? thumbnailPath : null
							),
							...(p.id === 'youtube' ? { title: shortsTitle(title, orientation) } : {})
						}
			];
		})
	) as Drafts;
}
