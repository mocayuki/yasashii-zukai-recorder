/**
 * 「いま送信中」の目印。SNS への送信（動画のアップロード・予約の登録）が走っている間、
 * userData/busy.json を書いておく。配置スクリプト（scripts/dev/deploy-app.sh）はこれを見て、
 * 送信中にアプリを開き直さない。終わったら消す。落ちて残っても 15 分で無視される
 */
import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const running = new Map<string, number>();

function file(): string {
	return path.join(app.getPath('userData'), 'busy.json');
}

async function write(): Promise<void> {
	try {
		if (running.size === 0) await fs.rm(file(), { force: true });
		else
			await fs.writeFile(
				file(),
				JSON.stringify({ at: Date.now(), what: [...running.keys()] }),
				'utf8'
			);
	} catch {
		/* 目印が書けなくても送信は続ける */
	}
}

/** いま SNS へ送っている最中か（終了の確認に使う） */
export function hasRunningPublishes(): boolean {
	return running.size > 0;
}

export async function withBusy<T>(what: string, fn: () => Promise<T>): Promise<T> {
	const key = `${what}:${Date.now()}`;
	running.set(key, Date.now());
	await write();
	// 長いアップロードの間も目印を新しくしておく（見張りは新しさで判断する）
	const timer = setInterval(() => void write(), 60_000);
	try {
		return await fn();
	} finally {
		clearInterval(timer);
		running.delete(key);
		await write();
	}
}
