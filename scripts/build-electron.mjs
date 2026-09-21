// Electron のメインプロセスと preload を esbuild でまとめる。
// `--watch` を付けると変更のたびに作り直す（開発時）。
import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const common = {
	bundle: true,
	platform: 'node',
	target: 'node22',
	format: 'cjs',
	sourcemap: true,
	// ffmpeg-static は実行ファイルの場所を返すだけの小さなモジュール。同梱の道を保つため bundle しない
	external: ['electron', 'ffmpeg-static'],
	logLevel: 'info'
};

const targets = [
	{ ...common, entryPoints: ['electron/main.ts'], outfile: 'dist-electron/main.cjs' },
	{ ...common, entryPoints: ['electron/preload.ts'], outfile: 'dist-electron/preload.cjs' }
];

if (watch) {
	for (const t of targets) {
		const ctx = await context(t);
		await ctx.watch();
	}
} else {
	await Promise.all(targets.map((t) => build(t)));
}
