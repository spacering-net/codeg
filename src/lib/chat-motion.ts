/**
 * Motion in the conversation view: whether it may play, and how it moves.
 *
 * Two switches turn it off. Settings → Appearance → "Chat animations" puts
 * `data-chat-animations="off"` on <html> (globals.css drops every CSS
 * animation and transition inside `.chat-motion-scope`), and the system's
 * reduced-motion preference does the same through media queries. Script-driven
 * motion (`element.animate`) is out of reach of both stylesheets, so it asks
 * here before it plays; components ask `useChatMotion`.
 */

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)"

/** Whether script-driven motion may play right now. */
export function chatMotionAllowed(): boolean {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return false
  }
  if (document.documentElement.getAttribute("data-chat-animations") === "off") {
    return false
  }
  return !window.matchMedia?.(REDUCED_MOTION_QUERY).matches
}

/**
 * How things move. Long enough to follow, short enough that a reply which
 * changes shape several times a second never lags behind itself; every curve
 * decelerates, so a thing arrives rather than stops.
 */
export const CHAT_MOTION = {
  /** A thing that moved, gliding from where it was to where it is now. */
  move: { duration: 300, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
  /** A thing that appeared: it fades in, rising this far (px). */
  enter: {
    duration: 240,
    easing: "cubic-bezier(0.22, 1, 0.36, 1)",
    rise: 4,
  },
} as const
