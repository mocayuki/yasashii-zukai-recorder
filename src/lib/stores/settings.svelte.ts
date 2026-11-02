import type { SecretName, SecretStatus, Settings } from '$shared/types';
import { api } from '$lib/api';

/**
 * アプリの設定（保存先、マイク、スピーカー、BGM）。Electron 側の settings.json に保存する。
 * 鍵・合言葉（OpenAI の API キーなど）は settings.json には無く Mac のキーチェーンにある。画面には有る／無いだけが来る
 */
class SettingsStore {
	value = $state<Settings | null>(null);
	/** 鍵・合言葉が入っているか（中身は画面に来ない） */
	secrets = $state<SecretStatus | null>(null);

	async load(): Promise<Settings> {
		const [value, secrets] = await Promise.all([api().settings.get(), api().settings.secrets()]);
		this.value = value;
		this.secrets = secrets;
		return value;
	}

	async save(patch: Partial<Settings>): Promise<void> {
		this.value = await api().settings.save(patch);
	}

	/** 鍵・合言葉をキーチェーンに置く（null か空で消す） */
	async setSecret(name: SecretName, value: string | null): Promise<void> {
		this.secrets = await api().settings.setSecret(name, value);
	}
}

export const settings = new SettingsStore();
