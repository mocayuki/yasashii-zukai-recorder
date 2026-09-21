import { exportsOf, type ExportOptions, type ExportProgress } from '$shared/types';
import { api } from '$lib/api';
import { toast } from '$lib/stores/toast.svelte';
import { library } from '$lib/stores/library.svelte';
import { ui } from '$lib/stores/ui.svelte';

/** 書き出しの 1 件の様子（画面のどこからでも見られるように、編集画面ではなくここで持つ） */
export interface ExportJob extends ExportProgress {
	title: string;
	/** 出来上がったファイル（done のとき） */
	dest?: string;
	/** 試し書き出し（先頭だけ）か */
	trial?: boolean;
}

/**
 * mp4 の書き出しは Electron 側（ffmpeg）で進むので、編集画面を閉じても止まらない。
 * 進み具合はここで受けて、編集画面にも、画面の隅の帯にも出す。終わったら通知する
 */
class ExportsStore {
	jobs = $state<Record<string, ExportJob>>({});
	#subscribed = false;

	#subscribe(): void {
		if (this.#subscribed) return;
		this.#subscribed = true;
		api().recordings.onExportProgress((p) => {
			const cur = this.jobs[p.id];
			if (!cur) return;
			this.jobs = { ...this.jobs, [p.id]: { ...cur, ...p } };
		});
	}

	/** いま進んでいる書き出し */
	get active(): ExportJob[] {
		return Object.values(this.jobs).filter(
			(j) => j.phase === 'preparing' || j.phase === 'encoding'
		);
	}

	isRunning(id: string): boolean {
		const j = this.jobs[id];
		return !!j && (j.phase === 'preparing' || j.phase === 'encoding');
	}

	/** 書き出しを始める。出来上がりの場所を返す（取りやめなら null） */
	async start(id: string, title: string, opts: ExportOptions): Promise<string | null> {
		if (this.isRunning(id)) return null;
		this.#subscribe();
		this.jobs = {
			...this.jobs,
			[id]: { id, title, ratio: 0, phase: 'preparing', trial: !!opts.limitMs }
		};
		try {
			const result = await api().recordings.exportMp4(id, opts);
			const saved = result?.path ?? null;
			if (result && saved) {
				this.jobs = {
					...this.jobs,
					[id]: { ...this.jobs[id], ratio: 1, phase: 'done', dest: saved }
				};
				if (opts.limitMs || !result.export) {
					toast.show(`mp4 を書き出しました: ${saved}`);
				} else {
					// 本番の書き出しは保存先の exports/ に履歴として残る。収録に記録して、開いていれば SNS 投稿の画面へ
					const rec = library.recordings.find((r) => r.id === id);
					const prev = rec ? exportsOf(rec) : [];
					await library.updateRecording(id, {
						exports: [...prev, result.export],
						export: undefined
					});
					toast.show('mp4 を書き出しました');
					if (ui.editingRecordingId === id)
						ui.publishing = { recordingId: id, exportId: result.export.id };
				}
			} else {
				// 取りやめ（保存先の選択でキャンセル、または中止）
				this.jobs = { ...this.jobs, [id]: { ...this.jobs[id], phase: 'cancelled' } };
			}
			return saved;
		} catch (err) {
			const message = (err as Error)?.message ?? '';
			this.jobs = { ...this.jobs, [id]: { ...this.jobs[id], phase: 'failed', message } };
			toast.error(`書き出しに失敗しました。${message}`);
			return null;
		}
	}

	cancel(id: string): void {
		void api().recordings.cancelExport(id);
	}
}

export const exports = new ExportsStore();
