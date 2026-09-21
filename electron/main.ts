import {
	app,
	BrowserWindow,
	dialog,
	net,
	protocol,
	screen,
	session,
	shell,
	systemPreferences
} from 'electron';
import { createReadStream, existsSync, mkdirSync, promises as fs, renameSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { ipcMain } from 'electron';
import { registerIpc } from './ipc';
import { hasRunningExports } from './lib/export';
import { hasRunningPublishes } from './lib/busy';
import { bgmDir } from './lib/bgm';
import { ensureLibrary, migrateLegacyLibrary } from './lib/library';
import { setMainWindowGetter } from './lib/present';
import { loadSettings, saveSettings } from './lib/settings';
import type { Settings } from '../shared/types';

/** 起動時に読んだ設定（ウィンドウを作る前に位置と大きさを知るため） */
let settingsCache: Settings | null = null;
import { closeAll, recoverUnfinished } from './lib/recorder';

const DEV_URL = process.env.ELECTRON_DEV_URL;
const BUILD_DIR = path.join(app.getAppPath(), 'build');

// 開発時の動作確認用: 設定の置き場所を別にして、使っている本物のアプリと別に起動できるようにする
if (!app.isPackaged && process.env.YASASHII_USER_DATA) {
	app.setPath('userData', process.env.YASASHII_USER_DATA);
} else {
	migrateUserDataFromOldName();
}

/**
 * 旧名「やさしい録音ノート」のころの設定・保存先・BGM を、新しい名前の置き場所へ移す（一度だけ）。
 * 設定を読む前に済ませる必要があるので、同期で行う。
 */
function migrateUserDataFromOldName(): void {
	const oldDir = path.join(app.getPath('appData'), 'やさしい録音ノート');
	const newDir = app.getPath('userData');
	if (!existsSync(oldDir) || existsSync(path.join(newDir, 'settings.json'))) return;
	try {
		mkdirSync(newDir, { recursive: true });
		for (const name of ['settings.json', 'library', 'bgm']) {
			const from = path.join(oldDir, name);
			const to = path.join(newDir, name);
			if (existsSync(from) && !existsSync(to)) renameSync(from, to);
		}
	} catch (err) {
		console.warn('旧名の設定・保存先を移せませんでした', err);
	}
}

let mainWindow: BrowserWindow | null = null;

// app://   画面（SvelteKit の静的ビルド）
// media:// 保存先フォルダーの収録ファイル（再生用）
protocol.registerSchemesAsPrivileged([
	{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
	{
		scheme: 'media',
		// corsEnabled: app:// の画面から fetch で読めるように（BGM の読み込みに必要）
		privileges: {
			standard: true,
			secure: true,
			stream: true,
			supportFetchAPI: true,
			corsEnabled: true
		}
	}
]);

function serveBuild(request: Request): Promise<Response> {
	const url = new URL(request.url);
	let rel = decodeURIComponent(url.pathname);
	if (rel === '/' || rel === '') rel = '/index.html';
	const file = path.normalize(path.join(BUILD_DIR, rel));
	if (!file.startsWith(BUILD_DIR))
		return Promise.resolve(new Response('Not found', { status: 404 }));
	return net.fetch(pathToFileURL(file).toString()).catch(
		// ファイルが無いパスは SPA の index.html に戻す（画面内の遷移用）
		() => net.fetch(pathToFileURL(path.join(BUILD_DIR, 'index.html')).toString())
	);
}

async function serveMedia(request: Request): Promise<Response> {
	// media://local/<file>        → <保存先>/media/<file>
	// media://local/bgm/<file>    → userData/bgm/<file>（アプリ自身の置き場所）
	// media://local/exports/<file> → <保存先>/exports/<file>（書き出した mp4）
	const url = new URL(request.url);
	const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
	const root = await ensureLibrary();
	let file: string;
	if (parts[0] === 'bgm' && parts.length === 2) {
		file = path.join(bgmDir(), path.basename(parts[1]));
	} else if (parts[0] === 'images' && parts.length === 2) {
		file = path.join(root, 'images', path.basename(parts[1]));
	} else if (parts[0] === 'exports' && parts.length === 2) {
		// 書き出した mp4（投稿の画面で再生する）
		file = path.join(root, 'exports', path.basename(parts[1]));
	} else if (parts.length === 1) {
		file = path.join(root, 'media', path.basename(parts[0]));
	} else {
		return new Response('Not found', { status: 404 });
	}
	return serveFileWithRange(file, request);
}

const MEDIA_TYPES: Record<string, string> = {
	'.webm': 'video/webm',
	'.mp4': 'video/mp4',
	'.m4a': 'audio/mp4',
	'.mp3': 'audio/mpeg',
	'.wav': 'audio/wav',
	'.ogg': 'audio/ogg',
	'.flac': 'audio/flac',
	'.aac': 'audio/aac',
	'.aiff': 'audio/aiff',
	'.aif': 'audio/aiff',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.bmp': 'image/bmp',
	'.svg': 'image/svg+xml'
};

/**
 * Range 要求に 206 で応える。これが無いと Chromium は動画を「シークできない」と見なし、
 * 再生位置を動かしても先頭に戻ってしまう（MediaRecorder の webm は特に）。
 * app:// から fetch で読む（BGM の読み込み）には、別オリジンなので CORS の許可も付ける。
 */
async function serveFileWithRange(file: string, request: Request): Promise<Response> {
	let size: number;
	try {
		size = (await fs.stat(file)).size;
	} catch {
		return new Response('Not found', { status: 404 });
	}
	const type = MEDIA_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
	const headers = new Headers({
		'Content-Type': type,
		// ノードの画像はファイル名が固有（UUID）で中身が変わらないので、長く覚えてよい（開閉のたびに読み直さない）
		...(type.startsWith('image/') ? { 'Cache-Control': 'max-age=31536000, immutable' } : {}),
		'Accept-Ranges': 'bytes',
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges'
	});
	const range = request.headers.get('range');
	let start = 0;
	let end = size - 1;
	let status = 200;
	if (range) {
		const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
		if (!m) return new Response('Bad range', { status: 416 });
		if (m[1] === '' && m[2] !== '') {
			start = Math.max(0, size - Number(m[2]));
		} else {
			start = Number(m[1] || 0);
			if (m[2] !== '') end = Math.min(end, Number(m[2]));
		}
		if (start > end || start >= size) {
			headers.set('Content-Range', `bytes */${size}`);
			return new Response(null, { status: 416, headers });
		}
		status = 206;
		headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
	}
	headers.set('Content-Length', String(end - start + 1));
	if (request.method === 'HEAD') return new Response(null, { status, headers });
	const stream = createReadStream(file, { start, end });
	return new Response(Readable.toWeb(stream) as unknown as ReadableStream, { status, headers });
}

/** 覚えていた位置と大きさが、いまある画面のどれかに（ほぼ）収まるか */
function boundsUsable(b: { x: number; y: number; width: number; height: number } | null): boolean {
	if (!b) return false;
	return screen.getAllDisplays().some((d) => {
		const a = d.workArea;
		return (
			b.x + b.width > a.x + 40 &&
			b.x < a.x + a.width - 40 &&
			b.y >= a.y - 10 &&
			b.y < a.y + a.height - 40
		);
	});
}

function createWindow(): void {
	// 前回の位置と大きさに戻す（その画面がもう無ければ既定の大きさで開く）
	const saved = settingsCache?.windowBounds ?? null;
	const usable = boundsUsable(saved);
	mainWindow = new BrowserWindow({
		width: usable && saved ? saved.width : 1240,
		height: usable && saved ? saved.height : 820,
		...(usable && saved ? { x: saved.x, y: saved.y } : {}),
		minWidth: 900,
		minHeight: 600,
		title: 'やさしい図解レコーダー',
		titleBarStyle: 'hiddenInset',
		trafficLightPosition: { x: 16, y: 18 },
		backgroundColor: '#FFD95C',
		webPreferences: {
			preload: path.join(__dirname, 'preload.cjs'),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true
		}
	});

	// 外部リンクはアプリ内で開かず、ブラウザーへ渡す
	mainWindow.webContents.setWindowOpenHandler(({ url }) => {
		if (url.startsWith('http')) void shell.openExternal(url);
		return { action: 'deny' };
	});

	if (DEV_URL) {
		void mainWindow.loadURL(DEV_URL);
		mainWindow.webContents.openDevTools({ mode: 'detach' });
	} else {
		void mainWindow.loadURL('app://local/');
	}

	// 全画面の出入りを画面へ知らせる（OS 側の操作で戻った場合も含む）
	// 確認用インスタンス（設定の置き場所を変えて起動）は、本物と見分けがつくように名前を変える
	if (process.env.YASASHII_USER_DATA) {
		const mark = () => mainWindow?.setTitle('やさしい図解レコーダー（確認用・本物ではありません）');
		mainWindow.on('page-title-updated', (e) => {
			e.preventDefault();
			mark();
		});
		mark();
	}

	// 動かしたり大きさを変えたりしたら、少し待ってから設定に覚える（全画面のときは覚えない）。
	// 一覧とワークスペースで別々に覚え、切り替えたときにそれぞれの大きさへ戻す
	let windowMode: 'list' | 'workspace' = 'list';
	const boundsKey = () => (windowMode === 'workspace' ? 'workspaceBounds' : 'windowBounds');
	let boundsTimer: ReturnType<typeof setTimeout> | null = null;
	const currentBounds = () => {
		if (!mainWindow || mainWindow.isFullScreen() || mainWindow.isMinimized()) return null;
		const b = mainWindow.getNormalBounds();
		return { x: b.x, y: b.y, width: b.width, height: b.height };
	};
	const rememberBounds = () => {
		if (!currentBounds()) return;
		if (boundsTimer) clearTimeout(boundsTimer);
		boundsTimer = setTimeout(() => {
			const b = currentBounds();
			if (b) void saveSettings({ [boundsKey()]: b });
		}, 400);
	};
	mainWindow.on('resize', rememberBounds);
	mainWindow.on('move', rememberBounds);
	// createWindow はウィンドウを閉じて Dock から開き直したときにもう一度走る。受け口は 1 つしか登録できないので、前のを外してから登録する
	ipcMain.removeHandler('app:setWindowMode');
	ipcMain.handle('app:setWindowMode', async (_e, mode: unknown) => {
		if ((mode !== 'list' && mode !== 'workspace') || mode === windowMode || !mainWindow) return;
		// いまの画面の大きさを、待たずにその画面の分として覚えてから切り替える
		if (boundsTimer) clearTimeout(boundsTimer);
		const b = currentBounds();
		if (b) await saveSettings({ [boundsKey()]: b });
		windowMode = mode;
		const next = (await loadSettings())[boundsKey()];
		if (next && boundsUsable(next) && !mainWindow.isFullScreen()) {
			mainWindow.setBounds(next, true);
		}
	});

	mainWindow.on('enter-full-screen', () => {
		mainWindow?.webContents.send('app:fullscreen-changed', true);
	});
	mainWindow.on('leave-full-screen', () => {
		mainWindow?.webContents.send('app:fullscreen-changed', false);
	});

	mainWindow.on('closed', () => {
		mainWindow = null;
	});
}

// 2 つ同時に開くと同じ保存先に書いてぶつかるので、1 つだけにする（2 つ目を開いたら 1 つ目を前に出す）
// 確認用インスタンスは設定の置き場所が別なので、この制限の外
if (!process.env.YASASHII_USER_DATA && !app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on('second-instance', () => {
		if (!mainWindow) return;
		if (mainWindow.isMinimized()) mainWindow.restore();
		mainWindow.focus();
	});
}

app.whenReady().then(async () => {
	protocol.handle('app', serveBuild);
	protocol.handle('media', serveMedia);
	// 以前の既定（ダウンロードの中）を使っていたら、アプリ自身の置き場所へ移す
	await migrateLegacyLibrary().catch(() => false);
	settingsCache = await loadSettings();
	await ensureLibrary();
	// 前回、終了処理まで行けなかった収録があれば回収の状態にする
	await recoverUnfinished().catch(() => 0);
	registerIpc(() => mainWindow);
	setMainWindowGetter(() => mainWindow);

	// 画面が getDisplayMedia を呼んだら、OS の選択画面を出さずに自分の画面の中身を渡す。
	// （黄色い枠の切り出しは画面側で行う。macOS の画面収録の許可も不要）
	session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
		callback({ video: request.frame ?? undefined });
	});

	// マイクの許可は OS に任せる（初回にダイアログが出る）
	if (process.platform === 'darwin') {
		void systemPreferences.askForMediaAccess('microphone').catch(() => false);
	}

	createWindow();

	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

app.on('before-quit', (e) => {
	// 書き出しの途中で終了すると出来上がらないので、確かめる
	if (hasRunningExports() || hasRunningPublishes()) {
		const publishing = hasRunningPublishes();
		const r = dialog.showMessageBoxSync({
			type: 'warning',
			buttons: [publishing ? '送信を待つ' : '書き出しを待つ', '終了する'],
			defaultId: 0,
			cancelId: 0,
			message: publishing ? 'SNS へ動画を送っている途中です' : 'mp4 を書き出している途中です',
			detail: publishing
				? '終了すると送信は途中で止まり、予約は登録されません。'
				: '終了すると書き出しは途中で止まり、ファイルはできません。'
		});
		if (r === 0) {
			e.preventDefault();
			return;
		}
	}
	void closeAll();
});

app.on('window-all-closed', () => {
	// Mac の流儀に合わせ、ウィンドウを閉じてもアプリは残す
	if (process.platform !== 'darwin') app.quit();
});
