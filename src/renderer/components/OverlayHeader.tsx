import CloseButton from './CloseButton';

export default function OverlayHeader({
  title,
  onClose,
  children,
  className = '',
}: {
  title: string;
  onClose: () => void;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex items-center justify-between px-4 py-3 border-b border-border-default ${className}`}>
      <h2 className="text-sm font-semibold text-primary">{title}</h2>
      <div className="flex items-center gap-2">
        {children}
        <CloseButton onClick={onClose} />
      </div>
    </div>
  );
}
