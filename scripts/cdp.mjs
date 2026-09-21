// 開発用: 起動中のアプリ（--remote-debugging-port=9222）に CDP でつないで、
// スクリーンショットを撮ったり、画面の中で JavaScript を実行したりする。
//
//   node scripts/cdp.mjs shot out.png
//   node scripts/cdp.mjs eval "document.title"
//   CDP_VIEW=1000x700 node scripts/cdp.mjs eval "..."
//     （表示領域を 1000x700 にしたつもりで実行する。つないでいる間だけ有効）
//
// 依存を増やさないため、Node 22 の組み込み WebSocket を使う。

const PORT = process.env.CDP_PORT ?? '9222';

async function connect() {
	const targets = await (await fetch(`http://localhost:${PORT}/json`)).json();
	// CDP_MATCH を付けると、その文字列を URL に含む画面（プレゼン用の窓など）につなぐ
	const match = process.env.CDP_MATCH ?? '';
	const page = targets.find(
		(t) =>
			t.type === 'page' &&
			!t.url.startsWith('devtools://') &&
			(!match || (match.startsWith('!') ? !t.url.includes(match.slice(1)) : t.url.includes(match)))
	);
	if (!page)
		throw new Error(
			'アプリの画面が見つかりません。--remote-debugging-port=9222 で起動していますか？'
		);
	const ws = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => {
		ws.onopen = resolve;
		ws.onerror = reject;
	});
	let seq = 0;
	const pending = new Map();
	ws.onmessage = (ev) => {
		const msg = JSON.parse(ev.data);
		if (msg.id && pending.has(msg.id)) {
			const { resolve, reject } = pending.get(msg.id);
			pending.delete(msg.id);
			if (msg.error) reject(new Error(msg.error.message));
			else resolve(msg.result);
		}
	};
	const send = (method, params = {}) =>
		new Promise((resolve, reject) => {
			const id = ++seq;
			pending.set(id, { resolve, reject });
			ws.send(JSON.stringify({ id, method, params }));
		});
	return { send, close: () => ws.close() };
}

const [cmd, arg] = process.argv.slice(2);
const cdp = await connect();
try {
	// CDP_VIEW=幅x高さ を付けると、表示領域をその大きさにしたつもりで実行する（動作確認用）。
	// Electron は Browser.setWindowBounds を持たないのでエミュレーションで代用する。
	// エミュレーションは接続している間だけ効くので、同じ実行の中で測る必要がある
	const view = /^(\d+)x(\d+)$/.exec(process.env.CDP_VIEW ?? '');
	if (view) {
		await cdp.send('Emulation.setDeviceMetricsOverride', {
			width: Number(view[1]),
			height: Number(view[2]),
			deviceScaleFactor: 0,
			mobile: false
		});
	}
	if (cmd === 'shot') {
		const { writeFile } = await import('node:fs/promises');
		const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
		await writeFile(arg ?? 'shot.png', Buffer.from(r.data, 'base64'));
		console.log(`saved ${arg ?? 'shot.png'}`);
	} else if (cmd === 'eval') {
		const r = await cdp.send('Runtime.evaluate', {
			expression: arg,
			awaitPromise: true,
			returnByValue: true
		});
		if (r.exceptionDetails) {
			console.error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
			process.exitCode = 1;
		} else {
			console.log(JSON.stringify(r.result.value, null, 2));
		}
	} else {
		console.log('usage: node scripts/cdp.mjs shot <file.png> | eval "<js>"');
	}
} finally {
	cdp.close();
}
