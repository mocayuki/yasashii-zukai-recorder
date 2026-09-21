import type {
	ComposeResult,
	Platform,
	HubAccount,
	HubJob,
	HubPlatform,
	HubPostRequest,
	UploadProgress,
	YouTubeAuth,
	YouTubeUploadRequest,
	YouTubeUploadResult,
	TikTokPostOptions,
	TikTokCreatorInfo
} from './publish';
/**
 * 画面（SvelteKit）とアプリの殻（Electron）の両方で使う型。
 * ここにはブラウザー専用・Node 専用の型を入れない。
 */

/** マインドマップのノード 1 つ */
export interface MapNode {
	id: string;
	text: string;
	/** このノードの注釈（補足・根拠など。空なら無し。何行でも可） */
	annotation: string;
	/** null = チェック無し、false = 未、true = 済 */
	checked: boolean | null;
	/** true のとき子を隠す */
	collapsed: boolean;
	/** 手で動かした位置（キャンバス座標の左上）。null なら自動配置 */
	pos: { x: number; y: number } | null;
	/** ノードの下に出す画像（保存先の images/ のファイル名。null なら無し） */
	image: string | null;
	children: MapNode[];
}

/**
 * ノート 1 件。`notes/<id>.json` に保存する。
 * title は動画の上に出る題名、root はマップの中心のノード（title と同じとは限らない）。
 */
/** 動画の向き。landscape = 横 16:9（1920×1080）、portrait = 縦 9:16（1080×1920、ショート動画） */
export type Orientation = 'landscape' | 'portrait';

export interface ThumbnailState {
	text: string;
	/** 文字の大きさ（サムネの幅に対する %） */
	size: number;
	/** 図のカメラ（画面 px。viewW はそのときの面の幅。面の幅が違えば比で合わせる） */
	camera: { x: number; y: number; zoom: number; viewW: number };
	/** 開いていたノードの id（子のあるノードで collapsed でなかったもの） */
	open: string[];
	/** 最後に保存した PNG の道（YouTube のサムネに使う。消されていれば無視） */
	file?: string;
}

export interface Note {
	id: string;
	title: string;
	root: MapNode;
	/** 動画の向き（無ければ横）。縦のときは木が下に広がる */
	orientation?: Orientation;
	/** サムネイルを作ったときの状態（文字・大きさ・図の位置・開いていたノード）。次に開いたとき同じ所から始める */
	thumbnail?: ThumbnailState;
	/** 入っているフォルダーの名前（一覧の整理用。無ければ null）。フォルダーはノートの属性で、1 段だけ */
	folder?: string | null;
	createdAt: number;
	updatedAt: number;
}

/** stage = 黄色い枠の中（ワークスペース）を録ったもの */
export type RecordingKind = 'mic' | 'screen' | 'screen+mic' | 'stage';
/** recording = 追記中、complete = 正常に終了、recovered = 途中で終わった分を回収 */
export type RecordingStatus = 'recording' | 'complete' | 'recovered';

/** 収録中に付けた時刻メモ */
export interface Marker {
	id: string;
	atMs: number;
	text: string;
	createdAt: number;
}

/** 消す範囲（カット）。startMs 以上 endMs 未満を書き出しから外す */
export interface Cut {
	id: string;
	startMs: number;
	endMs: number;
}

/** テロップ（字幕）1 つ。時刻は元の収録の時刻（カットを外す前） */
export interface Cue {
	id: string;
	startMs: number;
	endMs: number;
	text: string;
}

/** 収録 1 件のテロップ。`transcripts/<recordingId>.json` に保存する */
export interface Transcript {
	recordingId: string;
	cues: Cue[];
	/** 作った手段（openai = OpenAI の文字起こし） */
	source: 'openai' | 'manual';
	language: string;
	createdAt: number;
	updatedAt: number;
	/** OpenAI から返った生の時刻（segment と word）。時刻合わせを直すときに API を呼び直さずに済むよう残す */
	raw?: { segments: WhisperSegmentLike[]; words: WhisperWordLike[] };
	/** 外国語版の字幕の訳（言語 → テロップ id → { 元の文, 訳 }）。元の文が同じなら次回は訳し直さない */
	translations?: Record<string, Record<string, { src: string; text: string }>>;
}
/** テロップの校正の候補（shared/proofread.ts の ProofSuggestion と同じ形） */
export interface ProofSuggestionLike {
	id: string;
	before: string;
	after: string;
	confidence: number;
	reason: string;
}
/** 字幕の翻訳の進み具合 */
export interface SubtitleProgress {
	recordingId: string;
	lang: string;
	done: number;
	total: number;
}
export interface WhisperSegmentLike {
	start: number;
	end: number;
	text: string;
	/** whisper の確からしさ（作り話の判定に使った値。あとで見直せるように残す） */
	no_speech_prob?: number;
	avg_logprob?: number;
	compression_ratio?: number;
}
export interface WhisperWordLike {
	word: string;
	start: number;
	end: number;
}

/** 文字起こしの進み具合 */
export interface TranscribeProgress {
	recordingId: string;
	phase: 'extracting' | 'uploading' | 'done' | 'failed';
	message?: string;
}

/** 収録 1 件のメタ情報。`media/<id>.json` に保存する。本体は `media/<id>.<ext>` */
export interface Recording {
	id: string;
	noteId: string;
	title: string;
	kind: RecordingKind;
	createdAt: number;
	updatedAt: number;
	durationMs: number;
	mimeType: string;
	fileName: string;
	size: number;
	hasVideo: boolean;
	hasMic: boolean;
	displaySurface: string | null;
	status: RecordingStatus;
	markers: Marker[];
	/** 音声の波形（0〜1 の山の高さ、1 秒あたり peaksPerSecond 個） */
	peaks?: number[];
	peaksPerSecond?: number;
	/** 映像の大きさ */
	width?: number;
	height?: number;
	/** カット編集で消した範囲（元のファイルは変えず、書き出しのときに外す） */
	cuts?: Cut[];
	/** 書き出した mp4 の履歴（保存先の exports/ にある。古い順）。いらないものは自分で消す */
	exports?: ExportInfo[];
	/** 古い形（1 本だけ）。読むときは exportsOf() で exports に合流させる */
	export?: ExportInfo;
	/** SNS へ投稿した記録（予約も含む） */
	posts?: PostRecord[];
}

/** 書き出した mp4 の情報。ファイルは exports/<収録 id>-<id>.mp4（古い形は id = 'legacy' で exports/<収録 id>.mp4） */
export interface ExportInfo {
	id: string;
	fileName: string;
	size: number;
	createdAt: number;
	durationMs?: number;
	/** 自分で付けた「投稿済み」の印（投稿先ごと）。無ければ投稿の記録から決める */
	posted?: Partial<Record<Platform, boolean>>;
	/** 投稿文（投稿先ごと）。直すたびに自動で保存される。「投稿文を確定する」で confirmedAt が付き、投稿管理から予約できる */
	drafts?: Partial<Record<Platform, PostDraft>>;
	/** 投稿文を確定した時刻（無ければまだ作成中） */
	confirmedAt?: number;
	/** 自分で選んだ状態（無ければ記録から自動で決める） */
	statusOverride?: ExportStatus | null;
}

/** 投稿先 1 つぶんの投稿文（確定して保存するもの） */
export interface PostDraft {
	/** この投稿先に出すか */
	on: boolean;
	/** YouTube・TikTok の題 */
	title: string;
	/** 本文（YouTube は説明） */
	text: string;
	/** YouTube のタグ（, 区切りの文字列） */
	tagsText: string;
	/** Threads のトピック（# 無し、1 語） */
	topic?: string;
	/** YouTube のサムネ: sheet = 図つき（確定のときに写して thumbnailPath に入る）、file = 選んだ画像、auto = 付けない */
	thumbMode: 'sheet' | 'file' | 'auto';
	thumbnailPath: string | null;
	/** 何秒から始めるか（null / 0 = 先頭から） */
	startSec?: number | null;
	/** 何秒まで（動画の先頭からの位置。null = 最後まで） */
	trimSec: number | null;
	/** YouTube の公開範囲（予約のときは自動で非公開→公開） */
	privacy: 'public' | 'unlisted' | 'private';
	/** TikTok の投稿の設定（公開範囲・コメントなどの可否・宣伝の申告） */
	tiktok?: TikTokPostOptions;
}

/**
 * 書き出し 1 本の状態。
 * draft = 未編集（投稿文がまだ）、writing = 本文を作成中（直したが未確定）、ready = 投稿文完成（確定）、scheduled = 日程決定（待ち）、partial = 一部配信が残っている、done = 配信済み
 */
export type ExportStatus = 'draft' | 'writing' | 'ready' | 'scheduled' | 'partial' | 'done';

/** その書き出しをその投稿先に投稿済みとみなすか（自分で付けた印が優先。無ければ記録から） */
export function isPosted(
	rec: Pick<Recording, 'posts'>,
	ex: ExportInfo,
	platform: Platform,
	/** ハブの仕事の様子（分かるなら渡す。取り消し・失敗した予約の記録は「投稿済み」に数えない） */
	jobs?: Record<string, { status: string }>
): boolean {
	const mark = ex.posted?.[platform];
	if (typeof mark === 'boolean') return mark;
	return (rec.posts ?? []).some((p) => {
		if (p.platform !== platform || (p.exportId ?? 'legacy') !== ex.id) return false;
		const job = p.jobId && jobs ? jobs[p.jobId] : undefined;
		return !job || (job.status !== 'canceled' && job.status !== 'failed');
	});
}

/**
 * 投稿の記録を足した収録を返す。その投稿先に手で付けた「投稿済み／未投稿」の印は消す
 * （本当に送ったのだから、印より記録が正しい。印が残ると、送ったのに「残り」に出続ける）
 */
export function withPostRecords(
	rec: Recording,
	exportId: string,
	records: PostRecord[]
): Pick<Recording, 'posts' | 'exports' | 'export'> {
	const platforms = new Set(records.map((r) => r.platform));
	return {
		posts: [
			...(rec.posts ?? []),
			...records.map((r) => ({ ...r, exportId: r.exportId ?? exportId }))
		],
		exports: exportsOf(rec).map((e) => {
			if (e.id !== exportId || !e.posted) return e;
			const posted = { ...e.posted };
			for (const p of platforms) delete posted[p];
			return { ...e, posted };
		}),
		export: undefined
	};
}

/** 収録の書き出し履歴（古い形の export も含めて、古い順） */
export function exportsOf(rec: Pick<Recording, 'exports' | 'export' | 'id'>): ExportInfo[] {
	if (rec.exports && rec.exports.length > 0) return rec.exports;
	if (rec.export) return [{ ...rec.export, id: rec.export.id ?? 'legacy' }];
	return [];
}

/** 投稿 1 件の記録 */
export interface PostRecord {
	platform: Platform;
	/** 投稿した（または予約を登録した）時刻 */
	at: number;
	/** 予約の日時（ISO）。すぐ投稿なら無し */
	scheduledAt?: string | null;
	/** できた投稿の URL（YouTube はすぐ、ハブ経由は終わってから） */
	url?: string;
	/** ハブの仕事 id（ハブ経由のとき） */
	jobId?: string;
	/** YouTube の動画 id */
	videoId?: string;
	/** 何秒まで（動画の先頭からの位置）で切って投稿したか（最後までなら無し） */
	seconds?: number;
	/** 何秒から始めたか（先頭からなら無し） */
	fromSec?: number;
	/** どの書き出しか（ExportInfo.id） */
	exportId?: string;
}

/** mp4 書き出しの指定 */
export interface ExportOptions {
	/** 重ねる BGM のファイル名（保存先の bgm/ 内。null = 無し） */
	bgmFile: string | null;
	/** BGM の音量 0〜1 */
	bgmVolume: number;
	/** true なら、声が入っている間は BGM を自動で下げる */
	duck: boolean;
	/** 下げている間の BGM の音量（元の音量に対する割合 0〜1。0.3 = 30% まで下げる） */
	duckLevel: number;
	/** テロップを動画に焼き込む */
	burnTelop: boolean;
	/** mp4 と同じ名前で .srt も書く */
	writeSrt: boolean;
	/** 試し用: 最初の何ミリ秒だけ書き出すか（カットを外したあとの長さで数える。無ければ全部） */
	limitMs?: number;
	/** ノイズを抑える（off = しない、light = 弱、strong = 強）。書き出しのときに声へかける */
	noiseReduction?: NoiseReduction;
}
export type NoiseReduction = 'off' | 'light' | 'strong';

/** 書き出しの進み具合 */
export interface ExportProgress {
	id: string;
	/** 0〜1 */
	ratio: number;
	phase: 'preparing' | 'encoding' | 'done' | 'failed' | 'cancelled';
	message?: string;
}

/** 収録を始めるときの情報（本体は別に追記する） */
export interface RecordingBegin {
	id: string;
	noteId: string;
	title: string;
	kind: RecordingKind;
	mimeType: string;
	fileName: string;
	hasVideo: boolean;
	hasMic: boolean;
	width?: number;
	height?: number;
}

/** 収録を終えるときの情報 */
export interface RecordingFinish {
	durationMs: number;
	markers: Marker[];
	peaks: number[];
	peaksPerSecond: number;
}

/** 保存先フォルダーの状態 */
export interface StorageInfo {
	libraryPath: string;
	usedBytes: number;
	freeBytes: number | null;
	totalBytes: number | null;
	noteCount: number;
	recordingCount: number;
}

export interface Settings {
	libraryPath: string;
	/** 収録に使うマイク（null = OS の既定） */
	micDeviceId: string | null;
	/** マイクの音量の倍率（1 = そのまま。0.5〜6）。収録の音声とメーターの両方にかかる */
	micGain: number;
	/** 声を整える（コンプレッサー）。小さい声を持ち上げ、大きい声は抑える */
	micCompressor: boolean;
	/** BGM の試聴・収録中の再生に使うスピーカー（null = OS の既定） */
	speakerDeviceId: string | null;
	/** 収録に混ぜる BGM のファイル名（保存先の bgm/ 内。null = 無し） */
	bgmFile: string | null;
	/** BGM の音量 0〜1 */
	bgmVolume: number;
	/** 書き出しで、声が入っている間は BGM を自動で下げる */
	bgmDuck: boolean;
	/** 下げている間の BGM の音量（元の音量に対する割合 0〜1） */
	bgmDuckLevel: number;
	/** OpenAI の API キー（文字起こし用。ここ = userData の settings.json にだけ置く） */
	openaiApiKey: string | null;
	/** 書き起こしで書き方を寄せたい言葉（固有名詞など）。1 行 1 語。whisper の prompt に入れる */
	transcriptTerms: string;
	/** 書き起こし後に機械的に直す組。「誤り → 正しい」を 1 行 1 組 */
	transcriptReplacements: string;
	/** 書き出しでノイズを抑える強さ（覚えておく） */
	noiseReduction: NoiseReduction;
	/** 字幕ファイルを保存するときに一緒に作る外国語版（言語コード） */
	subtitleLanguages: string[];
	/** YouTube: Google Cloud の OAuth クライアント（デスクトップ アプリ）。この Mac の settings.json にだけ置く */
	youtubeClientId: string | null;
	youtubeClientSecret: string | null;
	/** YouTube の接続（トークン）。未接続なら null */
	youtubeAuth: YouTubeAuth | null;
	/** 投稿ハブ（hub/ の Cloudflare Worker）の URL と合言葉。X・Threads・Instagram・TikTok はここ経由 */
	hubUrl: string | null;
	hubToken: string | null;
	/** 前回のウィンドウの位置と大きさ（次に開くときに戻す） */
	windowBounds: { x: number; y: number; width: number; height: number } | null;
	/** ワークスペース（編集・収録の画面）を開いているときのウィンドウの位置と大きさ。一覧とは別に覚える */
	workspaceBounds: { x: number; y: number; width: number; height: number } | null;
}

/** バックアップを作った結果 */
export interface BackupResult {
	path: string;
	files: number;
	bytes: number;
}

/** BGM の 1 曲（保存先の bgm/ にあるファイル） */
export interface BgmTrack {
	fileName: string;
	size: number;
}

/** 初期版（ブラウザー版）のバックアップ JSON */
export interface LegacyBackup {
	app: 'yasashii-voice-notes';
	version: 1;
	exportedAt: string;
	notes: Array<{
		id: string;
		title: string;
		memo: string;
		createdAt: number;
		updatedAt: number;
		durationMs: number;
		mimeType: string;
		size: number;
		audio: string;
	}>;
}

export interface ImportResult {
	notes: number;
	recordings: number;
	skipped: number;
}

/** ワークスペースのカメラ（見ている位置と倍率）。プレゼン用の窓は自分の大きさに合わせて同じ見え方にする */
export interface PresentCamera {
	x: number;
	y: number;
	z: number;
	/** 送った側の、マップの面の大きさ（px）。受け取る側はこれとの比で拡大縮小する */
	viewW: number;
	viewH: number;
	/** true なら即座に合わせる（ドラッグの移動など）。false ならなめらかに追う */
	immediate: boolean;
}

/** プレゼン用の窓へ送る、いまの状態（ノートの中身と、選んでいるノード） */
export interface PresentState {
	note: Note;
	selectedId: string | null;
	/** 大きく見せている画像のノード id（無ければ null） */
	openImage?: string | null;
}

/** 画面から呼べる処理の一覧。preload で window.api として公開する */
export interface Api {
	settings: {
		get(): Promise<Settings>;
		save(patch: Partial<Settings>): Promise<Settings>;
		chooseLibraryFolder(): Promise<string | null>;
		openLibraryFolder(): Promise<void>;
	};
	bgm: {
		list(): Promise<BgmTrack[]>;
		/** ファイル選択で音楽を bgm/ にコピーする。追加した数を返す */
		add(): Promise<number>;
		/** ダウンロードフォルダーの音楽ファイルを全部 bgm/ にコピーする。追加した数を返す */
		importDownloads(): Promise<number>;
		remove(fileName: string): Promise<void>;
		/** 再生用の URL（media://local/bgm/<file>） */
		url(fileName: string): Promise<string>;
	};
	present: {
		/** プレゼン用の窓（Zoom や Meet で共有する用）を開く。開いていれば前に出す */
		open(noteId: string): Promise<void>;
		close(): Promise<void>;
		isOpen(): Promise<boolean>;
		/** プレゼン用の窓の向きを変える（枠の比率に合わせて窓の形も変える） */
		setOrientation(portrait: boolean): Promise<void>;
		/** ワークスペース側から、いまの状態を送る（プレゼン用の窓が受け取る） */
		update(state: PresentState): void;
		/** プレゼン用の窓側で、状態を受け取る */
		onUpdate(cb: (state: PresentState) => void): () => void;
		/** ワークスペースのカメラを送る（毎フレーム。送るだけ） */
		updateCamera(camera: PresentCamera): void;
		onCamera(cb: (camera: PresentCamera) => void): () => void;
		/** プレゼン用の窓が開いた・閉じたときにワークスペース側へ知らせる */
		onOpenChange(cb: (open: boolean) => void): () => void;
	};
	folders: {
		/** フォルダーの名前の一覧（空のフォルダーも持てるよう、ノートとは別に保存する） */
		list(): Promise<string[]>;
		save(names: string[]): Promise<void>;
	};
	transcripts: {
		get(recordingId: string): Promise<Transcript | null>;
		save(transcript: Transcript): Promise<void>;
		/** 音声を取り出して OpenAI で文字起こしし、保存して返す */
		generate(recordingId: string): Promise<Transcript>;
		onProgress(cb: (p: TranscribeProgress) => void): () => void;
		/** 字幕ファイル（.srt）を、選んだフォルダーへ保存する。日本語と、設定で選んだ外国語版。取りやめなら null */
		saveSubtitles(recordingId: string): Promise<{ dir: string; files: string[] } | null>;
		/** テロップの誤りの候補を AI に出してもらう（当てるのは画面側でユーザーがチェックしてから） */
		proofread(recordingId: string, cues: Cue[]): Promise<ProofSuggestionLike[]>;
		onSubtitleProgress(cb: (p: SubtitleProgress) => void): () => void;
	};
	images: {
		/** 画像ファイルを選んで保存先の images/ に写す。ファイル名を返す。取りやめなら null */
		add(): Promise<string | null>;
		/** ドラッグ＆ドロップなどで受け取った画像ファイルを images/ に写す。ファイル名を返す */
		importFile(file: File): Promise<string>;
		remove(fileName: string): Promise<void>;
	};
	storage: {
		info(): Promise<StorageInfo>;
		/** 保存先フォルダーを丸ごと、選んだ場所へコピーする（バックアップ）。作った場所を返す。取りやめなら null */
		backup(): Promise<BackupResult | null>;
	};
	notes: {
		list(): Promise<Note[]>;
		save(note: Note): Promise<void>;
		remove(id: string): Promise<void>;
	};
	recordings: {
		list(): Promise<Recording[]>;
		save(recording: Recording): Promise<void>;
		remove(id: string): Promise<void>;
		fileUrl(id: string): Promise<string | null>;
		revealInFinder(id: string): Promise<void>;
		/** 収録の開始（メタ情報を status: recording で書き、本体ファイルを開く） */
		begin(meta: RecordingBegin): Promise<Recording>;
		/** 収録データの追記（1 秒ごと） */
		append(id: string, chunk: ArrayBuffer): Promise<void>;
		/** 収録の終了（本体を閉じ、長さ・波形・しるしを書く） */
		finish(id: string, meta: RecordingFinish): Promise<Recording>;
		/** 保存先を選んで収録ファイルをコピーする（ダウンロード）。保存した場所を返す。取りやめなら null */
		exportFile(id: string): Promise<string | null>;
		/** カットを外し BGM を重ねて mp4 に書き出す（同梱の ffmpeg）。本番は保存先の exports/ に自動で置き（export に情報）、試し（limitMs）は保存先を聞く。取りやめなら null */
		exportMp4(
			id: string,
			opts: ExportOptions
		): Promise<{ path: string; export?: ExportInfo } | null>;
		/** 書き出した mp4 の情報（無ければ null）。exportId を省くと最新（古い形） */
		exportInfo(
			id: string,
			exportId?: string
		): Promise<(ExportInfo & { path: string; url: string }) | null>;
		/** 書き出した mp4 を好きな場所へコピーする（保存先を聞く）。コピーした場所を返す */
		copyExport(id: string, exportId?: string): Promise<string | null>;
		/** 書き出しを 1 本消す（exportId を省くと全部） */
		removeExport(id: string, exportId?: string): Promise<void>;
		cancelExport(id: string): Promise<void>;
		onExportProgress(cb: (p: ExportProgress) => void): () => void;
	};
	legacy: {
		importBackup(): Promise<ImportResult | null>;
	};
	app: {
		version(): Promise<string>;
		/** 収録画面用に、ウィンドウを画面全体にする／戻す */
		setFullScreen(flag: boolean): Promise<void>;
		/** ウィンドウの地の色（大きさを変えるときに描画の隙間から見える色） */
		setBackgroundColor(color: string): Promise<void>;
		/** いまの画面が一覧かワークスペースかを伝える。ウィンドウの大きさをそれぞれ別に覚えて、切り替え時に戻す */
		setWindowMode(mode: 'list' | 'workspace'): Promise<void>;
		/** 画面の一部（rect は画面上の px）を写して 1280×720 の PNG に保存する。保存した道を返す。取りやめなら null */
		saveThumbnail(
			rect: { x: number; y: number; width: number; height: number },
			baseName: string
		): Promise<string | null>;
		/** 任意のファイルを Finder で表示する（書き出した動画など） */
		revealPath(filePath: string): Promise<void>;
		/**
		 * ウィンドウの幅を dx px 変える（画面からはみ出す分は左へずらし、収まらなければ縮める）。
		 * 実際に変えた量を返す（全画面のときは 0）。Markdown 欄などを開くときに枠を縮めずに済むようにする
		 */
		resizeBy(dx: number): Promise<number>;
		/** ユーザーが OS 側の操作で全画面をやめたときなどに呼ばれる */
		onFullScreenChange(cb: (isFullScreen: boolean) => void): () => void;
	};
	/** 投稿（まずは YouTube。X・Threads・Instagram・TikTok は投稿ハブ経由で順に足す） */
	publish: {
		youtubeStatus(): Promise<{
			connected: boolean;
			channelTitle: string | null;
			hasClient: boolean;
		}>;
		/** ブラウザーで Google にログインして許可する。チャンネル名を返す */
		youtubeConnect(): Promise<string>;
		youtubeDisconnect(): Promise<void>;
		youtubeUpload(jobId: string, req: YouTubeUploadRequest): Promise<YouTubeUploadResult>;
		onProgress(cb: (p: UploadProgress) => void): () => void;
		/** サムネイル用の画像を選ぶ（png / jpg）。道を返す。取りやめなら null */
		pickImage(): Promise<string | null>;
		/** 画像ファイルを data: URL にして返す（画面で表示するため。無ければ null） */
		imageDataUrl(path: string): Promise<string | null>;
		/** 画面の範囲を写して 1280×720 の PNG にし、保存先の exports/<収録 id>.thumb.png に置く。その道を返す */
		captureThumbnail(
			recordingId: string,
			rect: { x: number; y: number; width: number; height: number },
			exportId?: string
		): Promise<string | null>;
		// ---- 投稿ハブ ----
		hubStatus(): Promise<
			| {
					ok: true;
					publicUrl: string;
					platforms: Array<{
						platform: HubPlatform;
						configured: boolean;
						account: HubAccount | null;
					}>;
			  }
			| { ok: false; error: string }
		>;
		/** ブラウザーでハブの接続ページを開く */
		hubConnect(platform: HubPlatform): Promise<void>;
		hubDisconnect(platform: HubPlatform): Promise<void>;
		/** 動画をハブに上げて仕事を登録する。進み具合は onProgress（id = jobId） */
		hubPost(
			jobId: string,
			filePath: string,
			req: Omit<HubPostRequest, 'mediaKey'>
		): Promise<HubJob>;
		hubJob(id: string): Promise<HubJob>;
		/** 続きを進めて（時間の許すところまで）、いまの様子を返す。すぐ投稿のときは終わるまで繰り返し呼ぶ */
		hubStep(id: string): Promise<HubJob>;
		hubJobs(): Promise<HubJob[]>;
		/** TikTok の投稿者の情報（公開範囲の選択肢など） */
		hubTikTokCreator(): Promise<TikTokCreatorInfo>;
		hubCancel(id: string): Promise<{ canceled: boolean }>;
		/** 送っている途中（アップロード）を取りやめる。id は progressId（収録 id:投稿先） */
		cancel(jobId: string): Promise<void>;
		/** 予約の日時を変える（queued のものだけ） */
		hubReschedule(id: string, scheduledAt: string): Promise<HubJob>;
		/** YouTube の予約公開の日時を変える */
		youtubeReschedule(videoId: string, publishAt: string): Promise<void>;
		/** YouTube の予約を取り消す（上げた動画を消す） */
		youtubeDelete(videoId: string): Promise<void>;
		/** テロップとノートの題から、投稿先ごとの本文を OpenAI で作る */
		compose(recordingId: string, platforms: Platform[]): Promise<ComposeResult>;
	};
}
