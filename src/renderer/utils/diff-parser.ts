export interface DiffFile {
  oldPath: string;
  newPath: string;
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

    const match = lines[i].match(/^diff --git a\/(.+) b\/(.+)$/);
    const file: DiffFile = {
      oldPath: match?.[1] ?? '',
      newPath: match?.[2] ?? '',
      hunks: [],
    };
    i++;

    // Skip index, --- and +++ lines
    while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('diff --git ')) {
      if (lines[i].startsWith('--- a/')) {
        file.oldPath = lines[i].slice(6);
      } else if (lines[i].startsWith('+++ b/')) {
        file.newPath = lines[i].slice(6);
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
