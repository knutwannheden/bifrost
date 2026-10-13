/**
 * A diff shows hunks with the file between them left out, so a construct opened
 * in one hunk and closed in the gap must not colour the hunks below it.
 * Run with `npm run check:syntax-highlight`.
 */
import { highlightLines } from '../src/renderer/utils/syntax-highlight.ts';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}${ok || !detail ? '' : `\n  ${detail}`}`);
}

/** github-dark's comment colour, which is what an unclosed javadoc spreads. */
const COMMENT = '#6A737D';

const colours = (tokens: { color: string }[]) => tokens.map((t) => t.color);

{
  // The control for the check below: a comment the grammar can close is the
  // comment colour, so finding that colour elsewhere means something.
  const tokens = await highlightLines([['/**', ' * doc', ' */']], 'java');
  check(
    'a closed comment is comment-coloured',
    tokens.length === 3 && tokens.every((line) => colours(line).every((c) => c === COMMENT)),
    tokens.map((l) => colours(l).join(' ')).join(' | '),
  );
}

{
  const tokens = await highlightLines(
    [
      ['import java.util.stream.Stream;', '/**'],
      ['public class GoBuildStep {', '    Duration timeout = requireNonNull(TIMEOUT);'],
    ],
    'java',
  );
  check(
    'a comment left open by one hunk does not reach the next',
    tokens.slice(2).every((line) => colours(line).some((c) => c !== COMMENT)),
    tokens
      .slice(2)
      .map((l) => colours(l).join(' '))
      .join(' | '),
  );
}

{
  // Both callers index this by a running line number across every hunk.
  const tokens = await highlightLines([['a', 'b'], ['c']], 'java');
  check('one token array comes back per line, hunks flattened', tokens.length === 3, `${tokens.length} lines`);

  const plain = await highlightLines([['a', 'b'], ['c']], 'nosuchext');
  check(
    'a language Shiki does not know leaves one token per line',
    plain.length === 3 && plain.every((line) => line.length === 1),
    `${plain.length} lines`,
  );
}

process.exit(failed === 0 ? 0 : 1);
