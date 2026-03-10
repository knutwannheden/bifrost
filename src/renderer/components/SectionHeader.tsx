export default function SectionHeader({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <h3 className={`text-xs font-semibold text-secondary uppercase tracking-wider ${className}`}>{children}</h3>;
}
