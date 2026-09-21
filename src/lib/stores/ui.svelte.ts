import { api } from '$lib/api';

/** 画面の見た目の状態（データではないもの） */
class UiStore {
	/** ワークスペース（マップの編集と収録を行う画面）を開いているか */
	workspace = $state(false);
	/** ウィンドウが画面全体になっているか（OS の状態に追従） */
	fullscreen = $state(false);
	/** 編集画面で開いている収録の id（null = 開いていない） */
	editingRecordingId = $state<string | null>(null);
	/** SNS 投稿の画面で開いている収録と書き出し（編集画面より手前に出る） */
	publishing = $state<{ recordingId: string; exportId: string } | null>(null);
	/** 投稿管理の画面を開いているか（いちばん手前） */
	scheduleOpen = $state(false);

	/** ワークスペースは普通のウィンドウのまま開く。大きさは自由に変えられる */
	enterWorkspace(): void {
		this.workspace = true;
		void api()
			.app.setWindowMode('workspace')
			.catch(() => {});
		// 大きさを変えるときに隙間から見える地の色を、周りと同じ水色にする
		void api()
			.app.setBackgroundColor('#8FD6F0')
			.catch(() => {});
	}

	/** 閉じるときは、画面全体になっていれば元の大きさに戻す */
	leaveWorkspace(): void {
		this.workspace = false;
		if (this.fullscreen) this.setFullScreen(false);
		void api()
			.app.setWindowMode('list')
			.catch(() => {});
		void api()
			.app.setBackgroundColor('#FFD95C')
			.catch(() => {});
	}

	setFullScreen(flag: boolean): void {
		void api()
			.app.setFullScreen(flag)
			.catch(() => {});
	}

	toggleFullScreen(): void {
		this.setFullScreen(!this.fullscreen);
	}
}

export const ui = new UiStore();
