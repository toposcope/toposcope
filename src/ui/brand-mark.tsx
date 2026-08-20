/** Skyline mark (Brand C). 14px in the header; 16px floor is mark-only. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <g fill="none" stroke="currentColor" strokeLinecap="round">
        <path d="M2.8 19.4H21.2" strokeWidth="1.6" opacity="0.6" />
        <g strokeWidth="2.4" opacity="0.6" strokeLinecap="butt">
          <path d="M6.2 19.4V13.2" />
          <path d="M15 19.4V10.4" />
          <path d="M19.4 19.4V13.8" />
        </g>
        <path d="M10.6 19.4V6.6" strokeWidth="2.4" strokeLinecap="butt" />
      </g>
    </svg>
  );
}
