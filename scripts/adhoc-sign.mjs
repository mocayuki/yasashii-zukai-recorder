// 作った .app に仮の署名（ad-hoc）を付ける。
// 署名が無いと macOS はアプリの身元を覚えられず、マイクの許可を起動のたびに聞いてくる。
// ad-hoc 署名なら、同じビルドの間は 1 回の許可で済む（作り直すと 1 回だけ聞き直される）。
// Apple の開発者アカウントは要らない。
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';

const dir = 'release/mac';
const apps = readdirSync(dir).filter((f) => f.endsWith('.app'));
for (const app of apps) {
	const p = path.join(dir, app);
	execFileSync('codesign', ['--force', '--deep', '--sign', '-', p], { stdio: 'inherit' });
	execFileSync('codesign', ['--verify', '--deep', '--strict', p], { stdio: 'inherit' });
	console.log(`ad-hoc 署名を付けました: ${p}`);
}
