import { emphasize, type WordRange } from '../utils/inline-diff';
import type { HighlightedToken } from '../utils/syntax-highlight';

/** One diff line's syntax tokens, with the words it differs from its counterpart by on `changedBg`. */
export default function DiffLineTokens({
  tokens,
  ranges,
  changedBg,
}: {
  tokens: readonly HighlightedToken[];
  ranges: WordRange[] | null;
  changedBg: string;
}) {
  return (
    <>
      {emphasize(tokens, ranges).map((segment, i) => (
        <span key={i} className={segment.changed ? changedBg : undefined} style={{ color: segment.color }}>
          {segment.content}
        </span>
      ))}
    </>
  );
}
