import type { StorageInfo } from '$shared/types';
import { api } from '$lib/api';

/** 保存先フォルダーと容量。ヘッダーと設定画面が見る */
class StorageStore {
	info = $state<StorageInfo | null>(null);
	error = $state<string | null>(null);

	async refresh(): Promise<void> {
		try {
			this.info = await api().storage.info();
			this.error = null;
		} catch (err) {
			this.error = (err as Error).message ?? '保存先を確認できませんでした。';
		}
	}

	async chooseFolder(): Promise<string | null> {
		const chosen = await api().settings.chooseLibraryFolder();
		if (chosen) await this.refresh();
		return chosen;
	}
}

export const storage = new StorageStore();
