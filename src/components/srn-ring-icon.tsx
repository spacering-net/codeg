import { cn } from "@/lib/utils"

/**
 * The SRN ring: SpaceRing's mark exactly as spacering.net's `favicon.svg`
 * draws it — the band as an even-odd ellipse pair tilted 30°, the node cut
 * out of the band at its lower left, and the inner wall's highlight in the
 * band's own colour. `currentColor`, so it takes the status bar's tone.
 *
 * The view box is the favicon's, cropped to a square around the band, which
 * fills it edge to edge; at `size-3.5` it therefore sits on the same
 * 0.875rem square every other status-bar glyph does.
 */
export function SrnRingIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="41 41 430 430"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className={cn("shrink-0", className)}
    >
      <path
        fillRule="evenodd"
        d="M447.95 366.91A221.8 192.09 30 0 1 159.82 422.36A221.8 192.09 30 0 1 63.78 145.11A221.8 192.09 30 0 1 351.91 89.66A221.8 192.09 30 0 1 447.95 366.91ZM416.77 323.09A172.89 149.73 30 0 0 341.91 106.98A172.89 149.73 30 0 0 117.32 150.2A172.89 149.73 30 0 0 192.18 366.31A172.89 149.73 30 0 0 416.77 323.09ZM188.32 413A20 10 30 0 0 176 394.34A20 10 30 0 0 153.68 393A20 10 30 0 0 166 411.66A20 10 30 0 0 188.32 413Z"
      />
      <path d="M134.69 146.1A160.53 137.37 30 0 1 411.63 305.99A172.89 149.73 30 0 0 134.69 146.1Z" />
    </svg>
  )
}
