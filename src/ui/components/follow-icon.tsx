type Props = {
  size?: number;
};

export function FollowIcon({ size = 13 }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M3 12h5" />
      <path d="M16 12h5" />
      <circle cx="12" cy="12" r="3.2" />
    </svg>
  );
}
