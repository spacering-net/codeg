"use client"

/**
 * The Harness page's sections, and what can be asked of them from outside.
 *
 * Harness is the workbench route that holds what an agent is extended with:
 * the SpaceRing Harness catalog ("Discover"), and what codeg manages on the
 * workspace's own host — MCP servers, skills, plugins and skill packs.
 * This module is the part of it with no React in it: which sections exist,
 * which one the page lands on, and the shape of a request to open one.
 */

const SECTION_KEY = "workspace:harness-section"

/** Every section, in display order. Each id doubles as its
 *  `Harness.sections` message key. */
export const HARNESS_SECTION_IDS = [
  "discover",
  "mcp",
  "skills",
  "plugins",
  "packs",
] as const

export type HarnessSectionId = (typeof HARNESS_SECTION_IDS)[number]

const SECTIONS_WITHOUT_DISCOVER: readonly HarnessSectionId[] =
  HARNESS_SECTION_IDS.filter((id) => id !== "discover")

export function isHarnessSectionId(value: unknown): value is HarnessSectionId {
  return (HARNESS_SECTION_IDS as readonly unknown[]).includes(value)
}

/**
 * The sections a window offers. Discover is the only optional one: an operator
 * whose deployment may not reach spacering.net switches the catalog off
 * (`CODEG_HARNESS=off`), and the page keeps the three sections that only read
 * and write files on the host.
 *
 * Both answers are module constants, so the list's identity only changes when
 * the switch does.
 */
export function harnessSectionsFor(
  discoverEnabled: boolean
): readonly HarnessSectionId[] {
  return discoverEnabled ? HARNESS_SECTION_IDS : SECTIONS_WITHOUT_DISCOVER
}

/** Where the page lands with nothing remembered: Discover, or MCP in a window
 *  that has no Discover. */
export function defaultHarnessSection(
  discoverEnabled: boolean
): HarnessSectionId {
  return discoverEnabled ? "discover" : "mcp"
}

/**
 * The section to show: the remembered one while this window still offers it,
 * the default otherwise. Derived on every read rather than written back, so a
 * remembered Discover survives the catalog being switched off and on again.
 */
export function resolveHarnessSection(
  remembered: HarnessSectionId | null,
  discoverEnabled: boolean
): HarnessSectionId {
  if (
    remembered !== null &&
    harnessSectionsFor(discoverEnabled).includes(remembered)
  ) {
    return remembered
  }
  return defaultHarnessSection(discoverEnabled)
}

/** The section last used on this device, or `null` before the first switch —
 *  and for anything unrecognized, so a value from a future version reads as a
 *  first visit rather than as a section that is not there. */
export function loadHarnessSection(): HarnessSectionId | null {
  if (typeof window === "undefined") return null
  try {
    const raw = localStorage.getItem(SECTION_KEY)
    return isHarnessSectionId(raw) ? raw : null
  } catch {
    return null
  }
}

export function saveHarnessSection(section: HarnessSectionId): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(SECTION_KEY, section)
  } catch {
    /* ignore */
  }
}

/**
 * The skill-pack tabs a caller can ask for. "Custom" is not one of them: the
 * user's own skills are in the Skills section now, and a request that still
 * names that tab opens Experts (see {@link harnessTargetOf}).
 */
export const HARNESS_PACK_TABS = ["experts", "science", "office", "ui"] as const

export type HarnessPackTab = (typeof HARNESS_PACK_TABS)[number]

export function isHarnessPackTab(value: unknown): value is HarnessPackTab {
  return (HARNESS_PACK_TABS as readonly unknown[]).includes(value)
}

/**
 * What a request for a Harness item wants done with it beyond showing it.
 * `install` comes from the "Open in Codeg" links: the item is shown, and the
 * install confirmation may be offered — installing itself is always the
 * user's decision, made inside Codeg, since any web page can send such a link.
 */
export type HarnessOpenIntent = "install"

/**
 * What `openHarness` can be asked for: a section, and optionally the one thing
 * to open inside it. Each section takes its own kind of target, so a request
 * can never pair a section with something it does not hold.
 */
export type HarnessOpenRequest =
  | {
      section: "discover"
      /** A Harness item, as `publisher/name`. */
      itemRef?: string
      intent?: HarnessOpenIntent
    }
  | {
      section: "mcp"
      /** An MCP server's key in the agents' configuration. */
      serverKey?: string
    }
  | {
      section: "skills"
      /** A skill's id — the name of its directory. */
      skillId?: string
    }
  | {
      section: "plugins"
      /** An installed plugin's Harness item id. */
      itemId?: string
    }
  | {
      section: "packs"
      tab?: HarnessPackTab
    }

/**
 * The target a request carried, parked until its section applies it. Always a
 * fresh object (see {@link harnessTargetOf}): its identity stands for one
 * request, which is what lets asking for the same thing twice open it twice.
 */
export type HarnessOpenTarget =
  | { section: "discover"; itemRef: string; intent?: HarnessOpenIntent }
  | { section: "mcp"; serverKey: string }
  | { section: "skills"; skillId: string }
  | { section: "plugins"; itemId: string }
  | { section: "packs"; tab: HarnessPackTab }

/** The kind of target one section takes. */
export type HarnessTargetFor<S extends HarnessSectionId> = Extract<
  HarnessOpenTarget,
  { section: S }
>

/**
 * The target a request names, or `null` when it only names a section. An empty
 * string and an unknown tab count as no target: requests are built from links
 * and stored values as well as from code, and one that names nothing usable
 * should open the section as it is rather than park something no section can
 * apply.
 */
export function harnessTargetOf(
  request: HarnessOpenRequest
): HarnessOpenTarget | null {
  switch (request.section) {
    case "discover":
      if (!request.itemRef) return null
      // Only an intent this build knows travels on, for the same reason.
      return request.intent === "install"
        ? { section: "discover", itemRef: request.itemRef, intent: "install" }
        : { section: "discover", itemRef: request.itemRef }
    case "mcp":
      return request.serverKey
        ? { section: "mcp", serverKey: request.serverKey }
        : null
    case "skills":
      return request.skillId
        ? { section: "skills", skillId: request.skillId }
        : null
    case "plugins":
      return request.itemId
        ? { section: "plugins", itemId: request.itemId }
        : null
    case "packs":
      if (isHarnessPackTab(request.tab)) {
        return { section: "packs", tab: request.tab }
      }
      // The Custom tab is gone (its skills are in the Skills section): a link
      // or a stored value that still asks for it lands on the first pack
      // rather than on whichever one was left open.
      return (request.tab as string | undefined) === "custom"
        ? { section: "packs", tab: "experts" }
        : null
    default:
      return null
  }
}
