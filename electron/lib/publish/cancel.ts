/**
 * 送信（YouTube・ハブへのアップロード）の取りやめ。
 * 画面から publish:cancel で仕事の id を受け取り、送っている側は区切り（8MB の塊・48MB の片・段階の境）ごとに
 * 見て、取りやめられていれば CANCELLED を投げる。YouTube は上げ終わる前なら動画は作られない
 */
const canceled = new Set<string>();

export const CANCELLED = 'cancelled';

export function cancelJob(id: string): void {
	canceled.add(id);
}
/** 送り始めるときに前回の取りやめを消す */
export function beginJob(id: string): void {
	canceled.delete(id);
}
export function isCanceled(id: string): boolean {
	return canceled.has(id);
}
export function throwIfCanceled(id: string): void {
	if (canceled.has(id)) throw new Error(CANCELLED);
}
