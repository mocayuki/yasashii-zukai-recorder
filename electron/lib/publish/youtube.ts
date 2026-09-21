/**
 * YouTube への接続（OAuth）とアップロード（Data API v3）。
 *
 * - 接続: 「デスクトップ アプリ」のクライアント ID / シークレット（設定に保存）で、この Mac の中だけで動く
 *   ループバック（http://127.0.0.1:ポート）へ戻ってくる OAuth 2.0（PKCE 付き）。ブラウザーで Google にログインして許可する。
 *   トークンは settings.json にだけ保存する
 * - アップロード: 再開可能アップロード（resumable）。8MB ずつ送って進み具合を出す。
 *   予約公開は privacyStatus=private + status.publishAt。サムネイルは thumbnails.set（電話確認済みのチャンネルが必要）
 * - 1 日の割り当て（10,000 単位）のうち、アップロード 1 本が 1,600 単位。1 日 6 本ほどが上限
 */
import { shell } from 'electron';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
	UploadProgress,
	YouTubeAuth,
	YouTubeUploadRequest,
	YouTubeUploadResult
} from '../../../shared/publish';
import { tidyDescription } from '../../../shared/publish';
import { loadSettings, saveSettings } from '../settings';
import { findRecording } from '../library';
import { getTranscript } from '../transcripts';
import { buildSubtitles } from '../subtitles';
import { parseTerms } from '../../../shared/transcribe-terms';
import { beginJob, throwIfCanceled } from './cancel';
import { SUBTITLE_LANGS, type SubtitleLang } from '../../../shared/subtitles';

// force-ssl は予約の取り消し（動画の削除）に要る（2026-09-17 に追加。前につないだままだと取り消しで 403 になるので、つなぎ直す）
const SCOPE =
	'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.force-ssl';
const CHUNK = 8 * 1024 * 1024;

function base64url(buf: Buffer): string {
	return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** ブラウザーで Google にログインして許可してもらい、トークンを設定に保存する。チャンネル名を返す */
export async function connectYouTube(): Promise<string> {
	const s = await loadSettings();
	const clientId = s.youtubeClientId?.trim();
	const clientSecret = s.youtubeClientSecret?.trim();
	if (!clientId || !clientSecret)
		throw new Error(
			'Google Cloud の「クライアント ID」と「クライアント シークレット」を設定に入れてください。'
		);
	const verifier = base64url(randomBytes(32));
	const challenge = base64url(createHash('sha256').update(verifier).digest());
	const state = base64url(randomBytes(16));

	// ループバックの受け口。空いている番号で待ち、許可の code を受け取ったら閉じる
	const { server, port, codePromise } = await listenForCode(state);
	const redirectUri = `http://127.0.0.1:${port}/callback`;
	const authUrl =
		'https://accounts.google.com/o/oauth2/v2/auth?' +
		new URLSearchParams({
			client_id: clientId,
			redirect_uri: redirectUri,
			response_type: 'code',
			scope: SCOPE,
			access_type: 'offline',
			prompt: 'consent',
			code_challenge: challenge,
			code_challenge_method: 'S256',
			state
		}).toString();
	await shell.openExternal(authUrl);
	let code: string;
	try {
		code = await codePromise;
	} finally {
		server.close();
	}
	const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: clientId,
			client_secret: clientSecret,
			code,
			code_verifier: verifier,
			grant_type: 'authorization_code',
			redirect_uri: redirectUri
		}).toString()
	});
	const tok = (await tokenRes.json()) as {
		access_token?: string;
		refresh_token?: string;
		expires_in?: number;
		scope?: string;
		error?: string;
		error_description?: string;
	};
	if (!tokenRes.ok || !tok.access_token || !tok.refresh_token) {
		throw new Error(
			`Google との接続に失敗しました。${tok.error_description ?? tok.error ?? tokenRes.status}`
		);
	}
	const channel = await fetchChannel(tok.access_token);
	const auth: YouTubeAuth = {
		refreshToken: tok.refresh_token,
		accessToken: tok.access_token,
		expiresAt: Date.now() + ((tok.expires_in ?? 3600) - 60) * 1000,
		channelTitle: channel.title,
		channelId: channel.id,
		scope: tok.scope
	};
	await saveSettings({ youtubeAuth: auth });
	return channel.title;
}

export async function disconnectYouTube(): Promise<void> {
	const s = await loadSettings();
	const token = s.youtubeAuth?.refreshToken;
	await saveSettings({ youtubeAuth: null });
	if (token) {
		await fetch(
			'https://oauth2.googleapis.com/revoke?' + new URLSearchParams({ token }).toString(),
			{
				method: 'POST'
			}
		).catch(() => {});
	}
}

function listenForCode(
	state: string
): Promise<{ server: Server; port: number; codePromise: Promise<string> }> {
	return new Promise((resolveListen, rejectListen) => {
		let resolveCode: (code: string) => void;
		let rejectCode: (err: Error) => void;
		const codePromise = new Promise<string>((res, rej) => {
			resolveCode = res;
			rejectCode = rej;
		});
		const server = createServer((req, res) => {
			const url = new URL(req.url ?? '/', 'http://127.0.0.1');
			if (url.pathname !== '/callback') {
				res.writeHead(404).end();
				return;
			}
			const err = url.searchParams.get('error');
			const code = url.searchParams.get('code');
			const st = url.searchParams.get('state');
			res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
			if (err || !code || st !== state) {
				res.end(
					'<p style="font-family:sans-serif">接続を取りやめました。このタブは閉じて構いません。</p>'
				);
				rejectCode(
					new Error(
						err === 'access_denied' ? '許可されませんでした。' : '接続の戻りが正しくありません。'
					)
				);
				return;
			}
			res.end(
				'<p style="font-family:sans-serif;font-size:18px">やさしい図解レコーダーと YouTube をつなぎました。このタブは閉じて構いません。</p>'
			);
			resolveCode(code);
		});
		server.on('error', rejectListen);
		server.listen(0, '127.0.0.1', () => {
			const addr = server.address();
			const port = typeof addr === 'object' && addr ? addr.port : 0;
			// 10 分待っても戻ってこなければ諦める
			const timer = setTimeout(
				() => rejectCode(new Error('ブラウザーでの許可が確認できませんでした（時間切れ）。')),
				10 * 60 * 1000
			);
			codePromise.finally(() => clearTimeout(timer));
			resolveListen({ server, port, codePromise });
		});
	});
}

async function fetchChannel(accessToken: string): Promise<{ id: string; title: string }> {
	const res = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
		headers: { Authorization: `Bearer ${accessToken}` }
	});
	const json = (await res.json()) as {
		items?: Array<{ id: string; snippet?: { title?: string } }>;
		error?: { message?: string };
	};
	if (!res.ok)
		throw new Error(`チャンネルを確かめられませんでした。${json.error?.message ?? res.status}`);
	const c = json.items?.[0];
	if (!c) throw new Error('この Google アカウントに YouTube チャンネルがありません。');
	return { id: c.id, title: c.snippet?.title ?? '' };
}

/** 有効なアクセストークンを返す（期限が近ければ refresh する） */
async function accessToken(): Promise<string> {
	const s = await loadSettings();
	const auth = s.youtubeAuth;
	if (!auth) throw new Error('YouTube に接続していません。設定で接続してください。');
	if (Date.now() < auth.expiresAt) return auth.accessToken;
	const res = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: s.youtubeClientId ?? '',
			client_secret: s.youtubeClientSecret ?? '',
			refresh_token: auth.refreshToken,
			grant_type: 'refresh_token'
		}).toString()
	});
	const tok = (await res.json()) as { access_token?: string; expires_in?: number; error?: string };
	if (!res.ok || !tok.access_token) {
		if (tok.error === 'invalid_grant') await saveSettings({ youtubeAuth: null });
		throw new Error('YouTube の接続が切れています。設定でもう一度接続してください。');
	}
	const next: YouTubeAuth = {
		...auth,
		accessToken: tok.access_token,
		expiresAt: Date.now() + ((tok.expires_in ?? 3600) - 60) * 1000
	};
	await saveSettings({ youtubeAuth: next });
	return next.accessToken;
}

export async function youtubeStatus(): Promise<{
	connected: boolean;
	channelTitle: string | null;
	hasClient: boolean;
}> {
	const s = await loadSettings();
	return {
		connected: !!s.youtubeAuth,
		channelTitle: s.youtubeAuth?.channelTitle ?? null,
		hasClient: !!(s.youtubeClientId?.trim() && s.youtubeClientSecret?.trim())
	};
}

/** 動画を上げる（再開可能アップロード）。予約があれば private + publishAt。サムネも設定する */
export async function uploadToYouTube(
	jobId: string,
	req: YouTubeUploadRequest,
	onProgress: (p: UploadProgress) => void
): Promise<YouTubeUploadResult> {
	beginJob(jobId);
	const token = await accessToken();
	const st = await fs.stat(req.filePath);
	onProgress({ id: jobId, phase: 'preparing', ratio: 0 });
	const body = {
		snippet: {
			title: req.title.trim().slice(0, 100) || '無題',
			description: tidyDescription(req.description).slice(0, 5000),
			tags: req.tags.slice(0, 50),
			categoryId: '22' // People & Blogs
		},
		status: {
			privacyStatus: req.publishAt ? 'private' : req.privacy,
			...(req.publishAt ? { publishAt: new Date(req.publishAt).toISOString() } : {}),
			selfDeclaredMadeForKids: false
		}
	};
	const start = await fetch(
		'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
		{
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json; charset=UTF-8',
				'X-Upload-Content-Length': String(st.size),
				'X-Upload-Content-Type': 'video/mp4'
			},
			body: JSON.stringify(body)
		}
	);
	if (!start.ok)
		throw new Error(`アップロードを始められませんでした。${await describeError(start)}`);
	const location = start.headers.get('location');
	if (!location) throw new Error('アップロード先が返ってきませんでした。');

	// 8MB ずつ送る。308 が返る間は続き、200/201 で完了
	const fh = await fs.open(req.filePath, 'r');
	let videoId = '';
	try {
		let offset = 0;
		while (offset < st.size) {
			// 取りやめ（投稿管理の ×）: 上げ終わる前なら動画は作られない
			throwIfCanceled(jobId);
			const len = Math.min(CHUNK, st.size - offset);
			const buf = Buffer.alloc(len);
			await fh.read(buf, 0, len, offset);
			const res = await fetch(location, {
				method: 'PUT',
				headers: {
					'Content-Type': 'video/mp4',
					'Content-Length': String(len),
					'Content-Range': `bytes ${offset}-${offset + len - 1}/${st.size}`
				},
				body: buf
			});
			if (res.status === 308) {
				const range = res.headers.get('range'); // bytes=0-8388607
				const m = range && /bytes=0-(\d+)/.exec(range);
				offset = m ? Number(m[1]) + 1 : offset + len;
			} else if (res.ok) {
				const json = (await res.json()) as { id?: string };
				videoId = json.id ?? '';
				offset = st.size;
			} else {
				throw new Error(`アップロードに失敗しました。${await describeError(res)}`);
			}
			onProgress({ id: jobId, phase: 'uploading', ratio: Math.min(1, offset / st.size) });
		}
	} finally {
		await fh.close();
	}
	if (!videoId) throw new Error('動画の id が返ってきませんでした。');
	const url = `https://youtu.be/${videoId}`;
	let thumbnailWarning: string | undefined;
	if (req.thumbnailPath) {
		onProgress({ id: jobId, phase: 'thumbnail', ratio: 1 });
		try {
			await setThumbnail(token, videoId, req.thumbnailPath);
		} catch (err) {
			thumbnailWarning = (err as Error).message;
		}
	}
	// テロップがあれば字幕を付ける（日本語と、設定で選んだ外国語）。付けられなくても動画は上がっている
	let captionsWarning: string | undefined;
	const captions: string[] = [];
	if (req.recordingId) {
		onProgress({ id: jobId, phase: 'captions', ratio: 1 });
		try {
			const rec = await findRecording(req.recordingId);
			const transcript = rec ? await getTranscript(rec.id).catch(() => null) : null;
			if (rec && transcript && transcript.cues.length > 0) {
				const s = await loadSettings();
				const langs = s.subtitleLanguages.filter((l): l is SubtitleLang =>
					SUBTITLE_LANGS.some((x) => x.code === l)
				);
				const srts = await buildSubtitles(
					rec,
					transcript,
					langs,
					s.openaiApiKey,
					parseTerms(s.transcriptTerms),
					() => {}
				);
				for (const { lang, srt } of srts) {
					await insertCaption(token, videoId, lang, srt);
					captions.push(lang);
				}
			}
		} catch (err) {
			captionsWarning = `字幕を付けられませんでした: ${(err as Error).message}`;
		}
	}
	onProgress({ id: jobId, phase: 'done', ratio: 1 });
	return { videoId, url, thumbnailWarning, captionsWarning, captions };
}

/** 字幕 1 言語を動画に付ける（captions.insert、multipart） */
async function insertCaption(
	token: string,
	videoId: string,
	lang: string,
	srt: string
): Promise<void> {
	const name =
		lang === 'ja' ? '日本語' : (SUBTITLE_LANGS.find((l) => l.code === lang)?.label ?? lang);
	const boundary = `yasashii-${Date.now()}`;
	const meta = JSON.stringify({ snippet: { videoId, language: lang, name, isDraft: false } });
	const body =
		`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
		`--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n${srt}\r\n--${boundary}--`;
	const res = await fetch(
		'https://www.googleapis.com/upload/youtube/v3/captions?part=snippet&uploadType=multipart',
		{
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': `multipart/related; boundary=${boundary}`
			},
			body
		}
	);
	if (!res.ok) throw new Error(`${name}: ${await describeError(res)}`);
}

async function setThumbnail(token: string, videoId: string, file: string): Promise<void> {
	const data = await fs.readFile(file);
	if (data.byteLength > 2 * 1024 * 1024) throw new Error('サムネイルが 2MB を超えています。');
	const ext = path.extname(file).toLowerCase();
	const type = ext === '.png' ? 'image/png' : 'image/jpeg';
	const res = await fetch(
		`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(videoId)}&uploadType=media`,
		{
			method: 'POST',
			headers: { Authorization: `Bearer ${token}`, 'Content-Type': type },
			body: data
		}
	);
	if (!res.ok) {
		const msg = await describeError(res);
		throw new Error(
			/forbidden|phone|verified|403/i.test(msg)
				? `サムネイルを設定できませんでした（チャンネルの電話番号の確認が必要です）。${msg}`
				: `サムネイルを設定できませんでした。${msg}`
		);
	}
}

/** 予約公開の日時を変える（非公開のまま publishAt を書き換える） */
export async function rescheduleYouTube(videoId: string, publishAt: string): Promise<void> {
	const token = await accessToken();
	const res = await fetch('https://www.googleapis.com/youtube/v3/videos?part=status', {
		method: 'PUT',
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ id: videoId, status: { privacyStatus: 'private', publishAt } })
	});
	if (!res.ok) throw new Error(`YouTube の予約を変えられませんでした: ${await describeError(res)}`);
}

/** 予約を取り消す = 上げた動画を YouTube から消す（予約公開は動画そのものなので、消すしかない） */
export async function deleteYouTubeVideo(videoId: string): Promise<void> {
	const token = await accessToken();
	const res = await fetch(
		`https://www.googleapis.com/youtube/v3/videos?id=${encodeURIComponent(videoId)}`,
		{ method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
	);
	if (res.status === 404) return; // もう無い
	if (!res.ok) {
		const msg = await describeError(res);
		throw new Error(
			/insufficient|403/i.test(msg)
				? `YouTube を消す許可がありません。設定で YouTube をいったん切ってつなぎ直すと、取り消せるようになります。${msg}`
				: `YouTube の予約を取り消せませんでした: ${msg}`
		);
	}
}

async function describeError(res: Response): Promise<string> {
	try {
		const json = (await res.json()) as {
			error?: { message?: string; errors?: Array<{ reason?: string }> };
		};
		const reason = json.error?.errors?.[0]?.reason;
		return `${res.status} ${json.error?.message ?? ''}${reason ? `（${reason}）` : ''}`.trim();
	} catch {
		return String(res.status);
	}
}
