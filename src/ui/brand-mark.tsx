/** Fault mark. Two offset bands. 16px in the header. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path fill="currentColor" d="M2.6 5 H16.8 L14 10.4 H4.8 Z" />
      <path fill="currentColor" d="M7.2 13.6 H21.4 L18.6 19 H9.4 Z" />
    </svg>
  );
}
