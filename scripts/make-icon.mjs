// アプリのアイコンを作る（依存を増やさないため、PNG を自前で描いて sips / iconutil で icns にする）。
//   node scripts/make-icon.mjs   → resources/icon.png と resources/icon.icns
// 見た目: 黄色の角丸の四角に太い黒い線と黒い影。中に白い丸いノードが 1 → 2 につながる小さなマインドマップ。
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import zlib from 'node:zlib';

const N = 1024;
const px = new Float32Array(N * N * 4); // RGBA 0..1（上から順に描く。アンチエイリアス付き）

const INK = [0x1c / 255, 0x18 / 255, 0x12 / 255];
const YELLOW = [0xff / 255, 0xd9 / 255, 0x5c / 255];
const WHITE = [1, 1, 1];

// 角丸四角の符号付き距離
function sdRoundRect(x, y, cx, cy, hw, hh, r) {
	const dx = Math.abs(x - cx) - hw + r;
	const dy = Math.abs(y - cy) - hh + r;
	const ox = Math.max(dx, 0);
	const oy = Math.max(dy, 0);
	return Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0) - r;
}
// 線分の距離
function sdSegment(x, y, ax, ay, bx, by) {
	const vx = bx - ax,
		vy = by - ay,
		wx = x - ax,
		wy = y - ay;
	const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / (vx * vx + vy * vy)));
	return Math.hypot(wx - t * vx, wy - t * vy);
}
function paint(sdf, color) {
	for (let y = 0; y < N; y++) {
		for (let x = 0; x < N; x++) {
			const d = sdf(x + 0.5, y + 0.5);
			const a = Math.max(0, Math.min(1, 0.5 - d)); // 1px のアンチエイリアス
			if (a <= 0) continue;
			const i = (y * N + x) * 4;
			const a0 = px[i + 3];
			const out = a + a0 * (1 - a);
			for (let c = 0; c < 3; c++)
				px[i + c] = (color[c] * a + px[i + c] * a0 * (1 - a)) / (out || 1);
			px[i + 3] = out;
		}
	}
}
const rr = (cx, cy, hw, hh, r) => (x, y) => sdRoundRect(x, y, cx, cy, hw, hh, r);
const ring = (cx, cy, hw, hh, r, w) => (x, y) =>
	Math.abs(sdRoundRect(x, y, cx, cy, hw, hh, r)) - w / 2;
const curve = (pts, w) => (x, y) => {
	let d = Infinity;
	for (let i = 1; i < pts.length; i++) d = Math.min(d, sdSegment(x, y, ...pts[i - 1], ...pts[i]));
	return d - w / 2;
};
function bezier(p0, p1, p2, p3, n = 24) {
	const out = [];
	for (let i = 0; i <= n; i++) {
		const t = i / n,
			u = 1 - t;
		out.push([
			u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
			u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]
		]);
	}
	return out;
}

// 土台: 影 → 黄色 → 黒い線
const C = 512,
	H = 430,
	R = 210,
	BORDER = 34,
	SHADOW = 26;
paint(rr(C + SHADOW, C + SHADOW, H, H, R), INK);
paint(rr(C, C, H, H, R), YELLOW);
paint(ring(C, C, H, H, R, BORDER), INK);

// つなぐ線（右端の中央から、子の左端の中央へ）
const A = { cx: 330, cy: 512, hw: 130, hh: 78 };
const B = { cx: 700, cy: 372, hw: 118, hh: 62 };
const Cn = { cx: 700, cy: 652, hw: 118, hh: 62 };
const LINE = 22;
for (const k of [B, Cn]) {
	const from = [A.cx + A.hw, A.cy];
	const to = [k.cx - k.hw, k.cy];
	const midx = (from[0] + to[0]) / 2;
	paint(curve(bezier(from, [midx, from[1]], [midx, to[1]], to), LINE), INK);
}
// ノード（影 → 白 → 線）
for (const k of [A, B, Cn]) {
	const r = Math.min(k.hw, k.hh);
	paint(rr(k.cx + 14, k.cy + 14, k.hw, k.hh, r), INK);
	paint(rr(k.cx, k.cy, k.hw, k.hh, r), WHITE);
	paint(ring(k.cx, k.cy, k.hw, k.hh, r, 20), INK);
}
// 中心のノードには「黄色の丸い印」（収録の赤丸ではなく、このアプリの黄色）
paint(rr(A.cx, A.cy, 34, 34, 34), YELLOW);
paint(ring(A.cx, A.cy, 34, 34, 34, 16), INK);

// PNG に書く
const raw = Buffer.alloc((N * 4 + 1) * N);
for (let y = 0; y < N; y++) {
	raw[y * (N * 4 + 1)] = 0;
	for (let x = 0; x < N; x++) {
		const i = (y * N + x) * 4,
			o = y * (N * 4 + 1) + 1 + x * 4;
		raw[o] = Math.round(px[i] * 255);
		raw[o + 1] = Math.round(px[i + 1] * 255);
		raw[o + 2] = Math.round(px[i + 2] * 255);
		raw[o + 3] = Math.round(px[i + 3] * 255);
	}
}
const crcTable = new Int32Array(256).map((_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c;
});
const crc = (b) => {
	let c = -1;
	for (const v of b) c = crcTable[(c ^ v) & 0xff] ^ (c >>> 8);
	return (c ^ -1) >>> 0;
};
const chunk = (t, d) => {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(d.length);
	const td = Buffer.concat([Buffer.from(t), d]);
	const c = Buffer.alloc(4);
	c.writeUInt32BE(crc(td));
	return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0);
ihdr.writeUInt32BE(N, 4);
ihdr[8] = 8;
ihdr[9] = 6; // 8bit RGBA
const png = Buffer.concat([
	Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
	chunk('IHDR', ihdr),
	chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
	chunk('IEND', Buffer.alloc(0))
]);
mkdirSync('resources', { recursive: true });
writeFileSync('resources/icon.png', png);

// icns（macOS の sips と iconutil を使う）
const set = 'resources/icon.iconset';
rmSync(set, { recursive: true, force: true });
mkdirSync(set);
for (const s of [16, 32, 128, 256, 512]) {
	execSync(`sips -z ${s} ${s} resources/icon.png --out ${set}/icon_${s}x${s}.png`, {
		stdio: 'ignore'
	});
	execSync(`sips -z ${s * 2} ${s * 2} resources/icon.png --out ${set}/icon_${s}x${s}@2x.png`, {
		stdio: 'ignore'
	});
}
execSync(`iconutil -c icns ${set} -o resources/icon.icns`);
rmSync(set, { recursive: true, force: true });
console.log('resources/icon.png, resources/icon.icns を作りました');
