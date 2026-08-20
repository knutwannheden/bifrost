import type { DiffFile, DiffSummary } from './types.js';

/**
 * Parse a unified diff string into a structured DiffSummary.
 */
export function parseDiff(diffText: string): DiffSummary {
  const files: DiffFile[] = [];
  const lines = diffText.split('\n');

  let currentFile: DiffFile | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // New file header
    if (line.startsWith('diff --git ')) {
      if (currentFile) files.push(currentFile);
      // Extract b/ path — the destination path
      const match = line.match(/diff --git a\/.+ b\/(.+)/);
      const path = match ? match[1] : 'unknown';
      currentFile = {
        path,
        linesAdded: 0,
        linesRemoved: 0,
        isNew: false,
        isDeleted: false,
        addedLines: [],
      };
      continue;
    }

    if (!currentFile) continue;

    // Detect new/deleted files
    if (line.startsWith('new file mode')) {
      currentFile.isNew = true;
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      currentFile.isDeleted = true;
      continue;
    }

    // Handle renames — update path to the destination
    if (line.startsWith('rename to ')) {
      currentFile.path = line.slice('rename to '.length);
      continue;
    }

    // Skip diff metadata lines
    if (
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line.startsWith('@@ ') ||
      line.startsWith('similarity index') ||
      line.startsWith('rename from ')
    ) {
      continue;
    }

    // Count additions and removals
    if (line.startsWith('+')) {
      currentFile.linesAdded++;
      currentFile.addedLines.push(line.slice(1));
    } else if (line.startsWith('-')) {
      currentFile.linesRemoved++;
    }
  }

  if (currentFile) files.push(currentFile);

  const totalAdded = files.reduce((sum, f) => sum + f.linesAdded, 0);
  const totalRemoved = files.reduce((sum, f) => sum + f.linesRemoved, 0);

  return { totalAdded, totalRemoved, files };
}
