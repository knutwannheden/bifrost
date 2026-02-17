#!/usr/bin/env bash
INPUT="$(cat)"
PORT="${BIFROST_API_PORT:-$(cat "$HOME/.bifrost/api-port" 2>/dev/null)}"
[ -z "$PORT" ] && exit 0
RESPONSE=$(curl -s --max-time 120 \
  -X POST -H "Content-Type: application/json" \
  -d "$INPUT" \
  "http://127.0.0.1:${PORT}/permission" 2>/dev/null)
[ -z "$RESPONSE" ] && exit 0
echo "$RESPONSE"
