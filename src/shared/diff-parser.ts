export type DiffFileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface DiffFile {
  oldPath: string;
  newPath: string;
  status: DiffFileStatus;
  binary: boolean;
  hunks: DiffHunk[];
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export interface DiffLine {
  type: 'add' | 'remove' | 'context';
  content: string;
  oldLineNo: number | null;
  newLineNo: number | null;
}

const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

/** The C string git quotes a path as, opening at `start`. Its octal escapes are the bytes of UTF-8. */
function readQuoted(s: string, start: number): { value: string; end: number } {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  let i = start + 1;
  while (i < s.length && s[i] !== '"') {
    if (s[i] === '\\' && /[0-7]/.test(s[i + 1] ?? '')) {
      bytes.push(parseInt(s.slice(i + 1, i + 4), 8));
      i += 4;
    } else if (s[i] === '\\') {
      bytes.push(C_ESCAPES[s[i + 1]] ?? s.charCodeAt(i + 1));
      i += 2;
    } else {
      const char = String.fromCodePoint(s.codePointAt(i) ?? 0);
      bytes.push(...encoder.encode(char));
      i += char.length;
    }
  }
  return { value: new TextDecoder().decode(new Uint8Array(bytes)), end: i + 1 };
}

function withoutPrefix(name: string, prefix: 'a/' | 'b/'): string {
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

/**
 * A path from a `---` or `+++` line, or null for /dev/null. git quotes a name
 * with unusual bytes, and ends an unquoted name holding a space with a TAB.
 */
function markerPath(raw: string, prefix: 'a/' | 'b/'): string | null {
  const name = raw.startsWith('"') ? readQuoted(raw, 0).value : raw.replace(/\t$/, '');
  return name === '/dev/null' ? null : withoutPrefix(name, prefix);
}

/** The two paths of a `diff --git` line, either of which git may have quoted. */
function gitHeaderPaths(line: string): [string, string] {
  const rest = line.slice('diff --git '.length);
  if (rest.startsWith('"')) {
    const a = readQuoted(rest, 0);
    const b = rest.slice(a.end + 1);
    return [withoutPrefix(a.value, 'a/'), withoutPrefix(b.startsWith('"') ? readQuoted(b, 0).value : b, 'b/')];
  }
  // An unquoted name holds no quote, so ` "` can only open a quoted second path.
  const quotedB = rest.endsWith('"') ? rest.lastIndexOf(' "') : -1;
  if (quotedB > 0) {
    return [withoutPrefix(rest.slice(0, quotedB), 'a/'), withoutPrefix(readQuoted(rest, quotedB + 1).value, 'b/')];
  }
  const match = rest.match(/^a\/(.+) b\/(.+)$/);
  return [match?.[1] ?? '', match?.[2] ?? ''];
}

export function parseDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = raw.split('\n');
  let i = 0;

  while (i < lines.length) {
    // Look for "diff --git" header
    if (!lines[i].startsWith('diff --git ')) {
      i++;
      continue;
    }

    const [oldPath, newPath] = gitHeaderPaths(lines[i]);
    const file: DiffFile = {
      oldPath,
      newPath,
      status: 'modified',
      binary: false,
      hunks: [],
    };
    i++;

    // Skip index, --- and +++ lines, detecting file status and binary markers
    while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('diff --git ')) {
      if (lines[i].startsWith('new file mode') || lines[i] === '--- /dev/null') {
        file.status = 'added';
      } else if (lines[i].startsWith('deleted file mode') || lines[i] === '+++ /dev/null') {
        file.status = 'deleted';
      } else if (lines[i].startsWith('rename from') || lines[i].startsWith('rename to')) {
        file.status = 'renamed';
      } else if (lines[i].startsWith('Binary files ')) {
        file.binary = true;
      } else if (lines[i] === 'GIT binary patch') {
        file.binary = true;
      }
      if (lines[i].startsWith('--- ')) {
        file.oldPath = markerPath(lines[i].slice(4), 'a/') ?? file.oldPath;
      } else if (lines[i].startsWith('+++ ')) {
        file.newPath = markerPath(lines[i].slice(4), 'b/') ?? file.newPath;
      }
      i++;
    }

    // Parse hunks
    while (i < lines.length && !lines[i].startsWith('diff --git ')) {
      if (lines[i].startsWith('@@')) {
        const hunkMatch = lines[i].match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        const hunk: DiffHunk = {
          header: lines[i],
          oldStart: parseInt(hunkMatch?.[1] ?? '1', 10),
          newStart: parseInt(hunkMatch?.[2] ?? '1', 10),
          lines: [],
        };

        let oldLine = hunk.oldStart;
        let newLine = hunk.newStart;
        i++;

        while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('diff --git ')) {
          const line = lines[i];
          if (line.startsWith('+')) {
            hunk.lines.push({
              type: 'add',
              content: line.slice(1),
              oldLineNo: null,
              newLineNo: newLine++,
            });
          } else if (line.startsWith('-')) {
            hunk.lines.push({
              type: 'remove',
              content: line.slice(1),
              oldLineNo: oldLine++,
              newLineNo: null,
            });
          } else if (line.startsWith(' ') || line === '') {
            hunk.lines.push({
              type: 'context',
              content: line.startsWith(' ') ? line.slice(1) : line,
              oldLineNo: oldLine++,
              newLineNo: newLine++,
            });
          } else {
            // Could be "\ No newline at end of file" or other metadata
            i++;
            continue;
          }
          i++;
        }

        file.hunks.push(hunk);
      } else {
        i++;
      }
    }

    files.push(file);
  }

  return files;
}

export function extFromPath(p: string): string {
  const dot = p.lastIndexOf('.');
  return dot >= 0 ? p.slice(dot + 1) : '';
}

export function diffFileStats(file: DiffFile): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.type === 'add') additions++;
      else if (line.type === 'remove') deletions++;
    }
  }
  return { additions, deletions };
}
