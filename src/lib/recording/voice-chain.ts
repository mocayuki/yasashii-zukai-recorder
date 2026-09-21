/**
 * マイクの音の道（収録と、音の設定のメーターで共通）:
 *   マイク → 倍率（GainNode） → 声を整える（DynamicsCompressor） → 出口
 * コンプレッサーは小さい声を持ち上げ、大きい声を抑える。Chrome の実装は持ち上げ（メイクアップゲイン）込みなので、
 * 倍率を上げても割れにくく、平均の大きさが上がる。
 */
export interface VoiceChain {
	gain: GainNode;
	compressor: DynamicsCompressorNode;
	/** 最後のノード（ここから analyser や destination につなぐ） */
	output: AudioNode;
	setGain(v: number): void;
	setCompressor(on: boolean): void;
}

export function buildVoiceChain(
	ac: AudioContext,
	source: AudioNode,
	opts: { gain: number; compressor: boolean }
): VoiceChain {
	const gain = ac.createGain();
	gain.gain.value = opts.gain;
	const compressor = ac.createDynamicsCompressor();
	compressor.threshold.value = -24;
	compressor.knee.value = 12;
	compressor.ratio.value = 4;
	compressor.attack.value = 0.005;
	compressor.release.value = 0.2;
	const output = ac.createGain(); // つなぎ替えの受け口（値は 1 のまま）
	source.connect(gain);
	let on = opts.compressor;
	const wire = () => {
		gain.disconnect();
		compressor.disconnect();
		if (on) {
			gain.connect(compressor);
			compressor.connect(output);
		} else {
			gain.connect(output);
		}
	};
	wire();
	return {
		gain,
		compressor,
		output,
		setGain: (v) => {
			gain.gain.value = v;
		},
		setCompressor: (flag) => {
			if (on === flag) return;
			on = flag;
			wire();
		}
	};
}
