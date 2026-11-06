#!/bin/sh
# Registers the native messaging host with every Chromium browser installed on this Mac
# (Brave, Chrome, Chromium, Edge, Vivaldi, Arc). Run once, after loading the extension
# via chrome://extensions (or the browser's equivalent) -> Load unpacked.
set -e

HOST_NAME=de.deutsch.prime_dualsub
EXTENSION_ID=ehhcbkjmmppglbijpafhmimehhiibnag
HERE=$(cd "$(dirname "$0")" && pwd)
SUPPORT="$HOME/Library/Application Support"

chmod +x "$HERE/bridge.sh"
found=0
for dir in BraveSoftware/Brave-Browser Google/Chrome Chromium Microsoft\ Edge Vivaldi Arc/User\ Data; do
  [ -d "$SUPPORT/$dir" ] || continue
  TARGET="$SUPPORT/$dir/NativeMessagingHosts"
  mkdir -p "$TARGET"
  cat > "$TARGET/$HOST_NAME.json" <<JSON
{
  "name": "$HOST_NAME",
  "description": "Prime Dualsub: subtitle translation and grammar via Codex, Claude, Anthropic API or Wire",
  "path": "$HERE/bridge.sh",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/"]
}
JSON
  echo "host registered: $TARGET/$HOST_NAME.json"
  found=1
done

[ "$found" = 1 ] || { echo "no Chromium-based browser found under $SUPPORT" >&2; exit 1; }
echo "restart the browser so it rereads the directory"
