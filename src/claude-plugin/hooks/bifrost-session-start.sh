#!/usr/bin/env bash
# Forward session start info (session_id, cwd) to Bifrost API.
INPUT="$(cat)"
PORT="${BIFROST_API_PORT:-$(cat "$HOME/.bifrost/api-port" 2>/dev/null)}"
[ -z "$PORT" ] && exit 0
# Inject BIFROST_CONTEXT and BIFROST_TASK_ID so the API knows the session type and task
ENRICHED="$(echo "$INPUT" | python3 -c "
import sys, json, os
d = json.load(sys.stdin)
d['bifrost_context'] = '${BIFROST_CONTEXT:-code}'
task_id = os.environ.get('BIFROST_TASK_ID', '')
if task_id:
    d['bifrost_task_id'] = task_id
review_id = os.environ.get('BIFROST_REVIEW_ID', '')
if review_id:
    d['bifrost_review_id'] = review_id
supervisor_item_id = os.environ.get('BIFROST_SUPERVISOR_ITEM_ID', '')
if supervisor_item_id:
    d['bifrost_supervisor_item_id'] = supervisor_item_id
print(json.dumps(d))
" 2>/dev/null)"
[ -z "$ENRICHED" ] && exit 0
curl -s -o /dev/null --max-time 2 \
  -X POST -H "Content-Type: application/json" \
  -d "$ENRICHED" \
  "http://127.0.0.1:${PORT}/session-start" 2>/dev/null || true
