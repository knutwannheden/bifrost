export default function PinIcon({ size = 11 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10 1.5 14.5 6l-2 1-1 3.5-5-5L10 3.5z" />
      <path d="M6.5 5.5 1.5 14.5" />
    </svg>
  );
}
