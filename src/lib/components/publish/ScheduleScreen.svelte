<script lang="ts">
	/**
	 * 投稿管理。上から今日・明日…と日が並び、左から右へ 0 時〜23 時。予約がその時刻の所に出る。
	 * ドラッグは「置くだけ」で、まだサーバーとはやりとりしない（何度でも動かせる）。
	 * 右上の「確定」で初めて、ハブ・YouTube へまとめて送る。過去は出さない
	 */
	import { exportsOf, isPosted, type ExportInfo, type Recording } from '$shared/types';
	import {
		enabledPlatforms,
		exportStatus,
		PLATFORMS,
		STATUS_LABEL,
		type HubJob,
		type Platform
	} from '$shared/publish';
	import { api } from '$lib/api';
	import { library } from '$lib/stores/library.svelte';
	import { toast } from '$lib/stores/toast.svelte';
	import { formatBytes, formatDateTime } from '$lib/utils/format';
	import { schedule, type Pending, type ScheduledItem as Item } from '$lib/stores/schedule.svelte';

	let {
		onBack,
		onOpenPublish
	}: { onBack: () => void; onOpenPublish: (recordingId: string, exportId: string) => void } =
		$props();

	/** 1 画面は 14 日。「次の 2 週」「前の 2 週」で動かす（今日より前には戻れない） */
	const DAYS = 14;
	/** 今日より前も少し出す（昨日・一昨日に出したものが見える。置くことはできない） */
	const PAST_DAYS = 2;
	let weekOffset = $state(0);
	/** 12 時〜23 時（ハブは 12:00〜23:30 に動く。午前と夜中には投稿しない） */
	const HOURS = Array.from({ length: 12 }, (_, h) => h + 12);
	/** 枡は 30 分ごと（:00 と :30）。1 時間の見出しの下に 2 枡 */
	const SLOTS = HOURS.flatMap((h) => [
		{ h, m: 0 },
		{ h, m: 30 }
	]);
	const label = (p: Platform) => PLATFORMS.find((x) => x.id === p)?.label ?? p;

	/** 格子に出す 1 枚（予約済み、動かした予約、置いた書き出し） */
	interface Chip {
		key: string;
		when: Date;
		/** もう出したもの（過去の日に出す。動かせない） */
		done?: boolean;
		title: string;
		platforms: Platform[];
		recordingId: string;
		exportId: string;
		pending: boolean;
		/** この札に入っている予約（同じ書き出し・同じ時刻。投稿先ごとに 1 つ） */
		items?: Item[];
		pendingId?: string;
		/** サムネ（確定のときに写した図つきサムネ。無ければ題名を出す） */
		thumb?: string;
	}

	/** 書き出しの図つきサムネの URL（保存先の exports/ にある PNG）。無ければ undefined */
	function thumbUrl(rec: Recording, exportId: string): string | undefined {
		const ex = exportsOf(rec).find((e) => e.id === exportId);
		const p = ex?.drafts?.youtube?.thumbnailPath;
		if (!p || !/\.thumb\.png$/.test(p)) return undefined;
		return `media://local/exports/${encodeURIComponent(p.split('/').pop() ?? '')}`;
	}
	let jobs = $state<Record<string, HubJob>>({});
	let loading = $state(true);
	async function loadJobs() {
		try {
			const all = await api().publish.hubJobs();
			const m: Record<string, HubJob> = {};
			for (const j of all) m[j.id] = j;
			jobs = m;
		} catch {
			/* ハブが無ければ記録だけで出す */
		} finally {
			loading = false;
		}
	}
	$effect(() => {
		void loadJobs();
	});

	const today = $derived.by(() => {
		const t = new Date();
		t.setHours(0, 0, 0, 0);
		return t;
	});
	const days = $derived(
		Array.from({ length: DAYS }, (_, i) => {
			const d = new Date(today);
			d.setDate(d.getDate() - PAST_DAYS + weekOffset * DAYS + i);
			return d;
		})
	);
	const rangeLabel = $derived(
		`${days[0].getMonth() + 1}/${days[0].getDate()} 〜 ${days[DAYS - 1].getMonth() + 1}/${days[DAYS - 1].getDate()}`
	);

	/** これから投稿される予約（今より先のもの。ハブの予約は取りかかり前のものだけ） */
	const items = $derived.by(() => {
		const out: Item[] = [];
		const now = Date.now();
		for (const rec of library.recordings) {
			for (const post of rec.posts ?? []) {
				if (!post.scheduledAt) continue;
				const job = post.jobId ? jobs[post.jobId] : undefined;
				if (job && job.status !== 'queued') continue;
				const when = new Date(job?.scheduledAt ?? post.scheduledAt);
				if (when.getTime() < now) continue;
				out.push({ key: `${rec.id}:${post.at}:${post.platform}`, recording: rec, post, when, job });
			}
		}
		return out.sort((a, b) => a.when.getTime() - b.when.getTime());
	});
	/** もう出したもの（出した日時が、表に出ている過去の日の範囲にあるもの）。動かせない札として出す */
	const doneItems = $derived.by(() => {
		const out: Item[] = [];
		const from = new Date(today);
		from.setDate(from.getDate() - PAST_DAYS + weekOffset * DAYS);
		const now = Date.now();
		for (const rec of library.recordings) {
			for (const post of rec.posts ?? []) {
				const job = post.jobId ? jobs[post.jobId] : undefined;
				if (job && job.status !== 'done') continue;
				if (!job && post.platform !== 'youtube' && post.platform !== 'note') continue;
				// 出した日時: 予約ならその時刻、すぐならその時
				const when = new Date(post.scheduledAt ?? post.at);
				if (when.getTime() >= now || when.getTime() < from.getTime()) continue;
				out.push({
					key: `done:${rec.id}:${post.at}:${post.platform}`,
					recording: rec,
					post,
					when,
					job
				});
			}
		}
		return out;
	});

	// ---- まだ確定していない変更 ----
	// 置いた変更・送信の様子は store にある（画面を閉じても送信が続き、置いたものも残る）
	const pendings = $derived(schedule.pendings);
	const pendingCount = $derived(pendings.length);
	const applying = $derived(schedule.applying);
	// 確定が終わったら予約を読み直す
	$effect(() => {
		void schedule.finished;
		void loadJobs();
	});

	/** 格子に出す札: 予約済み（動かしたものは新しい位置）＋ 置いた書き出し */
	/** 同じ書き出し・同じ時刻（分）の予約をひとまとまりにする（X・Threads… を 1 枚の札に） */
	function groupItems(list: Item[]): Item[][] {
		const m = new Map<string, Item[]>();
		for (const it of list) {
			const minute = Math.floor(it.when.getTime() / 60_000);
			const k = `${it.recording.id}:${it.post.exportId ?? 'legacy'}:${minute}`;
			const arr = m.get(k);
			if (arr) arr.push(it);
			else m.set(k, [it]);
		}
		return [...m.values()];
	}
	const chips = $derived.by(() => {
		const out: Chip[] = [];
		for (const group of groupItems(doneItems)) {
			const it = group[0];
			out.push({
				key: `done:${it.recording.id}:${it.post.exportId ?? 'legacy'}:${it.when.getTime()}`,
				when: it.when,
				done: true,
				title: it.recording.title,
				platforms: group.map((g) => g.post.platform),
				recordingId: it.recording.id,
				exportId: it.post.exportId ?? 'legacy',
				pending: false,
				items: group,
				thumb: thumbUrl(it.recording, it.post.exportId ?? 'legacy')
			});
		}
		for (const group of groupItems(items)) {
			const it = group[0];
			const key = `${it.recording.id}:${it.post.exportId ?? 'legacy'}:${it.when.getTime()}`;
			const mv = pendings.find((p) => p.kind === 'move' && p.items.some((x) => x.key === it.key));
			out.push({
				key,
				when: mv ? mv.when : it.when,
				title: it.recording.title,
				platforms: group.map((g) => g.post.platform),
				recordingId: it.recording.id,
				exportId: it.post.exportId ?? 'legacy',
				pending: !!mv,
				items: group,
				pendingId: mv?.id,
				thumb: thumbUrl(it.recording, it.post.exportId ?? 'legacy')
			});
		}
		for (const p of pendings) {
			if (p.kind !== 'place') continue;
			out.push({
				key: `place:${p.id}`,
				when: p.when,
				title: p.recording.title,
				platforms: p.remaining,
				recordingId: p.recording.id,
				exportId: p.ex.id,
				pending: true,
				pendingId: p.id,
				thumb: thumbUrl(p.recording, p.ex.id)
			});
		}
		return out;
	});
	const chipsAt = (day: Date, hour: number, minute: number) =>
		chips.filter(
			(c) =>
				c.when.getFullYear() === day.getFullYear() &&
				c.when.getMonth() === day.getMonth() &&
				c.when.getDate() === day.getDate() &&
				c.when.getHours() === hour &&
				(c.when.getMinutes() < 30 ? 0 : 30) === minute
		);
	const countOn = (day: Date) =>
		chips.filter((c) => c.when.toDateString() === day.toDateString()).length;

	/** 投稿文を確定してあって、まだ出していない投稿先が残っている書き出し（ドラッグで日程を決める） */
	const unscheduled = $derived.by(() => {
		const out: Array<{
			recording: Recording;
			ex: ExportInfo;
			remaining: Platform[];
			status: string;
		}> = [];
		for (const rec of library.recordings) {
			for (const ex of exportsOf(rec)) {
				const st = exportStatus(rec, ex, jobs);
				if (st !== 'ready' && st !== 'partial') continue;
				if (
					pendings.some((p) => p.kind === 'place' && p.ex.id === ex.id && p.recording.id === rec.id)
				)
					continue;
				// note は手で貼るので日程の対象外
				const remaining = enabledPlatforms(ex).filter(
					(p) => p !== 'note' && !isPosted(rec, ex, p, jobs)
				);
				if (remaining.length === 0) continue;
				out.push({ recording: rec, ex, remaining, status: STATUS_LABEL[st] });
			}
		}
		return out.sort((a, b) => b.ex.createdAt - a.ex.createdAt);
	});
	/** 投稿文がまだ確定していない書き出し（SNS 投稿で確定してもらう） */
	const unconfirmed = $derived.by(() => {
		const out: Array<{ recording: Recording; ex: ExportInfo }> = [];
		for (const rec of library.recordings)
			for (const ex of exportsOf(rec))
				if (['draft', 'writing'].includes(exportStatus(rec, ex, jobs)))
					out.push({ recording: rec, ex });
		return out.sort((a, b) => b.ex.createdAt - a.ex.createdAt);
	});

	// ---- ドラッグ（置くだけ。確定するまでサーバーには送らない）----
	type Drag =
		| { kind: 'chip'; chip: Chip }
		| { kind: 'export'; recording: Recording; ex: ExportInfo; remaining: Platform[] };
	let dragging = $state<Drag | null>(null);
	let over = $state<string | null>(null);
	const cellKey = (day: Date, hour: number, minute: number) =>
		`${day.toDateString()}@${hour}:${minute}`;
	const uid = () => Math.random().toString(36).slice(2, 10);

	function dropTo(day: Date, hour: number, minute: number) {
		const d = dragging;
		dragging = null;
		over = null;
		if (!d) return;
		const when = new Date(day);
		when.setHours(hour, minute, 0, 0);
		if (when.getTime() < Date.now() + 15 * 60_000) {
			toast.error('いまから 15 分以上あとにしてください');
			return;
		}
		if (d.kind === 'export') {
			schedule.pendings = [
				...pendings,
				{ id: uid(), kind: 'place', recording: d.recording, ex: d.ex, remaining: d.remaining, when }
			];
			return;
		}
		const chip = d.chip;
		if (chip.pendingId) {
			// もう動かしてあるもの・置いたもの: 位置だけ変える
			schedule.pendings = pendings.map((p) => (p.id === chip.pendingId ? { ...p, when } : p));
		} else if (chip.items?.length) {
			schedule.pendings = [...pendings, { id: uid(), kind: 'move', items: chip.items, when }];
		}
	}
	/** 未確定の変更を 1 つ戻す（置いたものは一覧へ、動かしたものは元の位置へ）。送っている途中なら取りやめる */
	function undoPending(id: string) {
		void schedule.cancelPending(id);
	}

	/** まとまりの予約を取り消す（ハブの仕事は消す。YouTube は上げた動画を消して記録も外す） */
	async function cancel(group: Item[]) {
		const hubOnes = group.filter((it) => it.post.platform !== 'youtube' && it.post.jobId);
		const ytOnes = group.filter((it) => it.post.platform === 'youtube');
		if (hubOnes.length === 0 && ytOnes.length === 0) return;
		const names = [...ytOnes, ...hubOnes].map((it) => label(it.post.platform)).join('・');
		const ytNote = ytOnes.length
			? '\nYouTube は上げた動画を消します（もう一度予約するときは動画を上げ直します）'
			: '';
		if (!confirm(`${names} の予約を取り消しますか？（すぐにサーバーに伝えます）${ytNote}`)) return;
		let ng = 0;
		for (const it of hubOnes) {
			try {
				const r = await api().publish.hubCancel(it.post.jobId!);
				if (!r.canceled) ng++;
			} catch (err) {
				toast.error((err as Error).message);
				ng++;
			}
		}
		for (const it of ytOnes) {
			try {
				if (it.post.videoId) await api().publish.youtubeDelete(it.post.videoId);
				// 記録を外す（動画が無くなったので「残り」に戻る）
				const rec = library.recordings.find((r) => r.id === it.recording.id);
				if (rec)
					await library.updateRecording(rec.id, {
						posts: (rec.posts ?? []).filter(
							(p) => !(p.at === it.post.at && p.platform === 'youtube')
						)
					});
			} catch (err) {
				toast.error((err as Error).message);
				ng++;
			}
		}
		if (ng)
			toast.error(`${ng} 件は取り消せませんでした（もう取りかかっていたか、許可が足りません）`);
		else toast.show('取り消しました');
		await loadJobs();
	}
	const dayLabel = (d: Date) => {
		const diff = Math.round((d.getTime() - today.getTime()) / 86_400_000);
		return `${d.getMonth() + 1}/${d.getDate()}（${['日', '月', '火', '水', '木', '金', '土'][d.getDay()]}）${diff === 0 ? ' 今日' : diff === 1 ? ' 明日' : ''}`;
	};
	const isToday = (d: Date) => d.toDateString() === today.toDateString();
	const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
	const hhmm = (d: Date) =>
		`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
</script>

<div class="sch">
	<div class="sch__top">
		<h1>投稿管理 <span class="muted">{rangeLabel}</span></h1>
		<div class="sch__tools">
			{#if pendingCount > 0}
				<span class="sch__pending-note">未確定の変更 {pendingCount} 件</span>
				<button
					type="button"
					class="chip"
					onclick={() => (schedule.pendings = [])}
					disabled={!!applying}>やり直す</button
				>
				<button
					type="button"
					class="btn btn--sm btn--green"
					onclick={() => void schedule.applyAll()}
					disabled={!!applying}>{applying ? '送っています…' : `確定する（${pendingCount}）`}</button
				>
			{:else}
				<button type="button" class="chip" onclick={() => void loadJobs()}>更新</button>
			{/if}
			<button type="button" class="chip" onclick={onBack}>閉じる</button>
		</div>
	</div>

	<div class="sch__body">
		{#if applying}
			<div class="card sch__applying">
				{applying}
				{#if schedule.ratio > 0}<span class="muted">{Math.round(schedule.ratio * 100)}%</span>{/if}
				<span class="muted"
					>この画面を閉じても送信は続きます（アプリは終了しないでください）。札の ×
					で取りやめられます</span
				>
			</div>
		{/if}
		<section class="card">
			<h2 class="card__title">
				投稿文が確定していて、日程待ちの動画 <span class="muted">{unscheduled.length} 本</span>
			</h2>
			<p class="muted">
				上の格子の好きな日時へドラッグして置きます（30
				分きざみ）。残っている投稿先がまとめてその日時になります。押すと SNS 投稿の画面へ。
			</p>
			{#if unscheduled.length === 0}
				<p class="muted">ありません。</p>
			{:else}
				<ul class="sch__tray">
					{#each unscheduled as u (u.recording.id + u.ex.id)}
						<li>
							<div
								class="sch__tray-item"
								draggable={!applying}
								role="button"
								tabindex="0"
								ondragstart={(e) => {
									dragging = {
										kind: 'export',
										recording: u.recording,
										ex: u.ex,
										remaining: u.remaining
									};
									e.dataTransfer?.setData('text/plain', u.ex.id);
								}}
								ondragend={() => {
									dragging = null;
									over = null;
								}}
								onclick={() => onOpenPublish(u.recording.id, u.ex.id)}
								onkeydown={(e) => {
									if (e.key === 'Enter') onOpenPublish(u.recording.id, u.ex.id);
								}}
							>
								<span class="sch__grip" aria-hidden="true">⋮⋮</span>
								{#if thumbUrl(u.recording, u.ex.id)}
									<img
										class="sch__tray-thumb"
										src={thumbUrl(u.recording, u.ex.id)}
										alt=""
										draggable="false"
									/>
								{/if}
								<strong>{u.recording.title}</strong>
								<span class="muted">残り: {u.remaining.map(label).join('・')}</span>
								<span class="muted">{formatBytes(u.ex.size)}</span>
							</div>
						</li>
					{/each}
				</ul>
			{/if}
			{#if unconfirmed.length > 0}
				<h3 class="sch__sub">
					投稿文がまだの動画 <span class="muted">{unconfirmed.length} 本</span>
				</h3>
				<ul class="sch__tray">
					{#each unconfirmed as u (u.recording.id + u.ex.id)}
						<li>
							<button
								type="button"
								class="btn btn--sm btn--green"
								onclick={() => onOpenPublish(u.recording.id, u.ex.id)}>SNS投稿で書く</button
							>
							<strong>{u.recording.title}</strong>
							<span class="muted"
								>書き出し {formatDateTime(u.ex.createdAt)}・{formatBytes(u.ex.size)}</span
							>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
		{#if schedule.lastErrors.length > 0}
			<section class="card sch__errors">
				<div class="sch__errors-head">
					<h2 class="card__title">できなかった予約があります</h2>
					<button type="button" class="chip" onclick={() => (schedule.lastErrors = [])}
						>閉じる</button
					>
				</div>
				<ul class="sch__errors-list">
					{#each schedule.lastErrors as e (e)}<li>{e}</li>{/each}
				</ul>
				<p class="muted">
					できなかった投稿先は上の一覧の「残り」に残っています。直してから、もう一度ドラッグして確定してください。
				</p>
			</section>
		{/if}

		<section class="card sch__grid-card">
			<div class="sch__grid-head">
				<p class="muted sch__hint">
					下の動画や予約の札を、好きな日時へドラッグして置きます。置くだけではまだ送りません。右上の「確定する」で、まとめてハブ・YouTube
					へ送ります。点線の札が未確定です。{loading ? 'ハブの予約を読んでいます…' : ''}
				</p>
				<div class="sch__weeks">
					<button
						type="button"
						class="chip"
						onclick={() => (weekOffset = Math.max(0, weekOffset - 1))}
						disabled={weekOffset === 0 || !!applying}>← 前の 2 週</button
					>
					<button
						type="button"
						class="chip"
						onclick={() => (weekOffset = 0)}
						disabled={weekOffset === 0 || !!applying}>今日</button
					>
					<button type="button" class="chip" onclick={() => (weekOffset += 1)} disabled={!!applying}
						>次の 2 週 →</button
					>
				</div>
			</div>
			<div class="sch__scroll">
				<div class="sch__grid" style="--slots: {SLOTS.length}">
					<div class="sch__corner"></div>
					{#each HOURS as h (h)}
						<div class="sch__hour">{h}</div>
					{/each}
					{#each days as d (d.toDateString())}
						<div class="sch__day">
							{dayLabel(d)}
							{#if countOn(d) > 0}<span class="sch__count">{countOn(d)} 件</span>{/if}
						</div>
						{#each SLOTS as { h, m } (`${h}:${m}`)}
							{@const past = d < today || (isToday(d) && h * 60 + m + 30 <= nowMin)}
							<div
								class="sch__cell"
								class:sch__cell--half={m === 30}
								class:sch__cell--past={past}
								class:sch__cell--over={over === cellKey(d, h, m)}
								role="gridcell"
								tabindex="-1"
								ondragover={(e) => {
									if (!dragging || past) return;
									e.preventDefault();
									over = cellKey(d, h, m);
								}}
								ondragleave={() => {
									if (over === cellKey(d, h, m)) over = null;
								}}
								ondrop={(e) => {
									e.preventDefault();
									if (!past) dropTo(d, h, m);
								}}
							>
								{#each chipsAt(d, h, m).slice(0, 1) as c (c.key)}
									<div
										class="sch__item"
										class:sch__item--pending={c.pending}
										class:sch__item--done={c.done}
										class:sch__item--youtube={c.platforms.length === 1 &&
											c.platforms[0] === 'youtube'}
										draggable={!applying && !c.done}
										role="button"
										tabindex="0"
										title="{c.platforms
											.map(label)
											.join('・')} ・ {c.title} ・ {c.when.toLocaleString('ja-JP')}{c.pending
											? '（未確定）'
											: c.done
												? '（投稿済み）'
												: ''}"
										ondragstart={(e) => {
											if (c.done) {
												e.preventDefault();
												return;
											}
											dragging = { kind: 'chip', chip: c };
											e.dataTransfer?.setData('text/plain', c.key);
										}}
										ondragend={() => {
											dragging = null;
											over = null;
										}}
										onclick={() => onOpenPublish(c.recordingId, c.exportId)}
										onkeydown={(e) => {
											if (e.key === 'Enter') onOpenPublish(c.recordingId, c.exportId);
										}}
									>
										{#if c.thumb}
											<img class="sch__thumb" src={c.thumb} alt={c.title} draggable="false" />
										{:else}
											<span class="sch__item-title">{c.title}</span>
										{/if}
										{#if !c.done}
											<button
												type="button"
												class="sch__x"
												title={c.pending ? (applying ? '取りやめる' : '戻す') : '取り消す'}
												aria-label={c.pending ? (applying ? '取りやめる' : '戻す') : '取り消す'}
												onclick={(e) => {
													e.stopPropagation();
													if (c.pendingId) undoPending(c.pendingId);
													else if (c.items) void cancel(c.items);
												}}>×</button
											>
										{/if}
									</div>
								{/each}
								{#if chipsAt(d, h, m).length > 1}
									<span
										class="sch__more"
										title={chipsAt(d, h, m)
											.slice(1)
											.map((c) => `${hhmm(c.when)} ${c.title}`)
											.join('\n')}>+{chipsAt(d, h, m).length - 1}</span
									>
								{/if}
							</div>
						{/each}
					{/each}
				</div>
			</div>
		</section>
	</div>
</div>

<style>
	.sch {
		--yellow: var(--green);
		height: 100vh;
		display: grid;
		grid-template-rows: auto minmax(0, 1fr);
		background: var(--yellow);
		padding: 0 24px 20px;
		gap: 14px;
	}
	.sch__top {
		min-height: var(--titlebar);
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		padding: 8px 0 0 60px;
		-webkit-app-region: drag;
	}
	.sch__top button {
		-webkit-app-region: no-drag;
	}
	.sch__top h1 {
		margin: 0;
		font-size: 20px;
		font-weight: 900;
	}
	.sch__top h1 .muted {
		font-size: 14px;
		font-weight: 700;
		color: #fff;
	}
	.sch__tools,
	.sch__weeks {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.sch__grid-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		flex-wrap: wrap;
	}
	.sch__weeks {
		flex: none;
	}
	.sch__pending-note {
		font-weight: 900;
		font-size: 13px;
		color: #fff;
	}
	.sch__body {
		overflow: auto;
		display: grid;
		gap: 14px;
		align-content: start;
		padding: 0 8px 20px 0;
	}
	.sch__applying {
		font-weight: 900;
		font-size: 14px;
	}
	.sch__grid-card {
		display: grid;
		gap: 8px;
	}
	.sch__errors {
		border-color: var(--alert);
	}
	.sch__errors-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}
	.sch__errors-list {
		margin: 6px 0;
		padding-left: 1.2em;
		font-weight: 700;
	}
	.sch__hint {
		margin: 0;
		font-size: 12.5px;
		flex: 1 1 400px;
	}
	.sch__scroll {
		overflow: auto;
		max-height: 60vh;
	}
	.sch__grid {
		display: grid;
		grid-template-columns: 150px repeat(var(--slots), minmax(34px, 1fr));
		min-width: 950px; /* 12 時間 × 2 枡。枠いっぱいに広がる */
		border: 2px solid var(--ink);
		border-radius: 10px;
		overflow: hidden;
	}
	.sch__hour {
		grid-column: span 2; /* 1 時間の見出しの下に :00 と :30 の 2 枡 */
	}
	.sch__corner,
	.sch__hour {
		background: var(--ink);
		color: var(--green);
		font-size: 11px;
		font-weight: 900;
		text-align: center;
		padding: 4px 0;
		position: sticky;
		top: 0;
		z-index: 2;
	}
	.sch__day {
		position: sticky;
		left: 0;
		z-index: 1;
		height: 64px;
		box-sizing: border-box;
		background: var(--cream);
		border-right: 2px solid var(--ink);
		border-top: 1px solid #e3dcc2;
		padding: 6px 8px;
		font-size: 12.5px;
		font-weight: 900;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.sch__count {
		font-size: 11px;
		font-weight: 700;
		color: #6b6455;
	}
	/* 枡の高さは固定（札があっても表の大きさが変わらない） */
	.sch__cell {
		position: relative;
		height: 64px;
		box-sizing: border-box;
		border-top: 1px solid #e3dcc2;
		border-right: 1px solid #d8d0b4; /* 時間の区切り */
		padding: 3px;
		display: flex;
		align-items: stretch;
		gap: 3px;
		overflow: visible;
	}
	/* 同じ枡にほかにもあるときの「+N」。札の幅を取らないように、枡の右上に重ねる */
	.sch__more {
		position: absolute;
		right: 2px;
		top: 2px;
		z-index: 3;
		font-size: 11px;
		font-weight: 900;
		border: 2px solid var(--ink);
		border-radius: 999px;
		padding: 0 5px;
		background: #fff;
	}
	/* :00 の枡（右隣が :30）。区切りは薄く */
	.sch__cell:not(.sch__cell--half) {
		border-right: 1px dotted #e3dcc2;
	}
	.sch__cell--past {
		background: repeating-linear-gradient(135deg, #f1ecd8 0 6px, #fffdf6 6px 12px);
	}
	.sch__cell--over {
		background: #d9f5e3;
		outline: 2px dashed var(--green);
		outline-offset: -3px;
	}
	/* 札は題名だけ（時刻は小さく）。細かいことはホバーの説明で */
	/* 札はサムネが 16:9 で全部見える幅（枡より広く、隣にかぶってよい）。載せると手前に来る（大きくはしない） */
	.sch__item {
		position: relative;
		z-index: 1;
		flex: none;
		width: 116px;
		display: block;
		padding: 2px;
		border: 2px solid var(--ink);
		border-radius: 8px;
		background: #fff;
		font-size: 11.5px;
		line-height: 1.3;
		cursor: grab;
		overflow: hidden;
	}
	.sch__item:active {
		cursor: grabbing;
	}
	/* 載せると、重なりの手前に来てはっきり見える（縁を黒く、影を付ける。大きさは変えない） */
	.sch__item:hover,
	.sch__item:focus-visible {
		z-index: 6;
		border-color: var(--ink);
		box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3);
	}
	/* 未確定は点線 */
	.sch__item--pending {
		border-style: dashed;
		background: #f2fbf5;
	}
	/* もう出したもの: 縁をグレーに（透けさせない）、動かせない */
	.sch__item--done {
		border-color: #9a9483;
		cursor: default;
	}
	.sch__thumb {
		display: block;
		width: 100%;
		aspect-ratio: 16 / 9;
		object-fit: cover;
		border-radius: 5px;
		pointer-events: none;
	}
	/* 題名は 2 行まで（サムネが無いとき） */
	.sch__item-title {
		padding: 1px 12px 1px 4px;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
		font-weight: 700;
	}
	.sch__x {
		position: absolute;
		top: 1px;
		right: 1px;
		width: 13px;
		height: 13px;
		border: 0;
		border-radius: 50%;
		background: var(--ink);
		color: #fff;
		font-size: 10px;
		line-height: 1;
		cursor: pointer;
		padding: 0;
	}
	.sch__tray {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 8px;
	}
	.sch__tray li {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		font-size: 13.5px;
	}
	.sch__tray-item {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		border: 2px solid var(--ink);
		border-radius: 12px;
		padding: 8px 12px;
		background: #fff;
		cursor: grab;
	}
	.sch__tray-item:active {
		cursor: grabbing;
	}
	.sch__tray-thumb {
		width: 80px;
		height: 45px;
		object-fit: cover;
		border: 2px solid var(--ink);
		border-radius: 6px;
	}
	.sch__grip {
		color: #9a927c;
		letter-spacing: -2px;
	}
	.sch__sub {
		margin: 8px 0 0;
		font-size: 14px;
	}
</style>
