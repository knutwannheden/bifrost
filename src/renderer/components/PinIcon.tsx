export default function PinIcon({ size = 12, filled = false }: { size?: number; filled?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 2.5h4v3.5l2 2.5v1H4v-1l2-2.5V2.5z" fill={filled ? 'currentColor' : 'none'} />
      <path d="M5 2.5h6M8 9.5V14" />
    </svg>
  );
}
