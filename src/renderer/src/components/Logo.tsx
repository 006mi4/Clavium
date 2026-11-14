/** Clavium mark: a key on a blue tile (Latin "clavis" = key). Kept in sync with scripts/make-icon.mjs. */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id="clv-g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3f97ff" />
          <stop offset="1" stopColor="#0b5fd8" />
        </linearGradient>
      </defs>
      <rect x="3" y="3" width="58" height="58" rx="14" fill="url(#clv-g)" />
      <g fill="none" stroke="#fff" strokeWidth="5.5" strokeLinecap="round">
        <circle cx="22" cy="32" r="9" />
        <path d="M31 32h20M45 32v8M51 32v6" />
      </g>
    </svg>
  )
}
