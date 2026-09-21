import type { MapNode, Note, Recording, ThumbnailState } from '$shared/types';
import { locate, newNode, plainText } from '$shared/notes';
import { api } from '$lib/api';
import { newId } from '$lib/utils/format';

export type SaveStatus =
	| { state: 'idle' }
	| { state: 'dirty' }
	| { state: 'saving' }
	| { state: 'saved'; at: number }
	| { state: 'error'; message: string };

const AUTOSAVE_DELAY_MS = 600;
const HISTORY_LIMIT = 100;
/** 同じ種類の変更が続くあいだは 1 つの「元に戻す」にまとめる時間 */
const HISTORY_MERGE_MS = 800;

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

interface History {
	undo: Note[];
	redo: Note[];
	lastKey: string;
	lastAt: number;
}

/**
 * ノートと収録の一覧（ライブラリー）。
 * 画面はここだけを見て描き、ここだけを通して書く。
 * ノートの変更は即座にメモリーへ反映し、少し待ってからファイルに書く（自動保存）。
 * 変更の前に写しを取っておき、⌘Z で戻せる。
 */
class LibraryStore {
	notes = $state<Note[]>([]);
	recordings = $state<Recording[]>([]);
	selectedId = $state<string | null>(null);
	query = $state('');
	loading = $state(true);
	loadError = $state<string | null>(null);
	saveStatus = $state<SaveStatus>({ state: 'idle' });

	#timers = new Map<string, ReturnType<typeof setTimeout>>();
	#pending = new Set<string>();
	#history = new Map<string, History>();
	/** 履歴が変わるたびに増える（画面がボタンの押せる／押せないを追えるように） */
	historyTick = $state(0);

	selected = $derived(this.notes.find((n) => n.id === this.selectedId) ?? null);

	filtered = $derived.by(() => {
		const q = this.query.trim().normalize('NFKC').toLowerCase();
		const sorted = [...this.notes].sort((a, b) => b.updatedAt - a.updatedAt);
		if (!q) return sorted;
		const words = q.split(/\s+/);
		return sorted.filter((n) => {
			const markers = this.recordingsOf(n.id)
				.flatMap((r) => r.markers.map((m) => m.text))
				.join('\n');
			const hay = `${n.title}\n${plainText([n.root])}\n${markers}`.normalize('NFKC').toLowerCase();
			return words.every((w) => hay.includes(w));
		});
	});

	recordingsOf(noteId: string): Recording[] {
		return this.recordings
			.filter((r) => r.noteId === noteId)
			.sort((a, b) => a.createdAt - b.createdAt);
	}

	snippet(note: Note): string {
		const nodes = note.root.text.trim() === note.title.trim() ? note.root.children : [note.root];
		return plainText(nodes).split('\n').filter(Boolean).slice(0, 2).join(' ').slice(0, 80);
	}

	async load(): Promise<void> {
		this.loading = true;
		try {
			const [notes, recordings, folders] = await Promise.all([
				api().notes.list(),
				api().recordings.list(),
				api()
					.folders.list()
					.catch(() => [] as string[])
			]);
			this.savedFolders = folders;
			this.notes = notes;
			this.recordings = recordings;
			this.loadError = null;
		} catch (err) {
			this.loadError = (err as Error).message ?? '読み込みに失敗しました。';
		} finally {
			this.loading = false;
		}
	}

	select(id: string | null): void {
		this.selectedId = id;
		this.saveStatus = { state: 'idle' };
	}

	/**
	 * ノートを複製する。木・フォルダー・向き・サムネの状態を写し、ノードの id は全部振り直す。
	 * 収録とテロップは元のノートのもので、写さない。画像はファイル名で共有する（外しても消えない）
	 */
	async duplicateNote(id: string): Promise<Note | null> {
		const src = this.#note(id);
		if (!src) return null;
		const copy = JSON.parse(JSON.stringify(src)) as Note;
		const renumber = (n: MapNode) => {
			n.id = newId();
			n.children.forEach(renumber);
		};
		renumber(copy.root);
		const now = Date.now();
		copy.id = newId();
		copy.title = `${src.title.trim() || '無題のノート'}（コピー）`;
		copy.createdAt = now;
		copy.updatedAt = now;
		const at = this.notes.findIndex((n) => n.id === id);
		this.notes = [...this.notes.slice(0, at + 1), copy, ...this.notes.slice(at + 1)];
		this.select(copy.id);
		await this.#write(copy.id);
		return copy;
	}

	async createNote(initial: Partial<Note> = {}): Promise<Note> {
		const now = Date.now();
		const note: Note = {
			id: newId(),
			title: '',
			root: newNode(''),
			createdAt: now,
			updatedAt: now,
			...initial
		};
		this.notes = [note, ...this.notes];
		this.select(note.id);
		await this.#write(note.id);
		return note;
	}

	// ---- ノートの編集（メモリーはすぐ更新し、書き込みは少し待ってまとめる） ----

	updateTitle(id: string, title: string): void {
		const note = this.#note(id);
		if (!note) return;
		this.#remember(id, 'title');
		note.title = title;
		this.#touch(id);
	}

	/** Markdown 編集で、タイトルと木をまるごと置き換える（title が null なら据え置き） */
	replaceDocument(id: string, title: string | null, root: MapNode): void {
		const note = this.#note(id);
		if (!note) return;
		this.#remember(id, 'markdown');
		if (title !== null) note.title = title;
		note.root = root;
		this.#touch(id);
	}

	updateAnnotation(noteId: string, nodeId: string, annotation: string): void {
		const hit = this.#locate(noteId, nodeId);
		if (!hit) return;
		this.#remember(noteId, `annotation:${nodeId}`);
		hit.node.annotation = annotation;
		this.#touch(noteId);
	}

	/** 手で動かした位置を覚える（null で自動配置に戻す） */
	setNodePos(noteId: string, nodeId: string, pos: { x: number; y: number } | null): void {
		const hit = this.#locate(noteId, nodeId);
		if (!hit) return;
		this.#remember(noteId, `pos:${nodeId}`);
		hit.node.pos = pos;
		this.#touch(noteId);
	}

	/** 手で動かしたノードが 1 つでもあるか */
	hasManualPositions(noteId: string): boolean {
		const note = this.#note(noteId);
		if (!note) return false;
		const walk = (n: MapNode): boolean => n.pos !== null || n.children.some(walk);
		return walk(note.root);
	}

	/** 手で動かしたノードを全部、自動の位置に戻す（⌘Z で戻せる） */
	resetAllPositions(noteId: string): void {
		const note = this.#note(noteId);
		if (!note || !this.hasManualPositions(noteId)) return;
		this.#remember(noteId, 'reset-positions');
		const walk = (n: MapNode) => {
			n.pos = null;
			n.children.forEach(walk);
		};
		walk(note.root);
		this.#touch(noteId);
	}

	updateNodeText(noteId: string, nodeId: string, text: string): void {
		const hit = this.#locate(noteId, nodeId);
		if (!hit) return;
		this.#remember(noteId, `text:${nodeId}`);
		hit.node.text = text;
		this.#touch(noteId);
	}

	/** 子を足す。追加したノードを返す */
	addChild(noteId: string, parentId: string, text = ''): MapNode | null {
		const hit = this.#locate(noteId, parentId);
		if (!hit) return null;
		this.#remember(noteId, 'add');
		const node = newNode(text);
		hit.node.children.push(node);
		hit.node.collapsed = false;
		this.#touch(noteId);
		return node;
	}

	/** 下に足す（根には使えない） */
	addSibling(noteId: string, nodeId: string, text = '', before = false): MapNode | null {
		const hit = this.#locate(noteId, nodeId);
		if (!hit || !hit.parent) return null;
		this.#remember(noteId, 'add');
		const node = newNode(text);
		hit.siblings.splice(before ? hit.index : hit.index + 1, 0, node);
		this.#touch(noteId);
		return node;
	}

	/** 根は消せない */
	removeNode(noteId: string, nodeId: string): void {
		const hit = this.#locate(noteId, nodeId);
		if (!hit || !hit.parent) return;
		this.#remember(noteId, 'remove');
		hit.siblings.splice(hit.index, 1);
		this.#touch(noteId);
	}

	/** 開閉を指定の状態にする（サムネイルで一時的に全部開き、閉じるときに元へ戻す用。履歴には残さない） */
	setCollapsed(noteId: string, nodeId: string, collapsed: boolean): void {
		const hit = this.#locate(noteId, nodeId);
		if (!hit || hit.node.children.length === 0 || hit.node.collapsed === collapsed) return;
		hit.node.collapsed = collapsed;
		this.#touch(noteId);
	}

	toggleCollapsed(noteId: string, nodeId: string): void {
		const hit = this.#locate(noteId, nodeId);
		if (!hit || hit.node.children.length === 0) return;
		this.#remember(noteId, `collapse:${nodeId}`);
		hit.node.collapsed = !hit.node.collapsed;
		this.#touch(noteId);
	}

	/** チェックがあるノードだけ、未 ↔ 済 を切り替える（収録中用。チェック自体は消さない） */
	toggleChecked(noteId: string, nodeId: string): void {
		const hit = this.#locate(noteId, nodeId);
		if (!hit || hit.node.checked === null) return;
		this.#remember(noteId, `check:${nodeId}`);
		hit.node.checked = !hit.node.checked;
		this.#touch(noteId);
	}

	/** 保存してあるフォルダーの名前（空のフォルダーも持てるよう、ノートとは別に `folders.json` に持つ） */
	savedFolders = $state<string[]>([]);

	/**
	 * フォルダーの名前の一覧。保存してある順（新しく作ったものが先頭）に、
	 * ノートにだけ付いている名前を後ろに足す。並び替えはしない（上から作業できるように）
	 */
	folders = $derived([
		...new Set([
			...this.savedFolders,
			...this.notes.map((n) => n.folder).filter((f): f is string => !!f)
		])
	]);

	async #persistFolders(): Promise<void> {
		try {
			await api().folders.save([...this.savedFolders]);
		} catch (err) {
			console.warn('フォルダーの一覧を保存できませんでした', err);
		}
	}

	/** フォルダーの並びを変える（name を target の前または後ろへ）。ノートにだけ付いている名前も含めた並びを保存する */
	async moveFolder(name: string, target: string, place: 'before' | 'after'): Promise<void> {
		if (name === target) return;
		const list = this.folders.filter((f) => f !== name);
		const at = list.indexOf(target);
		if (at < 0) return;
		list.splice(place === 'before' ? at : at + 1, 0, name);
		this.savedFolders = list;
		await this.#persistFolders();
	}

	/** 空のフォルダーを作る（同じ名前があれば何もしない） */
	async createFolder(name: string): Promise<boolean> {
		const n = name.trim();
		if (!n || this.folders.includes(n)) return false;
		this.savedFolders = [n, ...this.savedFolders]; // 新しいフォルダーは先頭に
		await this.#persistFolders();
		return true;
	}

	/** ノートをフォルダーに入れる／出す（null で出す）。フォルダーは名前だけの 1 段の入れ物 */
	setFolder(noteId: string, folder: string | null): void {
		const note = this.#note(noteId);
		if (!note) return;
		const next = folder?.trim() || null;
		if ((note.folder ?? null) === next) return;
		note.folder = next;
		if (next && !this.savedFolders.includes(next)) {
			this.savedFolders = [...this.savedFolders, next];
			void this.#persistFolders();
		}
		this.#touch(noteId);
	}

	/** フォルダーの名前を変える（入っているノート全部に付け直す） */
	async renameFolder(from: string, to: string): Promise<void> {
		const next = to.trim();
		if (!next || next === from) return;
		this.savedFolders = [...new Set(this.savedFolders.map((f) => (f === from ? next : f)))];
		for (const n of this.notes) if (n.folder === from) this.setFolder(n.id, next);
		await this.#persistFolders();
		await this.flush();
	}

	/** フォルダーをなくす（中のノートはフォルダーなしに戻る。ノートは消えない） */
	async dissolveFolder(name: string): Promise<void> {
		this.savedFolders = this.savedFolders.filter((f) => f !== name);
		for (const n of this.notes) if (n.folder === name) this.setFolder(n.id, null);
		await this.#persistFolders();
		await this.flush();
	}

	/** 動画の向き（横／縦）を変える */
	/** サムネイルを作ったときの状態を覚える（履歴には残さない） */
	setThumbnail(noteId: string, thumbnail: ThumbnailState): void {
		const note = this.#note(noteId);
		if (!note) return;
		note.thumbnail = thumbnail;
		this.#touch(noteId);
	}

	setOrientation(noteId: string, orientation: 'landscape' | 'portrait'): void {
		const note = this.#note(noteId);
		if (!note || (note.orientation ?? 'landscape') === orientation) return;
		this.#remember(noteId, 'orientation');
		note.orientation = orientation;
		this.#touch(noteId);
	}

	/** 子のあるノードを全部閉じる（収録の始めに。話しながら開いていく。⌘Z で戻せる）。閉じた数を返す */
	collapseAll(noteId: string): number {
		const note = this.#note(noteId);
		if (!note) return 0;
		let count = 0;
		const walk = (n: MapNode) => {
			if (n.children.length > 0 && !n.collapsed) count += 1;
			n.children.forEach(walk);
		};
		walk(note.root);
		if (count === 0) return 0;
		this.#remember(noteId, 'collapse-all');
		const close = (n: MapNode) => {
			if (n.children.length > 0) n.collapsed = true;
			n.children.forEach(close);
		};
		close(note.root);
		this.#touch(noteId);
		return count;
	}

	/** 閉じているノードを全部開く。開いた数を返す */
	expandAll(noteId: string): number {
		const note = this.#note(noteId);
		if (!note) return 0;
		let count = 0;
		const walk = (n: MapNode) => {
			if (n.children.length > 0 && n.collapsed) count += 1;
			n.children.forEach(walk);
		};
		walk(note.root);
		if (count === 0) return 0;
		this.#remember(noteId, 'expand-all');
		const open = (n: MapNode) => {
			n.collapsed = false;
			n.children.forEach(open);
		};
		open(note.root);
		this.#touch(noteId);
		return count;
	}

	/** 済になっているチェックを全部、未に戻す（収録の始めに。⌘Z で戻せる）。戻した数を返す */
	resetChecks(noteId: string): number {
		const note = this.#note(noteId);
		if (!note) return 0;
		let count = 0;
		const walk = (n: MapNode) => {
			if (n.checked === true) count += 1;
			n.children.forEach(walk);
		};
		walk(note.root);
		if (count === 0) return 0;
		this.#remember(noteId, 'reset-checks');
		const clear = (n: MapNode) => {
			if (n.checked === true) n.checked = false;
			n.children.forEach(clear);
		};
		clear(note.root);
		this.#touch(noteId);
		return count;
	}

	/** ノードの画像を付ける／外す（ファイル名。null で外す） */
	setNodeImage(noteId: string, nodeId: string, image: string | null): void {
		const hit = this.#locate(noteId, nodeId);
		if (!hit) return;
		this.#remember(noteId, `image:${nodeId}`);
		hit.node.image = image;
		this.#touch(noteId);
	}

	/** チェックボタンそのものを付ける／外す（外すと済・未の区別も消える） */
	setHasCheck(noteId: string, nodeId: string, has: boolean): void {
		const hit = this.#locate(noteId, nodeId);
		if (!hit || (hit.node.checked !== null) === has) return;
		this.#remember(noteId, `check:${nodeId}`);
		hit.node.checked = has ? false : null;
		this.#touch(noteId);
	}

	/**
	 * ノードを別の場所へ移す（ドラッグで落としたとき）。parentId の子の index 番目に入れる。
	 * 自分自身や自分の子孫の下には入れない。手で動かした位置は消して自動配置に戻す
	 */
	moveNodeTo(noteId: string, nodeId: string, parentId: string, index: number): boolean {
		const note = this.#note(noteId);
		if (!note || nodeId === parentId) return false;
		const hit = this.#locate(noteId, nodeId);
		if (!hit || !hit.parent) return false;
		const inside = (n: MapNode): boolean => n.id === parentId || n.children.some(inside);
		if (inside(hit.node)) return false; // 自分の子孫の下には入れない
		const target = this.#locate(noteId, parentId);
		if (!target) return false;
		this.#remember(noteId, 'move');
		hit.siblings.splice(hit.index, 1);
		let at = index;
		if (target.node === hit.parent && hit.index < index) at -= 1; // 同じ親の中で後ろへ動かすとき
		at = Math.max(0, Math.min(target.node.children.length, at));
		target.node.children.splice(at, 0, hit.node);
		target.node.collapsed = false;
		hit.node.pos = null;
		this.#touch(noteId);
		return true;
	}

	/** 前の兄弟の子にする（Tab） */
	indentNode(noteId: string, nodeId: string): void {
		const hit = this.#locate(noteId, nodeId);
		if (!hit || !hit.parent || hit.index === 0) return;
		this.#remember(noteId, 'move');
		const prev = hit.siblings[hit.index - 1];
		hit.siblings.splice(hit.index, 1);
		prev.children.push(hit.node);
		prev.collapsed = false;
		this.#touch(noteId);
	}

	/** 親の次の兄弟にする（Shift+Tab）。親が根なら何もしない */
	outdentNode(noteId: string, nodeId: string): void {
		const note = this.#note(noteId);
		if (!note) return;
		const hit = locate([note.root], nodeId);
		if (!hit || !hit.parent) return;
		const parentHit = locate([note.root], hit.parent.id);
		if (!parentHit || !parentHit.parent) return;
		this.#remember(noteId, 'move');
		hit.siblings.splice(hit.index, 1);
		parentHit.siblings.splice(parentHit.index + 1, 0, hit.node);
		this.#touch(noteId);
	}

	moveNode(noteId: string, nodeId: string, delta: -1 | 1): void {
		const hit = this.#locate(noteId, nodeId);
		if (!hit || !hit.parent) return;
		const to = hit.index + delta;
		if (to < 0 || to >= hit.siblings.length) return;
		this.#remember(noteId, 'move');
		hit.siblings.splice(hit.index, 1);
		hit.siblings.splice(to, 0, hit.node);
		this.#touch(noteId);
	}

	// ---- 元に戻す / やり直す ----

	canUndo(id: string): boolean {
		void this.historyTick;
		return (this.#history.get(id)?.undo.length ?? 0) > 0;
	}

	canRedo(id: string): boolean {
		void this.historyTick;
		return (this.#history.get(id)?.redo.length ?? 0) > 0;
	}

	undo(id: string): boolean {
		const h = this.#hist(id);
		const note = this.#note(id);
		const prev = h.undo.pop();
		if (!prev || !note) return false;
		h.redo.push(clone(note));
		this.#restore(id, prev);
		return true;
	}

	redo(id: string): boolean {
		const h = this.#hist(id);
		const note = this.#note(id);
		const next = h.redo.pop();
		if (!next || !note) return false;
		h.undo.push(clone(note));
		this.#restore(id, next);
		return true;
	}

	#hist(id: string): History {
		let h = this.#history.get(id);
		if (!h) {
			h = { undo: [], redo: [], lastKey: '', lastAt: 0 };
			this.#history.set(id, h);
		}
		return h;
	}

	/** 変更の前に写しを取る。同じ種類の変更が続くときはまとめる */
	#remember(id: string, key: string): void {
		const note = this.#note(id);
		if (!note) return;
		const h = this.#hist(id);
		const now = Date.now();
		if (key === h.lastKey && now - h.lastAt < HISTORY_MERGE_MS) {
			h.lastAt = now;
			return;
		}
		h.undo.push(clone(note));
		if (h.undo.length > HISTORY_LIMIT) h.undo.shift();
		h.redo = [];
		h.lastKey = key;
		h.lastAt = now;
		this.historyTick += 1;
	}

	#restore(id: string, snapshot: Note): void {
		const idx = this.notes.findIndex((n) => n.id === id);
		if (idx === -1) return;
		const h = this.#hist(id);
		h.lastKey = '';
		this.notes[idx] = clone(snapshot);
		this.historyTick += 1;
		this.#touch(id);
	}

	// ---- 自動保存 ----

	/** 待っている書き込みをすぐ行う（画面を閉じる前など） */
	async flush(id?: string): Promise<void> {
		const ids = id ? [id] : [...this.#pending];
		for (const nid of ids) {
			if (!this.#pending.has(nid)) continue;
			const t = this.#timers.get(nid);
			if (t) clearTimeout(t);
			this.#timers.delete(nid);
			await this.#write(nid);
		}
	}

	async retrySave(): Promise<void> {
		if (this.selectedId) await this.#write(this.selectedId);
	}

	#note(id: string): Note | undefined {
		return this.notes.find((n) => n.id === id);
	}

	#locate(noteId: string, nodeId: string) {
		const note = this.#note(noteId);
		return note ? locate([note.root], nodeId) : null;
	}

	#touch(id: string): void {
		const note = this.#note(id);
		if (!note) return;
		note.updatedAt = Date.now();
		this.#pending.add(id);
		if (id === this.selectedId) this.saveStatus = { state: 'dirty' };
		const prev = this.#timers.get(id);
		if (prev) clearTimeout(prev);
		this.#timers.set(
			id,
			setTimeout(() => void this.flush(id), AUTOSAVE_DELAY_MS)
		);
	}

	async #write(id: string): Promise<void> {
		const note = this.#note(id);
		if (!note) return;
		const isSelected = id === this.selectedId;
		this.#pending.delete(id);
		if (isSelected) this.saveStatus = { state: 'saving' };
		try {
			// プロキシではなく素のオブジェクトを渡す
			await api().notes.save(clone(note));
			if (isSelected && !this.#pending.has(id)) {
				this.saveStatus = { state: 'saved', at: Date.now() };
			}
		} catch (err) {
			const message = (err as Error).message ?? '保存に失敗しました。';
			this.#pending.add(id); // 再試行できるように残す
			if (isSelected) this.saveStatus = { state: 'error', message };
		}
	}

	async deleteNote(id: string): Promise<void> {
		const t = this.#timers.get(id);
		if (t) clearTimeout(t);
		this.#timers.delete(id);
		this.#pending.delete(id);
		this.#history.delete(id);
		await api().notes.remove(id);
		this.notes = this.notes.filter((n) => n.id !== id);
		this.recordings = this.recordings.filter((r) => r.noteId !== id);
		if (this.selectedId === id) this.select(null);
	}

	// ---- 収録 ----

	async upsertRecording(recording: Recording): Promise<void> {
		await api().recordings.save(clone(recording));
		const idx = this.recordings.findIndex((r) => r.id === recording.id);
		if (idx === -1) this.recordings = [recording, ...this.recordings];
		else this.recordings[idx] = recording;
	}

	/** 収録のメタ情報（カットなど）を一部だけ変えて保存する */
	async updateRecording(id: string, patch: Partial<Recording>): Promise<Recording | null> {
		const current = this.recordings.find((r) => r.id === id);
		if (!current) return null;
		const next: Recording = { ...current, ...patch, updatedAt: Date.now() };
		await this.upsertRecording(next);
		return next;
	}

	async deleteRecording(id: string): Promise<void> {
		await api().recordings.remove(id);
		this.recordings = this.recordings.filter((r) => r.id !== id);
	}
}

export const library = new LibraryStore();
