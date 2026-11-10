import type { AgentKind } from '../shared/types.ts';
import { shQuote } from './tmux-session.ts';

/**
 * How run.sh starts an agent, as shell lines. They run in the worktree with
 * "$@" holding the agent's arguments, "$sid" its session id and "$d" the
 * session's directory.
 */
interface Launcher {
  /** Runs first, and may add to "$@". */
  prelude?: string[];
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
    // Codex trusts a git project by its main checkout, which a worktree's common git dir sits in.
    prelude: [
      'root=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) && root=$(dirname "$root") || root=$PWD',
      'set -- -c "projects={\\"$root\\"={trust_level=\\"trusted\\"}}" "$@"',
    ],
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
    ...(launch.prelude ?? []),
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

/** Where a session's machine keeps what an agent other than Claude is pointed at. */
export interface AgentPlaces {
  home: string;
  /** Bifrost's plugin there. */
  pluginDir: string;
  /** Claude's config dir there, which holds the user's rules and skills. */
  claudeDir: string;
}

/** Bifrost's hook scripts by the event Codex raises, which it names as Claude does. */
const CODEX_HOOKS: Record<string, string> = {
  SessionStart: 'bifrost-session-start.sh',
  UserPromptSubmit: 'bifrost-prompt-submit.sh',
  Stop: 'bifrost-notify.sh',
  PostToolUse: 'bifrost-notify.sh',
  SubagentStart: 'bifrost-notify.sh',
  SubagentStop: 'bifrost-notify.sh',
  PreCompact: 'bifrost-notify.sh',
  SessionEnd: 'bifrost-notify.sh',
  // Codex has no Notification event, and this is the moment it waits for the user.
  PermissionRequest: 'bifrost-notify.sh',
};

/** The variables Codex passes on to an MCP server, which otherwise gets only a minimal environment. */
const MCP_VARS = [
  'BIFROST_TASK_ID',
  'BIFROST_API_PORT',
  'BIFROST_CONTEXT',
  'BIFROST_SESSION_NAME',
  'BIFROST_MACHINE',
  'BIFROST_AGENT',
];

/**
 * What a Copilot or Codex session starts with besides the environment every
 * session gets. Each is given Bifrost's hooks, MCP server and skills, and the
 * user's rules and skills, on its command line, so nothing is written into its own config.
 */
export function agentLaunch(
  agent: Exclude<AgentKind, 'claude'>,
  permissionMode: string | undefined,
  places: AgentPlaces,
): { args: string[]; env: Record<string, string> } {
  const skip = permissionMode === 'skip-permissions';
  if (agent === 'copilot') {
    return {
      args: ['--plugin-dir', places.pluginDir, '--no-auto-update'],
      env: {
        BIFROST_AGENT: agent,
        COPILOT_SKILLS_DIRS: `${places.claudeDir}/skills`,
        // A machine's synced rules sit in ~/.bifrost/claude, which its own CLAUDE.md imports.
        COPILOT_CUSTOM_INSTRUCTIONS_DIRS: `${places.claudeDir},${places.home}/.bifrost/claude`,
        // Also trusts the folder, which otherwise takes a question at every new worktree.
        ...(skip ? { COPILOT_ALLOW_ALL: 'true' } : {}),
      },
    };
  }
  const toml = (value: string) => JSON.stringify(value);
  const hooks = Object.entries(CODEX_HOOKS).flatMap(([event, script]) => [
    '-c',
    `hooks.${event}=[{hooks=[{type="command",command=${toml(shQuote(`${places.pluginDir}/hooks/${script}`))}}]}]`,
  ]);
  return {
    args: [
      '--no-alt-screen',
      // Untrusted hooks would wait on a review screen, and these are Bifrost's own.
      '--dangerously-bypass-hook-trust',
      ...hooks,
      ...['-c', 'mcp_servers.bifrost.command="node"'],
      ...['-c', `mcp_servers.bifrost.args=[${toml(`${places.pluginDir}/mcp/server.mjs`)}]`],
      ...['-c', `mcp_servers.bifrost.env_vars=[${MCP_VARS.map(toml).join(',')}]`],
      ...['-c', 'check_for_update_on_startup=false'],
      // A repo's rules are written for Claude.
      ...['-c', 'project_doc_fallback_filenames=["CLAUDE.md"]'],
      ...(skip ? ['--dangerously-bypass-approvals-and-sandbox'] : []),
      ...(permissionMode === 'sandbox' ? ['--sandbox', 'workspace-write'] : []),
    ],
    env: { BIFROST_AGENT: agent },
  };
}
