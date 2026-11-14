/** Clavium mark: a key on a blue-violet tile (Latin "clavis" = key). Kept in sync with scripts/make-icon.mjs. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-label="Clavium">
      <defs>
        <linearGradient id="clv-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3d6bff" />
          <stop offset="1" stopColor="#8a5bff" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="15" fill="url(#clv-g)" />
      <g fill="none" stroke="#fff" strokeWidth="5.5" strokeLinecap="round">
        <circle cx="22" cy="32" r="9" />
        <path d="M31 32h20M45 32v8M51 32v6" />
      </g>
    </svg>
  )
}
