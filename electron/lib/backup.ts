import { app, dialog, type BrowserWindow } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { BackupResult } from '../../shared/types';
import { ensureBgmDir } from './bgm';
import { ensureLibrary } from './library';

/**
 * バックアップ = 保存先フォルダーを丸ごと別の場所へコピーする。
 * ノート・収録・BGM はすべて普通のファイルなので、コピーしたフォルダーを
 * 「保存先」に指定し直せばそのまま使える（特別な形式にはしない）。
 */

function stamp(d = new Date()): string {
	const p = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`;
}

async function copyTree(from: string, to: string): Promise<{ files: number; bytes: number }> {
	let files = 0;
	let bytes = 0;
	await fs.mkdir(to, { recursive: true });
	for (const entry of await fs.readdir(from, { withFileTypes: true })) {
		if (entry.name.startsWith('.')) continue; // .DS_Store など
		const src = path.join(from, entry.name);
		const dst = path.join(to, entry.name);
		if (entry.isDirectory()) {
			const r = await copyTree(src, dst);
			files += r.files;
			bytes += r.bytes;
		} else if (entry.isFile()) {
			await fs.copyFile(src, dst);
			files += 1;
			bytes += (await fs.stat(src)).size;
		}
	}
	return { files, bytes };
}

export async function backupViaDialog(win: BrowserWindow | null): Promise<BackupResult | null> {
	const root = await ensureLibrary();
	const result = await dialog.showOpenDialog(win ?? undefined!, {
		title: 'バックアップを置くフォルダーを選ぶ',
		defaultPath: app.getPath('documents'),
		buttonLabel: 'ここにバックアップを作る',
		properties: ['openDirectory', 'createDirectory']
	});
	if (result.canceled || result.filePaths.length === 0) return null;
	const parent = result.filePaths[0];
	if (parent === root || parent.startsWith(root + path.sep)) {
		throw new Error('保存先フォルダーの中にはバックアップを作れません。別の場所を選んでください。');
	}
	const dest = path.join(parent, `やさしい図解レコーダー バックアップ ${stamp()}`);
	const { files, bytes } = await copyTree(root, dest);
	// BGM はアプリ側の置き場所にあるので、それも一緒に入れる
	const bgm = await copyTree(await ensureBgmDir(), path.join(dest, 'bgm'));
	return { path: dest, files: files + bgm.files, bytes: bytes + bgm.bytes };
}
