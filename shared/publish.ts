/**
 * 投稿（YouTube・X・Threads・Instagram・TikTok）の共通の型と規則。
 * アプリ（Electron）と、あとで作る投稿ハブ（Cloudflare Worker）の両方で使う。
 */
import {
	isPosted,
	type ExportInfo,
	type ExportStatus,
	type Orientation,
	type Recording
} from './types';

export type Platform = 'youtube' | 'x' | 'threads' | 'instagram' | 'facebook' | 'tiktok' | 'note';

export const PLATFORMS: Array<{ id: Platform; label: string }> = [
	{ id: 'youtube', label: 'YouTube' },
	{ id: 'x', label: 'X' },
	{ id: 'threads', label: 'Threads' },
	{ id: 'instagram', label: 'Instagram' },
	{ id: 'facebook', label: 'Facebook ページ' },
	{ id: 'tiktok', label: 'TikTok' },
	{ id: 'note', label: 'note' }
];

/**
 * 向きから、既定でオンにする投稿先を決める（投稿の画面でオンオフできる）。
 * 縦も横も同じ。縦は YouTube が自動的にショート扱い。横は Instagram・TikTok が帯付きの縦になる。
 * TikTok と note は既定でオフ（TikTok は審査が通るまで自分のみ、note は手で貼る）
 */
export function defaultTargets(_orientation: Orientation): Platform[] {
	return ['youtube', 'x', 'threads', 'instagram', 'facebook'];
}

/** SNS ごとの本文の上限（文字数。超えたら確認画面で赤く出す） */
export const TEXT_LIMITS: Record<Platform, { title?: number; body: number }> = {
	youtube: { title: 100, body: 5000 },
	x: { body: 280 },
	threads: { body: 500 },
	instagram: { body: 2200 },
	facebook: { body: 5000 },
	tiktok: { body: 2200 },
	note: { title: 100, body: 30000 }
};

export type YouTubePrivacy = 'public' | 'unlisted' | 'private';

/** YouTube へ 1 本アップロードするときの内容 */
export interface YouTubeUploadRequest {
	/** 書き出した mp4 の道 */
	filePath: string;
	/** 収録の id。あれば、テロップから字幕（日本語と設定の外国語）を作って動画に付ける */
	recordingId?: string;
	title: string;
	description: string;
	tags: string[];
	privacy: YouTubePrivacy;
	/** 予約公開の日時（ISO 8601）。あるときは private でアップロードし、この時刻に公開される */
	publishAt?: string | null;
	/** サムネイル（PNG / JPG の道）。無ければ YouTube が自動で選ぶ */
	thumbnailPath?: string | null;
	/** 縦（ショート）か。説明に #Shorts を足す判断などに使う */
	orientation: Orientation;
}

export interface YouTubeUploadResult {
	videoId: string;
	url: string;
	/** サムネイルの設定に失敗したときの理由（動画そのものは上がっている） */
	thumbnailWarning?: string;
	/** 字幕を付けられなかったときの理由 */
	captionsWarning?: string;
	/** 付けた字幕の言語 */
	captions?: string[];
}

export interface UploadProgress {
	/** 投稿の仕事の id（いまは収録 id） */
	id: string;
	phase: 'preparing' | 'uploading' | 'thumbnail' | 'captions' | 'done' | 'failed';
	/** 0〜1 */
	ratio: number;
	message?: string;
}

/** YouTube の接続状態（設定に保存。トークンは settings.json にだけ置く） */
export interface YouTubeAuth {
	refreshToken: string;
	accessToken: string;
	/** accessToken の期限（ms） */
	expiresAt: number;
	channelTitle: string;
	channelId: string;
	/** 許可された範囲（Google が返す scope。古い接続には無い） */
	scope?: string;
}

/** 予約の取り消し（動画の削除）に要る許可。無ければ設定でつなぎ直す */
export const YOUTUBE_DELETE_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';
export const youtubeCanDelete = (auth: YouTubeAuth | null | undefined): boolean =>
	!!auth?.scope?.includes(YOUTUBE_DELETE_SCOPE);

/** YouTube の説明文の末尾に付けるタグ行などを整える（空行の重複を除く） */
export function tidyDescription(text: string): string {
	return text
		.replace(/\r\n?/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/** 「a, b, c」「a、b」「#a #b」のような入力をタグの配列にする（重複と空は除く。YouTube は 1 本 500 文字まで） */
export function parseTags(text: string): string[] {
	const out: string[] = [];
	for (const raw of text.split(/[,、\n#]/)) {
		const t = raw.trim();
		if (t && !out.includes(t)) out.push(t);
	}
	let total = 0;
	return out.filter((t) => {
		total += t.length + 2;
		return total <= 500;
	});
}

/** 予約日時の妥当性: いまより 15 分以上あと */
export function scheduleError(iso: string | null | undefined, now = Date.now()): string | null {
	if (!iso) return null;
	const t = new Date(iso).getTime();
	if (!Number.isFinite(t)) return '日時の形が正しくありません';
	if (t < now + 15 * 60 * 1000) return '予約はいまから 15 分以上あとにしてください';
	return null;
}

// ---- 投稿ハブ（Cloudflare Worker）とアプリの間で使う型 ----

/** ハブが受け持つ投稿先（YouTube はアプリから直接上げる） */
/** 投稿ハブ経由の投稿先（YouTube はアプリから直接、note は手で貼る） */
export type HubPlatform = Exclude<Platform, 'youtube' | 'note'>;

/** TikTok の公開範囲（creator_info の privacy_level_options にあるものだけ選べる） */
export type TikTokPrivacy =
	'PUBLIC_TO_EVERYONE' | 'MUTUAL_FOLLOW_FRIENDS' | 'FOLLOWER_OF_CREATOR' | 'SELF_ONLY';

export const TIKTOK_PRIVACY_LABEL: Record<TikTokPrivacy, string> = {
	PUBLIC_TO_EVERYONE: '全員に公開',
	MUTUAL_FOLLOW_FRIENDS: '相互フォローの友達',
	FOLLOWER_OF_CREATOR: 'フォロワー',
	SELF_ONLY: '自分のみ'
};

/** TikTok の投稿の設定（投稿者が毎回選ぶ。TikTok の審査の決まり） */
export interface TikTokPostOptions {
	privacy: TikTokPrivacy;
	allowComment: boolean;
	allowDuet: boolean;
	allowStitch: boolean;
	/** 宣伝を含む投稿か（申告） */
	commercial: boolean;
	/** 自分（自分のブランド）の宣伝 */
	brandOrganic: boolean;
	/** 他社のブランドコンテンツ（有償のタイアップなど） */
	brandContent: boolean;
}

/** TikTok の投稿者の情報（ハブの GET /api/tiktok/creator。投稿の前に出す決まり） */
export interface TikTokCreatorInfo {
	nickname: string;
	avatarUrl: string | null;
	privacyOptions: TikTokPrivacy[];
	commentDisabled: boolean;
	duetDisabled: boolean;
	stitchDisabled: boolean;
	maxDurationSec: number | null;
	/** アプリが TikTok の審査に通っているか。通るまでは投稿は「自分のみ」に限られる（ハブの TIKTOK_AUDITED） */
	audited: boolean;
}

/** TikTok の設定の不備（投稿の前に確かめる）。無ければ null */
export function tiktokOptionsError(o: TikTokPostOptions | undefined): string | null {
	if (!o) return 'TikTok の公開範囲などを選んでください';
	if (o.commercial && !o.brandOrganic && !o.brandContent)
		return '宣伝を含む場合は「自分のブランド」か「ブランドコンテンツ」のどちらかを選んでください';
	if (o.brandContent && o.privacy === 'SELF_ONLY')
		return 'ブランドコンテンツは「自分のみ」では投稿できません（公開範囲を変えてください）';
	return null;
}

export interface HubPostRequest {
	platform: HubPlatform;
	/** ハブに上げた動画の鍵（PUT /api/media の返事） */
	mediaKey: string;
	/** 本文（X は 280 の重み付き文字数、Threads 500、Instagram / TikTok 2200） */
	text: string;
	/** 投稿する日時（ISO 8601）。無ければすぐ */
	scheduledAt?: string | null;
	orientation: Orientation;
	/** TikTok のタイトルなど、投稿先ごとの追加 */
	title?: string;
	/** TikTok の投稿の設定（公開範囲・コメントなどの可否・宣伝の申告）。TikTok の決まりで投稿者が毎回選ぶ */
	tiktok?: TikTokPostOptions;
	/** どの収録の投稿か（アプリの収録 id）。一覧で引くため */
	ref?: string;
	/** 何秒から（アプリ側で切ってから上げる。無ければ先頭から） */
	startSec?: number | null;
	/** 何秒まで（動画の先頭からの位置。無ければ最後まで） */
	trimSec?: number | null;
	/** Threads のトピック（topic_tag。# 無し） */
	topic?: string | null;
}

export type HubJobStatus = 'queued' | 'running' | 'done' | 'failed' | 'canceled';

export interface HubJob {
	id: string;
	platform: HubPlatform;
	ref?: string;
	status: HubJobStatus;
	text: string;
	mediaKey: string;
	scheduledAt: string;
	attempts: number;
	error?: string;
	resultUrl?: string;
	createdAt: string;
	updatedAt: string;
}

export interface HubAccount {
	platform: HubPlatform;
	username: string;
	updatedAt: string;
}

/**
 * X の文字数の数え方: 日本語・中国語・韓国語などは 1 文字を 2 と数え、URL は長さに関わらず 23。
 * 上限は 280（＝日本語なら 140 文字ほど）
 */
export function xWeightedLength(text: string): number {
	let n = 0;
	const withoutUrls = text.replace(/https?:\/\/\S+/g, () => {
		n += 23;
		return '';
	});
	for (const ch of withoutUrls) {
		const cp = ch.codePointAt(0) ?? 0;
		// CJK の統合漢字・かな・ハングル・全角記号など（X の重み 2 の範囲に合わせた近似）
		const heavy =
			(cp >= 0x1100 && cp <= 0x11ff) ||
			(cp >= 0x2e80 && cp <= 0x9fff) ||
			(cp >= 0xa960 && cp <= 0xa97f) ||
			(cp >= 0xac00 && cp <= 0xd7ff) ||
			(cp >= 0xf900 && cp <= 0xfaff) ||
			(cp >= 0xfe30 && cp <= 0xfe4f) ||
			(cp >= 0xff00 && cp <= 0xffef) ||
			(cp >= 0x20000 && cp <= 0x3134f);
		n += heavy ? 2 : 1;
	}
	return n;
}

/** ハブに送る前の本文の検査。問題が無ければ null */
export function hubTextError(platform: HubPlatform, text: string): string | null {
	if (platform === 'x') {
		const n = xWeightedLength(text);
		return n > TEXT_LIMITS.x.body ? `X は 280（日本語なら 140 文字ほど）までです。いま ${n}` : null;
	}
	const limit = TEXT_LIMITS[platform].body;
	const n = [...text].length;
	return n > limit
		? `${PLATFORMS.find((p) => p.id === platform)?.label} は ${limit} 文字までです。いま ${n}`
		: null;
}

// ---- AI で本文を作る ----

/** SNS ごとに作った本文。無い投稿先は作らない */
export type ComposeResult = Partial<
	Record<
		Platform,
		{
			title?: string;
			text: string;
			/** Threads のトピック（# 無し） */
			topic?: string;
			tags?: string[];
			hashtags?: string[];
			chapters?: Array<{ time: string; title: string }>;
		}
	>
>;

/** 書き起こしが長いときに切り詰める（前半を多め、最後も少し残す） */
export function clipTranscript(text: string, max = 9000): string {
	if (text.length <= max) return text;
	const head = Math.floor(max * 0.75);
	const tail = max - head;
	return `${text.slice(0, head)}\n…（中略）…\n${text.slice(-tail)}`;
}

/** AI で本文を作る投稿先。ほかは題名をそのまま本文にする（短くてよい） */
export const COMPOSE_TARGETS: Platform[] = [
	'youtube',
	'x',
	'threads',
	'instagram',
	'facebook',
	'note'
];

/** note の記事の結び（アプリが本文の下に付ける）。YouTube の URL が分かればそれ、無ければチャンネル */
export const YOUTUBE_CHANNEL_URL = 'https://www.youtube.com/@yuki_zukai';
export function noteClosing(youtubeUrl: string | null): string {
	// URL は独立した段落にする（note は URL だけの行を動画のカードにしてくれる）
	return `---\n\nこの話は YouTube でもお話ししています。\n\n${youtubeUrl ?? YOUTUBE_CHANNEL_URL}`;
}

/** 縦（ショート）の YouTube の題には「 #Shorts」を付ける（前の「 /ショート」は付け替える）。横なら付けない */
export function shortsTitle(title: string, orientation: Orientation): string {
	const t = title
		.trim()
		.replace(/\s*\/ショート$/, '')
		.replace(/\s*#shorts$/i, '')
		.trim();
	if (orientation !== 'portrait' || !t) return t;
	return `${t} #Shorts`;
}

/** OpenAI に渡す指示。JSON で返させる */
export function composePrompt(platforms: Platform[]): string {
	const rules: Record<Platform, string> = {
		youtube:
			'"youtube": { "description": 次の順で、間を空行で区切る: (1) 動画の内容の説明 2〜3 文 (2) 「この動画で話していること」という行と、その下に箇条書き（・で始める）3〜6 個 ハッシュタグとチャプターはここに書かない, "hashtags": ハッシュタグ 5〜8 個の配列（# 付き。広い語 #AI #生成AI と、この動画の話題そのものの語を混ぜる。検索されやすいカタカナ語も）, "tags": 検索されそうな語 8〜15 個の配列, "chapters": 書き起こしの [mm:ss] の時刻をもとにした章の配列 [{ "time": "mm:ss", "title": 12 文字程度の見出し }]。必ず 00:00 から始め、話題が変わる所で区切り、各章は 30 秒以上空ける。動画が 3 分未満なら空の配列 }',
		x: '"x": { "text": 1 行目は動画の題をそのまま + 改行 + 箇条書き（・で始める）。箇条書きは話の要点の数だけ（2〜5 個）、1 個は 15 文字以内の体言止めか短い文。全体で全角 120 文字以内（半角は 2 文字で 1 と数える）。ハッシュタグと URL は入れない }',
		threads:
			'"threads": { "text": 1 行目は動画の題をそのまま + 改行 + 箇条書き（・で始める）。箇条書きは話の要点の数だけ（2〜5 個）、1 個は 15 文字以内の体言止めか短い文（X と同じ短さ。長い文にしない）。全体で 200 文字以内。ハッシュタグと URL は入れない, "topic": Threads のトピック。みんなが実際に使っている一般的な話題の名前を 1 つ（例: AI、生成AI、ChatGPT、働き方、副業、ベーシックインカム、子育て、投資）。造語・省略・文は不可。# は付けない。2〜12 文字。動画の中心の話題に近いものを選び、迷ったら広い語にする }',
		instagram:
			'"instagram": { "text": 1 行目は動画の題をそのまま + 改行 + 箇条書き（・で始める）。箇条書きは話の要点の数だけ（2〜4 個）、1 個は 12 文字以内のごく短い言葉（X より短く、ぱっと読める）+ 空行 + ハッシュタグ 10〜15 個（広い語 #AI #生成AI と、この動画の話題の語、日本語の語を混ぜる。半角スペース区切りで 1 行に）。全体で 1000 文字以内 }',
		facebook:
			'"facebook": { "text": 1 行目は動画の題をそのまま + 改行 + 箇条書き（・で始める）。箇条書きは話の要点の数だけ（2〜5 個）、1 個は 20 文字以内。全体で 300 文字以内。X と同じ調子。ハッシュタグは入れない }',
		tiktok: '"tiktok": { "title": 80 文字以内, "text": 500 文字以内。ハッシュタグ 3〜5 個 }',
		// note は別の呼び出し（noteArticlePrompt。長い記事なので強いモデルで、書き起こしを全部渡す）
		note: '"note": { "title": 30 文字以内, "text": 空でよい }'
	};
	return [
		'あなたは日本語の SNS 用の文章を書く担当です。',
		'チャンネル「亀井ゆきのやさしいAI図解解説」（AI の話題を図解で分かりやすく話す、やさしい語り口）の動画について、投稿先ごとの本文を作ります。',
		'与えられるのは、動画の題と、話した内容の書き起こしです。書き起こしの内容に忠実に、話していないことは書かないでください。',
		'一人称は「私」、読者には「〜ですよね」「〜してみてください」のような柔らかい呼びかけ。絵文字は一切使わない。',
		'次のキーだけを持つ JSON オブジェクトで返してください。各投稿先のキーの中身（title / description / text / hashtags / tags / chapters / topic）は、書いてあるものを全部必ず入れてください（省かない）。',
		...platforms.map((p) => rules[p]),
		'文字数の上限は必ず守ってください。'
	].join('\n');
}

/**
 * note の記事の目安の長さ（文字）。話した量に合わせる: 書き起こしの 9 割ほど、2,000〜8,000 の間。
 * 「要約」ではなく「話したことを文章にしたもの」なので、書き起こしとほぼ同じ量にする
 */
export function noteTargetChars(transcriptChars: number): number {
	return Math.min(8000, Math.max(2000, Math.round(transcriptChars * 0.9)));
}

/** note の記事を作るプロンプト（note に貼ってそのまま読める、ちゃんとした記事） */
export function noteArticlePrompt(targetChars: number): string {
	return [
		'あなたは note（日本の記事サイト）で読まれる記事を書く編集者です。',
		'チャンネル「亀井ゆきのやさしいAI図解解説」（AI の話題を図解で分かりやすく話す）の動画の書き起こしをもとに、その内容を「動画を見なくても分かる」記事に書き起こします。',
		'目的: 動画で話したことを、読みやすい文章として残す。要約ではありません。話した中身を全部、文章に書き直します。具体例・たとえ話・「〜はどうなの？」という反論とその答え・理由・数字・自分の体験談は、ひとつも落とさずに入れる。省いてよいのは挨拶・言い直し・つなぎ言葉だけ。書き起こしに無いことは足さない。',
		`長さ: 本文は ${targetChars} 文字以上（上限はその 1.3 倍）。これより短くなったら、落とした具体例や説明を戻して長くする。1 つの見出しの下は 3〜5 段落。`,
		'文体: 一人称は「私」。やさしい語り口で、読者に「〜ですよね」「〜かもしれません」と話しかける。専門用語は初めて出るときに一言で説明する。絵文字は使わない。「です・ます」で統一。',
		'構成（Markdown）:',
		'1. 導入 2〜3 段落: どんな話か、なぜ気になる話なのか、この記事で分かること。',
		'2. 本文: ## の見出しを 4〜8 個。話の順番に沿って区切る。各見出しの下は 2〜4 段落（1 段落 2〜4 文）。要点が 3 つ以上並ぶ所は - の箇条書きにする。大事な一文は **太字** にしてよい（1 見出しに 1 つまで）。',
		'3. ## まとめ: 要点を - の箇条書きで 3〜5 個。そのあとに読者への一言（1〜2 文）。',
		'入れないもの: 題（# の行）や「導入」「本文」といった構成名の見出し、ハッシュタグ、URL、「YouTube でも話しています」の類の一文（あとでアプリが付ける）、動画の時刻 [mm:ss]、「書き起こし」「動画では」といったメタな言い方。',
		'書き方の目安: 書き起こしの一文一文を、順番に、読みやすい文に直していく感覚で書く。「たとえば美容師はどうか」のような具体例の話は、その話の流れ（疑問 → 考え → 結論）ごと 1 段落以上にして残す。話者が列挙したもの（職業名など）は全部書く。',
		'本文のいちばん最後に 1 行だけ「タグ: 」で始まる行を付け、note のハッシュタグを読点（、）区切りで 5〜8 個書く（# は付けない。広い語 AI、生成AI と、この記事の話題の語、働き方・お金などの生活の語を混ぜる。1 語は 2〜10 文字）。',
		'返事は Markdown の本文だけ。前置きや説明、コードブロックの記号（```）は付けない。'
	].join('\n');
}

/** X の本文を重み付き 280 に収める（超えていたら末尾を削って …） */
export function fitX(text: string): string {
	if (xWeightedLength(text) <= TEXT_LIMITS.x.body) return text;
	const chars = [...text];
	while (chars.length > 0 && xWeightedLength(chars.join('') + '…') > TEXT_LIMITS.x.body)
		chars.pop();
	return chars.join('').trimEnd() + '…';
}

// ---- 動画の長さ ----

/**
 * 投稿先ごとの動画の長さ（秒）。max は上限（null = 制限なし）、initial は既定で切る長さ（null = 全部）。
 * X は Premium でないと 140 秒。Instagram のリールは 90 秒を超えるとリール欄に出ない。Threads は 5 分。TikTok は API 経由 10 分
 */
export const DURATION_LIMITS: Record<Platform, { max: number | null; initial: number | null }> = {
	youtube: { max: null, initial: null },
	x: { max: 140, initial: 60 },
	threads: { max: 300, initial: 60 },
	instagram: { max: 90, initial: 60 },
	facebook: { max: null, initial: null },
	tiktok: { max: 600, initial: 60 },
	note: { max: null, initial: null }
};

/** 動画の長さから、その投稿先で選べる最大と既定の秒数を出す（先頭からこの秒数まで） */
export function trimBounds(
	platform: Platform,
	durationSec: number
): { max: number; initial: number } {
	const dur = Math.max(1, Math.floor(durationSec));
	const lim = DURATION_LIMITS[platform];
	const max = Math.min(lim.max ?? dur, dur);
	const initial = Math.min(lim.initial ?? dur, max);
	return { max, initial };
}

// ---- 書き出しの状態 ----

export const STATUS_LABEL: Record<ExportStatus, string> = {
	draft: '未編集',
	writing: '本文を作成中',
	ready: '投稿文完成',
	scheduled: '日程決定',
	partial: '一部配信が残っている',
	done: '配信済み'
};

/** 確定した投稿文のうち、出す投稿先 */
export function enabledPlatforms(ex: ExportInfo): Platform[] {
	return PLATFORMS.map((p) => p.id).filter((p) => ex.drafts?.[p]?.on);
}

/**
 * 書き出しの状態を決める。自分で選んだ状態があればそれ。
 * 投稿文が無ければ draft。出す投稿先のうち投稿（予約）済みが 0 なら ready、全部なら（まだ待ちがあれば scheduled、無ければ done）、途中なら partial。
 * jobs（ハブの仕事）を渡すと、終わったかどうかをより正しく見る
 */
export function exportStatus(
	rec: Pick<Recording, 'posts'>,
	ex: ExportInfo,
	jobs?: Record<string, HubJob>,
	now = Date.now()
): ExportStatus {
	if (ex.statusOverride) return ex.statusOverride;
	if (!ex.drafts) return 'draft';
	const targets = enabledPlatforms(ex);
	if (!ex.confirmedAt || targets.length === 0) return 'writing';
	const posted = targets.filter((p) => isPosted(rec, ex, p, jobs));
	if (posted.length === 0) return 'ready';
	if (posted.length < targets.length) return 'partial';
	const waiting = (rec.posts ?? []).some((p) => {
		if ((p.exportId ?? 'legacy') !== ex.id) return false;
		const job = p.jobId ? jobs?.[p.jobId] : undefined;
		if (job) return job.status === 'queued' || job.status === 'running';
		return !!p.scheduledAt && Date.parse(p.scheduledAt) > now;
	});
	return waiting ? 'scheduled' : 'done';
}

/** 投稿できる時間帯は 12:00〜23:30（投稿ハブが動く時間。午前と夜中には投稿しない）。外れていれば文句を返す */
export function postingHoursError(iso: string | null): string | null {
	if (!iso) return null;
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return null;
	const h = d.getHours();
	const m = d.getMinutes();
	if (h < 12 || h > 23 || (h === 23 && m > 30)) return '投稿できるのは 12:00〜23:30 の間です';
	return null;
}
