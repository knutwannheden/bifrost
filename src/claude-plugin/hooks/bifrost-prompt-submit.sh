#!/usr/bin/env bash
INPUT="$(cat)"
PORT="${BIFROST_API_PORT:-$(cat "$HOME/.bifrost/api-port" 2>/dev/null)}"
[ -z "$PORT" ] && exit 0
ENRICHED="$(echo "$INPUT" | python3 -c "
import sys, json, os
d = json.load(sys.stdin)
d['bifrost_context'] = os.environ.get('BIFROST_CONTEXT', 'code')
task_id = os.environ.get('BIFROST_TASK_ID', '')
if task_id:
    d['bifrost_task_id'] = task_id
print(json.dumps(d))
" 2>/dev/null)"
[ -z "$ENRICHED" ] && exit 0
RESPONSE=$(curl -s --max-time 2 \
  -X POST -H "Content-Type: application/json" \
  -d "$ENRICHED" \
  "http://127.0.0.1:${PORT}/hook" 2>/dev/null)
[ -z "$RESPONSE" ] && exit 0
echo "$RESPONSE"
