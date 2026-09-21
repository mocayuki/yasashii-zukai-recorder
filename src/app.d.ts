import type { Api } from '$shared/types';

declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}

	interface Window {
		/** preload.ts が公開するアプリの殻との橋渡し */
		api?: Api;
	}
}

export {};
