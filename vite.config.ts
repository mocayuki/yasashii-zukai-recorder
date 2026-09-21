import { defineConfig } from 'vitest/config';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import path from 'node:path';

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			// Electron が app:// で読み込む静的ファイルを build/ に出す。
			// 画面内の遷移はすべて index.html に戻す（SPA）。
			adapter: adapter({ fallback: 'index.html' }),
			alias: { $shared: path.resolve('shared') },
			// 画面の起動スクリプトはインラインなので、ハッシュ付きの CSP を SvelteKit に作らせる。
			// app:// は画面自身、media:// は保存先フォルダーの収録ファイル（main.ts 参照）。
			csp: {
				mode: 'hash',
				directives: {
					'default-src': ['self'],
					'script-src': ['self'],
					'style-src': ['self', 'unsafe-inline'],
					'font-src': ['self', 'data:'],
					// media: はノードの画像（保存先の images/）
					'img-src': ['self', 'data:', 'blob:', 'media:' as 'blob:'],
					'media-src': ['self', 'blob:', 'media:' as 'blob:'],
					'connect-src': [
						'self',
						'blob:',
						'media:' as 'blob:',
						'ws://localhost:5173',
						'http://localhost:5173'
					]
				}
			}
		})
	],
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'unit',
					environment: 'node',
					include: [
						'src/**/*.{test,spec}.{js,ts}',
						'electron/**/*.{test,spec}.{js,ts}',
						'shared/**/*.{test,spec}.{js,ts}',
						'hub/src/**/*.{test,spec}.{js,ts}'
					],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}', 'legacy/**', '**/node_modules/**']
				}
			}
		]
	}
});
