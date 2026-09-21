import type { ExportOptions, Recording } from '../../shared/types';
import { keptSegments } from '../../shared/cuts';
import { cuesForExport, splitLongCue, telopSpec, toAss, toSrt } from '../../shared/cues';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { getTranscript } from './transcripts';
import { bgmFilePath } from './bgm';
import { mediaFilePath } from './library';
import { runFfmpeg } from './ffmpeg';

/**
 * mp4 の書き出し。
 * - カット（消す範囲）を外し、残す区間をつなぐ（trim / concat）
 * - BGM を指定の音量で重ねる。声が入っている間は BGM を下げる（sidechaincompress）
 * - 映像は H.264（まず Mac のハードウェア、だめなら libx264）、音声は AAC、1920×1080 / 30fps
 * 元の webm は変えない。
 */

const running = new Map<string, AbortController>();

/** 進行中の書き出しがあるか（終了の確認に使う） */
export function hasRunningExports(): boolean {
	return running.size > 0;
}

export function cancelExport(id: string): void {
	running.get(id)?.abort();
}

export async function exportMp4(
	rec: Recording,
	opts: ExportOptions,
	dest: string,
	onProgress: (ratio: number) => void
): Promise<void> {
	const src = await mediaFilePath(rec);
	const bgm = opts.bgmFile ? await bgmFilePath(opts.bgmFile) : null;
	if (opts.bgmFile && !bgm) throw new Error(`BGM「${opts.bgmFile}」が見つかりません。`);
	let segs = keptSegments(rec.cuts ?? [], rec.durationMs);
	if (segs.length === 0) throw new Error('残す部分がありません。カットを減らしてください。');
	// 試し書き出し: 残す区間を先頭から limitMs 分だけにする（BGM の調整などを短い動画で確かめるため）
	if (opts.limitMs && opts.limitMs > 0) {
		let left = opts.limitMs;
		const clipped: typeof segs = [];
		for (const s of segs) {
			if (left <= 0) break;
			const len = s.endMs - s.startMs;
			clipped.push(len <= left ? s : { startMs: s.startMs, endMs: s.startMs + left });
			left -= len;
		}
		segs = clipped;
	}
	const totalMs = segs.reduce((s, x) => s + (x.endMs - x.startMs), 0);
	// テロップ: カットを外した時刻に直してから、焼き込み用の ASS と、並べて置く SRT を作る
	let ass: string | null = null;
	const transcript = opts.burnTelop || opts.writeSrt ? await getTranscript(rec.id) : null;
	// 長いテロップが残っていれば（手で書いたものなど）、ここでも「、」で分けて出す。上限は動画の向きで変わる
	const spec = telopSpec(rec.width ?? 1920, rec.height ?? 1080);
	const exportedCues = transcript
		? cuesForExport(transcript.cues, rec.cuts ?? [], rec.durationMs)
				.filter((c) => c.startMs < totalMs)
				.flatMap((c) => splitLongCue(c, spec.maxChars, () => randomUUID()))
		: [];
	if (transcript && exportedCues.length > 0) {
		if (opts.burnTelop) {
			const tmpDir = path.join(app.getPath('temp'), 'yasashii-zukai-recorder');
			await fs.mkdir(tmpDir, { recursive: true });
			ass = path.join(tmpDir, `${rec.id}.ass`);
			await fs.writeFile(
				ass,
				toAss(exportedCues, {
					width: spec.width,
					height: spec.height,
					fontSize: spec.fontSize,
					margin: spec.margin,
					marginBottom: spec.marginBottom
				}),
				'utf8'
			);
		}
		if (opts.writeSrt) {
			await fs.writeFile(dest.replace(/\.mp4$/i, '') + '.srt', toSrt(exportedCues), 'utf8');
		}
	}
	const ac = new AbortController();
	running.set(rec.id, ac);
	try {
		const args = buildArgs(src, bgm, segs, totalMs, opts, dest, 'h264_videotoolbox', ass);
		try {
			await runFfmpeg(args, { totalMs, onProgress, signal: ac.signal });
		} catch (err) {
			if ((err as Error).message === 'cancelled') throw err;
			// ハードウェアの H.264 が使えない環境ではソフトウェアでやり直す
			const fallback = buildArgs(src, bgm, segs, totalMs, opts, dest, 'libx264', ass);
			await runFfmpeg(fallback, { totalMs, onProgress, signal: ac.signal });
		}
	} finally {
		running.delete(rec.id);
		if (ass) await fs.rm(ass, { force: true }).catch(() => {});
	}
}

/** 同梱の書体のフォルダー（配布版は Resources/fonts、開発時は resources/fonts） */
export function fontsDir(): string {
	return app.isPackaged
		? path.join(process.resourcesPath, 'fonts')
		: path.join(app.getAppPath(), 'resources', 'fonts');
}

/** ffmpeg のフィルターに書くファイルの道（: \\ ' を逃がす） */
function filterPath(p: string): string {
	return p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function sec(ms: number): string {
	return (ms / 1000).toFixed(3);
}

export function buildArgs(
	src: string,
	bgm: string | null,
	segs: { startMs: number; endMs: number }[],
	totalMs: number,
	opts: ExportOptions,
	dest: string,
	vcodec: 'h264_videotoolbox' | 'libx264',
	ass: string | null = null
): string[] {
	const parts: string[] = [];
	// 残す区間を切り出してつなぐ
	segs.forEach((s, i) => {
		parts.push(`[0:v]trim=start=${sec(s.startMs)}:end=${sec(s.endMs)},setpts=PTS-STARTPTS[v${i}]`);
		parts.push(
			`[0:a]atrim=start=${sec(s.startMs)}:end=${sec(s.endMs)},asetpts=PTS-STARTPTS[a${i}]`
		);
	});
	const inputs = segs.map((_, i) => `[v${i}][a${i}]`).join('');
	parts.push(`${inputs}concat=n=${segs.length}:v=1:a=1[vc][ac]`);
	// テロップの焼き込み。書体は同梱の Zen Maru Gothic Black（fontsdir で渡す）
	const telop = ass ? `,subtitles='${filterPath(ass)}':fontsdir='${filterPath(fontsDir())}'` : '';
	parts.push(`[vc]fps=30,format=yuv420p${telop}[vout]`);
	// ノイズを抑える: 低い唸り（150Hz 以下に集まっていた）をハイパスで落とし、afftdn で定常ノイズを引く。
	// 声（女性の基本周波数は 180Hz 以上）は残る。loudnorm の前にかける（後だと持ち上がったノイズを引くことになる）
	const denoise =
		opts.noiseReduction === 'strong'
			? 'highpass=f=120,afftdn=nf=-40:nt=w:tn=1,'
			: opts.noiseReduction === 'light'
				? 'highpass=f=90,afftdn=nf=-30:nt=w:tn=1,'
				: '';
	// 声を 48kHz ステレオにそろえ、大きさを YouTube 向けの標準（-16 LUFS、ピーク -1.5 dB）にそろえる
	parts.push(
		`[ac]aformat=sample_rates=48000:channel_layouts=stereo,${denoise}loudnorm=I=-16:TP=-1.5:LRA=11,aformat=sample_rates=48000:channel_layouts=stereo[voice]`
	);

	if (bgm) {
		const vol = Math.max(0, Math.min(1, opts.bgmVolume));
		const fadeStart = Math.max(0, totalMs / 1000 - 2);
		parts.push(
			`[1:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${vol.toFixed(3)},afade=t=in:st=0:d=1,afade=t=out:st=${fadeStart.toFixed(3)}:d=2[bgm]`
		);
		if (opts.duck) {
			// 声（sidechain）が鳴っている間、BGM を下げる。
			// 声は loudnorm で -16 LUFS（話している間の実効値はおよそ -20 dBFS）にそろえてあるので、
			// しきい値 -45 dB からの超過 25 dB に対して、指定の割合（duckLevel）まで下がる比率を決める
			const level = Math.max(0.02, Math.min(1, opts.duckLevel ?? 0.3));
			const reductionDb = -20 * Math.log10(level); // 0.3 → 10.5 dB
			const over = 25;
			const ratio = Math.min(20, Math.max(1.01, over / Math.max(0.5, over - reductionDb)));
			parts.push(`[voice]asplit=2[voice1][sc]`);
			parts.push(
				`[bgm][sc]sidechaincompress=threshold=${Math.pow(10, -45 / 20).toFixed(5)}:ratio=${ratio.toFixed(2)}:attack=60:release=700:makeup=1[bgmd]`
			);
			parts.push(
				`[voice1][bgmd]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`
			);
		} else {
			parts.push(`[voice][bgm]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`);
		}
	} else {
		parts.push(`[voice]anull[aout]`);
	}

	const video =
		vcodec === 'h264_videotoolbox'
			? ['-c:v', 'h264_videotoolbox', '-b:v', '8M', '-profile:v', 'high']
			: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20'];

	return [
		'-i',
		src,
		...(bgm ? ['-stream_loop', '-1', '-i', bgm] : []),
		'-filter_complex',
		parts.join(';'),
		'-map',
		'[vout]',
		'-map',
		'[aout]',
		...video,
		'-r',
		'30',
		'-c:a',
		'aac',
		'-b:a',
		'192k',
		'-ar',
		'48000',
		'-movflags',
		'+faststart',
		'-t',
		sec(totalMs),
		dest
	];
}
