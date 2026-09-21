import { BrowserWindow } from 'electron';
import path from 'node:path';

/**
 * プレゼン用の窓（Zoom や Meet で共有する用）。
 * 黄色い枠だけを出し、ワークスペースの編集（ノードの開閉・文字・選択）に連動する。
 * 中身は同じ画面（app://）を `#present=<noteId>` で開いたもの。状態はワークスペース側から IPC で流す
 */

let presentWindow: BrowserWindow | null = null;
let lastState: unknown = null;
let getMain: () => BrowserWindow | null = () => null;

export function setMainWindowGetter(getter: () => BrowserWindow | null): void {
	getMain = getter;
}

export function getPresentWindow(): BrowserWindow | null {
	return presentWindow && !presentWindow.isDestroyed() ? presentWindow : null;
}

export function openPresentWindow(noteId: string, portrait: boolean): void {
	const existing = getPresentWindow();
	if (existing) {
		existing.focus();
		return;
	}
	presentWindow = new BrowserWindow({
		width: portrait ? 486 : 960,
		height: portrait ? 864 : 540,
		minWidth: 240,
		minHeight: 240,
		title: 'やさしい図解レコーダー（プレゼン）',
		backgroundColor: '#FFD95C',
		webPreferences: {
			preload: path.join(__dirname, 'preload.cjs'),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true
		}
	});
	// 中身は黄色い枠そのものなので、窓の比率を枠と同じに保つ（16:9 または 9:16）
	presentWindow.setAspectRatio(portrait ? 9 / 16 : 16 / 9);
	presentWindow.on('closed', () => {
		presentWindow = null;
		getMain()?.webContents.send('present:open-changed', false);
	});
	presentWindow.webContents.on('did-finish-load', () => {
		if (lastState) presentWindow?.webContents.send('present:state', lastState);
		if (lastCamera) presentWindow?.webContents.send('present:camera', lastCamera);
	});
	const hash = `#present=${encodeURIComponent(noteId)}`;
	const dev = process.env.ELECTRON_DEV_URL;
	void presentWindow.loadURL(dev ? `${dev}/${hash}` : `app://local/${hash}`);
	getMain()?.webContents.send('present:open-changed', true);
}

/** 向きが変わったら、窓の比率と形も変える（幅はいまのまま、高さを比率に合わせる） */
export function applyPresentOrientation(portrait: boolean): void {
	const win = getPresentWindow();
	if (!win) return;
	const ratio = portrait ? 9 / 16 : 16 / 9;
	win.setAspectRatio(ratio);
	const [w] = win.getContentSize();
	const width = portrait ? Math.min(w, 600) : Math.max(w, 640);
	win.setContentSize(width, Math.round(width / ratio), true);
}

export function closePresentWindow(): void {
	getPresentWindow()?.close();
}

let lastCamera: unknown = null;
/** カメラ（見ている位置と倍率）を流す。窓が開いた直後にも最後のものを渡す */
export function forwardPresentCamera(camera: unknown): void {
	lastCamera = camera;
	getPresentWindow()?.webContents.send('present:camera', camera);
}

/** ワークスペースから来た状態を、プレゼン用の窓へ流す（開いていなければ覚えておくだけ） */
export function forwardPresentState(state: unknown): void {
	lastState = state;
	getPresentWindow()?.webContents.send('present:state', state);
}
