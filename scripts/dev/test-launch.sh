#!/bin/bash
# 動作確認用の別インスタンスを起動する（設定・保存先が別。本物のアプリには触らない）。
#   SCRATCH=<作業フォルダー> scripts/dev/test-launch.sh
# 初回は本物のライブラリーから、ノート・画像・書き起こし・小さい収録だけを写して確認用ライブラリーを作る。
# ポート 9223（画面の CDP）と 9229（メインプロセスの inspector）で待つ
set -e
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
S="${SCRATCH:?SCRATCH を指定してください}"
cd "$(dirname "$0")/../.."
REAL="$HOME/Library/Application Support/やさしい図解レコーダー/library"
if [ ! -d "$S/library/notes" ]; then
	mkdir -p "$S/library"/{notes,media,images,transcripts,exports} "$S/userdata"
	cp "$REAL"/notes/*.json "$S/library/notes/" 2>/dev/null || true
	cp "$REAL"/folders.json "$S/library/" 2>/dev/null || true
	cp "$REAL"/images/* "$S/library/images/" 2>/dev/null || true
	cp "$REAL"/transcripts/*.json "$S/library/transcripts/" 2>/dev/null || true
	cp "$REAL"/media/*.json "$S/library/media/" 2>/dev/null || true
	# 収録の動画は 60MB までのものだけ写す
	find "$REAL/media" -name "*.webm" -size -60M -exec cp {} "$S/library/media/" \; 2>/dev/null || true
	# 写した動画の無い収録の json は消す
	for j in "$S"/library/media/*.json; do f=$(node -e "console.log(require(process.argv[1]).fileName)" "$j"); [ -f "$S/library/media/$f" ] || rm -f "$j"; done
	node -e "require('fs').writeFileSync(process.argv[1]+'/userdata/settings.json', JSON.stringify({libraryPath: process.argv[1]+'/library'}))" "$S"
fi
pkill -f "remote-debugging-port=9223" 2>/dev/null || true; sleep 1
(YASASHII_USER_DATA="$S/userdata" YASASHII_EXPORT_DIR="$S" nohup npx electron . --remote-debugging-port=9223 --inspect=9229 > "$S/test-app.log" 2>&1 &)
for i in $(seq 1 20); do sleep 0.5; curl -s http://localhost:9223/json >/dev/null 2>&1 && break; done
sleep 2; CDP_PORT=9223 node scripts/cdp.mjs eval "document.title"
