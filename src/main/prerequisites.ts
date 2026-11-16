import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentKind, Prerequisite } from '../shared/types.ts';

const execFile = promisify(execFileCb);

const AGENT_CLIS: Record<AgentKind, { purpose: string; url: string }> = {
  claude: { purpose: 'Claude Code CLI', url: 'https://docs.anthropic.com/en/docs/claude-code/overview' },
  copilot: { purpose: 'GitHub Copilot CLI', url: 'https://github.com/github/copilot-cli' },
  codex: { purpose: 'OpenAI Codex CLI', url: 'https://github.com/openai/codex' },
};

/** The programs Bifrost runs here, and which of them sessions of this agent and its own calls need. */
export async function checkPrograms(agent: AgentKind, oneshot: AgentKind | 'off'): Promise<Prerequisite[]> {
  const listed: Array<Omit<Prerequisite, 'found'>> = [
    { name: 'git', required: true, purpose: 'version control', url: 'https://git-scm.com/downloads' },
    {
      name: 'tmux',
      required: true,
      purpose: 'runs every session',
      url: 'https://github.com/tmux/tmux/wiki/Installing',
    },
    {
      name: 'node',
      required: true,
      purpose: "runs Bifrost's hooks and MCP server",
      url: 'https://nodejs.org/en/download',
    },
    { name: agent, required: true, ...AGENT_CLIS[agent] },
    ...(oneshot === 'off' || oneshot === agent
      ? []
      : [
          {
            name: oneshot,
            required: false,
            purpose: `${AGENT_CLIS[oneshot].purpose}, for Bifrost's titles, summaries and walkthroughs`,
            url: AGENT_CLIS[oneshot].url,
          },
        ]),
    { name: 'gh', required: false, purpose: 'GitHub CLI, for PR-based task creation', url: 'https://cli.github.com' },
  ];
  return Promise.all(listed.map(async (program) => ({ ...program, found: await answers(program.name) })));
}

function answers(program: string): Promise<boolean> {
  return execFile(program, [program === 'tmux' ? '-V' : '--version'], { timeout: 5000, killSignal: 'SIGKILL' }).then(
    () => true,
    () => false,
  );
}
