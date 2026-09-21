import { app, dialog, type BrowserWindow } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { BgmTrack } from '../../shared/types';
import { libraryPath } from './library';

/**
 * BGM の音楽ファイル。アプリ自身の置き場所（userData/bgm）に持つ。
 * 保存先フォルダー（既定はダウンロードの中）とは別なので、ダウンロードの整理や保存先の変更で消えない。
 * 以前の置き場所（<保存先>/bgm）にある曲は、最初に一覧を出すときに移す。
 */

const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.flac', '.aiff', '.aif']);

export function isAudioFile(name: string): boolean {
	return AUDIO_EXT.has(path.extname(name).toLowerCase());
}

export function bgmDir(): string {
	return path.join(app.getPath('userData'), 'bgm');
}

export async function ensureBgmDir(): Promise<string> {
	const dir = bgmDir();
	await fs.mkdir(dir, { recursive: true });
	return dir;
}

/** 1 つのファイルを bgm/ へ移す（別ディスクなら写して消す）。同名が既にあれば元を残して false */
async function moveIn(from: string, to: string): Promise<boolean> {
	try {
		await fs.access(to);
		return false;
	} catch {
		/* 無いので移す */
	}
	try {
		await fs.rename(from, to);
	} catch {
		await fs.copyFile(from, to);
		await fs.rm(from, { force: true });
	}
	return true;
}

let migrated = false;
/** 以前の置き場所（保存先の bgm/）から移す。一度だけ */
async function migrateFromLibrary(): Promise<void> {
	if (migrated) return;
	migrated = true;
	const old = path.join(await libraryPath(), 'bgm');
	let names: string[] = [];
	try {
		names = await fs.readdir(old);
	} catch {
		return;
	}
	const dir = await ensureBgmDir();
	for (const name of names.filter(isAudioFile)) {
		try {
			await moveIn(path.join(old, name), path.join(dir, name));
		} catch (err) {
			console.warn(`BGM を移せませんでした: ${name}`, err);
		}
	}
	// 空になったら古いフォルダーは消す（消せなければそのまま）
	await fs.rmdir(old).catch(() => {});
}

export async function listBgm(): Promise<BgmTrack[]> {
	await migrateFromLibrary();
	const dir = await ensureBgmDir();
	let names: string[] = [];
	try {
		names = await fs.readdir(dir);
	} catch {
		return [];
	}
	const tracks: BgmTrack[] = [];
	for (const name of names) {
		if (!isAudioFile(name)) continue;
		try {
			const st = await fs.stat(path.join(dir, name));
			if (st.isFile()) tracks.push({ fileName: name, size: st.size });
		} catch {
			/* 消えた直後などは無視 */
		}
	}
	return tracks.sort((a, b) => a.fileName.localeCompare(b.fileName, 'ja'));
}

/** 曲のファイルの場所（無ければ null） */
export async function bgmFilePath(fileName: string): Promise<string | null> {
	const file = path.join(await ensureBgmDir(), path.basename(fileName));
	try {
		await fs.access(file);
		return file;
	} catch {
		return null;
	}
}

/** 指定したファイルを bgm/ にコピーする。同名があれば飛ばす。追加した数を返す */
export async function copyIntoBgm(files: string[]): Promise<number> {
	const dir = await ensureBgmDir();
	let added = 0;
	for (const file of files) {
		if (!isAudioFile(file)) continue;
		const dest = path.join(dir, path.basename(file));
		try {
			await fs.access(dest);
			continue; // すでにある
		} catch {
			/* 無いのでコピーする */
		}
		try {
			await fs.copyFile(file, dest);
			added += 1;
		} catch (err) {
			console.warn(`BGM をコピーできませんでした: ${file}`, err);
		}
	}
	return added;
}

export async function addBgmViaDialog(win: BrowserWindow | null): Promise<number> {
	const result = await dialog.showOpenDialog(win ?? undefined!, {
		title: 'BGM にする音楽ファイルを選ぶ',
		defaultPath: app.getPath('downloads'),
		buttonLabel: 'BGM に追加',
		filters: [{ name: '音楽', extensions: ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'flac', 'aiff'] }],
		properties: ['openFile', 'multiSelections']
	});
	if (result.canceled) return 0;
	return copyIntoBgm(result.filePaths);
}

/**
 * ダウンロードフォルダーの直下にある音楽ファイルを全部 bgm/ へ移動する
 * （アプリの中に持つ形にして、ダウンロードフォルダーの整理で消えないようにする）。
 * 同名が既にあればダウンロード側を残す。
 */
export async function importDownloads(): Promise<number> {
	const src = app.getPath('downloads');
	let names: string[] = [];
	try {
		names = await fs.readdir(src);
	} catch {
		return 0;
	}
	const dir = await ensureBgmDir();
	let moved = 0;
	for (const name of names.filter(isAudioFile)) {
		try {
			if (await moveIn(path.join(src, name), path.join(dir, name))) moved += 1;
		} catch (err) {
			console.warn(`BGM を移動できませんでした: ${name}`, err);
		}
	}
	return moved;
}

export async function removeBgm(fileName: string): Promise<void> {
	await fs.rm(path.join(await ensureBgmDir(), path.basename(fileName)), { force: true });
}
