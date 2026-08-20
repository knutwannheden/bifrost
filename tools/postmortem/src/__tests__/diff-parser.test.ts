import { describe, expect, it } from 'vitest';
import { parseDiff } from '../diff-parser.js';

describe('parseDiff', () => {
  it('parses a simple unified diff with additions and removals', () => {
    const diff = `diff --git a/src/utils.ts b/src/utils.ts
index abc1234..def5678 100644
--- a/src/utils.ts
+++ b/src/utils.ts
@@ -1,5 +1,6 @@
 import { foo } from "bar";

-export function old() {
-  return 1;
+export function updated() {
+  return 2;
+  // extra line
 }
`;
    const result = parseDiff(diff);
    expect(result.totalAdded).toBe(3);
    expect(result.totalRemoved).toBe(2);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe('src/utils.ts');
    expect(result.files[0].linesAdded).toBe(3);
    expect(result.files[0].linesRemoved).toBe(2);
    expect(result.files[0].isNew).toBe(false);
    expect(result.files[0].isDeleted).toBe(false);
    expect(result.files[0].addedLines).toEqual(['export function updated() {', '  return 2;', '  // extra line']);
  });

  it('parses multiple files', () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
index abc..def 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 line1
+added
 line2
 line3
diff --git a/src/b.ts b/src/b.ts
index abc..def 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,2 +1,2 @@
-old
+new
 keep
`;
    const result = parseDiff(diff);
    expect(result.files).toHaveLength(2);
    expect(result.totalAdded).toBe(2);
    expect(result.totalRemoved).toBe(1);
    expect(result.files[0].path).toBe('src/a.ts');
    expect(result.files[1].path).toBe('src/b.ts');
  });

  it('detects new files', () => {
    const diff = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,3 @@
+line1
+line2
+line3
`;
    const result = parseDiff(diff);
    expect(result.files[0].isNew).toBe(true);
    expect(result.files[0].isDeleted).toBe(false);
    expect(result.files[0].linesAdded).toBe(3);
    expect(result.files[0].linesRemoved).toBe(0);
  });

  it('detects deleted files', () => {
    const diff = `diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
index abc1234..0000000
--- a/src/old.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-line1
-line2
`;
    const result = parseDiff(diff);
    expect(result.files[0].isNew).toBe(false);
    expect(result.files[0].isDeleted).toBe(true);
    expect(result.files[0].linesRemoved).toBe(2);
    expect(result.files[0].linesAdded).toBe(0);
  });

  it('handles empty diff', () => {
    const result = parseDiff('');
    expect(result.totalAdded).toBe(0);
    expect(result.totalRemoved).toBe(0);
    expect(result.files).toHaveLength(0);
  });

  it('handles rename with changes', () => {
    const diff = `diff --git a/src/old-name.ts b/src/new-name.ts
similarity index 80%
rename from src/old-name.ts
rename to src/new-name.ts
index abc..def 100644
--- a/src/old-name.ts
+++ b/src/new-name.ts
@@ -1,3 +1,3 @@
 unchanged
-old line
+new line
 unchanged
`;
    const result = parseDiff(diff);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe('src/new-name.ts');
    expect(result.files[0].linesAdded).toBe(1);
    expect(result.files[0].linesRemoved).toBe(1);
  });
});
