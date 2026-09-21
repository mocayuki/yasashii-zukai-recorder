import type { HubPlatform } from '../../../shared/publish';
import type { Publisher } from './types';
import { xPublisher } from './x';
import { facebookPublisher, instagramPublisher, threadsPublisher } from './meta';
import { tiktokPublisher } from './tiktok';

/** 投稿先の一覧（この順に画面に並ぶ） */
const publishers: Partial<Record<HubPlatform, Publisher>> = {
	x: xPublisher,
	threads: threadsPublisher,
	instagram: instagramPublisher,
	facebook: facebookPublisher,
	tiktok: tiktokPublisher
};

export function getPublisher(platform: string): Publisher | null {
	return (publishers as Record<string, Publisher | undefined>)[platform] ?? null;
}

export const HUB_PLATFORMS = Object.keys(publishers) as HubPlatform[];
