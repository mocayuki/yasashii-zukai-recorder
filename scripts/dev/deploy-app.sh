#!/bin/bash
# 配布物（release/mac）を /Applications に入れ替えて開き直す。収録中なら何もしない。
#   npm run package のあとに scripts/dev/deploy-app.sh
set -e
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
cd "$(dirname "$0")/../.."
LIB="$HOME/Library/Application Support/やさしい図解レコーダー/library"
# 収録中の判定: status が recording で、動画が 20 秒以内に更新されている
for j in "$LIB"/media/*.json; do
	[ -f "$j" ] || continue
	if grep -q '"status": *"recording"' "$j"; then
		f="$LIB/media/$(node -e "console.log(require(process.argv[1]).fileName)" "$j")"
		if [ -f "$f" ] && [ $(( $(date +%s) - $(stat -f %m "$f") )) -lt 20 ]; then
			echo "収録中なので入れ替えを中止しました: $j"; exit 1
		fi
	fi
done
# 送信中（SNS へのアップロードや予約の登録）の判定: userData/busy.json が 15 分以内に更新されている
BUSY="$HOME/Library/Application Support/やさしい図解レコーダー/busy.json"
if [ -f "$BUSY" ] && [ $(( $(date +%s) - $(stat -f %m "$BUSY") )) -lt 900 ]; then
	echo "SNS へ送信中なので入れ替えを中止しました: $(cat "$BUSY")"; exit 1
fi
SRC="release/mac/YasashiiZukaiRecorder.app"
DEST="/Applications/やさしい図解レコーダー.app"
[ -d "$SRC" ] || { echo "release/mac に .app がありません（npm run package）"; exit 1; }
osascript -e 'tell application id "jp.moca.yasashii-zukai-recorder" to quit' >/dev/null 2>&1 || true
for i in $(seq 1 60); do sleep 0.5; pgrep -x YasashiiZukaiRecorder >/dev/null || break; done
# エラーダイアログなどで終了できないときは、収録中でないことを上で確かめているので止める
pgrep -x YasashiiZukaiRecorder >/dev/null && { echo "終了できないので止めます"; pkill -x YasashiiZukaiRecorder; sleep 2; }
rm -rf "$DEST" && cp -R "$SRC" "$DEST"
open -a "$DEST" --args --remote-debugging-port=9222
# 入れ替え直後は macOS の登録に時間がかかることがあるので長めに待ち、途中で一度開き直す
for i in $(seq 1 90); do sleep 1; curl -s --max-time 2 http://localhost:9222/json >/dev/null 2>&1 && break; [ $i = 30 ] && open -a "$DEST" --args --remote-debugging-port=9222; done
sleep 2; node scripts/cdp.mjs eval "document.title"
