/**
 * 数値をなめらかに目標へ寄せる（カメラの位置・倍率、ノードの位置に使う）。
 * 毎フレーム「残りの距離の一定割合」だけ進むので、動き出しも止まり方もやわらかい。
 */
export class Motion {
	#targets = new Map<string, number>();
	#values = new Map<string, number>();
	#raf: number | null = null;
	#last = 0;
	#tau: number;
	#onFrame: (values: ReadonlyMap<string, number>) => void;

	/** tau は「残り 63% を詰めるのにかかる秒数」。小さいほど速い */
	constructor(tau: number, onFrame: (values: ReadonlyMap<string, number>) => void) {
		this.#tau = tau;
		this.#onFrame = onFrame;
	}

	/** 目標を設定する。immediate なら今の値も一気にそこへ */
	set(key: string, target: number, immediate = false): void {
		this.#targets.set(key, target);
		if (immediate || !this.#values.has(key)) this.#values.set(key, target);
		this.#start();
	}

	/** 今の値を強制する（動き始めの位置を決めたいとき） */
	jump(key: string, value: number): void {
		this.#values.set(key, value);
		if (!this.#targets.has(key)) this.#targets.set(key, value);
		this.#start();
	}

	target(key: string): number | undefined {
		return this.#targets.get(key);
	}

	value(key: string): number | undefined {
		return this.#values.get(key);
	}

	remove(key: string): void {
		this.#targets.delete(key);
		this.#values.delete(key);
	}

	stop(): void {
		if (this.#raf !== null) cancelAnimationFrame(this.#raf);
		this.#raf = null;
	}

	#start(): void {
		if (this.#raf !== null) return;
		this.#last = performance.now();
		this.#raf = requestAnimationFrame(this.#tick);
	}

	#tick = (now: number): void => {
		const dt = Math.min(0.05, Math.max(0.001, (now - this.#last) / 1000));
		this.#last = now;
		const k = 1 - Math.exp(-dt / this.#tau);
		let active = false;
		for (const [key, t] of this.#targets) {
			const v = this.#values.get(key) ?? t;
			const d = t - v;
			// 止まる直前の「最後の一跳ね」が見えないよう、倍率はごく小さな差まで追う
			const eps = key.endsWith(':z') ? 0.0002 : 0.05;
			if (Math.abs(d) < eps) {
				this.#values.set(key, t);
				continue;
			}
			this.#values.set(key, v + d * k);
			active = true;
		}
		this.#onFrame(this.#values);
		this.#raf = active ? requestAnimationFrame(this.#tick) : null;
	};
}
