interface DiffStatsBadgeProps {
  additions: number;
  deletions: number;
  className?: string;
}

export default function DiffStatsBadge({ additions, deletions, className = '' }: DiffStatsBadgeProps) {
  if (additions === 0 && deletions === 0) return null;

  return (
    <span className={`inline-flex items-center gap-1 bg-surface-alt/80 rounded-full px-2 py-0.5 text-xs ${className}`}>
      {additions > 0 && <span className="text-success">+{additions}</span>}
      {deletions > 0 && <span className="text-danger">-{deletions}</span>}
    </span>
  );
}
