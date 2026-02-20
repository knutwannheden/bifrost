#!/usr/bin/env bash
# Usage: bifrost-agent-activity.sh [busy|idle]
# Signals agent activity state to Bifrost API.
INPUT="$(cat)"
PORT="${BIFROST_API_PORT:-$(cat "$HOME/.bifrost/api-port" 2>/dev/null)}"
[ -z "$PORT" ] && exit 0
curl -s -o /dev/null --max-time 2 \
  -X POST -H "Content-Type: application/json" \
  -d "$INPUT" \
  "http://127.0.0.1:${PORT}/agent-${1:-busy}" 2>/dev/null || true
