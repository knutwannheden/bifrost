import { searchTerms } from '../utils/search';

/** Highlights all matching search terms within text using multi-word OR matching. */
export default function Highlight({ text, search }: { text: string; search: string }) {
  if (!search) return <>{text}</>;
  const terms = searchTerms(search);
  if (terms.length === 0) return <>{text}</>;
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const regex = new RegExp(`(${escaped.join('|')})`, 'gi');
  const parts = text.split(regex);
  return (
    <>
      {parts.map((part, i) =>
        regex.test(part)
          ? <mark key={i} className="bg-highlight text-inherit rounded-sm">{part}</mark>
          : part,
      )}
    </>
  );
}
