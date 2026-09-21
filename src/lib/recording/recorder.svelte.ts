import type { Marker, Recording } from '$shared/types';
import { makeId } from '$shared/notes';
import { api } from '$lib/api';
import { buildVoiceChain, type VoiceChain } from './voice-chain';

/**
 * ワークスペースの黄色い枠の中を、1920×1080 の動画として録る。
 *
 * 1. getDisplayMedia で自分の画面の中身をもらう（Electron 側が自分のフレームを渡す）
 * 2. その映像から枠の部分だけを canvas に描き写す（30fps）
 * 3. マイクの音声（声だけ。BGM は書き出しのときに重ねる）と canvas の映像を MediaRecorder に入れる
 * 4. 1 秒ごとにファイルへ追記する
 *
 * メモリーに全量はためない。音声の波形（1 秒に 20 個）は録りながら計算する。
 * エコー除去・雑音除去・自動音量は切る（声を押さえたり歪めたりしないように。BGM は鳴らさないのでエコーも無い）。
 */

export type RecorderStatus = 'idle' | 'starting' | 'recording' | 'stopping';

export interface RecorderOptions {
	noteId: string;
	title: string;
	/** 黄色い枠の要素（この範囲だけが動画になる） */
	frameEl: HTMLElement;
	/** 使うマイク（null = OS の既定） */
	micDeviceId: string | null;
	/** マイクの音量の倍率（1 = そのまま） */
	micGain: number;
	/** 声を整える（コンプレッサー） */
	micCompressor: boolean;
	/** 動画の大きさ（横 1920×1080、縦 1080×1920）。省くと横 */
	width?: number;
	height?: number;
}

export const OUTPUT_W = 1920;
export const OUTPUT_H = 1080;
const FPS = 30;
const PEAKS_PER_SECOND = 20;
const VIDEO_BPS = 8_000_000;

const MIME_CANDIDATES = [
	'video/webm;codecs=vp9,opus',
	'video/webm;codecs=vp8,opus',
	'video/webm;codecs=h264,opus',
	'video/webm'
];

function pickMime(): string | null {
	if (typeof MediaRecorder === 'undefined') return null;
	for (const m of MIME_CANDIDATES) if (MediaRecorder.isTypeSupported(m)) return m;
	return null;
}

export function describeMicError(err: unknown): string {
	const name = (err as { name?: string })?.name ?? '';
	switch (name) {
		case 'NotAllowedError':
		case 'PermissionDeniedError':
			return 'マイクの使用が許可されていません。システム設定 → プライバシーとセキュリティ → マイク で、このアプリを許可してください。';
		case 'NotFoundError':
		case 'OverconstrainedError':
			return '選んだマイクが見つかりません。「音の設定」でマイクを選び直してください。';
		case 'NotReadableError':
			return 'マイクを使えませんでした。ほかのアプリがマイクを使っていないか確認してください。';
		default:
			return `マイクを使えませんでした。${(err as Error)?.message ?? ''}`;
	}
}

class RecorderStore {
	status = $state<RecorderStatus>('idle');
	elapsedMs = $state(0);
	level = $state(0);
	error = $state<string | null>(null);
	/** いま録っている収録の id */
	activeId = $state<string | null>(null);
	/** 録りながら付いたしるし */
	markers = $state<Marker[]>([]);
	/** 収録中、声がまったく入っていないと思われるとき true（無音の警告用） */
	silent = $state(false);

	#recorder: MediaRecorder | null = null;
	#streams: MediaStream[] = [];
	#audioCtx: AudioContext | null = null;
	#chain: VoiceChain | null = null;
	#timers: number[] = [];
	#cleanups: (() => void)[] = [];
	#startedAt = 0;
	#peaks: number[] = [];
	#chunkQueue: Promise<void> = Promise.resolve();
	#finished: ((rec: Recording | null) => void) | null = null;

	async start(opts: RecorderOptions): Promise<void> {
		if (this.status !== 'idle') return;
		this.error = null;
		this.silent = false;
		this.status = 'starting';
		const mime = pickMime();
		if (!mime) {
			this.error = 'この環境では動画の収録形式（webm）が使えません。';
			this.status = 'idle';
			return;
		}

		// ---- マイク ----
		let mic: MediaStream;
		try {
			mic = await navigator.mediaDevices.getUserMedia({
				audio: {
					...(opts.micDeviceId ? { deviceId: { exact: opts.micDeviceId } } : {}),
					echoCancellation: false,
					noiseSuppression: false,
					autoGainControl: false
				}
			});
		} catch (err) {
			this.error = describeMicError(err);
			this.status = 'idle';
			return;
		}
		this.#streams.push(mic);

		// ---- 画面（自分の中身） ----
		let screen: MediaStream;
		try {
			screen = await navigator.mediaDevices.getDisplayMedia({
				video: { frameRate: FPS },
				audio: false
			});
		} catch (err) {
			this.#release();
			this.error = `画面を取り込めませんでした。${(err as Error)?.message ?? ''}`;
			this.status = 'idle';
			return;
		}
		this.#streams.push(screen);

		// 取り込んだ映像を <video> で受け、枠の部分だけ canvas に描き写す
		const source = document.createElement('video');
		source.srcObject = screen;
		source.muted = true;
		await source.play();
		const outW = opts.width ?? OUTPUT_W;
		const outH = opts.height ?? OUTPUT_H;
		const canvas = document.createElement('canvas');
		canvas.width = outW;
		canvas.height = outH;
		const ctx = canvas.getContext('2d', { alpha: false })!;
		// 枠の線の内側だけを切り出す（線や外の色が動画の縁に映らないように）
		const cs = getComputedStyle(opts.frameEl);
		const bl = parseFloat(cs.borderLeftWidth) || 0;
		const bt = parseFloat(cs.borderTopWidth) || 0;
		const br = parseFloat(cs.borderRightWidth) || 0;
		const bb = parseFloat(cs.borderBottomWidth) || 0;
		// 取り込んだ映像は窓の中身を（縦横同じ比で）拡大したもので、拡大率は窓の大きさを変えるたびに変わる
		// （画素密度どおりとは限らない。3 倍の画面で 4 倍や 2.88 倍になることを確認済み）。
		// 窓の大きさを変えている最中は古い大きさの映像や途中の映像が届き、そのまま切り出すと枠の外
		// （水色やボタン）が映る。なので、大きさを変えてから落ち着くまでと、映像の縦横比が窓と合わない間は
		// 描かず、直前のコマを保つ（動画は止まるだけで乱れない）。縦横比が長く合わないとき（想定外）は描いて止まらないようにする
		let resizedAt = 0;
		const onResize = () => (resizedAt = performance.now());
		window.addEventListener('resize', onResize);
		this.#cleanups.push(() => window.removeEventListener('resize', onResize));
		let mismatchSince = 0;
		// 枠の位置や大きさが変わった直後も、取り込んだ映像が追いつくまで直前のコマを保つ
		let lastRect = '';
		let rectChangedAt = 0;
		let drawn = false;
		const draw = () => {
			const vw = source.videoWidth;
			const vh = source.videoHeight;
			if (!vw || !vh) return;
			const now = performance.now();
			const r = opts.frameEl.getBoundingClientRect();
			const rectKey = [r.left, r.top, r.width, r.height].map((v) => Math.round(v * 2)).join(',');
			if (rectKey !== lastRect) {
				if (lastRect !== '') rectChangedAt = now;
				lastRect = rectKey;
			}
			// 最初の 1 コマは必ず描く（黒いまま録り始めないように）。それ以降は落ち着くまで待つ
			if (drawn && now - rectChangedAt < 250) return;
			const settled = now - resizedAt > 400;
			const winAspect = window.innerWidth / window.innerHeight;
			const aspectOk = Math.abs(vw / vh - winAspect) <= winAspect * 0.01;
			if (drawn && !settled) return;
			if (!aspectOk) {
				if (mismatchSince === 0) mismatchSince = now;
				if (now - mismatchSince < 1500) return;
			} else {
				mismatchSince = 0;
			}
			const scale = vw / window.innerWidth;
			// 動作確認用: 直近の切り出しの値を見られるようにしておく
			(window as unknown as { __recDebug?: unknown }).__recDebug = {
				vw,
				vh,
				innerW: window.innerWidth,
				innerH: window.innerHeight,
				scale,
				left: r.left,
				top: r.top,
				width: r.width,
				height: r.height,
				settled,
				aspectOk,
				t: Math.round(now)
			};
			// 枠の線の内側から、さらに数 px 内側を切り出す（1〜2px のずれで線や外の色が映らないように。削れるのは黄色の余白だけ）
			const inset = 3;
			const x = (r.left + bl + inset) * scale;
			const y = (r.top + bt + inset) * scale;
			const w = (r.width - bl - br - inset * 2) * scale;
			const h = (r.height - bt - bb - inset * 2) * scale;
			ctx.drawImage(source, x, y, w, h, 0, 0, outW, outH);
			drawn = true;
		};
		draw();
		this.#timers.push(window.setInterval(draw, 1000 / FPS));
		const canvasStream = canvas.captureStream(FPS);

		// ---- 音声: マイクの声だけ。音量の倍率をかけてから録り、同じ音で波形とメーターを出す ----
		let audioTrack: MediaStreamTrack = mic.getAudioTracks()[0];
		try {
			const ac = new AudioContext();
			this.#audioCtx = ac;
			if (ac.state === 'suspended') await ac.resume().catch(() => {});
			const micSrc = ac.createMediaStreamSource(mic);
			const chain = buildVoiceChain(ac, micSrc, {
				gain: opts.micGain,
				compressor: opts.micCompressor
			});
			this.#chain = chain;
			const dest = ac.createMediaStreamDestination();
			const analyser = ac.createAnalyser();
			analyser.fftSize = 2048;
			chain.output.connect(dest); // 録る音（スピーカーへは返さない）
			chain.output.connect(analyser);
			audioTrack = dest.stream.getAudioTracks()[0];
			const buf = new Uint8Array(analyser.fftSize);
			let quietTicks = 0;
			this.#timers.push(
				window.setInterval(() => {
					analyser.getByteTimeDomainData(buf);
					let peak = 0;
					for (let i = 0; i < buf.length; i++) {
						const v = Math.abs((buf[i] - 128) / 128);
						if (v > peak) peak = v;
					}
					this.#peaks.push(Math.round(peak * 1000) / 1000);
					this.level = Math.min(1, peak * 1.6);
					// 3 秒以上ほぼ無音なら警告を出す（ミュートや装置違いに気づけるように）
					quietTicks = peak < 0.01 ? quietTicks + 1 : 0;
					this.silent = quietTicks > PEAKS_PER_SECOND * 3;
				}, 1000 / PEAKS_PER_SECOND)
			);
		} catch {
			/* 音量の倍率と波形は補助なので、失敗してもマイクの音をそのまま録る */
		}

		const id = makeId();
		const mixed = new MediaStream([...canvasStream.getVideoTracks(), audioTrack]);
		let recorder: MediaRecorder;
		try {
			recorder = new MediaRecorder(mixed, { mimeType: mime, videoBitsPerSecond: VIDEO_BPS });
		} catch (err) {
			this.#release();
			this.error = `収録を始められませんでした。${(err as Error)?.message ?? ''}`;
			this.status = 'idle';
			return;
		}

		try {
			await api().recordings.begin({
				id,
				noteId: opts.noteId,
				title: opts.title,
				kind: 'stage',
				mimeType: mime,
				fileName: `${id}.webm`,
				hasVideo: true,
				hasMic: true,
				width: outW,
				height: outH
			});
		} catch (err) {
			this.#release();
			this.error = `保存先に書き込めませんでした。${(err as Error)?.message ?? ''}`;
			this.status = 'idle';
			return;
		}

		this.#peaks = [];
		this.markers = [];
		this.activeId = id;
		this.#recorder = recorder;

		recorder.ondataavailable = (ev: BlobEvent) => {
			if (!ev.data || ev.data.size === 0) return;
			// 順番どおりに追記する。失敗はまとめて記録する
			this.#chunkQueue = this.#chunkQueue
				.then(async () => {
					const buf = await ev.data.arrayBuffer();
					await api().recordings.append(id, buf);
				})
				.catch((err: Error) => {
					this.error = `書き込みに失敗しました。${err.message}`;
				});
		};
		recorder.onerror = (ev) => {
			const e = (ev as unknown as { error?: Error }).error;
			this.error = `収録中にエラーが起きました。${e?.message ?? ''}`;
		};
		recorder.onstop = () => {
			void this.#finalize(id);
		};

		// 画面の取り込みが外から止められた場合は、そこまでで終える
		screen.getVideoTracks().forEach((t) => t.addEventListener('ended', () => void this.stop()));

		recorder.start(1000);
		this.#startedAt = performance.now();
		this.elapsedMs = 0;
		this.#timers.push(
			window.setInterval(() => {
				this.elapsedMs = performance.now() - this.#startedAt;
			}, 200)
		);
		this.status = 'recording';
	}

	/** 収録中でもマイクの音量の倍率を変えられる */
	setGain(v: number): void {
		this.#chain?.setGain(v);
	}

	/** 収録中でも「声を整える」を切り替えられる */
	setCompressor(on: boolean): void {
		this.#chain?.setCompressor(on);
	}

	/** 録りながら、今の時刻にしるしを付ける（ノードを選んだときなど） */
	mark(text: string): void {
		if (this.status !== 'recording') return;
		const atMs = Math.round(performance.now() - this.#startedAt);
		const last = this.markers[this.markers.length - 1];
		if (last && last.text === text && atMs - last.atMs < 500) return;
		this.markers.push({ id: makeId(), atMs, text, createdAt: Date.now() });
	}

	/** 収録を止める。終了処理まで終わったら、その収録を返す */
	stop(): Promise<Recording | null> {
		if (this.status !== 'recording' || !this.#recorder) return Promise.resolve(null);
		this.status = 'stopping';
		return new Promise((resolve) => {
			this.#finished = resolve;
			try {
				this.#recorder!.stop();
			} catch {
				void this.#finalize(this.activeId!);
			}
		});
	}

	async #finalize(id: string): Promise<void> {
		const durationMs = Math.round(performance.now() - this.#startedAt);
		this.#release();
		let result: Recording | null = null;
		try {
			await this.#chunkQueue; // 残りの追記を待つ
			result = await api().recordings.finish(id, {
				durationMs,
				markers: JSON.parse(JSON.stringify(this.markers)) as Marker[],
				peaks: this.#peaks,
				peaksPerSecond: PEAKS_PER_SECOND
			});
		} catch (err) {
			this.error = `終了処理に失敗しました。${(err as Error)?.message ?? ''}`;
		}
		this.#recorder = null;
		this.activeId = null;
		this.status = 'idle';
		this.elapsedMs = durationMs;
		this.silent = false;
		const done = this.#finished;
		this.#finished = null;
		done?.(result);
	}

	#release(): void {
		for (const t of this.#timers) window.clearInterval(t);
		this.#timers = [];
		for (const c of this.#cleanups) c();
		this.#cleanups = [];
		for (const s of this.#streams) s.getTracks().forEach((t) => t.stop());
		this.#streams = [];
		if (this.#audioCtx) {
			void this.#audioCtx.close().catch(() => {});
			this.#audioCtx = null;
		}
		this.#chain = null;
		this.level = 0;
	}
}

export const recorder = new RecorderStore();
