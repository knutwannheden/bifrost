/** Inline search indicator bar shown when the user types to filter a list. */
export default function SearchIndicator({
  search,
  matchInfo,
  className,
}: {
  search: string;
  matchInfo?: string;
  className?: string;
}) {
  if (!search) return null;
  return (
    <div
      className={`px-3 py-1.5 bg-surface-alt/70 border border-border-input rounded flex items-center gap-2 ${className ?? ''}`}
    >
      <span className="text-xs text-secondary">Search:</span>
      <span className="text-sm text-primary">{search}</span>
      {matchInfo && <span className="text-xs text-faint">{matchInfo}</span>}
      <span className="ml-auto text-xs text-faint">Esc to clear</span>
    </div>
  );
}
