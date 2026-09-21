import type { Settings } from '$shared/types';
import { api } from '$lib/api';

/** アプリの設定（保存先、マイク、スピーカー、BGM）。Electron 側の settings.json に保存する */
class SettingsStore {
	value = $state<Settings | null>(null);

	async load(): Promise<Settings> {
		this.value = await api().settings.get();
		return this.value;
	}

	async save(patch: Partial<Settings>): Promise<void> {
		this.value = await api().settings.save(patch);
	}
}

export const settings = new SettingsStore();
