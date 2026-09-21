<script lang="ts">
	/**
	 * 投稿ハブ経由の 1 つの投稿先（X・Threads・Instagram・Facebook ページ）の欄。
	 * 本文と長さは投稿の画面の draft を直接編集し（確定すると書き出しに保存される）、日時は画面で共通に決める。
	 * すぐ投稿のときは終わるまで「続きを進める」を呼び続けて URL を出す
	 */
	import type { Recording, Note, PostRecord, ExportInfo } from '$shared/types';
	import {
		hubTextError,
		PLATFORMS,
		TEXT_LIMITS,
		trimBounds,
		xWeightedLength,
		DURATION_LIMITS,
		TIKTOK_PRIVACY_LABEL,
		tiktokOptionsError,
		type HubAccount,
		type HubJob,
		type HubPlatform,
		type TikTokCreatorInfo,
		type TikTokPostOptions
	} from '$shared/publish';
	import { untrack } from 'svelte';
	import { api } from '$lib/api';
	import { toast } from '$lib/stores/toast.svelte';
	import { postOne, progressId } from '$lib/publish/run';
	import type { Draft } from './draft';

	let {
		platform,
		account,
		configured,
		recording,
		exportInfo,
		note,
		draft = $bindable(),
		publishAtIso,
		schedErr,
		onPosted,
		durationSec,
		onPreview,
		onScrub,
		previewingPlatform = null,
		playheadSec = null,
		postedOn = false,
		onTogglePosted
	}: {
		platform: HubPlatform;
		account: HubAccount | null;
		configured: boolean;
		recording: Recording;
		exportInfo: ExportInfo;
		note: Note | null;
		draft: Draft;
		publishAtIso: string | null;
		schedErr: string | null;
		onPosted?: (record: PostRecord) => void;
		/** 書き出した動画の長さ（秒）。分かるまで null */
		durationSec: number | null;
		/** 共通の再生で「ここで終わる」を確かめる */
		onPreview?: (
			from: number,
			to: number,
			label: string,
			platform: HubPlatform,
			kind: 'start' | 'end'
		) => void;
		/** 範囲を動かしている間、左の動画をその秒に合わせる（止めたまま） */
		onScrub?: (sec: number, label: string, platform: HubPlatform) => void;
		/** いま「終わりを確かめる」で流している投稿先（この欄なら時間の帯に印を出す） */
		previewingPlatform?: string | null;
		playheadSec?: number | null;
		/** この書き出しをこの投稿先に投稿済みか（判子と、二重投稿の確認）。自分で付け外しできる */
		postedOn?: boolean;
		onTogglePosted?: () => void;
	} = $props();

	const label = $derived(PLATFORMS.find((p) => p.id === platform)?.label ?? platform);
	/** 秒を「1 時間 2 分 3 秒」のように */
	const fmtSec = (sec: number) => {
		const s = Math.max(0, Math.round(sec));
		const h = Math.floor(s / 3600);
		const m = Math.floor((s % 3600) / 60);
		const r = s % 60;
		return `${h ? `${h} 時間 ` : ''}${h || m ? `${m} 分 ` : ''}${r} 秒`;
	};
	const portrait = $derived(note?.orientation === 'portrait');
	let busy = $state(false);
	let progress = $state<{ phase: string; ratio: number } | null>(null);
	let job = $state<HubJob | null>(null);
	const jobId = $derived(progressId(recording.id, platform));

	const count = $derived(platform === 'x' ? xWeightedLength(draft.text) : [...draft.text].length);
	const limit = $derived(TEXT_LIMITS[platform].body);
	const textErr = $derived(hubTextError(platform, draft.text));
	/** X はリンク入りだと 1 件 0.20 ドル（リンク無しは 0.015 ドル）。止めはしないが注意を出す */
	const hasUrl = $derived(
		platform === 'x' &&
			/https?:\/\/\S+|\b[\w-]+\.(com|jp|net|org|io|dev|app|me|tv)\b/i.test(draft.text)
	);
	const locked = $derived(busy || !!job);

	// ---- TikTok: 投稿者の情報を出し、公開範囲・コメントなどの可否・宣伝の申告を投稿者が選ぶ（TikTok の決まり）----
	let creator = $state<TikTokCreatorInfo | null>(null);
	let creatorErr = $state<string | null>(null);
	/** どのアカウントぶんを読んだか（$state にしない: 読み直しの引き金にしないため。TikTok は 1 分 20 回まで） */
	let creatorLoadedFor: string | null = null;
	$effect(() => {
		if (platform !== 'tiktok' || !account) return;
		const key = account.username;
		if (creatorLoadedFor === key) return;
		creatorLoadedFor = key;
		api()
			.publish.hubTikTokCreator()
			.then((c) => {
				creator = c;
				creatorErr = null;
				// 既定: 公開範囲は選べる中の最初（審査前は「自分のみ」だけ）。コメントなどは投稿者の設定に合わせる。
				// draft はここで読むと effect の依存になって無限に読み直すので untrack で読む
				const cur = untrack(() => draft.tiktok);
				// 審査前は「自分のみ」固定。審査後は前に選んだもの（選べる中にあれば）、無ければ最初
				const privacy = !c.audited
					? 'SELF_ONLY'
					: cur && c.privacyOptions.includes(cur.privacy)
						? cur.privacy
						: c.privacyOptions[0];
				draft.tiktok = {
					privacy: privacy ?? 'SELF_ONLY',
					allowComment: cur ? cur.allowComment && !c.commentDisabled : !c.commentDisabled,
					allowDuet: cur ? cur.allowDuet && !c.duetDisabled : !c.duetDisabled,
					allowStitch: cur ? cur.allowStitch && !c.stitchDisabled : !c.stitchDisabled,
					commercial: cur?.commercial ?? false,
					brandOrganic: cur?.brandOrganic ?? false,
					brandContent: cur?.brandContent ?? false
				};
			})
			.catch((err) => {
				creatorErr = (err as Error).message;
				creatorLoadedFor = null; // 次に開いたときに読み直す
			});
	});
	const tiktokErr = $derived(platform === 'tiktok' ? tiktokOptionsError(draft.tiktok) : null);
	/** 宣伝の申告の説明（TikTok の決まりの文言） */
	const commercialNote = $derived.by(() => {
		const o = draft.tiktok;
		if (!o?.commercial) return '';
		if (o.brandContent && o.brandOrganic)
			return '「有料パートナーシップ」「プロモーション」と表示されます';
		if (o.brandContent) return '「有料パートナーシップ」と表示されます';
		if (o.brandOrganic) return '「プロモーション」と表示されます';
		return '';
	});
	const tiktokOpt = (patch: Partial<TikTokPostOptions>) => {
		if (draft.tiktok) draft.tiktok = { ...draft.tiktok, ...patch };
	};
	// ---- 長さ（先頭から何秒まで）。draft.trimSec に持つ（確定で保存される）----
	const bounds = $derived(durationSec ? trimBounds(platform, durationSec) : null);
	$effect(() => {
		// 長さが分かったら、その投稿先の既定（X は 60 秒など）を入れる
		if (bounds && draft.trimSec === null) draft.trimSec = bounds.initial;
	});
	/** 何秒から（0 = 先頭） */
	const startSec = $derived(draft.startSec ?? 0);
	/** 動画の長さ（整数秒） */
	const dur = $derived(durationSec ? Math.floor(durationSec) : 0);
	/** この投稿先の上限（秒。無ければ動画の長さ） */
	const maxLen = $derived(DURATION_LIMITS[platform].max ?? dur);
	/** 終わりに選べる最大（先頭からの位置）: 動画の最後か、始まり + 上限 */
	const endMax = $derived(Math.min(dur, startSec + maxLen));
	/** 始まりに選べる最大（終わりまで 5 秒は残す） */
	const startMax = $derived(Math.max(0, dur - 5));
	const trimmed = $derived(
		!!bounds && draft.trimSec !== null && (startSec > 0 || draft.trimSec < dur)
	);
	/** 始まりから最後まで送れる（上限が残りより長い）か */
	const canFull = $derived(!!bounds && dur > 0 && maxLen >= dur - startSec);
	const limitNote = $derived(
		dur && maxLen < dur ? `${label} は ${fmtSec(maxLen)} まで（始まりから数えて）` : ''
	);
	// ---- 範囲の帯のドラッグ（本体で動かす、両端で伸び縮み）。動かしている間は左の動画がその場所を映す ----
	let barEl = $state<HTMLDivElement | null>(null);
	let drag = $state<{ kind: 'move' | 'start' | 'end'; grabOffset: number } | null>(null);
	const pct = (sec: number) => (dur > 0 ? Math.min(100, Math.max(0, (sec / dur) * 100)) : 0);
	/** 帯の上の x 座標 → 秒（整数） */
	function secAt(clientX: number): number {
		if (!barEl || dur === 0) return 0;
		const r = barEl.getBoundingClientRect();
		return Math.round(Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * dur);
	}
	function beginDrag(e: PointerEvent, kind: 'move' | 'start' | 'end') {
		if (locked || draft.trimSec === null) return;
		e.preventDefault();
		e.stopPropagation();
		drag = { kind, grabOffset: secAt(e.clientX) - startSec };
	}
	function onDragMove(e: PointerEvent) {
		if (!drag || draft.trimSec === null) return;
		const sec = secAt(e.clientX);
		if (drag.kind === 'move') {
			const len = draft.trimSec - startSec;
			const ns = Math.max(0, Math.min(dur - len, sec - drag.grabOffset));
			draft.startSec = ns > 0 ? ns : null;
			draft.trimSec = ns + len;
			onScrub?.(ns, label, platform);
		} else if (drag.kind === 'start') {
			setStart(Math.min(sec, draft.trimSec - 5));
			onScrub?.(startSec, label, platform);
		} else {
			setEnd(sec);
			onScrub?.(draft.trimSec, label, platform);
		}
	}
	function endDrag() {
		if (!drag || draft.trimSec === null) return;
		const kind = drag.kind;
		drag = null;
		// 放したら、その場所を少し流して確かめられるようにする
		if (kind === 'end')
			onPreview?.(Math.max(startSec, draft.trimSec - 5), draft.trimSec, label, platform, 'end');
		else onPreview?.(startSec, startSec + 5, label, platform, 'start');
	}
	/** 始まりを変える。終わりが近すぎたり上限を超えたりしないように直す */
	function setStart(v: number) {
		const s = Math.max(0, Math.min(startMax, Math.round(v)));
		draft.startSec = s > 0 ? s : null;
		if (draft.trimSec !== null) {
			if (draft.trimSec - s > maxLen) draft.trimSec = s + maxLen;
			if (draft.trimSec < s + 5) draft.trimSec = Math.min(dur, s + 5);
		}
	}
	function setEnd(v: number) {
		const e = Math.max(startSec + 5, Math.min(endMax, Math.round(v)));
		draft.trimSec = e;
	}
	export const canPost = () =>
		!!account &&
		!busy &&
		!job &&
		draft.text.trim() !== '' &&
		!textErr &&
		!schedErr &&
		!tiktokErr &&
		(platform !== 'tiktok' || !!creator);
	const finished = $derived(
		job ? job.status === 'done' || job.status === 'failed' || job.status === 'canceled' : false
	);

	$effect(() => {
		return api().publish.onProgress((p) => {
			if (p.id === jobId) progress = { phase: p.phase, ratio: p.ratio };
		});
	});
	// 登録したあと、終わるまで「続きを進める」を呼び続ける（ハブは 1 回に 20 秒ほど進めて返す）。予約は時刻が来るまで見ない
	$effect(() => {
		if (!job || finished || (job.status === 'queued' && publishAtIso)) return;
		const id = job.id;
		let stop = false;
		(async () => {
			while (!stop) {
				try {
					const j = await api().publish.hubStep(id);
					if (stop) return;
					job = j;
					if (j.status === 'done' || j.status === 'failed' || j.status === 'canceled') return;
				} catch {
					/* 次の周で */
				}
				await new Promise((r) => setTimeout(r, 2000));
			}
		})();
		return () => {
			stop = true;
		};
	});

	/** 投稿する。投稿の画面の「すべて投稿」からも呼ばれる */
	export async function post(): Promise<void> {
		if (!canPost()) return;
		if (
			postedOn &&
			!confirm(
				`この動画は ${label} にもう投稿済みです。もう一度投稿すると同じ動画が 2 本になります。投稿しますか？`
			)
		)
			return;
		busy = true;
		progress = { phase: 'preparing', ratio: 0 };
		try {
			const r = await postOne(platform, recording, exportInfo, draft, note, publishAtIso);
			job = r.job ?? null;
			toast.show(publishAtIso ? `${label} に予約しました` : `${label} に投稿しています…`);
			onPosted?.(r.record);
		} catch (err) {
			toast.error((err as Error).message);
		} finally {
			busy = false;
		}
	}
	async function cancel() {
		if (!job) return;
		try {
			const r = await api().publish.hubCancel(job.id);
			if (r.canceled) {
				toast.show('予約を取り消しました');
				job = null;
			} else toast.error('もう取りかかっていたので取り消せませんでした');
		} catch (err) {
			toast.error((err as Error).message);
		}
	}
	const phaseText = (p: string) =>
		p === 'preparing'
			? (platform === 'instagram' || platform === 'tiktok') && !portrait
				? '横の動画を帯付きの縦にしています…'
				: '準備しています…'
			: p === 'uploading'
				? 'ハブに動画を送っています…'
				: p === 'done'
					? 'ハブに渡しました'
					: '';
	const statusText = (j: HubJob) =>
		j.status === 'queued'
			? publishAtIso
				? `予約しました: ${new Date(j.scheduledAt).toLocaleString('ja-JP')}`
				: j.attempts > 0 && j.error
					? `やり直し待ち（${j.error}）`
					: '順番待ち…'
			: j.status === 'running'
				? `${label} に投稿しています…`
				: j.status === 'done'
					? '投稿しました'
					: j.status === 'failed'
						? `投稿できませんでした: ${j.error ?? ''}`
						: '取り消しました';
</script>

<svelte:window onpointermove={onDragMove} onpointerup={endDrag} onpointercancel={endDrag} />

<section class="hp card" class:card--posted={postedOn}>
	{#if postedOn}<span class="stamp">投稿済み</span>{/if}
	<div class="hp__head">
		<h2 class="card__title">
			{label}{platform === 'instagram'
				? portrait
					? '（リール）'
					: '（横は帯付きのリールに）'
				: platform === 'tiktok'
					? portrait
						? ''
						: '（横は帯付きの縦に）'
					: ''}
		</h2>
		<span class="muted">
			{#if !configured}
				ハブに {label} の設定（クライアント ID）がまだありません
			{:else if account}
				{platform === 'facebook' ? account.username : `@${account.username}`}
			{:else}
				まだ接続していません。設定の「投稿ハブ」で {label} に接続してください
			{/if}
		</span>
		{#if onTogglePosted}
			<button type="button" class="chip hp__mark" onclick={onTogglePosted}
				>{postedOn ? '投稿済みを外す' : '投稿済みにする'}</button
			>
		{/if}
	</div>
	{#if platform === 'tiktok' && account}
		<div class="hp__tt">
			{#if creator}
				<div class="hp__tt-creator">
					<span>投稿先: <strong>{creator.nickname}</strong></span>
				</div>
				{#if draft.tiktok}
					<div class="hp__tt-row">
						<span class="hp__tt-label">公開範囲</span>
						<div class="hp__tt-chips">
							{#each creator.privacyOptions as p (p)}
								<label class="chip hp__tt-chip" class:chip--green={draft.tiktok.privacy === p}>
									<input
										type="radio"
										name="tt-privacy-{recording.id}"
										value={p}
										checked={draft.tiktok.privacy === p}
										onchange={() => tiktokOpt({ privacy: p })}
										disabled={locked || (!creator.audited && p !== 'SELF_ONLY')}
									/>
									{TIKTOK_PRIVACY_LABEL[p]}
								</label>
							{/each}
						</div>
						{#if !creator.audited}
							<span class="muted"
								>TikTok の審査が通るまでは「自分のみ」でしか投稿できません（TikTok の決まり）</span
							>
						{/if}
					</div>
					<div class="hp__tt-row">
						<span class="hp__tt-label">許可する</span>
						<div class="hp__tt-chips">
							<label class="chip hp__tt-chip" class:chip--green={draft.tiktok.allowComment}>
								<input
									type="checkbox"
									checked={draft.tiktok.allowComment}
									onchange={(e) => tiktokOpt({ allowComment: e.currentTarget.checked })}
									disabled={locked || creator.commentDisabled}
								/>
								コメント
							</label>
							<label class="chip hp__tt-chip" class:chip--green={draft.tiktok.allowDuet}>
								<input
									type="checkbox"
									checked={draft.tiktok.allowDuet}
									onchange={(e) => tiktokOpt({ allowDuet: e.currentTarget.checked })}
									disabled={locked || creator.duetDisabled}
								/>
								デュエット
							</label>
							<label class="chip hp__tt-chip" class:chip--green={draft.tiktok.allowStitch}>
								<input
									type="checkbox"
									checked={draft.tiktok.allowStitch}
									onchange={(e) => tiktokOpt({ allowStitch: e.currentTarget.checked })}
									disabled={locked || creator.stitchDisabled}
								/>
								ステッチ
							</label>
						</div>
						{#if creator.commentDisabled || creator.duetDisabled || creator.stitchDisabled}
							<span class="muted">TikTok の設定で止めてあるものは選べません</span>
						{/if}
					</div>
					<div class="hp__tt-row">
						<span class="hp__tt-label">宣伝の申告</span>
						<div class="hp__tt-chips">
							<label class="chip hp__tt-chip" class:chip--green={draft.tiktok.commercial}>
								<input
									type="checkbox"
									checked={draft.tiktok.commercial}
									onchange={(e) =>
										tiktokOpt({
											commercial: e.currentTarget.checked,
											...(e.currentTarget.checked
												? {}
												: { brandOrganic: false, brandContent: false })
										})}
									disabled={locked}
								/>
								宣伝を含む
							</label>
							{#if draft.tiktok.commercial}
								<label class="chip hp__tt-chip" class:chip--green={draft.tiktok.brandOrganic}>
									<input
										type="checkbox"
										checked={draft.tiktok.brandOrganic}
										onchange={(e) => tiktokOpt({ brandOrganic: e.currentTarget.checked })}
										disabled={locked}
									/>
									自分のブランド
								</label>
								<label class="chip hp__tt-chip" class:chip--green={draft.tiktok.brandContent}>
									<input
										type="checkbox"
										checked={draft.tiktok.brandContent}
										onchange={(e) => tiktokOpt({ brandContent: e.currentTarget.checked })}
										disabled={locked}
									/>
									ブランドコンテンツ
								</label>
							{/if}
						</div>
						<span class="muted">
							{#if draft.tiktok.commercial}
								{commercialNote ||
									'自分（自分のブランド）の宣伝か、他社のブランドコンテンツ（タイアップ）かを選んでください'}
							{:else}
								この動画で自分や他社の商品・サービスを宣伝する場合はオンにします
							{/if}
						</span>
					</div>
					{#if tiktokErr}<span class="hp__err">{tiktokErr}</span>{/if}
					<p class="muted hp__tt-consent">
						投稿すると、TikTok の
						{#if draft.tiktok.brandContent}
							<a
								href="https://www.tiktok.com/legal/page/global/bc-policy/en"
								target="_blank"
								rel="noreferrer">ブランドコンテンツポリシー</a
							>と
						{/if}
						<a
							href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en"
							target="_blank"
							rel="noreferrer">音楽利用の確認</a
						>に同意したことになります
					</p>
				{/if}
			{:else if creatorErr}
				<span class="hp__err">TikTok の投稿者の情報を読めませんでした: {creatorErr}</span>
			{:else}
				<span class="muted">TikTok の投稿者の情報を読んでいます…</span>
			{/if}
		</div>
	{/if}
	{#if platform === 'threads'}
		<label class="hp__field hp__topic">
			<span>トピック <span class="muted">（Threads の話題の札。1 語。# は要らない）</span></span>
			<input class="input" bind:value={draft.topic} placeholder="例: 生成AI" disabled={locked} />
		</label>
	{/if}
	<label class="hp__field">
		<span
			>本文 <span class="muted" class:hp__over={count > limit}
				>{count}/{limit}{platform === 'x' ? '（日本語は 1 文字 2）' : ''}</span
			></span
		>
		<textarea class="input hp__text" rows="5" bind:value={draft.text} disabled={locked}></textarea>
		{#if textErr}<span class="hp__err">{textErr}</span>{/if}
		{#if hasUrl}<span class="hp__warn"
				>⚠ リンク入りの X 投稿は 1 件 0.20 ドル（約 30 円）かかります。リンク無しなら 0.015 ドルです</span
			>{/if}
	</label>

	{#if bounds && draft.trimSec !== null && durationSec}
		<div class="hp__trim">
			<div class="hp__row hp__trim-head">
				<span class="hp__label">投稿する部分</span>
				<span class="muted hp__trim-hint"
					>濃いところをつかんで動かす。両端をつまんで伸び縮み。動かすと左の動画がその場所を映します</span
				>
				<button
					type="button"
					class="chip"
					onclick={() => {
						draft.startSec = null;
						draft.trimSec = Math.min(dur, maxLen);
					}}
					disabled={locked || (startSec === 0 && draft.trimSec >= Math.min(dur, maxLen))}
					>{canFull ? '全部にする' : '先頭から上限まで'}</button
				>
			</div>
			<!-- 範囲の帯: 濃いところが投稿する範囲。本体をつかんで動かす、両端で伸び縮み -->
			<div
				class="hp__timeline hp__timeline--range"
				bind:this={barEl}
				role="group"
				aria-label="投稿する部分"
			>
				<div
					class="hp__kept hp__kept--grab"
					class:hp__kept--active={drag !== null}
					role="slider"
					aria-label="投稿する部分（つかんで動かす）"
					aria-valuemin="0"
					aria-valuemax={dur}
					aria-valuenow={startSec}
					tabindex="-1"
					style="left: {pct(startSec)}%; width: {Math.max(0, pct(draft.trimSec) - pct(startSec))}%"
					onpointerdown={(e) => beginDrag(e, 'move')}
				>
					<span class="hp__len">{fmtSec(draft.trimSec - startSec)}</span>
				</div>
				<div
					class="hp__grip hp__grip--start"
					role="slider"
					aria-label="始まり"
					aria-valuemin="0"
					aria-valuemax={dur}
					aria-valuenow={startSec}
					tabindex="-1"
					style="left: {pct(startSec)}%"
					onpointerdown={(e) => beginDrag(e, 'start')}
					title="始まりを動かす"
				></div>
				<div
					class="hp__grip hp__grip--end"
					role="slider"
					aria-label="終わり"
					aria-valuemin="0"
					aria-valuemax={dur}
					aria-valuenow={draft.trimSec}
					tabindex="-1"
					style="left: {pct(draft.trimSec)}%"
					onpointerdown={(e) => beginDrag(e, 'end')}
					title="終わりを動かす"
				></div>
				{#if previewingPlatform === platform && playheadSec !== null}
					<div class="hp__playhead" style="left: {pct(playheadSec)}%"></div>
				{/if}
				<!-- 両端の目盛り（0 と全長）は、範囲の時刻と重なるときは出さない -->
				{#if pct(startSec) > 12}<span class="hp__tick hp__tick--start">0</span>{/if}
				{#if pct(draft.trimSec) < 85}<span class="hp__tick hp__tick--end"
						>{fmtSec(durationSec)}</span
					>{/if}
				<span class="hp__edge hp__edge--start" style="left: {pct(startSec)}%"
					>{fmtSec(startSec)}</span
				>
				<span class="hp__edge hp__edge--end" style="left: {pct(draft.trimSec)}%"
					>{fmtSec(draft.trimSec)}</span
				>
			</div>
			<div class="hp__row">
				{#if onPreview}
					<button
						type="button"
						class="chip"
						onclick={() => onPreview?.(startSec, startSec + 5, label, platform, 'start')}
						>▶ 始まりを確かめる</button
					>
					<button
						type="button"
						class="chip"
						onclick={() =>
							onPreview?.(
								Math.max(startSec, draft.trimSec! - 5),
								draft.trimSec!,
								label,
								platform,
								'end'
							)}>▶ 終わりを確かめる</button
					>
				{/if}
			</div>
			<p class="muted hp__note">
				{trimmed
					? `${startSec ? fmtSec(startSec) : '先頭'}から ${fmtSec(draft.trimSec)} までの ${fmtSec(draft.trimSec - startSec)} を投稿します。終わりは音を 1 秒で下げます${startSec ? '（始まりは 0.5 秒で上げます）' : ''}`
					: '全部を投稿します'}{limitNote ? `。${limitNote}` : ''}
			</p>
		</div>
	{/if}

	{#if busy && progress}
		<div
			class="hp__progress"
			role="progressbar"
			aria-valuemin="0"
			aria-valuemax="100"
			aria-valuenow={Math.round(progress.ratio * 100)}
		>
			<div class="hp__bar" style="transform: scaleX({progress.ratio})"></div>
		</div>
		<span class="muted"
			>{phaseText(progress.phase)}
			{progress.phase === 'uploading' ? `${Math.round(progress.ratio * 100)}%` : ''}</span
		>
	{:else if job}
		<div class="hp__row">
			<strong class:hp__err={job.status === 'failed'}>{statusText(job)}</strong>
			{#if job.resultUrl}<a href={job.resultUrl} target="_blank" rel="noreferrer">{job.resultUrl}</a
				>{/if}
			{#if job.status === 'queued' && publishAtIso}
				<button type="button" class="chip" onclick={cancel}>予約を取り消す</button>
			{/if}
			{#if finished}
				<button type="button" class="chip" onclick={() => (job = null)}>もう一度</button>
			{/if}
		</div>
	{:else}
		<div class="hp__row">
			<button
				type="button"
				class="btn btn--sm btn--green"
				onclick={() => void post()}
				disabled={!canPost()}
			>
				{publishAtIso ? `${label} に予約する` : `${label} に投稿する`}
			</button>
			{#if platform === 'x'}<span class="muted"
					>{hasUrl ? '1 件およそ 30 円（リンク入り）' : '1 件およそ 2 円（X の従量課金）'}</span
				>{/if}
		</div>
	{/if}
</section>

<style>
	.hp {
		display: grid;
		gap: 12px;
	}
	.hp__head {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
	}
	.hp__mark {
		margin-left: auto;
	}
	.hp__topic .input {
		max-width: 320px;
	}
	/* TikTok の投稿の設定 */
	.hp__tt {
		display: grid;
		gap: 10px;
		padding: 10px 12px;
		border: 2px solid var(--ink);
		border-radius: 10px;
		background: #fff;
	}
	.hp__tt-creator {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 13px;
	}
	.hp__tt-row {
		display: grid;
		gap: 6px;
		font-size: 12.5px;
	}
	.hp__tt-label {
		font-weight: 900;
		font-size: 13px;
	}
	.hp__tt-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.hp__tt-chip {
		position: relative;
		cursor: pointer;
	}
	.hp__tt-chip input {
		position: absolute;
		opacity: 0;
		width: 0;
		height: 0;
	}
	.hp__tt-chip:has(input:disabled) {
		opacity: 0.5;
		cursor: default;
	}
	.hp__tt-consent {
		margin: 0;
		font-size: 12px;
	}
	.hp__tt-consent a {
		color: inherit;
	}
	.hp__field {
		display: grid;
		gap: 4px;
		font-weight: 900;
		font-size: 13px;
	}
	.hp__text {
		font: inherit;
		line-height: 1.6;
		resize: vertical;
		/* 中身に合わせて伸びる（欄の中でスクロールしない） */
		field-sizing: content;
		min-height: 6em;
	}
	.hp__over {
		color: var(--alert);
	}
	.hp__trim {
		display: grid;
		gap: 6px;
	}
	.hp__note {
		margin: 0;
		font-size: 12.5px;
		min-height: 1.4em;
	}
	.hp__timeline {
		position: relative;
		height: 14px;
		border: 2px solid var(--ink);
		border-radius: 999px;
		background: repeating-linear-gradient(135deg, #eee6c8 0 6px, #fffdf6 6px 12px);
		overflow: visible;
		margin: 8px 0 14px;
	}
	.hp__kept {
		position: absolute;
		top: 0;
		height: 100%;
		background: var(--ink);
		border-radius: 999px;
	}
	.hp__timeline--range {
		height: 28px;
		margin: 8px 0 30px;
		user-select: none;
		touch-action: none;
	}
	/* 帯が高いぶん、端の目盛りも下の段（範囲の時刻と同じ高さ）へ */
	.hp__timeline--range .hp__tick {
		top: 30px;
	}
	.hp__kept--grab {
		border-radius: 0; /* 両端のつまみとの間に隙間ができないように角を立てる */
		cursor: grab;
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--green);
		font-size: 11.5px;
		font-weight: 900;
		white-space: nowrap;
		overflow: hidden;
	}
	.hp__kept--active {
		cursor: grabbing;
		background: #333;
	}
	.hp__len {
		pointer-events: none;
	}
	/* 両端のつまみ */
	.hp__grip {
		position: absolute;
		top: -4px;
		width: 12px;
		height: 32px;
		margin-left: -6px;
		border: 2px solid var(--ink);
		border-radius: 4px;
		background: var(--green);
		cursor: ew-resize;
		z-index: 2;
	}
	/* 範囲の両端の時刻（帯の下） */
	.hp__edge {
		position: absolute;
		top: 30px;
		font-size: 11.5px;
		font-weight: 900;
		white-space: nowrap;
	}
	/* 始まりの時刻はつまみの右へ、終わりの時刻はつまみの左へ（端で切れない・互いに重なりにくい） */
	.hp__edge--start {
		transform: translateX(-4px);
	}
	.hp__edge--end {
		transform: translateX(calc(-100% + 4px));
	}
	.hp__trim-hint {
		font-size: 12px;
		flex: 1 1 auto;
	}
	.hp__trim-head .chip {
		margin-left: auto;
	}
	.hp__playhead {
		position: absolute;
		top: -6px;
		width: 4px;
		height: 22px;
		margin-left: -2px;
		background: var(--green);
		border: 2px solid var(--ink);
		border-radius: 3px;
	}
	.hp__tick {
		position: absolute;
		top: 16px;
		pointer-events: none;
		font-size: 11px;
		color: var(--muted, #6b6455);
	}
	.hp__tick--start {
		left: 0;
	}
	.hp__tick--end {
		right: 0;
	}
	.hp__row {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}
	.hp__label {
		font-weight: 900;
		font-size: 13px;
	}
	.hp__warn {
		color: #8a5a00;
		font-weight: 700;
		font-size: 12.5px;
	}
	.hp__err {
		color: var(--alert);
		font-weight: 700;
		font-size: 12.5px;
	}
	.hp__progress {
		height: 10px;
		border: 2px solid var(--ink);
		border-radius: 999px;
		overflow: hidden;
		background: var(--cream);
	}
	.hp__bar {
		height: 100%;
		width: 100%;
		background: var(--ink);
		transform-origin: left;
		transition: transform 0.2s linear;
	}
</style>
