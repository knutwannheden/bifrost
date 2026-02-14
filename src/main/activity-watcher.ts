import { BrowserWindow } from 'electron';
import chokidar from 'chokidar';
import { promisify } from 'node:util';
import { execFile as execFileCb } from 'node:child_process';
import { v4 as uuidv4 } from 'uuid';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ActivityEntry } from '../shared/types';
import { IPC_STREAM } from '../shared/ipc-channels';
import { startClaudeWatching, stopClaudeWatching, getRecentClaudeEntries } from './claude-watcher';

const execFile = promisify(execFileCb);

const ACTIVITY_DIR = path.join(os.homedir(), '.bifrost', 'activity');

interface TaskWatcher {
  watcher: chokidar.FSWatcher;
  entries: ActivityEntry[];
  headSha: string | null;
  debounceTimers: Map<string, ReturnType<typeof setTimeout>>;
}

const watchers = new Map<string, TaskWatcher>();

function ensureActivityDir(): void {
  if (!fs.existsSync(ACTIVITY_DIR)) {
    fs.mkdirSync(ACTIVITY_DIR, { recursive: true });
  }
}

function activityFilePath(taskId: string): string {
  return path.join(ACTIVITY_DIR, `${taskId}.json`);
}

function loadEntries(taskId: string): ActivityEntry[] {
  const filePath = activityFilePath(taskId);
  if (!fs.existsSync(filePath)) return [];
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return [];
  }
}

function saveEntries(taskId: string, entries: ActivityEntry[]): void {
  ensureActivityDir();
  fs.writeFileSync(activityFilePath(taskId), JSON.stringify(entries, null, 2));
}

async function getHeadSha(worktreePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], {
      cwd: worktreePath,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function getFileDiff(worktreePath: string, filePath: string): Promise<string> {
  try {
    // Try tracked file diff first
    const { stdout } = await execFile(
      'git',
      ['diff', 'HEAD', '--', filePath],
      { cwd: worktreePath, maxBuffer: 5 * 1024 * 1024 },
    );
    if (stdout) return stdout;

    // Check if untracked (new file)
    try {
      await execFile('git', ['ls-files', '--error-unmatch', filePath], {
        cwd: worktreePath,
      });
      // File is tracked but has no diff — no changes
      return '';
    } catch {
      // File is untracked — generate synthetic diff
      const fullPath = path.resolve(worktreePath, filePath);
      if (!fs.existsSync(fullPath)) return '';
      const content = fs.readFileSync(fullPath, 'utf-8');
      const lines = content.split('\n');
      const header = `--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${lines.length} @@\n`;
      return header + lines.map((l) => `+${l}`).join('\n') + '\n';
    }
  } catch {
    return '';
  }
}

async function getCommitMessage(worktreePath: string, sha: string): Promise<string> {
  try {
    const { stdout } = await execFile(
      'git',
      ['log', '-1', '--format=%s', sha],
      { cwd: worktreePath },
    );
    return stdout.trim();
  } catch {
    return '';
  }
}

export function startWatching(
  taskId: string,
  worktreePath: string,
  mainWindow: BrowserWindow,
): void {
  // Stop any existing watcher for this task
  stopWatching(taskId);

  const entries = loadEntries(taskId);

  const tw: TaskWatcher = {
    watcher: null!,
    entries,
    headSha: null,
    debounceTimers: new Map(),
  };

  // Get initial HEAD SHA
  getHeadSha(worktreePath).then((sha) => {
    tw.headSha = sha;
  });

  const watcher = chokidar.watch(worktreePath, {
    ignored: [
      /(^|[/\\])\../, // dotfiles (includes .git)
      '**/node_modules/**',
      '**/.git/**',
    ],
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100,
    },
  });

  tw.watcher = watcher;

  const handleFileChange = (filePath: string) => {
    const relative = path.relative(worktreePath, filePath);

    // Debounce per file
    const existing = tw.debounceTimers.get(relative);
    if (existing) clearTimeout(existing);

    tw.debounceTimers.set(
      relative,
      setTimeout(async () => {
        tw.debounceTimers.delete(relative);

        // Check for new commit first
        const currentSha = await getHeadSha(worktreePath);
        if (currentSha && tw.headSha && currentSha !== tw.headSha) {
          // A commit happened — add commit marker and clear file entries
          const commitMsg = await getCommitMessage(worktreePath, currentSha);
          const commitEntry: ActivityEntry = {
            id: uuidv4(),
            taskId,
            timestamp: Date.now(),
            type: 'commit',
            commitSha: currentSha,
            commitMessage: commitMsg,
          };
          tw.entries = [commitEntry];
          tw.headSha = currentSha;
          saveEntries(taskId, tw.entries);
          mainWindow.webContents.send(IPC_STREAM.ACTIVITY_ENTRY, commitEntry);
          return;
        }

        const diff = await getFileDiff(worktreePath, relative);
        if (!diff) return;

        const entry: ActivityEntry = {
          id: uuidv4(),
          taskId,
          timestamp: Date.now(),
          type: 'file_change',
          filePath: relative,
          diff,
        };

        tw.entries.push(entry);
        saveEntries(taskId, tw.entries);
        mainWindow.webContents.send(IPC_STREAM.ACTIVITY_ENTRY, entry);
      }, 500),
    );
  };

  watcher.on('add', handleFileChange);
  watcher.on('change', handleFileChange);

  // Also watch for git HEAD changes (commit detection)
  const gitHeadPath = path.join(worktreePath, '.git');
  // For worktrees, .git is a file pointing to the real .git dir
  let gitDir: string;
  try {
    const stat = fs.statSync(gitHeadPath);
    if (stat.isFile()) {
      const content = fs.readFileSync(gitHeadPath, 'utf-8').trim();
      const match = content.match(/^gitdir: (.+)$/);
      gitDir = match ? path.resolve(worktreePath, match[1]) : gitHeadPath;
    } else {
      gitDir = gitHeadPath;
    }
  } catch {
    gitDir = gitHeadPath;
  }

  // Watch the HEAD ref file for commit detection
  const headRefPath = path.join(gitDir, 'HEAD');
  if (fs.existsSync(headRefPath)) {
    const headWatcher = chokidar.watch(headRefPath, {
      ignoreInitial: true,
    });
    headWatcher.on('change', async () => {
      const currentSha = await getHeadSha(worktreePath);
      if (currentSha && tw.headSha && currentSha !== tw.headSha) {
        const commitMsg = await getCommitMessage(worktreePath, currentSha);
        const commitEntry: ActivityEntry = {
          id: uuidv4(),
          taskId,
          timestamp: Date.now(),
          type: 'commit',
          commitSha: currentSha,
          commitMessage: commitMsg,
        };
        // Clear file change entries, keep only the commit marker
        tw.entries = [commitEntry];
        tw.headSha = currentSha;
        saveEntries(taskId, tw.entries);
        mainWindow.webContents.send(IPC_STREAM.ACTIVITY_ENTRY, commitEntry);
      }
    });

    // Store reference for cleanup
    const origClose = tw.watcher.close.bind(tw.watcher);
    tw.watcher.close = async () => {
      await headWatcher.close();
      return origClose();
    };
  }

  watchers.set(taskId, tw);

  // Also watch Claude Code JSONL session files
  startClaudeWatching(taskId, worktreePath, mainWindow);
}

export function stopWatching(taskId: string): void {
  const tw = watchers.get(taskId);
  if (tw) {
    tw.watcher.close();
    for (const timer of tw.debounceTimers.values()) {
      clearTimeout(timer);
    }
    watchers.delete(taskId);
  }
  stopClaudeWatching(taskId);
}

export function getActivityLog(taskId: string, worktreePath: string): ActivityEntry[] {
  const tw = watchers.get(taskId);
  const fileEntries = tw ? tw.entries : loadEntries(taskId);

  // Also include recent Claude JSONL entries (read directly from source)
  const claudeEntries = getRecentClaudeEntries(taskId, worktreePath);

  if (claudeEntries.length === 0) return fileEntries;

  // Merge and sort by timestamp
  return [...fileEntries, ...claudeEntries].sort((a, b) => a.timestamp - b.timestamp);
}

export function clearActivityLog(taskId: string): void {
  const tw = watchers.get(taskId);
  if (tw) {
    tw.entries = [];
  }
  saveEntries(taskId, []);
}
