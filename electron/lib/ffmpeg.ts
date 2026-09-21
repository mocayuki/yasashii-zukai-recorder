import { app } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * 同梱の ffmpeg（npm の ffmpeg-static）を動かす。
 * 配布版では asar の外（app.asar.unpacked）に置かれるので、そちらの道を使う。
 */

export function ffmpegPath(): string {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const bundled = require('ffmpeg-static') as string;
	return app.isPackaged ? bundled.replace('app.asar', 'app.asar.unpacked') : bundled;
}

export async function ffmpegAvailable(): Promise<boolean> {
	try {
		await fs.access(ffmpegPath());
		return true;
	} catch {
		return false;
	}
}

export interface RunOptions {
	/** 全体の長さ（ms）。進み具合の計算に使う */
	totalMs: number;
	onProgress?: (ratio: number) => void;
	signal?: AbortSignal;
}

/**
 * ffmpeg を走らせ、終わるまで待つ。`-progress pipe:1` の out_time_us から進み具合を出す。
 * 失敗したら stderr の末尾を含む Error を投げる。
 */
export function runFfmpeg(args: string[], opts: RunOptions): Promise<void> {
	return new Promise((resolve, reject) => {
		const child: ChildProcess = spawn(
			ffmpegPath(),
			['-hide_banner', '-nostats', '-y', '-progress', 'pipe:1', ...args],
			{ stdio: ['ignore', 'pipe', 'pipe'] }
		);
		let stderr = '';
		let outBuf = '';
		let aborted = false;
		const onAbort = () => {
			aborted = true;
			child.kill('SIGKILL');
		};
		opts.signal?.addEventListener('abort', onAbort, { once: true });

		child.stdout?.on('data', (d: Buffer) => {
			outBuf += d.toString();
			let nl: number;
			while ((nl = outBuf.indexOf('\n')) !== -1) {
				const line = outBuf.slice(0, nl).trim();
				outBuf = outBuf.slice(nl + 1);
				const m = /^out_time_us=(\d+)/.exec(line);
				if (m && opts.totalMs > 0) {
					const ratio = Math.min(1, Number(m[1]) / 1000 / opts.totalMs);
					opts.onProgress?.(ratio);
				}
			}
		});
		child.stderr?.on('data', (d: Buffer) => {
			stderr += d.toString();
			if (stderr.length > 20000) stderr = stderr.slice(-10000);
		});
		child.on('error', (err) => {
			opts.signal?.removeEventListener('abort', onAbort);
			reject(err);
		});
		child.on('close', (code) => {
			opts.signal?.removeEventListener('abort', onAbort);
			if (aborted) return reject(new Error('cancelled'));
			if (code === 0) return resolve();
			const tail = stderr.trim().split('\n').slice(-6).join('\n');
			reject(new Error(`ffmpeg が失敗しました (code ${code})\n${tail}`));
		});
	});
}

/**
 * 音声・動画ファイルの長さ（ms）を測る。ffprobe は同梱していないので、
 * ffmpeg で読み流して最後の out_time_us を取る。途中で切れた webm でも測れる。
 */
export function probeDurationMs(file: string): Promise<number> {
	return new Promise((resolve) => {
		const child = spawn(
			ffmpegPath(),
			['-hide_banner', '-nostats', '-progress', 'pipe:1', '-i', file, '-vn', '-f', 'null', '-'],
			{ stdio: ['ignore', 'pipe', 'ignore'] }
		);
		let last = 0;
		let buf = '';
		child.stdout?.on('data', (d: Buffer) => {
			buf += d.toString();
			for (const m of buf.matchAll(/out_time_us=(\d+)/g)) last = Math.max(last, Number(m[1]));
			buf = buf.slice(-200);
		});
		child.on('error', () => resolve(0));
		child.on('close', () => resolve(Math.round(last / 1000)));
	});
}

/**
 * MediaRecorder が書いた webm は長さ（Duration）と索引（Cues）を持たない。
 * 中身は変えずに（-c copy）詰め直して、両方を付ける。成功したら元のファイルを置き換える。
 * 失敗しても元のファイルはそのまま残す（再生はできる）。
 */
export async function remuxInPlace(file: string): Promise<boolean> {
	const tmp = `${file}.remux${path.extname(file)}`;
	try {
		await runFfmpeg(['-i', file, '-c', 'copy', tmp], { totalMs: 0 });
		const [a, b] = await Promise.all([fs.stat(file), fs.stat(tmp)]);
		if (b.size < a.size * 0.9) throw new Error('remux output too small');
		await fs.rename(tmp, file);
		return true;
	} catch (err) {
		console.warn('webm の詰め直しに失敗しました（元のまま使います）', err);
		await fs.rm(tmp, { force: true }).catch(() => {});
		return false;
	}
}

/** ファイル名に使えない文字を置き換える */
export function safeFileName(name: string, fallback = '動画'): string {
	const s = name
		.replace(/[\\/:*?"<>|]/g, '_')
		.trim()
		.slice(0, 80);
	return s || fallback;
}

export { path };
