import { promises as fs } from 'node:fs';
import type { StorageInfo } from '../../shared/types';
import { ensureLibrary, listNotes, listRecordings, usedBytes } from './library';

/** ディスクの空き容量。取れない環境では null */
async function diskSpace(dir: string): Promise<{ free: number; total: number } | null> {
	try {
		const st = await fs.statfs(dir);
		return {
			free: Number(st.bavail) * Number(st.bsize),
			total: Number(st.blocks) * Number(st.bsize)
		};
	} catch {
		return null;
	}
}

export async function storageInfo(): Promise<StorageInfo> {
	const root = await ensureLibrary();
	const [used, disk, notes, recordings] = await Promise.all([
		usedBytes(),
		diskSpace(root),
		listNotes(),
		listRecordings()
	]);
	return {
		libraryPath: root,
		usedBytes: used,
		freeBytes: disk?.free ?? null,
		totalBytes: disk?.total ?? null,
		noteCount: notes.length,
		recordingCount: recordings.length
	};
}
