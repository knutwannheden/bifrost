import { searchTerms } from '../utils/search';

/** Highlights all matching search terms within text using multi-word OR matching. */
export default function Highlight({ text, search }: { text: string; search: string }) {
  if (!search) return <>{text}</>;
  const terms = searchTerms(search);
  if (terms.length === 0) return <>{text}</>;
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`(${escaped.join('|')})`, 'gi');
  const parts = text.split(pattern);
  const testRegex = new RegExp(`^(?:${escaped.join('|')})$`, 'i');
  return (
    <span>
      {parts.map((part, i) =>
        testRegex.test(part) ? (
          <span key={i} className="bg-highlight rounded-sm">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </span>
  );
}
