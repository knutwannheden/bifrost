export default function FlaskIcon({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className="text-success opacity-70" fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M6 1h4v1H9v4l3.5 6.5a1 1 0 0 1-.9 1.5H4.4a1 1 0 0 1-.9-1.5L7 6V2H6V1z" />
      <path d="M5.5 10.5L7.5 7h1l2 3.5a1 1 0 0 1-.9 1.5H6.4a1 1 0 0 1-.9-1.5z" fill="currentColor" opacity="0.5" stroke="none" />
    </svg>
  );
}
