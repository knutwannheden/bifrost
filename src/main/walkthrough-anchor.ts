import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import {
  type Anchor,
  type Comment,
  extractSnippet,
  type GeneratedAnchor,
  type GeneratedWalkthrough,
  locateQuote,
  matchSnippet,
  parseZeroContextHunks,
  type Remapped,
  type Staleness,
  type Step,
  shiftRange,
  type Walkthrough,
} from '../shared/walkthrough.ts';

const execFile = promisify(execFileCb);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile('git', ['--no-optional-locks', ...args], {
    cwd,
    maxBuffer: 20 * 1024 * 1024,
    timeout: 30_000,
  });
  return stdout;
}

async function succeeds(cwd: string, args: string[]): Promise<boolean> {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

/** A file's lines at a commit, or null when the commit or the path is not there. */
export async function fileAt(cwd: string, commit: string, filePath: string): Promise<string[] | null> {
  try {
    const text = await git(cwd, ['show', `${commit}:${filePath}`]);
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    return lines;
  } catch {
    return null;
  }
}

function fileCache(cwd: string) {
  const cache = new Map<string, Promise<string[] | null>>();
  return (commit: string, filePath: string) => {
    const key = `${commit}:${filePath}`;
    let hit = cache.get(key);
    if (!hit) {
      hit = fileAt(cwd, commit, filePath);
      cache.set(key, hit);
    }
    return hit;
  };
}

/**
 * Turn a model's reply into a walkthrough. Each anchor's quote is checked
 * against the real file on its side, which moves a misnumbered range to the
 * quoted line and leaves an unfindable one unanchored.
 */
export async function anchorGenerated(
  cwd: string,
  base: string,
  head: string,
  generated: GeneratedWalkthrough,
  meta: { focus: string | null; model: string; headRef?: string | null },
): Promise<Walkthrough> {
  const read = fileCache(cwd);
  const resolve = async (g: GeneratedAnchor): Promise<Anchor | null> => {
    const commit = g.side === 'old' ? base : head;
    const lines = await read(commit, g.path);
    if (!lines) return null;
    const [claimedStart, claimedEnd] = g.lines;
    const start = locateQuote(lines, claimedStart, g.quote);
    if (start === null) return null;
    const end = Math.min(lines.length, start + Math.max(0, claimedEnd - claimedStart));
    return { path: g.path, side: g.side, commit, lines: [start, end], snippet: extractSnippet(lines, [start, end]) };
  };

  const steps: Step[] = [];
  for (const [i, g] of generated.steps.entries()) {
    const id = `s${i + 1}`;
    const anchor = g.anchor ? await resolve(g.anchor) : null;
    const comments: Comment[] = [];
    let body = g.body;
    for (const c of g.comments) {
      const commentAnchor = await resolve(c.anchor);
      if (commentAnchor) {
        comments.push({
          id: `${id}c${comments.length + 1}`,
          kind: c.kind,
          body: c.body,
          author: 'agent',
          anchor: commentAnchor,
          review: null,
        });
      } else {
        // The remark survives in the step's text even though its lines did not.
        body += `\n\n**${c.kind}:** ${c.body}`;
      }
    }
    steps.push({
      id,
      kind: g.kind,
      chapter: g.chapter,
      title: g.title,
      body,
      anchor,
      ...(g.anchor && !anchor ? { unverified: true as const } : {}),
      comments,
    });
  }

  return {
    version: 1,
    title: generated.title,
    summary: generated.summary,
    change: { base, head, headRef: meta.headRef ?? null, pr: null },
    focus: meta.focus,
    generatedAt: new Date().toISOString(),
    generator: { kind: 'cold', model: meta.model },
    steps,
  };
}

interface FileSection {
  oldPath: string;
  newPath: string | null;
  text: string;
}

function fileSections(diff: string): FileSection[] {
  return diff
    .split(/^(?=diff --git )/m)
    .filter((s) => s.startsWith('diff --git '))
    .map((text) => {
      const header = text.match(/^diff --git a\/(.+) b\/(.+)$/m);
      const renameFrom = text.match(/^rename from (.+)$/m)?.[1];
      const renameTo = text.match(/^rename to (.+)$/m)?.[1];
      const deleted = /^deleted file mode/m.test(text);
      return {
        oldPath: renameFrom ?? header?.[1] ?? '',
        newPath: deleted ? null : (renameTo ?? header?.[2] ?? null),
        text,
      };
    });
}

async function bySnippet(cwd: string, anchor: Anchor, target: string, targetPath: string): Promise<Remapped> {
  const lines = await fileAt(cwd, target, targetPath);
  const length = anchor.lines[1] - anchor.lines[0] + 1;
  const found = lines ? matchSnippet(lines, anchor.snippet, length) : null;
  if (!found) return { anchor: null, status: 'lost' };
  return { anchor: { ...anchor, path: targetPath, commit: target, lines: found }, status: 'fuzzy' };
}

/**
 * Where an anchor's lines are in `target`. Git's own diff decides while the
 * anchor's commit exists. The snippet decides only when it does not, or when
 * the file was renamed, and then only on a unique match.
 */
export async function remapAnchor(cwd: string, anchor: Anchor, target: string): Promise<Remapped> {
  if (target === anchor.commit) return { anchor, status: 'exact' };
  if (!(await succeeds(cwd, ['cat-file', '-e', `${anchor.commit}^{commit}`]))) {
    return bySnippet(cwd, anchor, target, anchor.path);
  }

  const diff = await git(cwd, ['diff', '-U0', '-M', '--no-color', '--no-ext-diff', anchor.commit, target]);
  const section = fileSections(diff).find((s) => s.oldPath === anchor.path);
  if (!section) return { anchor: { ...anchor, commit: target }, status: 'exact' };
  if (section.newPath === null) return { anchor: null, status: 'lost' };
  if (section.newPath !== anchor.path) return bySnippet(cwd, anchor, target, section.newPath);

  const moved = shiftRange(anchor.lines, parseZeroContextHunks(section.text));
  if (!moved) return { anchor: null, status: 'lost' };
  const status = moved[0] === anchor.lines[0] ? 'exact' : 'shifted';
  return { anchor: { ...anchor, commit: target, lines: moved }, status };
}

export async function currentHead(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', 'HEAD'])).trim();
}

export async function assessStaleness(cwd: string, w: Walkthrough): Promise<Staleness> {
  const head = await currentHead(cwd);
  const dirty = (await git(cwd, ['status', '--porcelain'])).trim() !== '';
  if (head === w.change.head) return { state: 'current', currentHead: head, dirty };
  if (await succeeds(cwd, ['merge-base', '--is-ancestor', w.change.head, head])) {
    const count = Number((await git(cwd, ['rev-list', '--count', `${w.change.head}..${head}`])).trim());
    return { state: 'ahead', currentHead: head, commitsAhead: count, dirty };
  }
  return { state: 'rebased', currentHead: head, dirty };
}
