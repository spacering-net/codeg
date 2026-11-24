// The ONE decision function behind every http(s) click in the app: transcript
// links, tool cards, the terminal, notifications. Synchronous and pure — the
// caller supplies a snapshot of preferences and of the surface it sits in, and
// gets back an action to execute INSIDE THE CLICK'S OWN CALL STACK (a system
// target must reach `window.open` / `openUrl` before the user gesture expires;
// WebKit's popup blocker swallows anything a microtask later, see issue #410).
//
// Order, and why it is fixed:
//   1. classify — identical to what `link-safety.tsx` has always done, so a
//      local path still opens the file panel, `mailto:`/`tel:` still go to the
//      OS, and an unknown scheme (`vscode:`, `javascript:` …) is still refused
//      rather than handed to the OS.
//   2. terminal rules — a `block` site rule (the administrator's table is
//      consulted before the user's), or a loopback/private address seen from a
//      window bound to a REMOTE codeg-server, or a loopback http address seen
//      from a browser whose codeg-server bridges its ports. These cannot be
//      inverted by the modifier key: flipping a remote `localhost:3000` to
//      the system browser would only ever hit the local machine's loopback.
//   3. base target — an explicit menu choice, else a site rule, else the
//      per-source preference; without a built-in browser it is always `system`.
//   4. modifier — ⌘ (macOS) / Ctrl (elsewhere) inverts an ordinary preference.
//   5. placement — the file column when it is on screen, else the transcript's
//      own viewer drawer (full-page routes), else the column anyway.

import { isLoopbackHost, isRemoteHostName } from "@/lib/browser/browser-url"
import type {
  BrowserPrefsSnapshot,
  LinkSource,
  LinkTarget,
} from "@/lib/browser/browser-prefs"
import { matchHostRule, type HostRule } from "@/lib/browser/host-rules"
import { classifyLinkTarget, type LocalFileTarget } from "@/lib/link-classify"

export { matchHostRule }
export type { HostRule }

export interface LinkSurface {
  /** `browser_capabilities().available` on desktop; false in web mode. */
  builtinAvailable: boolean
  /** The workspace file column is on screen (conversations route). */
  fileColumnVisible: boolean
  /** A session viewer host can render the file/browser drawer instead. */
  viewerHostAvailable: boolean
  /** The window is bound to a remote codeg-server (`isRemoteDesktopMode()`). */
  remoteDesktop: boolean
  /** That server's own host name — reached directly by this computer, so an
   *  address on it is not one of the remote host's private ones (see
   *  `isRemoteHostName`). */
  remoteServerHost?: string | null
  /** Web mode, and the codeg-server bridges its loopback ports so a dev
   *  server there can be shown in a tab (`bridgeStatus().enabled`). */
  bridgeAvailable?: boolean
}

export interface ResolveLinkContext {
  source: LinkSource
  /** Primary modifier held during the gesture: ⌘ on macOS, Ctrl elsewhere. */
  modifier: boolean
  surface: LinkSurface
  prefs: Pick<BrowserPrefsSnapshot, "defaultTarget">
  /** The user's site rules. */
  hostRules?: readonly HostRule[]
  /** The administrator's site rules: consulted first, whatever the user's
   *  table says about the same host. */
  managedHostRules?: readonly HostRule[]
  /** An explicit user choice (context menu). Replaces the preference and
   *  ignores the modifier, but still yields to the terminal rules. */
  forceTarget?: LinkTarget
}

export type LinkAction =
  | { kind: "file"; target: LocalFileTarget }
  | { kind: "os-handler"; url: string; protocol: string }
  | {
      kind: "reject"
      reason: "empty" | "unsupported-scheme" | "blocked-host"
      url: string
    }
  | { kind: "system"; url: string }
  | {
      kind: "builtin"
      url: string
      placement: "tab" | "drawer"
      /** Chosen by a terminal rule rather than a preference: the address is
       *  loopback or private and only reachable from the codeg host (a
       *  remote-workspace window, or a browser with the port bridge). */
      remoteOverride: boolean
      /** The address lives on the remote codeg host of a remote-workspace
       *  window: it opens in a remote tab (`BrowserTabSeed.remote`), never in
       *  a profile of this computer. */
      remote: boolean
    }

function invert(target: LinkTarget): LinkTarget {
  return target === "builtin" ? "system" : "builtin"
}

export function resolveLinkAction(
  rawUrl: string,
  ctx: ResolveLinkContext
): LinkAction {
  // 1. classify
  const classified = classifyLinkTarget(rawUrl)
  switch (classified.kind) {
    case "empty":
      return { kind: "reject", reason: "empty", url: rawUrl }
    case "file":
      return { kind: "file", target: classified.target }
    case "os-handler":
      return {
        kind: "os-handler",
        url: classified.url,
        protocol: classified.protocol,
      }
    case "unsupported":
      return { kind: "reject", reason: "unsupported-scheme", url: rawUrl }
    case "http":
      break
  }
  const { url, parsed } = classified
  const { surface } = ctx

  // 2. terminal rules
  const rule =
    matchHostRule(ctx.managedHostRules, parsed) ??
    matchHostRule(ctx.hostRules, parsed)
  if (rule?.action === "block") {
    return { kind: "reject", reason: "blocked-host", url }
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "")
  if (
    surface.remoteDesktop &&
    surface.builtinAvailable &&
    isRemoteHostName(hostname, surface.remoteServerHost ?? null)
  ) {
    return {
      kind: "builtin",
      url,
      placement: placementFor(surface),
      remoteOverride: true,
      remote: true,
    }
  }

  if (
    !surface.builtinAvailable &&
    surface.bridgeAvailable === true &&
    parsed.protocol === "http:" &&
    isLoopbackHost(hostname)
  ) {
    return {
      kind: "builtin",
      url,
      placement: placementFor(surface),
      remoteOverride: true,
      remote: false,
    }
  }

  // 3. base target
  let target: LinkTarget
  if (!surface.builtinAvailable) {
    target = "system"
  } else if (ctx.forceTarget) {
    target = ctx.forceTarget
  } else {
    // `block` returned above, so a surviving rule carries a plain target.
    target = rule?.action ?? ctx.prefs.defaultTarget[ctx.source] ?? "builtin"
    // 4. modifier
    if (ctx.modifier) target = invert(target)
  }

  // 5. placement
  if (target === "system") return { kind: "system", url }
  return {
    kind: "builtin",
    url,
    placement: placementFor(surface),
    remoteOverride: false,
    remote: false,
  }
}

function placementFor(surface: LinkSurface): "tab" | "drawer" {
  if (surface.fileColumnVisible) return "tab"
  return surface.viewerHostAvailable ? "drawer" : "tab"
}
