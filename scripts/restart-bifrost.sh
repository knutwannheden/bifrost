#!/bin/bash
# Restarts the Bifrost that runs in development mode, from a task inside it.
#
#   scripts/restart-bifrost.sh [--revert FROM..TO] [--prompt TEXT] [--while-stopped COMMAND]
#
# It detaches and returns at once, printing its log. Once no claimed cpu work is
# running, it restarts Bifrost from the same checkout, wakes the sessions that
# were in use, and prompts the calling task with how it went.
set -u

DIR=$HOME/.bifrost/restart
# A session counts as in use when its turn state changed this recently, or a turn is under way.
ACTIVE_WITHIN_MIN=60

# The mode comes from an argument only. RESTART_* travel in the environment, and any left over must not decide it.
MODE=launch
case "${1:-}" in
  --run) MODE=run ;;
  --restart) MODE=restart ;;
esac

if [ "$MODE" = launch ]; then
  export RESTART_TS=$(date +%Y%m%d-%H%M%S)
  export RESTART_CALLER=${BIFROST_TASK_ID:-} RESTART_REVERT= RESTART_PROMPT= RESTART_WHILE_STOPPED=
  while [ $# -gt 0 ]; do
    case "$1" in
      --revert) RESTART_REVERT=$2; shift 2 ;;
      --prompt) RESTART_PROMPT=$2; shift 2 ;;
      --while-stopped) RESTART_WHILE_STOPPED=$2; shift 2 ;;
      *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
  done
  mkdir -p "$DIR"
  # A copy runs, so the restart outlives a checkout that changes or goes away meanwhile.
  cp "$0" "$DIR/$RESTART_TS.sh"
  python3 -c 'import os, sys; os.setsid(); os.execvp("bash", ["bash", sys.argv[1], "--run"])' "$DIR/$RESTART_TS.sh" \
    < /dev/null > /dev/null 2>&1 &
  echo "restarting Bifrost in the background; log: $DIR/$RESTART_TS.log"
  exit 0
fi

RESTART_CALLER=${RESTART_CALLER:-} RESTART_REVERT=${RESTART_REVERT:-} RESTART_PROMPT=${RESTART_PROMPT:-} RESTART_WHILE_STOPPED=${RESTART_WHILE_STOPPED:-}
LOG=$DIR/$RESTART_TS.log NPM_LOG=$DIR/$RESTART_TS-npm.log CLAUDE_LOG=$DIR/$RESTART_TS-claude.log
LIVE=$DIR/$RESTART_TS-live.txt REPORT=$DIR/$RESTART_TS-report.md
exec >> "$LOG" 2>&1 < /dev/null
log() { echo "$(date +%T) $*"; }

# Run from a task, the environment holds the session's variables and what Claude's Bash tool adds, such as NO_COLOR.
# Its CLAUDE_CONFIG_DIR is the one the task started under, so the running Bifrost's record decides instead.
# Without a record, the task's stands.
inherited_config_dir=${CLAUDE_CONFIG_DIR-}
for name in $(compgen -e); do
  case $name in
    CLAUDE* | BIFROST_*) unset "$name" ;;
  esac
done
if [ -f "$HOME/.bifrost/claude-config-dir" ]; then
  config_dir=$(cat "$HOME/.bifrost/claude-config-dir")
else
  config_dir=$inherited_config_dir
fi
[ -n "$config_dir" ] && export CLAUDE_CONFIG_DIR=$config_dir
log "Claude config dir: ${CLAUDE_CONFIG_DIR:-default}"
unset NO_COLOR AI_AGENT GIT_EDITOR COREPACK_ENABLE_AUTO_PIN
# A Copilot session's: allow-all would reach every session a fresh tmux server starts.
unset COPILOT_ALLOW_ALL COPILOT_SKILLS_DIRS COPILOT_CLI COPILOT_AGENT_SESSION_ID

# pgrep -f cannot read other processes' arguments on macOS, so ps is matched instead.
processes() { ps -axo pid=,command= | sed 's/^ *//'; }
electron_pid() { processes | awk -v repo="$REPO" '$2 == repo "/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" && $3 == "." && NF == 3 { print $1 }' | head -1; }
forge_pid() { processes | awk -v start="$REPO/node_modules/@electron-forge/cli/dist/electron-forge-start.js" '$3 == start { print $1 }' | head -1; }

# The running Bifrost says which checkout to start again, and which node to start it with.
REPO=$(processes | awk '$2 ~ /\/node_modules\/electron\/dist\/Electron\.app\/Contents\/MacOS\/Electron$/ && $3 == "." && NF == 3 { sub(/\/node_modules\/.*/, "", $2); print $2 }' | head -1)
if [ -z "$REPO" ] || ! grep -q '"name": "bifrost"' "$REPO/package.json" 2>/dev/null; then
  log "no Bifrost running in development mode; nothing restarted"
  exit 1
fi
NODE_BIN=$(processes | awk -v start="$REPO/node_modules/@electron-forge/cli/dist/electron-forge-start.js" '$3 == start { print $2 }' | head -1)
[ -n "$NODE_BIN" ] && export PATH=$(dirname "$NODE_BIN"):$PATH
log "Bifrost runs from $REPO"

api() {
  local port
  port=$(cat "$HOME/.bifrost/api-port" 2>/dev/null) || return 1
  curl -s --max-time 30 -X POST -H 'Content-Type: application/json' -d "$2" "http://127.0.0.1:$port$1"
}
healthy() { api /list-tasks '{"status":"running","limit":1}' | grep -q '"tasks"'; }
wait_healthy() { for _ in $(seq 1 60); do sleep 3; healthy && return 0; done; return 1; }

stop_bifrost() {
  local pid forge
  pid=$(electron_pid) forge=$(forge_pid)
  [ -z "$pid" ] && { log "no Electron running"; return 0; }
  # SIGTERM lets Electron quit on its own terms, and SIGKILL follows only when it does not.
  log "SIGTERM Electron $pid (forge ${forge:-none})"
  kill -TERM "$pid"
  for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  kill -0 "$pid" 2>/dev/null && { log "Electron still up after 30s, SIGKILL"; kill -KILL "$pid"; }
  for _ in $(seq 1 15); do { [ -z "$forge" ] || ! kill -0 "$forge" 2>/dev/null; } && break; sleep 1; done
  [ -n "$forge" ] && kill -0 "$forge" 2>/dev/null && { log "forge still up, SIGTERM"; kill -TERM "$forge"; sleep 3; }
  return 0
}

start_bifrost() {
  # Bifrost hands its environment to every session, so the restart's own variables stay behind.
  (cd "$REPO" && env -u RESTART_TS -u RESTART_CALLER -u RESTART_REVERT -u RESTART_PROMPT -u RESTART_WHILE_STOPPED \
    nohup npm start >> "$NPM_LOG" 2>&1 < /dev/null &)
  log "npm start launched, output in $NPM_LOG"
}

restart() {
  # The rest stay deferred until their tabs are opened, as after any restart.
  local tasks since
  tasks=$(api /list-tasks '{"status":"running","limit":500}')
  since=$(( ($(date +%s) - ACTIVE_WITHIN_MIN * 60) * 1000 ))
  echo "$tasks" | jq -r --arg me "$RESTART_CALLER" --argjson since "$since" '
    .tasks[] | select(.sessionName != null)
    | select(.id == $me or .idle == false or (.lastActiveAt // 0) >= $since)
    | .id' > "$LIVE"
  log "sessions in use: $(wc -l < "$LIVE" | tr -d ' ')"
  stop_bifrost
  if [ -n "$RESTART_WHILE_STOPPED" ]; then
    log "while stopped: $RESTART_WHILE_STOPPED"
    sh -c "$RESTART_WHILE_STOPPED" && log "while stopped: done" || log "while stopped: exited $?"
  fi
  start_bifrost
  if wait_healthy; then
    log "new build is up"
    return 0
  fi
  if [ -z "$RESTART_REVERT" ]; then
    log "new build not up after 3 minutes"
    return 1
  fi
  # Takes out only the named commits, so uncommitted work in the checkout stays.
  log "new build not up after 3 minutes, reverting $RESTART_REVERT in the working tree"
  stop_bifrost
  if git -C "$REPO" diff "$RESTART_REVERT" | git -C "$REPO" apply -R; then
    log "reverted; to re-apply: git diff $RESTART_REVERT | git apply"
  else
    log "revert did not apply"
  fi
  start_bifrost
  wait_healthy && log "previous build is up" || log "previous build did not come up either"
  return 1
}

failsafe() {
  log "Bifrost is not answering; handing over to claude -p, transcript in $CLAUDE_LOG"
  local brief
  brief=$(cat <<EOF
Bifrost is an Electron app that the user runs in development mode with \`npm start\` from $REPO. A scripted restart has left it not answering, and the user may be away and depend on it. Get it running and healthy again.

What happened is in the restart log $LOG, and the app's own output is in $NPM_LOG.${RESTART_REVERT:+ The restart was to load commits $RESTART_REVERT. If the log says it reverted them, they are already out of the working tree.}

Healthy means ~/.bifrost/api-port names a port where this prints JSON with a "tasks" key:
  curl -s -X POST -H 'Content-Type: application/json' -d '{"status":"running","limit":1}' http://127.0.0.1:\$(cat ~/.bifrost/api-port)/list-tasks

Only one Bifrost may run. Before starting one, check ps for $REPO/node_modules/electron and for electron-forge. Start it detached, so it outlives you, and give it a minute to answer:
  cd $REPO && nohup npm start >> $NPM_LOG 2>&1 < /dev/null &

The checkout may hold the user's uncommitted work, which has to survive. Never run git reset, checkout, restore, stash, clean, commit or push.${RESTART_REVERT:+ Do not edit tracked files, except to take $RESTART_REVERT out with \`git -C $REPO diff $RESTART_REVERT | git -C $REPO apply -R\` when the log does not already say that was done.} Installing or rebuilding dependencies is fine.

Finish by writing what you found and what you did to $REPORT, whether or not Bifrost is up.
EOF
)
  # macOS has no timeout(1) of its own, and without it the turn cap is the only limit.
  if command -v timeout >/dev/null; then
    timeout 1800 claude -p --max-turns 80 --dangerously-skip-permissions "$brief" >> "$CLAUDE_LOG" 2>&1 < /dev/null
  else
    claude -p --max-turns 80 --dangerously-skip-permissions "$brief" >> "$CLAUDE_LOG" 2>&1 < /dev/null
  fi
  log "claude -p exited $?"
}

if [ "$MODE" = restart ]; then
  restart
  exit $?
fi

if command -v headroom >/dev/null; then
  log "waiting for an exclusive cpu claim, so no claimed run is cut off"
  # --force skips only the check for load nobody claimed, which a restart cannot cut off.
  if id=$(headroom acquire cpu --exclusive --force --wait -q --as bifrost-restart \
    --why "restarting Bifrost: dev terminals end, so no claimed run may be in flight"); then
    headroom hold "$id" --grace never -- bash "$0" --restart
    headroom release "$id" > /dev/null
  else
    log "no cpu claim; Bifrost was left as it was"
    exit 1
  fi
else
  restart
fi

healthy || failsafe
healthy || { log "Bifrost is still down"; exit 1; }

while read -r id; do
  log "wake $id: $(api /wake-task "{\"taskId\":\"$id\"}" | head -c 200)"
done < "$LIVE"

if [ -n "$RESTART_CALLER" ]; then
  if grep -q 'new build is up' "$LOG"; then build="the new build"; else build="the previous build, since the new one did not start"; fi
  prompt="Bifrost restarted on $build (log: $LOG)."
  [ -f "$REPORT" ] && prompt="$prompt A headless Claude brought it back up, and its report is $REPORT."
  [ -n "$RESTART_PROMPT" ] && prompt="$prompt $RESTART_PROMPT"
  log "prompt to $RESTART_CALLER: $(api /send-prompt "$(jq -n --arg t "$prompt" --arg id "$RESTART_CALLER" '{taskId: $id, text: $t, mode: "queue"}')" | head -c 200)"
fi
log "done"
