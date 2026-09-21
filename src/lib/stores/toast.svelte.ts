export interface ToastMessage {
	id: number;
	text: string;
	kind: 'ok' | 'error';
}

/** 画面下の短い通知。エラーは長めに残す */
class ToastStore {
	current = $state<ToastMessage | null>(null);
	#timer: ReturnType<typeof setTimeout> | null = null;

	show(text: string, kind: 'ok' | 'error' = 'ok'): void {
		if (this.#timer) clearTimeout(this.#timer);
		this.current = { id: Date.now(), text, kind };
		this.#timer = setTimeout(() => (this.current = null), kind === 'error' ? 8000 : 3500);
	}

	error(text: string): void {
		this.show(text, 'error');
	}

	close(): void {
		if (this.#timer) clearTimeout(this.#timer);
		this.current = null;
	}
}

export const toast = new ToastStore();
