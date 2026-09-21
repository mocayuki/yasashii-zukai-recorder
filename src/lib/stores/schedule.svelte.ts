/**
 * 投稿管理の「確定する」。ドラッグで置いたもの（pendings）と、送っている途中の様子をここで持つ。
 * 画面（ScheduleScreen）を閉じても送信は続き、進み具合は画面の隅の帯（ExportBar）に出る。
 * 送信そのものは Electron 側（アップロード）なので、画面を離れても止まらない。アプリの終了だけは避ける
 */
import { withPostRecords, type ExportInfo, type PostRecord, type Recording } from '$shared/types';
import { PLATFORMS, type HubJob, type Platform } from '$shared/publish';
import { api } from '$lib/api';
import { library } from '$lib/stores/library.svelte';
import { toast } from '$lib/stores/toast.svelte';
import { postOne, progressId } from '$lib/publish/run';

/** 予約済みの 1 件（サーバーにある） */
export interface ScheduledItem {
	key: string;
	recording: Recording;
	post: PostRecord;
	when: Date;
	job?: HubJob;
}
/** まだ確定していない変更 */
export type Pending =
	| {
			id: string;
			kind: 'place';
			recording: Recording;
			ex: ExportInfo;
			remaining: Platform[];
			when: Date;
	  }
	/** 同じ書き出し・同じ時刻の予約のまとまり（複数の投稿先）をまとめて動かす */
	| { id: string; kind: 'move'; items: ScheduledItem[]; when: Date };

const label = (p: Platform) => PLATFORMS.find((x) => x.id === p)?.label ?? p;

class ScheduleStore {
	/** ドラッグで置いた・動かした変更（確定するまで） */
	pendings = $state<Pending[]>([]);
	/** 送っている途中の説明（null なら送っていない） */
	applying = $state<string | null>(null);
	/** いま上げている動画の進み具合 0〜1（アップロード中だけ） */
	ratio = $state(0);
	/** 前回の「確定する」でできなかったもの（消すまで出しておく。通知は消えてしまうので） */
	lastErrors = $state<string[]>([]);
	/** 確定が終わるたびに増える（画面はこれを見て予約を読み直す） */
	finished = $state(0);
	#subscribed = false;
	#watching: string | null = null;
	/** 送っている途中で取りやめた変更の id */
	#canceled = new Set<string>();
	/** いま送っている変更の id（送っていなければ null） */
	current = $state<string | null>(null);

	#subscribe(): void {
		if (this.#subscribed) return;
		this.#subscribed = true;
		api().publish.onProgress((p) => {
			if (p.id !== this.#watching) return;
			this.ratio = p.phase === 'uploading' ? p.ratio : p.phase === 'done' ? 1 : 0;
		});
	}

	get pendingCount(): number {
		return this.pendings.length;
	}

	/**
	 * 変更を取りやめる（投稿管理の ×）。まだ送っていなければ一覧から外すだけ。
	 * 送っている途中なら、いまのアップロードを次の区切りで止め、残りの投稿先も送らない。
	 * もう上げ終わった投稿先（YouTube の動画ができている等）はそのまま予約される
	 */
	async cancelPending(id: string): Promise<void> {
		this.pendings = this.pendings.filter((p) => p.id !== id);
		if (!this.applying) return;
		this.#canceled.add(id);
		if (this.current === id && this.#watching) {
			this.applying = '取りやめています…';
			await api().publish.cancel(this.#watching);
		}
	}

	/** まとめてハブ・YouTube へ送る。終わるまで applying に様子が入る */
	async applyAll(): Promise<void> {
		if (this.applying || this.pendings.length === 0) return;
		this.#subscribe();
		const list = this.pendings;
		let n = 0;
		const failed: string[] = [];
		try {
			for (const p of list) {
				n++;
				if (this.#canceled.has(p.id)) continue;
				this.current = p.id;
				if (p.kind === 'move') {
					this.#watching = null;
					this.ratio = 0;
					for (const it of p.items) {
						if (this.#canceled.has(p.id)) break;
						this.applying = `${n}/${list.length} ${label(it.post.platform)} の予約を動かしています…`;
						try {
							await reschedule(it, p.when);
						} catch (err) {
							failed.push(`${label(it.post.platform)}: ${(err as Error).message}`);
						}
					}
				} else {
					const note = library.notes.find((x) => x.id === p.recording.noteId) ?? null;
					const iso = p.when.toISOString();
					const records: PostRecord[] = [];
					for (const plat of p.remaining) {
						if (this.#canceled.has(p.id)) break;
						this.applying = `${n}/${list.length} ${p.recording.title} → ${label(plat)} を予約しています…`;
						this.#watching = progressId(p.recording.id, plat);
						this.ratio = 0;
						const draft = p.ex.drafts?.[plat];
						if (!draft) continue;
						try {
							const r = await postOne(plat, p.recording, p.ex, draft, note, iso);
							records.push(r.record);
							if (r.warning) toast.error(r.warning);
						} catch (err) {
							if ((err as Error).message === 'cancelled') continue; // 取りやめ（× を押した）
							failed.push(`${label(plat)}: ${(err as Error).message}`);
						}
					}
					if (this.#canceled.has(p.id))
						toast.show(
							records.length > 0
								? `取りやめました（${records.map((r) => label(r.platform)).join('・')} はもう予約されています）`
								: '取りやめました'
						);
					if (records.length > 0) {
						const rec = library.recordings.find((r) => r.id === p.recording.id) ?? p.recording;
						await library.updateRecording(rec.id, withPostRecords(rec, p.ex.id, records));
					}
				}
			}
			// 送っている間に置いたものは残す（取りやめたものは cancelPending で外してある）
			this.pendings = this.pendings.filter((p) => !list.includes(p));
			this.lastErrors = failed;
			const done = list.length - this.#canceled.size;
			if (failed.length > 0) toast.error(`できなかったものがあります。${failed.join(' / ')}`);
			else if (done > 0) toast.show(`${done} 件を確定しました`);
		} finally {
			this.applying = null;
			this.current = null;
			this.#canceled.clear();
			this.#watching = null;
			this.ratio = 0;
			this.finished++;
		}
	}
}

/** 予約の日時を動かす（YouTube は動画の公開日時、ほかはハブの仕事） */
export async function reschedule(it: ScheduledItem, next: Date): Promise<void> {
	const iso = next.toISOString();
	if (it.post.platform === 'youtube') {
		if (!it.post.videoId) throw new Error('YouTube の動画 id が記録にありません');
		await api().publish.youtubeReschedule(it.post.videoId, iso);
	} else if (it.post.jobId) {
		await api().publish.hubReschedule(it.post.jobId, iso);
	} else throw new Error('ハブの仕事の id が記録にありません');
	const rec = library.recordings.find((r) => r.id === it.recording.id);
	if (!rec) return;
	await library.updateRecording(rec.id, {
		posts: (rec.posts ?? []).map((p) =>
			p.at === it.post.at && p.platform === it.post.platform ? { ...p, scheduledAt: iso } : p
		)
	});
}

export const schedule = new ScheduleStore();
