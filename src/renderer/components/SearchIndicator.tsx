/** Inline search indicator bar shown when the user types to filter a list. */
export default function SearchIndicator({ search, matchInfo, className }: {
  search: string;
  matchInfo?: string;
  className?: string;
}) {
  if (!search) return null;
  return (
    <div className={`px-3 py-1.5 bg-slate-700/70 border border-slate-600 rounded flex items-center gap-2 ${className ?? ''}`}>
      <span className="text-xs text-slate-500">Search:</span>
      <span className="text-sm text-slate-200">{search}</span>
      {matchInfo && <span className="text-xs text-slate-600">{matchInfo}</span>}
      <span className="ml-auto text-xs text-slate-600">Esc to clear</span>
    </div>
  );
}
