interface CloseButtonProps {
  onClick: () => void;
  className?: string;
}

export default function CloseButton({ onClick, className = '' }: CloseButtonProps) {
  return (
    <button
      onClick={onClick}
      tabIndex={-1}
      className={`text-secondary hover:text-primary text-lg leading-none transition-colors ${className}`}
    >
      &times;
    </button>
  );
}
