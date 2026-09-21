import type { Api } from '$shared/types';

/**
 * アプリの殻（Electron）が公開する window.api への入口。
 * 普通のブラウザーで開いたときは、何が足りないかを分かる形で失敗させる。
 */
export function api(): Api {
	if (typeof window === 'undefined' || !window.api) {
		throw new Error('このアプリは Electron の中でだけ動きます。`npm run dev` で起動してください。');
	}
	return window.api;
}

/** ノードの画像の表示用 URL（保存先の images/ を media:// で配信している） */
export function imageUrl(fileName: string): string {
	return `media://local/images/${encodeURIComponent(fileName)}`;
}

export function hasApi(): boolean {
	return typeof window !== 'undefined' && !!window.api;
}
