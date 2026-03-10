export default function OverlayFooter({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`px-4 pb-3 pt-2 border-t border-border-default ${className}`}>{children}</div>;
}
