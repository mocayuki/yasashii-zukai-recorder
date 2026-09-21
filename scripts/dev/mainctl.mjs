// 確認用インスタンスのメインプロセス（--inspect=9229）で JS を実行する（実際のウィンドウの大きさ変更などに使う）。
//   node scripts/dev/mainctl.mjs "<式>"    （MAIN_PORT で番号を変えられる）
const port = process.env.MAIN_PORT ?? '9229';
const list = await (await fetch(`http://localhost:${port}/json`)).json();
const ws = new WebSocket(list[0].webSocketDebuggerUrl);
await new Promise((res, rej) => {
	ws.onopen = res;
	ws.onerror = rej;
});
let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
	const m = JSON.parse(ev.data);
	if (m.id && pending.has(m.id)) {
		pending.get(m.id)(m);
		pending.delete(m.id);
	}
};
const send = (method, params = {}) =>
	new Promise((r) => {
		const id = ++seq;
		pending.set(id, r);
		ws.send(JSON.stringify({ id, method, params }));
	});
const r = await send('Runtime.evaluate', {
	expression: process.argv[2],
	awaitPromise: true,
	returnByValue: true,
	includeCommandLineAPI: true
});
console.log(JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails ?? r, null, 1));
ws.close();
