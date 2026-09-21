/**
 * 投稿ハブ（hub/ の Cloudflare Worker）との通信。X・Threads・Instagram・TikTok はここを通す。
 * 動画はファイルから流し込み（メモリーに全部は載せない）、仕事（予約）を登録する。
 */
import { promises as fs } from 'node:fs';
import { shell } from 'electron';
import type {
	HubAccount,
	HubJob,
	HubPlatform,
	HubPostRequest,
	UploadProgress,
	TikTokCreatorInfo
} from '../../../shared/publish';
import { app } from 'electron';
import path from 'node:path';
import { loadSettings } from '../settings';
import { probeDurationMs, runFfmpeg } from '../ffmpeg';
import { uploadMedia } from './upload';
import { beginJob, isCanceled, throwIfCanceled } from './cancel';

export interface HubStatus {
	ok: true;
	publicUrl: string;
	platforms: Array<{ platform: HubPlatform; configured: boolean; account: HubAccount | null }>;
}

async function config(): Promise<{ url: string; token: string }> {
	const s = await loadSettings();
	if (!s.hubUrl || !s.hubToken)
		throw new Error('設定の「投稿ハブ」に URL と合言葉を入れてください');
	return { url: s.hubUrl.replace(/\/+$/, ''), token: s.hubToken };
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
	const { url, token } = await config();
	let res: Response;
	try {
		res = await fetch(url + path, {
			...init,
			headers: {
				authorization: `Bearer ${token}`,
				'content-type': 'application/json',
				...(init.headers ?? {})
			}
		});
	} catch (err) {
		throw new Error(`投稿ハブにつながりません（${url}）。${(err as Error).message}`);
	}
	const text = await res.text();
	let body: unknown = null;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {
		/* JSON でない返事はそのまま下で扱う */
	}
	if (!res.ok) {
		const msg = (body as { error?: string } | null)?.error ?? text.slice(0, 200) ?? '';
		throw new Error(
			res.status === 401 ? '投稿ハブの合言葉が違います' : `投稿ハブ: ${msg || `HTTP ${res.status}`}`
		);
	}
	return body as T;
}

/** 接続の様子。ハブが設定されていない・届かないときは例外ではなく { ok: false } で返す（画面で文言にする） */
export async function hubStatus(): Promise<HubStatus | { ok: false; error: string }> {
	try {
		return await call<HubStatus>('/api/status');
	} catch (err) {
		return { ok: false, error: (err as Error).message };
	}
}

/** ブラウザーでハブの接続ページを開く（ハブが SNS の許可画面へ送る） */
export async function hubConnect(platform: HubPlatform): Promise<void> {
	const { url, token } = await config();
	await shell.openExternal(`${url}/connect/${platform}?t=${encodeURIComponent(token)}`);
}

export async function hubDisconnect(platform: HubPlatform): Promise<void> {
	await call(`/api/accounts/${platform}`, { method: 'DELETE' });
}

export const hubJob = (id: string) => call<HubJob>(`/api/jobs/${encodeURIComponent(id)}`);
export const hubJobs = () => call<HubJob[]>('/api/jobs');
/** TikTok の投稿者の情報（公開範囲の選択肢など。画面で投稿の前に出す決まり） */
export const hubTikTokCreator = () => call<TikTokCreatorInfo>('/api/tiktok/creator');
/** 予約の日時を変える（まだ取りかかっていないものだけ） */
export const hubReschedule = (id: string, scheduledAt: string) =>
	call<HubJob>(`/api/jobs/${encodeURIComponent(id)}`, {
		method: 'PATCH',
		body: JSON.stringify({ scheduledAt })
	});
/** 続きを進める（ハブ側で最長 20 秒ほど）。返事はいまの様子 */
export const hubStep = (id: string) =>
	call<HubJob>(`/api/jobs/${encodeURIComponent(id)}/run`, { method: 'POST' });
export const hubCancel = (id: string) =>
	call<{ canceled: boolean }>(`/api/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' });

/** 動画を上げて、仕事を登録する。返ってきた仕事の様子は hubJob で追いかける */
export async function hubPost(
	jobId: string,
	filePath: string,
	req: Omit<HubPostRequest, 'mediaKey'>,
	onProgress: (p: UploadProgress) => void
): Promise<HubJob> {
	beginJob(jobId);
	onProgress({ id: jobId, phase: 'preparing', ratio: 0 });
	// 投稿先に合わせて動画を作り直す: startSec 秒から trimSec 秒までで切る（終わりは音を 1 秒でフェード）、
	// Instagram・TikTok の横動画は上下に黄色の帯を付けた 9:16 にする。どちらも要らなければそのまま上げる
	let upload = filePath;
	let temp: string | null = null;
	// Instagram のリールと TikTok は縦が前提なので、横の動画は上下に黄色の帯を付けた 9:16 にする
	const letterbox =
		(req.platform === 'instagram' || req.platform === 'tiktok') && req.orientation === 'landscape';
	const trimSec = typeof req.trimSec === 'number' && req.trimSec > 0 ? req.trimSec : null;
	const startSec = typeof req.startSec === 'number' && req.startSec > 0 ? req.startSec : null;
	if (letterbox || trimSec || startSec) {
		temp = await prepareVideo(filePath, { letterbox, trimSec, startSec }, (ratio) =>
			onProgress({ id: jobId, phase: 'preparing', ratio })
		);
		upload = temp;
	}
	let media: { key: string; url: string; size: number };
	try {
		throwIfCanceled(jobId);
		const { url, token } = await config();
		media = await uploadMedia(
			url,
			token,
			upload,
			(ratio) => onProgress({ id: jobId, phase: 'uploading', ratio }),
			() => isCanceled(jobId)
		);
	} finally {
		if (temp) await fs.rm(temp, { force: true }).catch(() => {});
	}
	// 取りやめ: 仕事を登録する前ならここで止める（上げた動画は使われない）
	throwIfCanceled(jobId);
	try {
		const job = await call<HubJob>('/api/jobs', {
			method: 'POST',
			body: JSON.stringify({ ...req, mediaKey: media.key })
		});
		onProgress({ id: jobId, phase: 'done', ratio: 1 });
		return job;
	} catch (err) {
		onProgress({ id: jobId, phase: 'failed', ratio: 1, message: (err as Error).message });
		throw err;
	}
}

/**
 * 投稿用に動画を作り直す。startSec があればそこから、trimSec があればそこ（先頭からの位置）までで切り、終わりの 1 秒で音を下げる。
 * letterbox なら 1080×1920 に収める（上下は黄色の帯）。一時ファイルの道を返す
 */
async function prepareVideo(
	filePath: string,
	opts: { letterbox: boolean; trimSec: number | null; startSec?: number | null },
	onRatio: (r: number) => void
): Promise<string> {
	const out = path.join(app.getPath('temp'), `yasashii-post-${Date.now()}.mp4`);
	const fullMs = await probeDurationMs(filePath).catch(() => 0);
	const start = opts.startSec && opts.startSec > 0 ? opts.startSec : 0;
	// 切り出す長さ（秒）。trimSec は先頭からの位置なので、始まりを引く
	const len = opts.trimSec ? Math.max(1, opts.trimSec - start) : null;
	const totalMs = len
		? Math.min(fullMs ? Math.max(0, fullMs - start * 1000) : len * 1000, len * 1000)
		: Math.max(0, fullMs - start * 1000);
	const args: string[] = [];
	// -ss は -i の前（速い。再エンコードするのでコマ単位でずれない）
	if (start > 0) args.push('-ss', String(start));
	args.push('-i', filePath);
	if (len) args.push('-t', String(len));
	if (opts.letterbox)
		args.push('-vf', 'scale=1080:-2,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=0xffd95c');
	args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p');
	if (len) {
		// 途中から始めるときは頭も 0.5 秒で音を上げる（ぶつ切りにしない）
		const fade = Math.max(0, len - 1);
		const af = `${start > 0 ? 'afade=t=in:st=0:d=0.5,' : ''}afade=t=out:st=${fade}:d=1`;
		args.push('-af', af, '-c:a', 'aac', '-b:a', '192k');
	} else if (start > 0) {
		args.push('-af', 'afade=t=in:st=0:d=0.5', '-c:a', 'aac', '-b:a', '192k');
	} else {
		args.push('-c:a', 'copy');
	}
	args.push('-movflags', '+faststart', out);
	await runFfmpeg(args, { totalMs, onProgress: onRatio });
	return out;
}
