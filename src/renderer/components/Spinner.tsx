type SpinnerSize = 'sm' | 'md';

/** Animated loading spinner. */
export default function Spinner({ size = 'md', className }: { size?: SpinnerSize; className?: string }) {
  const sizeClass = size === 'sm' ? 'w-3 h-3 border' : 'w-4 h-4 border-2';
  return (
    <div className={`${sizeClass} border-slate-500 border-t-slate-200 rounded-full animate-spin flex-shrink-0 ${className ?? ''}`} />
  );
}
