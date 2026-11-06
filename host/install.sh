#!/bin/sh
# Registers the native messaging host with Brave. Run once, after loading the
# extension from brave://extensions -> Load unpacked.
set -e

HOST_NAME=de.deutsch.prime_dualsub
EXTENSION_ID=ehhcbkjmmppglbijpafhmimehhiibnag
HERE=$(cd "$(dirname "$0")" && pwd)
TARGET="$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"

chmod +x "$HERE/bridge.sh"
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
echo "restart Brave so it rereads the directory"
