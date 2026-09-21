import { app, dialog, ipcMain, screen, shell, type BrowserWindow } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
	Cue,
	ExportOptions,
	ExportProgress,
	Note,
	Recording,
	RecordingBegin,
	RecordingFinish,
	Settings,
	SubtitleProgress,
	TranscribeProgress,
	Transcript
} from '../shared/types';
import { exportsOf } from '../shared/types';
import { addBgmViaDialog, importDownloads, listBgm, removeBgm } from './lib/bgm';
import { backupViaDialog } from './lib/backup';
import {
	applyPresentOrientation,
	closePresentWindow,
	forwardPresentCamera,
	forwardPresentState,
	getPresentWindow,
	openPresentWindow
} from './lib/present';
import { addImageViaDialog, importImageData, removeImage } from './lib/images';
import { plainText } from '../shared/notes';
import { isSubtitleLang } from '../shared/subtitles';
import { saveSubtitles } from './lib/subtitles';
import { proofreadCues } from './lib/proofread';
import {
	connectYouTube,
	deleteYouTubeVideo,
	disconnectYouTube,
	rescheduleYouTube,
	uploadToYouTube,
	youtubeStatus
} from './lib/publish/youtube';
import type {
	HubPlatform,
	HubPostRequest,
	Platform,
	UploadProgress,
	YouTubeUploadRequest
} from '../shared/publish';
import { composePosts } from './lib/publish/compose';
import { withBusy } from './lib/busy';
import {
	hubCancel,
	hubConnect,
	hubDisconnect,
	hubJob,
	hubJobs,
	hubPost,
	hubReschedule,
	hubStatus,
	hubStep,
	hubTikTokCreator
} from './lib/publish/hub';
import { parseReplacements, parseTerms } from '../shared/transcribe-terms';
import { generateTranscript, getTranscript, saveTranscript } from './lib/transcripts';
import { cancelExport, exportMp4 } from './lib/export';
import { cancelJob } from './lib/publish/cancel';
import { safeFileName, probeDurationMs } from './lib/ffmpeg';
import { importLegacyBackup } from './lib/legacy';
import {
	ensureLibrary,
	exportFilePath,
	findRecording,
	listFolders,
	listNotes,
	listRecordings,
	mediaFilePath,
	removeExportFiles,
	removeNote,
	removeRecording,
	saveFolders,
	saveNote,
	saveRecording
} from './lib/library';
import { appendRecording, beginRecording, finishRecording } from './lib/recorder';
import { loadSettings, saveSettings } from './lib/settings';
import { storageInfo } from './lib/storage';

/**
 * 画面から呼ばれる処理。チャンネル名は preload.ts と対で管理する。
 * 引数は画面から来るものなので、型どおりでも信用しすぎない。
 */
export function registerIpc(getWindow: () => BrowserWindow | null): void {
	// ---- 設定 ----
	ipcMain.handle('settings:get', () => loadSettings());
	ipcMain.handle('settings:save', (_e, patch: Partial<Settings>) => {
		// 画面から来る値なので、保存先だけはここでは変えさせない（専用の処理を通す）
		const { libraryPath: _ignored, ...rest } = patch ?? {};
		void _ignored;
		return saveSettings(rest);
	});

	ipcMain.handle('settings:chooseLibraryFolder', async () => {
		const win = getWindow();
		const current = await loadSettings();
		const result = await dialog.showOpenDialog(win ?? undefined!, {
			title: '録音・ノートの保存先フォルダーを選ぶ',
			defaultPath: current.libraryPath,
			buttonLabel: 'このフォルダーに保存',
			properties: ['openDirectory', 'createDirectory']
		});
		if (result.canceled || result.filePaths.length === 0) return null;
		const chosen = result.filePaths[0];
		await saveSettings({ libraryPath: chosen });
		await ensureLibrary();
		return chosen;
	});

	ipcMain.handle('settings:openLibraryFolder', async () => {
		const root = await ensureLibrary();
		await shell.openPath(root);
	});

	// ---- 容量 ----
	ipcMain.handle('storage:info', () => storageInfo());

	// ---- ノート ----
	ipcMain.handle('notes:list', () => listNotes());
	ipcMain.handle('notes:save', (_e, note: Note) => saveNote(note));
	ipcMain.handle('notes:remove', (_e, id: string) => removeNote(id));

	// ---- 収録 ----
	ipcMain.handle('recordings:list', () => listRecordings());
	ipcMain.handle('recordings:save', (_e, recording: Recording) => saveRecording(recording));
	ipcMain.handle('recordings:remove', (_e, id: string) => removeRecording(id));
	ipcMain.handle('recordings:fileUrl', async (_e, id: string) => {
		const rec = await findRecording(id);
		if (!rec) return null;
		// media:// は main.ts でライブラリーの media フォルダーに割り当てている
		return `media://local/${encodeURIComponent(path.basename(rec.fileName))}`;
	});
	// 収録中はウィンドウの大きさを固定する（ユーザー了承済み 2026-09-12）。自分の窓の画面収録は
	// 窓の大きさが変わるたびに取り込み直しになり、カクつくうえに枠の外が映ることがあったため。
	// 動画は枠の中身を 1920px に伸ばしたものなので、窓の大きさを変えても動画は変わらない（全画面の出入りはできる）
	const lockSize = (flag: boolean) => {
		const win = getWindow();
		if (win && !win.isDestroyed()) win.setResizable(!flag);
	};
	ipcMain.handle('recordings:begin', async (_e, meta: RecordingBegin) => {
		const rec = await beginRecording(meta);
		lockSize(true);
		return rec;
	});
	ipcMain.handle('recordings:append', (_e, id: string, chunk: ArrayBuffer | Uint8Array) =>
		appendRecording(id, chunk)
	);
	ipcMain.handle('recordings:finish', async (_e, id: string, meta: RecordingFinish) => {
		try {
			return await finishRecording(id, meta);
		} finally {
			lockSize(false);
		}
	});
	ipcMain.handle('recordings:exportFile', async (_e, id: string) => {
		const rec = await findRecording(id);
		if (!rec) return null;
		const ext = path.extname(rec.fileName) || '.webm';
		const base = (rec.title || '収録').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
		const result = await dialog.showSaveDialog(getWindow() ?? undefined!, {
			title: '収録を保存する',
			defaultPath: path.join(app.getPath('downloads'), `${base}${ext}`),
			buttonLabel: '保存',
			filters: [{ name: '動画', extensions: [ext.slice(1)] }]
		});
		if (result.canceled || !result.filePath) return null;
		await fs.copyFile(await mediaFilePath(rec), result.filePath);
		return result.filePath;
	});
	ipcMain.handle('recordings:exportMp4', async (_e, id: string, opts: ExportOptions) => {
		const rec = await findRecording(id);
		if (!rec) return null;
		const win = getWindow();
		const limit = typeof opts.limitMs === 'number' && opts.limitMs > 0 ? opts.limitMs : null;
		let dest = '';
		if (limit) {
			// 試し書き出し: 聞き比べ用なので、好きな場所（既定はダウンロード）に置く
			const base = `${safeFileName(rec.title || '収録')}（試し${Math.round(limit / 1000)}秒）.mp4`;
			// 開発時の動作確認用: ダイアログを出さずに決まった場所へ書く
			const devDir = !app.isPackaged ? process.env.YASASHII_EXPORT_DIR : undefined;
			const result = devDir
				? { canceled: false, filePath: path.join(devDir, base) }
				: await dialog.showSaveDialog(win ?? undefined!, {
						title: 'mp4 に書き出す（試し）',
						defaultPath: path.join(app.getPath('downloads'), base),
						buttonLabel: '書き出す',
						filters: [{ name: 'mp4 動画', extensions: ['mp4'] }]
					});
			if (result.canceled || !result.filePath) return null;
			dest = result.filePath.endsWith('.mp4') ? result.filePath : `${result.filePath}.mp4`;
		}
		let exportId: string | null = null;
		if (!limit) {
			// 本番の書き出し: 保存先の exports/ に、書き出しごとに別の名前で置く（履歴。いらなければ画面で消す）
			exportId = Date.now().toString(36);
			dest = await exportFilePath(id, exportId);
			await fs.mkdir(path.dirname(dest), { recursive: true });
		}
		const send = (p: ExportProgress) =>
			getWindow()?.webContents.send('recordings:export-progress', p);
		send({ id, ratio: 0, phase: 'preparing' });
		try {
			await exportMp4(rec, opts, dest, (ratio) => send({ id, ratio, phase: 'encoding' }));
			send({ id, ratio: 1, phase: 'done' });
			if (!exportId) return { path: dest };
			const st = await fs.stat(dest);
			const durationMs = await probeDurationMs(dest).catch(() => 0);
			return {
				path: dest,
				export: {
					id: exportId,
					fileName: path.basename(dest),
					size: st.size,
					createdAt: st.mtimeMs,
					durationMs
				}
			};
		} catch (err) {
			const message = (err as Error).message;
			await fs.rm(dest, { force: true }).catch(() => {});
			if (message === 'cancelled') {
				send({ id, ratio: 0, phase: 'cancelled' });
				return null;
			}
			send({ id, ratio: 0, phase: 'failed', message });
			throw err;
		}
	});
	ipcMain.handle('recordings:cancelExport', (_e, id: string) => cancelExport(id));
	ipcMain.handle('recordings:exportInfo', async (_e, id: string, exportId?: string) => {
		const file = await exportFilePath(id, exportId);
		try {
			const st = await fs.stat(file);
			// 長さ: 書き出しの記録にあればそれ、無ければ測って記録に覚える（古い書き出しは長さを持っていない）
			const rec = await findRecording(id);
			const ex = rec ? exportsOf(rec).find((e) => e.id === (exportId ?? 'legacy')) : undefined;
			let durationMs = ex?.durationMs ?? null;
			if (!durationMs) {
				durationMs = (await probeDurationMs(file).catch(() => 0)) || null;
				if (durationMs && rec && ex) {
					await saveRecording({
						...rec,
						exports: exportsOf(rec).map((e) =>
							e.id === ex.id ? { ...e, durationMs: durationMs ?? undefined } : e
						),
						export: undefined
					});
				}
			}
			return {
				id: exportId ?? 'legacy',
				fileName: path.basename(file),
				size: st.size,
				createdAt: st.mtimeMs,
				durationMs,
				path: file,
				url: `media://local/exports/${encodeURIComponent(path.basename(file))}`
			};
		} catch {
			return null;
		}
	});
	ipcMain.handle('recordings:copyExport', async (_e, id: string, exportId?: string) => {
		const rec = await findRecording(id);
		if (!rec) return null;
		const file = await exportFilePath(id, exportId);
		const result = await dialog.showSaveDialog(getWindow() ?? undefined!, {
			title: '書き出した mp4 をコピーする',
			defaultPath: path.join(app.getPath('downloads'), `${safeFileName(rec.title || '収録')}.mp4`),
			buttonLabel: 'ここに保存',
			filters: [{ name: 'mp4 動画', extensions: ['mp4'] }]
		});
		if (result.canceled || !result.filePath) return null;
		const dest = result.filePath.endsWith('.mp4') ? result.filePath : `${result.filePath}.mp4`;
		await fs.copyFile(file, dest);
		return dest;
	});
	ipcMain.handle('recordings:removeExport', (_e, id: string, exportId?: string) =>
		removeExportFiles(id, exportId)
	);
	ipcMain.handle('recordings:revealInFinder', async (_e, id: string) => {
		const rec = await findRecording(id);
		if (rec) shell.showItemInFolder(await mediaFilePath(rec));
	});

	// ---- BGM ----
	ipcMain.handle('bgm:list', () => listBgm());
	ipcMain.handle('bgm:add', () => addBgmViaDialog(getWindow()));
	ipcMain.handle('bgm:importDownloads', () => importDownloads());
	ipcMain.handle('bgm:remove', (_e, fileName: string) => removeBgm(fileName));
	ipcMain.handle(
		'bgm:url',
		(_e, fileName: string) => `media://local/bgm/${encodeURIComponent(path.basename(fileName))}`
	);

	// ---- バックアップ ----
	ipcMain.handle('storage:backup', () => backupViaDialog(getWindow()));

	// ---- 初期版からの取り込み ----
	ipcMain.handle('legacy:importBackup', async () => {
		const win = getWindow();
		const result = await dialog.showOpenDialog(win ?? undefined!, {
			title: '初期版のバックアップ JSON を選ぶ',
			filters: [{ name: 'バックアップ JSON', extensions: ['json'] }],
			properties: ['openFile']
		});
		if (result.canceled || result.filePaths.length === 0) return null;
		return importLegacyBackup(result.filePaths[0]);
	});

	// ---- アプリ ----
	// ---- プレゼン用の窓 ----
	ipcMain.handle('present:open', async (_e, noteId: string) => {
		const notes = await listNotes();
		const note = notes.find((n) => n.id === noteId);
		openPresentWindow(noteId, note?.orientation === 'portrait');
	});
	ipcMain.handle('present:close', () => closePresentWindow());
	ipcMain.handle('present:isOpen', () => getPresentWindow() !== null);
	ipcMain.handle('present:orientation', (_e, portrait: boolean) =>
		applyPresentOrientation(portrait === true)
	);
	ipcMain.on('present:update', (_e, state: unknown) => forwardPresentState(state));
	ipcMain.on('present:camera', (_e, camera: unknown) => forwardPresentCamera(camera));

	// ---- フォルダー ----
	ipcMain.handle('folders:list', () => listFolders());
	ipcMain.handle('folders:save', (_e, names: string[]) =>
		saveFolders(Array.isArray(names) ? names : [])
	);

	ipcMain.handle('app:version', () => app.getVersion());
	// ---- テロップ（文字起こし） ----
	ipcMain.handle('transcripts:get', (_e, recordingId: string) => getTranscript(recordingId));
	ipcMain.handle('transcripts:save', (_e, t: Transcript) => saveTranscript(t));
	ipcMain.handle('transcripts:generate', async (_e, recordingId: string) => {
		const rec = await findRecording(recordingId);
		if (!rec) throw new Error('収録が見つかりません。');
		const s = await loadSettings();
		const key = s.openaiApiKey;
		if (!key) throw new Error('OpenAI の API キーが設定されていません。設定で入力してください。');
		const send = (p: TranscribeProgress) =>
			getWindow()?.webContents.send('transcripts:progress', p);
		// 文字起こしは whisper だけ、ヒント無し（ヒントを渡すと崩れた）。辞書とノートの言葉は「誤りの候補を出す（AI）」で使う。
		// 置き換えは書き起こし後に当てる
		const replacements = parseReplacements(s.transcriptReplacements);
		return generateTranscript(rec, key, send, { replacements });
	});

	ipcMain.handle('transcripts:saveSubtitles', async (_e, recordingId: string) => {
		const rec = await findRecording(recordingId);
		if (!rec) throw new Error('収録が見つかりません。');
		const transcript = await getTranscript(recordingId);
		if (!transcript || transcript.cues.length === 0)
			throw new Error('テロップがまだありません。先に「テロップを作る」を押してください。');
		const s = await loadSettings();
		const langs = s.subtitleLanguages.filter(isSubtitleLang);
		const send = (p: SubtitleProgress) => getWindow()?.webContents.send('subtitles:progress', p);
		return saveSubtitles(
			rec,
			transcript,
			langs,
			s.openaiApiKey,
			parseTerms(s.transcriptTerms),
			getWindow(),
			send
		);
	});

	ipcMain.handle('transcripts:proofread', async (_e, recordingId: string, cues: Cue[]) => {
		const rec = await findRecording(recordingId);
		if (!rec) throw new Error('収録が見つかりません。');
		if (!Array.isArray(cues) || cues.length === 0) throw new Error('テロップがありません。');
		const s = await loadSettings();
		if (!s.openaiApiKey)
			throw new Error('OpenAI の API キーが設定されていません。設定で入力してください。');
		const note = (await listNotes()).find((n) => n.id === rec.noteId);
		const context = note ? [note.title, ...plainText([note.root]).split('\n')] : [];
		return proofreadCues(s.openaiApiKey, cues, context, parseTerms(s.transcriptTerms));
	});

	// ---- 投稿（YouTube） ----
	ipcMain.handle('publish:youtubeStatus', () => youtubeStatus());
	ipcMain.handle('publish:youtubeConnect', () => connectYouTube());
	ipcMain.handle('publish:youtubeDisconnect', () => disconnectYouTube());
	ipcMain.handle('publish:youtubeUpload', (_e, jobId: string, req: YouTubeUploadRequest) => {
		if (typeof req?.filePath !== 'string' || !path.isAbsolute(req.filePath))
			throw new Error('動画のファイルが正しくありません。');
		const send = (p: UploadProgress) => getWindow()?.webContents.send('publish:progress', p);
		return withBusy('youtube', () => uploadToYouTube(jobId, req, send));
	});
	ipcMain.handle('publish:hubStatus', () => hubStatus());
	ipcMain.handle('publish:hubConnect', (_e, platform: HubPlatform) => hubConnect(platform));
	ipcMain.handle('publish:hubDisconnect', (_e, platform: HubPlatform) => hubDisconnect(platform));
	ipcMain.handle(
		'publish:hubPost',
		(_e, jobId: string, filePath: string, req: Omit<HubPostRequest, 'mediaKey'>) => {
			if (typeof filePath !== 'string' || !path.isAbsolute(filePath))
				throw new Error('動画のファイルが正しくありません。');
			const send = (p: UploadProgress) => getWindow()?.webContents.send('publish:progress', p);
			return withBusy(req.platform, () => hubPost(jobId, filePath, req, send));
		}
	);
	ipcMain.handle('publish:hubJob', (_e, id: string) => hubJob(id));
	ipcMain.handle('publish:compose', (_e, recordingId: string, platforms: Platform[]) =>
		composePosts(recordingId, platforms)
	);
	ipcMain.handle('publish:hubStep', (_e, id: string) => hubStep(id));
	ipcMain.handle('publish:hubReschedule', (_e, id: string, when: string) =>
		hubReschedule(id, when)
	);
	ipcMain.handle('publish:youtubeReschedule', (_e, videoId: string, when: string) =>
		rescheduleYouTube(videoId, when)
	);
	ipcMain.handle('publish:youtubeDelete', (_e, videoId: string) => deleteYouTubeVideo(videoId));
	ipcMain.handle('publish:hubJobs', () => hubJobs());
	ipcMain.handle('publish:hubTikTokCreator', () => hubTikTokCreator());
	ipcMain.handle('publish:hubCancel', (_e, id: string) => hubCancel(id));
	// 送っている途中の取りやめ（投稿管理の ×）。次の区切りで止まる
	ipcMain.handle('publish:cancel', (_e, jobId: string) => cancelJob(jobId));
	ipcMain.handle('publish:imageDataUrl', async (_e, p: string) => {
		if (typeof p !== 'string' || !path.isAbsolute(p)) return null;
		const ext = path.extname(p).toLowerCase();
		const mime =
			ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : null;
		if (!mime) return null;
		try {
			const buf = await fs.readFile(p);
			if (buf.byteLength > 8 * 1024 * 1024) return null;
			return `data:${mime};base64,${buf.toString('base64')}`;
		} catch {
			return null;
		}
	});
	ipcMain.handle(
		'publish:captureThumbnail',
		async (
			_e,
			id: string,
			rect: { x: number; y: number; width: number; height: number },
			exportId?: string
		) => {
			const win = getWindow();
			if (!win || typeof id !== 'string') return null;
			const ok = [rect?.x, rect?.y, rect?.width, rect?.height].every(
				(v) => typeof v === 'number' && Number.isFinite(v)
			);
			if (!ok || rect.width < 16 || rect.height < 9)
				throw new Error('写す範囲が正しくありません。');
			const image = await win.webContents.capturePage({
				x: Math.round(rect.x),
				y: Math.round(rect.y),
				width: Math.round(rect.width),
				height: Math.round(rect.height)
			});
			const png = image.resize({ width: 1280, height: 720, quality: 'best' }).toPNG();
			const dest = (await exportFilePath(id, exportId)).replace(/\.mp4$/, '.thumb.png');
			await fs.mkdir(path.dirname(dest), { recursive: true });
			await fs.writeFile(dest, png);
			return dest;
		}
	);
	ipcMain.handle('publish:pickImage', async () => {
		const result = await dialog.showOpenDialog(getWindow() ?? undefined!, {
			title: 'サムネイルの画像を選ぶ',
			defaultPath: app.getPath('downloads'),
			buttonLabel: 'この画像にする',
			filters: [{ name: '画像', extensions: ['png', 'jpg', 'jpeg'] }],
			properties: ['openFile']
		});
		return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
	});

	// ---- ノードの画像 ----
	ipcMain.handle('images:add', () => addImageViaDialog(getWindow()));
	ipcMain.handle('images:importData', (_e, name: string, data: Uint8Array) =>
		importImageData(name, data)
	);
	ipcMain.handle('images:remove', (_e, fileName: string) => removeImage(fileName));

	ipcMain.handle('app:revealPath', (_e, filePath: string) => {
		if (typeof filePath === 'string' && path.isAbsolute(filePath)) shell.showItemInFolder(filePath);
	});
	// ウィンドウの幅を変える（脇の欄を開くときに広げ、閉じるときに戻す）。
	// 画面の作業領域に収まるように、右にはみ出す分は左へずらし、それでも入らなければ広げる量を減らす
	ipcMain.handle('app:resizeBy', (_e, dx: number) => {
		const win = getWindow();
		if (!win || typeof dx !== 'number' || !Number.isFinite(dx)) return 0;
		// 全画面・最大化・画面いっぱいのときは変えない（全画面中に変えると、戻したときの大きさが狂う）
		if (win.isFullScreen() || win.isSimpleFullScreen() || win.isMaximized()) return 0;
		const b = win.getBounds();
		const area = screen.getDisplayMatching(b).workArea;
		if (b.width >= area.width) return 0;
		const [minW] = win.getMinimumSize();
		let width = Math.round(b.width + dx);
		width = Math.max(minW || 320, Math.min(width, area.width));
		let x = b.x;
		if (x + width > area.x + area.width) x = area.x + area.width - width;
		if (x < area.x) x = area.x;
		win.setBounds({ x, y: b.y, width, height: b.height }, true);
		return width - b.width;
	});
	// サムネイル: 画面の一部（見えているまま）を写して 1280×720 の PNG にする
	ipcMain.handle(
		'app:saveThumbnail',
		async (_e, rect: { x: number; y: number; width: number; height: number }, baseName: string) => {
			const win = getWindow();
			if (!win) return null;
			const ok = [rect?.x, rect?.y, rect?.width, rect?.height].every(
				(v) => typeof v === 'number' && Number.isFinite(v)
			);
			if (!ok || rect.width < 16 || rect.height < 9)
				throw new Error('写す範囲が正しくありません。');
			const image = await win.webContents.capturePage({
				x: Math.round(rect.x),
				y: Math.round(rect.y),
				width: Math.round(rect.width),
				height: Math.round(rect.height)
			});
			const png = image.resize({ width: 1280, height: 720, quality: 'best' }).toPNG();
			const base = `${safeFileName(baseName || 'サムネイル')}（サムネ）.png`;
			const devDir = !app.isPackaged ? process.env.YASASHII_EXPORT_DIR : undefined;
			const dest = devDir
				? path.join(devDir, base)
				: await dialog
						.showSaveDialog(win, {
							title: 'サムネイルを保存する',
							defaultPath: path.join(app.getPath('downloads'), base),
							buttonLabel: '保存',
							filters: [{ name: 'PNG 画像', extensions: ['png'] }]
						})
						.then((r) => (r.canceled || !r.filePath ? null : r.filePath));
			if (!dest) return null;
			await fs.writeFile(dest, png);
			return dest;
		}
	);
	ipcMain.handle('app:setFullScreen', (_e, flag: boolean) => {
		getWindow()?.setFullScreen(flag === true);
	});
	ipcMain.handle('app:setBackgroundColor', (_e, color: string) => {
		// 画面側から来る値なので、色の形だけ受け付ける
		if (/^#[0-9a-fA-F]{6}$/.test(color)) getWindow()?.setBackgroundColor(color);
	});
}
