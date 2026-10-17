"use client"

/**
 * The "what mode should a NEW session start in" preference, per agent plus a
 * global full-access (Yolo) switch. Deliberately SEPARATE from
 * selector-prefs-storage: that store is the user's last MANUAL pick and feeds
 * every reconnect; this one only speaks for sessions that have no manual pick
 * yet. Precedence is manual-saved > default setting > agent's own default.
 *
 * The Yolo switch cannot name mode ids itself — each CLI calls full access
 * something else (zcode `yolo`, codex `danger-full-access`, claude
 * `bypassPermissions`) and the valid ids are only known from the agent's
 * advertised modes list (see agent-modes-cache). So the switch is stored as an
 * intent, and resolved by matching the cached list against a fixed weight
 * order of well-known substrings. Unmatched agents stay on their default and
 * the settings page says so — no blind id guessing, the backend would
 * silently drop a wrong preferred id.
 */

const STORAGE_KEY = "codeg:default-mode-prefs"

/** Substrings that identify a full-access mode, in match priority order. */
export const FULL_ACCESS_WEIGHTS = [
  "danger",
  "bypass",
  "yolo",
  "full",
  "access",
] as const

export interface DefaultModePrefs {
  /** Per-agentType explicit default mode id; null = follow the Yolo switch. */
  modeByAgent: Record<string, string | null>
  /** Global full-access switch. */
  yoloEnabled: boolean
}

const DEFAULTS: DefaultModePrefs = { modeByAgent: {}, yoloEnabled: false }

let prefs: DefaultModePrefs | null = null

function read(): DefaultModePrefs {
  if (prefs) return prefs
  if (typeof window === "undefined") return DEFAULTS
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return (prefs = DEFAULTS)
    const parsed = JSON.parse(raw) as Partial<DefaultModePrefs>
    prefs = {
      modeByAgent:
        parsed.modeByAgent && typeof parsed.modeByAgent === "object"
          ? parsed.modeByAgent
          : {},
      yoloEnabled: parsed.yoloEnabled === true,
    }
    return prefs
  } catch {
    return (prefs = DEFAULTS)
  }
}

function write(next: DefaultModePrefs) {
  prefs = next
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    /* ignore */
  }
}

export function isYoloEnabled(): boolean {
  return read().yoloEnabled
}

export function setYoloEnabled(on: boolean) {
  write({ ...read(), yoloEnabled: on })
}

/** Explicit per-agent default; null when the user never pinned one. */
export function getAgentDefaultMode(agentType: string): string | null {
  return read().modeByAgent[agentType] ?? null
}

export function setAgentDefaultMode(agentType: string, modeId: string | null) {
  const next = { ...read().modeByAgent }
  if (modeId == null) delete next[agentType]
  else next[agentType] = modeId
  write({ ...read(), modeByAgent: next })
}

/** Drop every explicit per-agent pin ("clear manual values" affordance). */
export function clearAllAgentDefaultModes() {
  write({ ...read(), modeByAgent: {} })
}

/**
 * Match a full-access mode among the advertised ids. Weight order decides
 * between multiple hits (an agent offering both `yolo` and
 * `danger-full-access` gets the `danger` one); ties resolve by list order so
 * the result is stable across restarts.
 */
export function matchFullAccessMode(modeIds: readonly string[]): string | null {
  for (const weight of FULL_ACCESS_WEIGHTS) {
    for (const id of modeIds) {
      if (id.toLowerCase().includes(weight)) return id
    }
  }
  return null
}

/**
 * The mode id a NEW session for this agent should request, given the modes
 * the agent advertised last time. Null = no preference resolvable — the
 * caller passes no preferred id and the agent uses its own default.
 *
 * Priority: explicit per-agent pin > Yolo match > nothing.
 */
export function resolveDefaultModeForAgent(
  agentType: string,
  advertisedModeIds: readonly string[]
): string | null {
  const pinned = getAgentDefaultMode(agentType)
  if (pinned) {
    return advertisedModeIds.includes(pinned) ? pinned : null
  }
  if (isYoloEnabled()) return matchFullAccessMode(advertisedModeIds)
  return null
}
