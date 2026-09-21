/**
 * 投稿ハブへ動画を上げる。
 * 小さいものは PUT /api/media に本体をそのまま流す。大きいもの（64 MB 超）は 48 MB ずつに分けて
 * multipart（POST /api/media/multipart → PUT …/:part → POST …/complete）で上げる。
 * Cloudflare は 1 回の HTTP の本体が 100 MB までなので、長い動画はこれでないと上がらない。
 * electron に依存しない（単体で試せる）
 */
import { createReadStream, promises as fs } from 'node:fs';
import http from 'node:http';
import https from 'node:https';

export const SINGLE_MAX = 64 * 1024 * 1024;
export const PART_SIZE = 48 * 1024 * 1024;

export type Uploaded = { key: string; url: string; size: number };

/** 1 回の HTTP で、ファイルの一部（start〜end、end は含まない）を Content-Length 付きで送る */
function send<T>(
	target: URL,
	method: 'PUT' | 'POST' | 'DELETE',
	token: string,
	body: { filePath: string; start: number; end: number } | { json: unknown } | null,
	onSent?: (bytes: number) => void
): Promise<T> {
	const lib = target.protocol === 'https:' ? https : http;
	const headers: Record<string, string | number> = { authorization: `Bearer ${token}` };
	let jsonBody: string | null = null;
	if (body && 'json' in body) {
		jsonBody = JSON.stringify(body.json);
		headers['content-type'] = 'application/json';
		headers['content-length'] = Buffer.byteLength(jsonBody);
	} else if (body) {
		headers['content-type'] = 'video/mp4';
		headers['content-length'] = body.end - body.start;
	} else headers['content-length'] = 0;
	return new Promise((resolve, reject) => {
		const req = lib.request(target, { method, headers }, (res) => {
			let text = '';
			res.setEncoding('utf8');
			res.on('data', (c: string) => (text += c));
			res.on('end', () => {
				if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
					try {
						resolve(JSON.parse(text) as T);
					} catch {
						reject(new Error('投稿ハブの返事が読めません'));
					}
				} else {
					let msg = text.slice(0, 200);
					try {
						msg = (JSON.parse(text) as { error?: string }).error ?? msg;
					} catch {
						/* そのまま */
					}
					reject(
						new Error(
							res.statusCode === 401
								? '投稿ハブの合言葉が違います'
								: `投稿ハブ: ${msg || `HTTP ${res.statusCode}`}`
						)
					);
				}
			});
		});
		req.on('error', (err) =>
			reject(new Error(`投稿ハブにつながりません（${target.origin}）。${err.message}`))
		);
		if (jsonBody !== null) req.end(jsonBody);
		else if (body && 'filePath' in body) {
			const stream = createReadStream(body.filePath, {
				start: body.start,
				end: body.end - 1,
				highWaterMark: 1024 * 1024
			});
			stream.on('data', (chunk) => onSent?.(chunk.length));
			stream.on('error', (err) => {
				req.destroy(err);
				reject(err);
			});
			stream.pipe(req);
		} else req.end();
	});
}

/** 動画を上げて {key, url, size} を返す。onRatio は 0〜0.999 */
export async function uploadMedia(
	hubUrl: string,
	token: string,
	filePath: string,
	onRatio: (r: number) => void,
	stopped: () => boolean = () => false
): Promise<Uploaded> {
	const base = hubUrl.replace(/\/+$/, '');
	const size = (await fs.stat(filePath)).size;
	let sent = 0;
	const tick = (n: number) => {
		sent += n;
		onRatio(Math.min(sent / size, 0.999));
	};
	if (size <= SINGLE_MAX) {
		return send<Uploaded>(
			new URL(base + '/api/media'),
			'PUT',
			token,
			{ filePath, start: 0, end: size },
			tick
		);
	}
	const { key, uploadId } = await send<{ key: string; uploadId: string }>(
		new URL(base + '/api/media/multipart'),
		'POST',
		token,
		{ json: { contentType: 'video/mp4' } }
	);
	const partUrl = (n: number) =>
		new URL(
			`${base}/api/media/multipart/${encodeURIComponent(key)}/${encodeURIComponent(uploadId)}/${n}`
		);
	try {
		const parts: { partNumber: number; etag: string }[] = [];
		for (let n = 1, start = 0; start < size; n++, start += PART_SIZE) {
			if (stopped()) throw new Error('cancelled');
			const end = Math.min(size, start + PART_SIZE);
			// 1 片は 2 回まで試す（途中で切れることがある）
			let part: { partNumber: number; etag: string } | null = null;
			for (let attempt = 0; attempt < 2 && !part; attempt++) {
				try {
					const before = sent;
					part = await send(partUrl(n), 'PUT', token, { filePath, start, end }, tick);
					sent = before + (end - start);
				} catch (err) {
					if (attempt === 1) throw err;
				}
			}
			parts.push(part!);
		}
		return await send<Uploaded>(
			new URL(
				`${base}/api/media/multipart/${encodeURIComponent(key)}/${encodeURIComponent(uploadId)}/complete`
			),
			'POST',
			token,
			{ json: { parts, contentType: 'video/mp4' } }
		);
	} catch (err) {
		await send(
			new URL(
				`${base}/api/media/multipart/${encodeURIComponent(key)}/${encodeURIComponent(uploadId)}`
			),
			'DELETE',
			token,
			null
		).catch(() => {});
		throw err;
	}
}
