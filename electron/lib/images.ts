import { app, dialog, type BrowserWindow } from 'electron';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ensureLibrary } from './library';

/** ノードに付ける画像。保存先の images/ に写して、ファイル名だけをノートに持つ */

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.bmp', '.svg']);

export async function addImageViaDialog(win: BrowserWindow | null): Promise<string | null> {
	const result = await dialog.showOpenDialog(win ?? undefined!, {
		title: 'ノードに付ける画像を選ぶ',
		defaultPath: app.getPath('downloads'), // 画像はダウンロードフォルダーに落とすことが多いので、そこから
		buttonLabel: 'この画像を付ける',
		filters: [{ name: '画像', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] }],
		properties: ['openFile']
	});
	if (result.canceled || result.filePaths.length === 0) return null;
	const src = result.filePaths[0];
	const ext = path.extname(src).toLowerCase();
	if (!IMAGE_EXT.has(ext)) throw new Error('画像ファイルを選んでください。');
	const root = await ensureLibrary();
	const fileName = `${randomUUID()}${ext}`;
	await fs.copyFile(src, path.join(root, 'images', fileName));
	return fileName;
}

/** 画面から受け取った画像の中身を images/ に保存する（ドラッグ＆ドロップ用）。ファイル名を返す */
export async function importImageData(name: string, data: Uint8Array): Promise<string> {
	if (!(data instanceof Uint8Array) || data.byteLength === 0) throw new Error('画像が空です。');
	if (data.byteLength > 50 * 1024 * 1024) throw new Error('画像が大きすぎます（50MB まで）。');
	const ext = path.extname(String(name ?? '')).toLowerCase();
	if (!IMAGE_EXT.has(ext))
		throw new Error('画像ファイル（png / jpg / gif / webp など）を落としてください。');
	const root = await ensureLibrary();
	const fileName = `${randomUUID()}${ext}`;
	await fs.writeFile(path.join(root, 'images', fileName), data);
	return fileName;
}

export async function removeImage(fileName: string): Promise<void> {
	const root = await ensureLibrary();
	await fs.rm(path.join(root, 'images', path.basename(fileName)), { force: true });
}
