import type { AgentKind } from '../shared/types.ts';

/**
 * How run.sh starts an agent, as shell lines. They run in the worktree with
 * "$@" holding the agent's arguments, "$sid" its session id and "$d" the
 * session's directory.
 */
interface Launcher {
  /** Succeeds when the conversation under "$sid" exists. */
  transcript: string;
  resume: string;
  /** Starts it with "$d/prompt.sent" as the first message. */
  prompted: string;
  start: string;
}

const LAUNCHERS: Record<AgentKind, Launcher> = {
  // Claude files the transcript under a directory named for the cwd, so it is found by session id alone.
  claude: {
    transcript: 'ls "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*/"$sid".jsonl',
    resume: 'exec claude "$@" --resume "$sid"',
    prompted: 'cat "$d/prompt.sent" | claude "$@" --session-id "$sid"',
    start: 'exec claude "$@" --session-id "$sid"',
  },
  // --session-id resumes the session when it exists and starts it under that id when not.
  copilot: {
    transcript: '[ -d "${COPILOT_HOME:-$HOME/.copilot}/session-state/$sid" ]',
    resume: 'exec copilot "$@" --session-id "$sid"',
    prompted: 'exec copilot "$@" --session-id "$sid" -i "$(cat "$d/prompt.sent")"',
    start: 'exec copilot "$@" --session-id "$sid"',
  },
  // Codex picks the id itself, and Bifrost learns it from the first turn's SessionStart hook.
  codex: {
    transcript: '[ -n "$sid" ] && ls "${CODEX_HOME:-$HOME/.codex}"/sessions/*/*/*/rollout-*-"$sid".jsonl',
    resume: 'exec codex resume "$@" "$sid"',
    prompted: 'exec codex "$@" -- "$(cat "$d/prompt.sent")"',
    start: 'exec codex "$@"',
  },
};

/** The end of run.sh: resume the conversation, or start one, sending the prompt once. */
export function startLines(agent: AgentKind): string[] {
  const launch = LAUNCHERS[agent];
  return [
    `if ${launch.transcript} >/dev/null 2>&1; then`,
    '  rm -f "$d/prompt"',
    `  ${launch.resume}`,
    'fi',
    // The prompt is moved aside as it is sent, so a later start under a new session id does not send it again.
    'if [ -f "$d/prompt" ]; then',
    '  mv "$d/prompt" "$d/prompt.sent"',
    `  ${launch.prompted}`,
    '  exit',
    'fi',
    launch.start,
  ];
}
