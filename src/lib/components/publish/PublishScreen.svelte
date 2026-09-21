<script lang="ts">
	/**
	 * 投稿の画面。書き出しが終わると自動でここに来る（収録の一覧の「投稿」からも）。
	 * 左に書き出した動画、右に投稿先のオンオフと共通の予約日時と「AI で本文を作る」。
	 * その下にオンの投稿先の欄が並び、最後にこの収録の投稿の記録
	 */
	import {
		exportsOf,
		isPosted,
		type ExportStatus,
		type Recording,
		type Note,
		type PostRecord,
		withPostRecords
	} from '$shared/types';
	import {
		COMPOSE_TARGETS,
		exportStatus,
		PLATFORMS,
		postingHoursError,
		scheduleError,
		shortsTitle,
		STATUS_LABEL,
		type HubAccount,
		type HubJob,
		type HubPlatform,
		type Platform,
		type ComposeResult
	} from '$shared/publish';
	import { api } from '$lib/api';
	import { library } from '$lib/stores/library.svelte';
	import { toast } from '$lib/stores/toast.svelte';
	import { formatBytes, formatDateTime } from '$lib/utils/format';
	import YouTubePublish from './YouTubePublish.svelte';
	import ThumbnailCard from './ThumbnailCard.svelte';
	import NotePublish from './NotePublish.svelte';
	import HubPublish from './HubPublish.svelte';
	import { initialDrafts, type Draft, type Drafts } from './draft';

	let {
		recording,
		exportId,
		note,
		onBack,
		onEdit,
		onOpenSchedule
	}: {
		recording: Recording;
		/** どの書き出しを投稿するか（ExportInfo.id） */
		exportId: string;
		note: Note | null;
		onBack: () => void;
		onEdit: () => void;
		onOpenSchedule: () => void;
	} = $props();
	/** ハブの仕事（この収録のもの。状態の判定と記録の表示に使う） */
	let jobs = $state<Record<string, HubJob>>({});
	/** この書き出し（履歴の 1 本） */
	const thisExport = $derived(exportsOf(recording).find((e) => e.id === exportId) ?? null);
	/** 投稿済みか（自分で付けた印が優先。無ければ投稿の記録から） */
	const postedOn = (platform: Platform) =>
		thisExport ? isPosted(recording, thisExport, platform, jobs) : false;
	/** 「投稿済み」の印を自分で付け外しする */
	function togglePosted(platform: Platform) {
		if (!thisExport) return;
		const next = !postedOn(platform);
		void library.updateRecording(recording.id, {
			exports: exportsOf(recording).map((e) =>
				e.id === exportId ? { ...e, posted: { ...(e.posted ?? {}), [platform]: next } } : e
			),
			export: undefined
		});
	}

	const orientation = $derived(note?.orientation === 'portrait' ? 'portrait' : 'landscape');
	let info = $state<{ path: string; url: string; size: number; createdAt: number } | null>(null);
	let infoLoaded = $state(false);
	// ---- 共通の再生（各投稿先の「終わり」を確かめる）。左の動画は貼り付いているので、どこからでも見える ----
	let player = $state<HTMLVideoElement | null>(null);
	let durationSec = $state<number | null>(null);
	let previewing = $state<{
		from: number;
		end: number;
		label: string;
		platform: Platform;
		kind: 'start' | 'end';
	} | null>(null);
	/** 確かめている間の再生位置（秒）。欄の時間の帯に印を出す */
	let playheadSec = $state<number | null>(null);
	/** 範囲を動かしている間: その秒で止めて映す（帯にも印） */
	function scrubTo(sec: number, label: string, platform: Platform) {
		if (!player) return;
		player.pause();
		previewing = { from: sec, end: sec, label, platform, kind: 'start' };
		player.currentTime = Math.max(0, sec);
		playheadSec = sec;
	}
	/** from 秒から to 秒まで流して止める（kind は説明の文言用: 始まり / 終わり） */
	function previewRange(
		from: number,
		to: number,
		label: string,
		platform: Platform,
		kind: 'start' | 'end'
	) {
		if (!player) return;
		previewing = { from: Math.max(0, from), end: to, label, platform, kind };
		player.currentTime = Math.max(0, from);
		playheadSec = player.currentTime;
		void player.play().catch(() => {});
	}
	function onTime() {
		if (!player) return;
		if (!previewing) return;
		playheadSec = player.currentTime;
		if (player.currentTime >= previewing.end) {
			player.pause();
			player.currentTime = previewing.end;
			// ここで「確かめる」は終わり。そのあと ▶ を押せば、ふつうに続きが流れる（止めたままにしない）
			previewing = null;
			playheadSec = null;
		}
	}
	function onSeek() {
		// 手で大きく動かしたら「確かめる」はやめる
		if (previewing && player && player.currentTime < previewing.from - 1) {
			previewing = null;
			playheadSec = null;
		}
	}
	/** 秒を「1 時間 2 分 3 秒」のように */
	const fmtSec = (sec: number) => {
		const v = Math.max(0, Math.round(sec));
		const h = Math.floor(v / 3600);
		const mnt = Math.floor((v % 3600) / 60);
		const r = v % 60;
		return `${h ? `${h} 時間 ` : ''}${h || mnt ? `${mnt} 分 ` : ''}${r} 秒`;
	};

	// ---- 下書き（投稿先ごと。オンオフも draft.on に持つ）。確定してあればそこから ----
	// svelte-ignore state_referenced_locally
	const baseTitle = note?.title.trim() || recording.title || '';
	// svelte-ignore state_referenced_locally
	const thumb = note?.thumbnail?.file ?? null;
	// svelte-ignore state_referenced_locally
	let drafts = $state<Drafts>(
		initialDrafts(thisExport, note?.orientation ?? 'landscape', baseTitle, thumb)
	);
	const enabled = $derived(PLATFORMS.map((p) => p.id).filter((id) => drafts[id].on));
	/** 直すたびに自動で保存する（閉じても消えない。AI で作った本文も）。確定してから直したら dirty */
	let dirty = $state(false);
	let saveTimer: ReturnType<typeof setTimeout> | null = null;
	let firstRun = true;
	$effect(() => {
		const json = JSON.stringify(drafts);
		if (firstRun) {
			firstRun = false;
			return;
		}
		dirty = true;
		if (saveTimer) clearTimeout(saveTimer);
		saveTimer = setTimeout(() => void saveDrafts(JSON.parse(json) as Drafts, false), 600);
	});
	async function saveDrafts(saved: Drafts, confirmed: boolean) {
		await library.updateRecording(recording.id, {
			exports: exportsOf(recording).map((e) =>
				e.id === exportId
					? { ...e, drafts: saved, ...(confirmed ? { confirmedAt: Date.now() } : {}) }
					: e
			),
			export: undefined
		});
	}

	// ---- 状態 ----
	const status = $derived<ExportStatus>(
		thisExport ? exportStatus(recording, thisExport, jobs) : 'draft'
	);
	function setStatusOverride(v: ExportStatus | null) {
		void library.updateRecording(recording.id, {
			exports: exportsOf(recording).map((e) =>
				e.id === exportId ? { ...e, statusOverride: v } : e
			),
			export: undefined
		});
	}

	// ---- 投稿文を確定する: サムネを写し、drafts を書き出しに保存 ----
	let confirming = $state(false);
	async function confirmDrafts() {
		if (confirming || !thisExport) return;
		confirming = true;
		try {
			// サムネは YouTube を使わなくても写す（投稿管理の札に出す）
			await thumbCard?.captureThumbnail();
			if (saveTimer) clearTimeout(saveTimer);
			await saveDrafts(JSON.parse(JSON.stringify(drafts)) as Drafts, true);
			dirty = false;
			toast.show('投稿文を確定しました。投稿管理で日程を決められます');
		} catch (err) {
			toast.error((err as Error).message);
		} finally {
			confirming = false;
		}
	}

	// ---- 共通の予約 ----
	/** 既定は「日時を決める」（間違って押してすぐ投稿されないように）。明日の正午から */
	let scheduleOn = $state(true);
	/** 日付と時刻は別々に選ぶ（時刻は 12:00〜23:30 の 30 分刻みだけ。時間外は選べない） */
	const tomorrow = (() => {
		const t = new Date();
		t.setDate(t.getDate() + 1);
		const pad = (n: number) => String(n).padStart(2, '0');
		return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
	})();
	let scheduleDate = $state(tomorrow);
	let scheduleTime = $state('12:00');
	/** 選べる時刻: 12:00〜23:30 の 30 分刻み */
	const TIMES = Array.from({ length: 24 }, (_, i) => {
		const h = 12 + Math.floor(i / 2);
		const m = i % 2 === 0 ? '00' : '30';
		return `${String(h).padStart(2, '0')}:${m}`;
	});
	const scheduleLocal = $derived(
		scheduleDate && scheduleTime ? `${scheduleDate}T${scheduleTime}` : ''
	);
	const publishAtIso = $derived(
		scheduleOn && scheduleLocal ? new Date(scheduleLocal).toISOString() : null
	);
	const schedErr = $derived(
		scheduleOn
			? scheduleLocal
				? (scheduleError(publishAtIso) ?? postingHoursError(publishAtIso))
				: '日時を入れてください'
			: null
	);

	// ---- ハブ ----
	let hub = $state<
		| {
				ok: true;
				platforms: Array<{
					platform: HubPlatform;
					configured: boolean;
					account: HubAccount | null;
				}>;
		  }
		| { ok: false; error: string }
		| null
	>(null);
	const hubOf = (p: Platform) =>
		hub?.ok ? (hub.platforms.find((x) => x.platform === p) ?? null) : null;

	// ---- 投稿の記録 ----
	const posts = $derived([...(recording.posts ?? [])].sort((a, b) => b.at - a.at));
	const pending = $derived(
		posts.some(
			(p) => p.jobId && !['done', 'failed', 'canceled'].includes(jobs[p.jobId]?.status ?? '')
		)
	);

	async function loadJobs() {
		try {
			const all = await api().publish.hubJobs();
			const mine: Record<string, HubJob> = {};
			for (const j of all) if (j.ref === recording.id) mine[j.id] = j;
			jobs = mine;
		} catch {
			/* ハブが無いときは記録だけ出す */
		}
	}

	$effect(() => {
		const id = recording.id;
		infoLoaded = false;
		void api()
			.recordings.exportInfo(id, exportId)
			.then((i) => (info = i))
			.finally(() => (infoLoaded = true));
		void api()
			.publish.hubStatus()
			.then((s) => {
				hub = s;
				// ハブがまだ対応していない投稿先（TikTok など）は既定でオフにする
				if (s.ok)
					for (const p of PLATFORMS)
						if (
							p.id !== 'youtube' &&
							p.id !== 'note' &&
							!s.platforms.some((x) => x.platform === p.id)
						)
							drafts[p.id].on = false;
			});
		void loadJobs();
	});
	// 進行中の投稿がある間は 10 秒ごとに様子を見る
	$effect(() => {
		if (!pending) return;
		const t = setInterval(() => void loadJobs(), 10_000);
		return () => clearInterval(t);
	});

	function recordPost(record: PostRecord) {
		void library.updateRecording(recording.id, withPostRecords(recording, exportId, [record]));
		if (record.jobId) void loadJobs();
	}

	// ---- AI で本文を作る ----
	let composing = $state(false);
	async function compose() {
		if (composing || enabled.length === 0) return;
		// COMPOSE_TARGETS のぶんを作る（TikTok は題名のまま）
		const targets = enabled.filter((p) => COMPOSE_TARGETS.includes(p));
		if (targets.length === 0) {
			toast.error('作る投稿先がオンになっていません');
			return;
		}
		composing = true;
		try {
			// 投稿先ごとに 1 つずつ別の呼び出しにする（まとめて頼むと中身が省かれることがあった）。
			// 同時に走らせるので待ち時間は変わらない。どれかがしくじっても、ほかの結果は生かす
			const results = await Promise.allSettled(
				targets.map((p) => api().publish.compose(recording.id, [p]))
			);
			const failed: string[] = [];
			results.forEach((x, i) => {
				if (x.status === 'rejected')
					failed.push(
						`${PLATFORMS.find((q) => q.id === targets[i])?.label ?? targets[i]}: ${(x.reason as Error).message}`
					);
			});
			const r: ComposeResult = Object.assign(
				{},
				...results.map((x) => (x.status === 'fulfilled' ? x.value : {}))
			);
			if (failed.length === targets.length || (failed.length && Object.keys(r).length === 0))
				throw new Error(failed.join(' / '));
			if (failed.length) toast.error(`一部できませんでした。${failed.join(' / ')}`);
			let n = 0;
			for (const p of targets) {
				const v = r[p];
				if (!v) continue;
				n++;
				const d: Draft = drafts[p];
				if (p === 'youtube') {
					// 題は収録の題のまま（自分で考えたキーワードを AI に変えさせない。縦なら #Shorts だけ付ける）
					d.title = shortsTitle(baseTitle, orientation);
					d.text = v.text;
					if (v.tags?.length) d.tagsText = v.tags.join(', ');
				} else {
					if (v.title && p !== 'note') d.title = v.title;
					if (p === 'threads' && v.topic) d.topic = v.topic;
					if (p === 'note' && v.tags?.length) d.tagsText = v.tags.join(', ');
					d.text = v.text;
				}
			}
			toast.show(`${n} 件の本文を作りました。読んで直してから投稿してください`);
		} catch (err) {
			toast.error((err as Error).message);
		} finally {
			composing = false;
		}
	}

	// ---- まとめて投稿 ----
	let thumbCard = $state<ThumbnailCard | null>(null);
	let cards = $state<
		Record<
			string,
			| {
					post: () => Promise<void>;
					canPost: () => boolean;
					captureThumbnail?: () => Promise<void>;
			  }
			| undefined
		>
	>({});

	async function copyExport() {
		try {
			const dest = await api().recordings.copyExport(recording.id, exportId);
			if (dest) toast.show(`コピーしました: ${dest}`);
		} catch (err) {
			toast.error((err as Error).message);
		}
	}
	async function cancelJob(jobId: string) {
		try {
			const r = await api().publish.hubCancel(jobId);
			toast.show(
				r.canceled ? '予約を取り消しました' : 'もう取りかかっていたので取り消せませんでした'
			);
			await loadJobs();
		} catch (err) {
			toast.error((err as Error).message);
		}
	}
	const jobText = (j: HubJob | undefined, p: PostRecord) =>
		!j
			? p.scheduledAt
				? `予約: ${new Date(p.scheduledAt).toLocaleString('ja-JP')}`
				: '登録済み'
			: j.status === 'queued'
				? p.scheduledAt
					? `予約中: ${new Date(j.scheduledAt).toLocaleString('ja-JP')}`
					: '順番待ち…'
				: j.status === 'running'
					? '投稿しています…'
					: j.status === 'done'
						? '投稿しました'
						: j.status === 'failed'
							? `失敗: ${j.error ?? ''}`
							: '取り消し';
	const label = (p: Platform) => PLATFORMS.find((x) => x.id === p)?.label ?? p;
</script>

<div class="pub">
	<div class="pub__top">
		<div class="pub__title">
			<h1>SNS投稿 <span class="muted">{recording.title}</span></h1>
		</div>
		<div class="pub__tools">
			<button type="button" class="btn btn--sm btn--green" onclick={onOpenSchedule}>投稿管理</button
			>
			<button type="button" class="chip" onclick={onEdit}>編集画面へ</button>
			<button type="button" class="chip" onclick={onBack}>閉じる</button>
		</div>
	</div>

	<div class="pub__body">
		<!-- 左: 動画（いつも見えている）・投稿日・投稿先 -->
		<div class="pub__left">
			<section class="card pub__video">
				{#if info}
					<!-- svelte-ignore a11y_media_has_caption -->
					<video
						class="pub__player"
						class:pub__player--portrait={orientation === 'portrait'}
						src={info.url}
						controls
						preload="metadata"
						bind:this={player}
						onloadedmetadata={() => (durationSec = player?.duration ?? null)}
						ontimeupdate={onTime}
						onseeking={onSeek}
					></video>
					{#if previewing}
						<p class="pub__preview">
							{#if previewing.kind === 'start'}
								▶ {previewing.label} の始まり（{fmtSec(previewing.from)}）。ここから 5 秒流れます
							{:else}
								▶ {previewing.label} の終わり（{fmtSec(previewing.end)}）。5
								秒前から流れて、ここで止まります
							{/if}
						</p>
					{/if}
					<p class="muted">
						{orientation === 'portrait' ? '縦' : '横'}・{durationSec
							? fmtSec(durationSec)
							: ''}・{formatBytes(info.size)}・書き出し {formatDateTime(info.createdAt)}
					</p>
					<div class="pub__row">
						<button type="button" class="chip" onclick={() => api().app.revealPath(info!.path)}
							>Finder で表示</button
						>
						<button type="button" class="chip" onclick={copyExport}>ダウンロードにコピー</button>
					</div>
				{:else if infoLoaded}
					<p>
						まだ書き出した動画がありません。編集画面で「mp4
						に書き出す」を押すと、終わったあと自動でここに戻ります。
					</p>
					<button type="button" class="btn btn--sm btn--green" onclick={onEdit}
						>編集画面で書き出す</button
					>
				{:else}
					<p class="muted">動画を読んでいます…</p>
				{/if}
			</section>

			<section class="card pub__status">
				<h2 class="card__title">ステータス</h2>
				<div class="pub__row">
					<span class="pub__status-badge pub__status-badge--{status}">{STATUS_LABEL[status]}</span>
					<select
						class="input pub__status-select"
						value={thisExport?.statusOverride ?? ''}
						onchange={(e) =>
							setStatusOverride((e.currentTarget.value || null) as ExportStatus | null)}
					>
						<option value="">自動で決める</option>
						{#each Object.entries(STATUS_LABEL) as [v, l] (v)}
							<option value={v}>{l}</option>
						{/each}
					</select>
				</div>
			</section>

			<section class="card pub__targets">
				<h2 class="card__title">投稿先</h2>
				<div class="pub__row">
					{#each PLATFORMS as p (p.id)}
						{@const h = hubOf(p.id)}
						{@const unavailable = p.id !== 'youtube' && p.id !== 'note' && hub?.ok === true && !h}
						<label
							class="chip pub__toggle"
							class:chip--green={drafts[p.id].on}
							class:pub__toggle--off={unavailable}
						>
							<input type="checkbox" bind:checked={drafts[p.id].on} disabled={unavailable} />
							{p.label}{unavailable ? '（準備中）' : ''}
						</label>
					{/each}
				</div>
				{#if hub && !hub.ok}
					<p class="muted">投稿ハブにつながっていません。{hub.error}</p>
				{/if}
			</section>

			{#if info && thisExport}
				<ThumbnailCard
					bind:this={thumbCard}
					{recording}
					exportInfo={thisExport}
					{note}
					bind:draft={drafts.youtube}
				/>
			{/if}

			<section class="card pub__when">
				<h2 class="card__title">投稿日</h2>
				<div class="pub__row">
					<label class="chip pub__toggle" class:chip--green={scheduleOn}>
						<input
							type="radio"
							name="pub-when"
							value="later"
							checked={scheduleOn}
							onchange={() => (scheduleOn = true)}
						/>
						日時を決める
					</label>
					<label class="chip pub__toggle" class:chip--green={!scheduleOn}>
						<input
							type="radio"
							name="pub-when"
							value="now"
							checked={!scheduleOn}
							onchange={() => (scheduleOn = false)}
						/>
						いますぐ
					</label>
				</div>
				{#if scheduleOn}
					<div class="pub__row">
						<input class="input pub__dt" type="date" min={tomorrow} bind:value={scheduleDate} />
						<select class="input pub__time" bind:value={scheduleTime}>
							{#each TIMES as t (t)}
								<option value={t}>{t}</option>
							{/each}
						</select>
					</div>
					<span class="muted"
						>全部の投稿先に同じ日時（12:00〜23:30 の間）。YouTube はその時刻に公開、ほかは 30
						分以内に投稿されます</span
					>
					{#if schedErr}<span class="pub__err">{schedErr}</span>{/if}
				{/if}
			</section>
		</div>

		<!-- 右: AI で本文 → 選んだ投稿先の欄 → まとめて投稿 → 記録 -->
		<div class="pub__right">
			<section class="card pub__ai">
				<button
					type="button"
					class="btn btn--green"
					onclick={() => void compose()}
					disabled={composing || enabled.length === 0 || !info}
				>
					{composing ? '作っています…' : 'AI で本文を作る'}
				</button>
				<span class="muted"
					>テロップとノートの題から、YouTube
					の題・説明（チャプター付き）・タグと、X・Threads・Instagram・Facebook
					の本文（つかみ＋箇条書き。ハッシュタグは YouTube と Instagram だけ）、note
					の記事（Markdown）を作ります（数円）</span
				>
			</section>

			{#if info}
				{#each PLATFORMS as p (p.id)}
					{#if drafts[p.id].on}
						{#if p.id === 'youtube'}
							<YouTubePublish
								bind:this={cards.youtube}
								{recording}
								exportInfo={thisExport!}
								{note}
								bind:draft={drafts.youtube}
								postedOn={postedOn('youtube')}
								onTogglePosted={() => togglePosted('youtube')}
								{publishAtIso}
								{schedErr}
								onPosted={recordPost}
								onCapture={() => thumbCard?.captureThumbnail() ?? Promise.resolve()}
							/>
						{:else if p.id === 'note'}
							<NotePublish
								{recording}
								exportInfo={thisExport!}
								bind:draft={drafts.note}
								postedOn={postedOn('note')}
								onTogglePosted={() => togglePosted('note')}
								onPosted={recordPost}
							/>
						{:else}
							{@const h = hubOf(p.id)}
							{#if h}
								<HubPublish
									bind:this={cards[p.id]}
									platform={p.id}
									account={h.account}
									configured={h.configured}
									{recording}
									exportInfo={thisExport!}
									{note}
									bind:draft={drafts[p.id]}
									postedOn={postedOn(p.id)}
									onTogglePosted={() => togglePosted(p.id)}
									{publishAtIso}
									{schedErr}
									onPosted={recordPost}
									{durationSec}
									onPreview={previewRange}
									onScrub={scrubTo}
									previewingPlatform={previewing?.platform ?? null}
									{playheadSec}
								/>
							{:else if hub?.ok}
								<section class="card">
									<h2 class="card__title">{p.label}</h2>
									<p class="muted">{p.label} はまだ準備中です。</p>
								</section>
							{/if}
						{/if}
					{/if}
				{/each}

				<section class="card pub__all">
					<button
						type="button"
						class="btn btn--lg btn--green pub__all-btn"
						onclick={() => void confirmDrafts()}
						disabled={confirming || enabled.length === 0}
					>
						{confirming
							? '確定しています…'
							: dirty || !thisExport?.confirmedAt
								? '投稿文を確定する'
								: '確定済み（直したらもう一度）'}
					</button>
					<span class="muted"
						>本文は直すたびに自動で保存されます。確定すると投稿管理でドラッグして日程を決められます</span
					>
				</section>
			{/if}

			<section class="card">
				<h2 class="card__title">この収録の投稿 <span class="muted">{posts.length} 件</span></h2>
				{#if posts.length === 0}
					<p class="muted">まだ投稿していません。</p>
				{:else}
					<ul class="pub__posts">
						{#each posts as p (p.at + p.platform)}
							{@const j = p.jobId ? jobs[p.jobId] : undefined}
							<li>
								<strong>{label(p.platform)}</strong>
								{#if (p.exportId ?? 'legacy') !== exportId}<span class="muted"
										>（別の書き出し）</span
									>{/if}
								<span class="muted">{formatDateTime(p.at)}</span>
								{#if p.seconds || p.fromSec}<span class="muted"
										>{p.fromSec ? fmtSec(p.fromSec) : '先頭'}から{p.seconds
											? ` ${fmtSec(p.seconds)} まで`
											: '最後まで'}</span
									>{/if}
								{#if p.platform === 'youtube'}
									<span
										>{p.scheduledAt
											? `予約: ${new Date(p.scheduledAt).toLocaleString('ja-JP')}`
											: '投稿しました'}</span
									>
								{:else}
									<span class:pub__err={j?.status === 'failed'}>{jobText(j, p)}</span>
								{/if}
								{#if p.url || j?.resultUrl}
									<a href={p.url ?? j?.resultUrl} target="_blank" rel="noreferrer"
										>{p.url ?? j?.resultUrl}</a
									>
								{/if}
								{#if j?.status === 'queued' && p.scheduledAt}
									<button type="button" class="chip" onclick={() => void cancelJob(j.id)}
										>予約を取り消す</button
									>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		</div>
	</div>
</div>

<style>
	.pub {
		/* この画面は背景から全部、黄色の代わりに緑 */
		--yellow: var(--green);
		height: 100vh;
		display: grid;
		grid-template-rows: auto minmax(0, 1fr);
		background: var(--yellow);
		padding: 0 24px 20px;
		gap: 14px;
	}
	.pub__top {
		min-height: var(--titlebar);
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		padding: 8px 0 0 60px; /* 信号機ボタンの分 */
		-webkit-app-region: drag;
	}
	.pub__top button {
		-webkit-app-region: no-drag;
	}
	.pub__title {
		min-width: 0;
	}
	.pub__title h1 {
		margin: 0;
		font-size: 20px;
		font-weight: 900;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.pub__title h1 .muted {
		font-size: 15px;
		font-weight: 700;
		color: #fff; /* 緑の地なので白 */
	}
	.pub__body {
		overflow: auto;
		padding-right: 8px; /* カードの影（右 4px）が切れないように */
		display: grid;
		grid-template-columns: minmax(300px, 400px) minmax(0, 1fr);
		gap: 16px;
		align-items: start;
		padding-bottom: 20px;
	}
	/* 左は上に貼り付く（スクロールしても動画・投稿日・投稿先が見えている） */
	.pub__left {
		position: sticky;
		top: 0;
		/* sticky は重なりの入れ物になるので、中から出す全画面の窓（サムネを作る）が右の欄より上に来るように */
		z-index: 10;
		display: grid;
		gap: 12px;
		align-content: start;
		max-height: calc(100vh - var(--titlebar) - 40px);
		overflow: auto;
		padding: 0 8px 8px 0; /* 影が切れないように */
	}
	.pub__right {
		display: grid;
		gap: 12px;
		align-content: start;
		min-width: 0;
	}
	@media (max-width: 900px) {
		.pub__body {
			grid-template-columns: 1fr;
		}
		.pub__left {
			position: static;
			max-height: none;
		}
	}
	.pub__video {
		display: grid;
		gap: 8px;
		align-content: start;
	}
	.pub__player {
		width: 100%;
		max-height: 300px;
		background: #000;
		border-radius: 12px;
		border: 2px solid var(--ink);
	}
	.pub__player--portrait {
		max-height: 420px;
		width: auto;
		max-width: 100%;
		justify-self: center;
	}
	.pub__preview {
		margin: 0;
		font-size: 13px;
		font-weight: 700;
	}
	.pub__status {
		display: grid;
		gap: 8px;
	}
	.pub__status-badge {
		display: inline-block;
		border: 2px solid var(--ink);
		border-radius: 999px;
		padding: 4px 12px;
		font-weight: 900;
		font-size: 13px;
		background: var(--cream);
	}
	.pub__status-badge--writing {
		background: #fff3b0;
	}
	.pub__status-badge--ready {
		background: #d9f5e3;
	}
	.pub__status-badge--scheduled {
		background: #cfe9ff;
	}
	.pub__status-badge--partial {
		background: #ffd6a5;
	}
	.pub__status-badge--done {
		background: var(--green);
	}
	.pub__status-select {
		font: inherit;
		padding: 4px 8px;
	}
	.pub__when,
	.pub__targets {
		display: grid;
		gap: 10px;
		align-content: start;
	}
	.pub__ai {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
	}
	.pub__row {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}
	.pub__toggle {
		cursor: pointer;
	}
	.pub__toggle--off {
		opacity: 0.5;
		cursor: default;
	}
	.pub__toggle input {
		position: absolute;
		opacity: 0;
		width: 1px;
		height: 1px;
	}
	.pub__dt {
		font: inherit;
		padding: 4px 8px;
		flex: 1 1 160px;
	}
	.pub__time {
		font: inherit;
		padding: 4px 8px;
		width: 96px;
	}
	.pub__err {
		color: var(--alert);
		font-weight: 700;
		font-size: 12.5px;
	}
	.pub__all {
		display: grid;
		justify-items: center;
	}
	.pub__all-btn {
		font-size: 18px;
		padding: 16px 40px;
		min-width: min(100%, 420px);
	}
	.pub__posts {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 6px;
	}
	.pub__posts li {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		font-size: 13.5px;
	}
	.pub__posts a {
		word-break: break-all;
	}
</style>
