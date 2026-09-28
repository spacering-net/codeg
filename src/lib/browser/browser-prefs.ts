// Built-in browser preferences. Persisted per key in localStorage (one key per
// setting rather than one JSON blob, so the settings window and the workspace
// window never clobber each other's writes); read through a cached snapshot so
// `useSyncExternalStore` gets a stable object between changes. Same shape as
// `office-preview-prefs.ts`: a same-window custom event plus the native
// cross-window `storage` event keep every reader live.

import { useSyncExternalStore } from "react"

import { randomUUID } from "@/lib/utils"

import { isHostRule, type HostRule } from "./host-rules"

/** Where a clicked address came from; each source carries its own default. */
export type LinkSource =
  | "transcript"
  | "toolCard"
  | "terminal"
  | "editor"
  | "notification"

export const LINK_SOURCES: readonly LinkSource[] = [
  "transcript",
  "toolCard",
  "terminal",
  "editor",
  "notification",
]

export type LinkTarget = "builtin" | "system"

/** Runtime escape hatch over the compiled surface choice (§0.3 of the plan):
 *  lets a user on a platform whose child-webview path was never verified fall
 *  back to the owned-window surface without a rebuild. */
export type SurfaceOverride = "auto" | "child" | "window"

/** What renders an HTML file's preview on the desktop: the document guest
 *  (a native surface served by the backend from the file's folder) or the
 *  inline `srcdoc` iframe the web build uses. */
export type HtmlPreviewEngine = "guest" | "inline"

/** The level a page is shared at when nobody picked one. Same three values as
 *  the grant itself (`GrantLevel`), including `none` — which here is not "no
 *  grant yet" but a standing answer: share nothing until asked. */
export type DefaultAgentGrant = "none" | "read" | "control"

/** What happens when an agent asks to run its own code on a shared page:
 *  the per-snippet dialog, or a standing yes. */
export type BrowserEvalApproval = "ask" | "silent"

export const BROWSER_EVAL_APPROVALS: readonly BrowserEvalApproval[] = [
  "ask",
  "silent",
]

/** What happens when a server codeg started announces its address.
 *
 *  The same three answers VS Code offers for an auto-forwarded port
 *  (`silent` / `notify` / `openPreview`), under the names they have here. */
export type ServiceAutoOpen = "off" | "notify" | "open"

export const SERVICE_AUTO_OPEN_MODES: readonly ServiceAutoOpen[] = [
  "off",
  "notify",
  "open",
]

/** The profile every installation has; it cannot be deleted, only cleared.
 *  Its name is localized, so it is not in the list the user edits. */
export const DEFAULT_BROWSER_PROFILE_ID = "default"

/** A browser profile the user created: a cookie jar and site storage of its
 *  own on the backend, named here. The id is minted once and never changes
 *  (the backend derives the store from it); the name is for people. */
export interface BrowserProfile {
  id: string
  name: string
}

/** Same alphabet as the backend's `valid_profile_id`: ids become directory
 *  names and store identifiers. */
const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/

export function isBrowserProfileId(value: unknown): value is string {
  return typeof value === "string" && PROFILE_ID_PATTERN.test(value)
}

export function isBrowserProfile(value: unknown): value is BrowserProfile {
  if (!value || typeof value !== "object") return false
  const { id, name } = value as Record<string, unknown>
  return (
    isBrowserProfileId(id) &&
    id !== DEFAULT_BROWSER_PROFILE_ID &&
    typeof name === "string" &&
    name.trim().length > 0
  )
}

/** A fresh id for a profile: short, opaque, and in the backend's alphabet. */
export function mintBrowserProfileId(): string {
  return `p-${randomUUID().replace(/-/g, "").slice(0, 12)}`
}

export interface BrowserPrefsSnapshot {
  defaultTarget: Readonly<Record<LinkSource, LinkTarget>>
  /** Build a tab's surface with the web inspector available, and offer it in
   *  that tab's "More" menu. On by default: this is a workbench for people
   *  who read pages for a living, and every engine takes the inspector as a
   *  creation-time attribute — off by default meant the answer to "can I look
   *  at this page" was always "reopen it first". */
  devtools: boolean
  surfaceOverride: SurfaceOverride
  firstOpenSeen: boolean
  /** Release the native surface of tabs that stay in the background for a
   *  while (they reload when shown again). Off by default: a page's state
   *  is worth more than its memory unless the user says otherwise. */
  suspendBackgroundTabs: boolean
  /** Per-site overrides of the default target, and outright blocks. The
   *  administrator's rules (from the backend's policy) are not in here. */
  hostRules: readonly HostRule[]
  /** A plain click on a terminal link opens a small menu (built-in browser,
   *  system browser, copy) instead of following the link. Off by default:
   *  one more click on every link is only worth it to people who switch
   *  destinations often; a modifier-click already offers the other one. */
  terminalClickMenu: boolean
  /** Guest by default wherever a guest exists; the inline preview remains
   *  one switch away for anyone who prefers the old rendering. */
  htmlPreviewEngine: HtmlPreviewEngine
  /** Profiles the user created, in the order they were made. The default
   *  profile is not listed: it always exists and comes first. */
  profiles: readonly BrowserProfile[]
  /** The profile new browser tabs open in. Always names a profile that
   *  exists (the default one when the stored choice was deleted). */
  newTabProfile: string
  /** Present a Firefox identity to Google's sign-in pages, which refuse
   *  embedded browsers. On by default: without it, signing in to Google from
   *  a tab fails with "this browser may not be secure". */
  signInUserAgent: boolean
  /** What every site a browser tab arrives at is shared at, applied on its
   *  own (`browser-agent-grant.ts`) as soon as the page commits — and the
   *  entry the share menu opens onto and tags. `none` is the original
   *  behaviour: a tab hands nothing over until somebody uses that menu.
   *
   *  Reading and acting by default: a page kept open beside an agent is
   *  almost always one the person is about to ask it to do something on, and
   *  both narrower answers are a click away in the same menu.
   *
   *  A level applied here is the default for a SITE, not a lease on the tab:
   *  the moment a page leaves the origin it was granted for, the backend
   *  revokes as it always did, and this re-applies at the next one. The one
   *  place it deliberately does not reach is the "share again" button of a
   *  replaced grant (`browser-status-layer.tsx`), which stays at `read`: that
   *  one sits in an alarm bar reporting that something else is now serving the
   *  address, and a one-press button there must not hand over more than
   *  reading because of a preference set somewhere else. */
  defaultAgentGrant: DefaultAgentGrant
  /** Whether an agent's own code is put in front of the person before it runs
   *  on a page they shared for acting.
   *
   *  `silent` by default. The question it removes was asked once per snippet
   *  and never remembered, which is the most repetitive consent in the app:
   *  somebody who has turned the `browser_eval` switch on and shared a tab at
   *  `control` has already decided, and the hundredth dialog is answered by
   *  reflex rather than read. So the decision is moved up to where it is made
   *  deliberately — the tool switch, which ships OFF and whose own text says
   *  that turning it on means code runs without asking.
   *
   *  This replaces the per-snippet dialog and NOTHING ELSE: the `browser_eval`
   *  tool switch and the tab's `control` grant are enforced in the backend and
   *  are not reachable from here. Every silent run is still recorded on that
   *  tab's agent activity strip, so "without asking" does not mean unseen. */
  evalApproval: BrowserEvalApproval
  /** What to do when a server started in a codeg terminal (or in a terminal
   *  an agent asked codeg to run) prints its loopback address.
   *
   *  `notify` by default, which is VS Code's default for the same situation:
   *  a tab appearing on its own is a surprise the first time it happens to
   *  somebody, and one press in a toast is a small price for never being
   *  surprised. `open` is for people who want their app in front of them; it
   *  opens in the background, so the file column keeps whatever was there.
   *  `off` still LISTS the servers (the "+" menu reads them from the backend
   *  either way) — it only means "do not interrupt me". */
  serviceAutoOpen: ServiceAutoOpen
}

export const DEFAULT_BROWSER_PREFS: BrowserPrefsSnapshot = Object.freeze({
  defaultTarget: Object.freeze({
    transcript: "builtin",
    toolCard: "builtin",
    terminal: "builtin",
    editor: "builtin",
    notification: "builtin",
  }),
  devtools: true,
  surfaceOverride: "auto",
  firstOpenSeen: false,
  suspendBackgroundTabs: false,
  hostRules: Object.freeze([]) as readonly HostRule[],
  terminalClickMenu: false,
  htmlPreviewEngine: "guest",
  profiles: Object.freeze([]) as readonly BrowserProfile[],
  newTabProfile: DEFAULT_BROWSER_PROFILE_ID,
  signInUserAgent: true,
  defaultAgentGrant: "control",
  evalApproval: "silent",
  serviceAutoOpen: "notify",
}) as BrowserPrefsSnapshot

const KEY_PREFIX = "browser:"
const CHANGE_EVENT = "codeg:browser-prefs-changed"

function targetKey(source: LinkSource): string {
  return `${KEY_PREFIX}default-target:${source}`
}
const DEVTOOLS_KEY = `${KEY_PREFIX}devtools`
const SURFACE_KEY = `${KEY_PREFIX}surface-override`
const FIRST_OPEN_KEY = `${KEY_PREFIX}first-open-seen`
const SUSPEND_KEY = `${KEY_PREFIX}suspend-background-tabs`
// One key for the whole table: a rule list is one setting, edited in one
// place, and half a table is not a meaningful state.
const HOST_RULES_KEY = `${KEY_PREFIX}host-rules`
const TERMINAL_MENU_KEY = `${KEY_PREFIX}terminal-click-menu`
const HTML_PREVIEW_KEY = `${KEY_PREFIX}html-preview-engine`
// One key for the whole list, like the rules: a profile list is one setting.
const PROFILES_KEY = `${KEY_PREFIX}profiles`
const NEW_TAB_PROFILE_KEY = `${KEY_PREFIX}new-tab-profile`
const SIGN_IN_UA_KEY = `${KEY_PREFIX}sign-in-user-agent`
const AGENT_GRANT_KEY = `${KEY_PREFIX}default-agent-grant`
const EVAL_APPROVAL_KEY = `${KEY_PREFIX}eval-approval`
const SERVICE_AUTO_OPEN_KEY = `${KEY_PREFIX}service-auto-open`

function readRaw(key: string): string | null {
  if (typeof window === "undefined") return null
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function parseTarget(raw: string | null): LinkTarget | null {
  return raw === "builtin" || raw === "system" ? raw : null
}

function parseSurface(raw: string | null): SurfaceOverride | null {
  return raw === "auto" || raw === "child" || raw === "window" ? raw : null
}

/** Anything but the two stored values means the default — including the value
 *  a build before this setting had three levels would have left behind. */
function parseAgentGrant(raw: string | null): DefaultAgentGrant {
  return raw === "read" || raw === "none"
    ? raw
    : DEFAULT_BROWSER_PREFS.defaultAgentGrant
}

/** Anything but the one stored value means the default, as everywhere else in
 *  here: only somebody who went and asked for the dialog gets it. */
function parseEvalApproval(raw: string | null): BrowserEvalApproval {
  return raw === "ask" ? "ask" : "silent"
}

/** Anything but the two stored values means the default. */
function parseServiceAutoOpen(raw: string | null): ServiceAutoOpen {
  return raw === "off" || raw === "open"
    ? raw
    : DEFAULT_BROWSER_PREFS.serviceAutoOpen
}

/** Stored rules, one bad entry dropped rather than the whole list. */
function parseHostRules(raw: string | null): readonly HostRule[] {
  if (!raw) return DEFAULT_BROWSER_PREFS.hostRules
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return DEFAULT_BROWSER_PREFS.hostRules
    return parsed
      .filter(isHostRule)
      .map((rule) => ({ pattern: rule.pattern, action: rule.action }))
  } catch {
    return DEFAULT_BROWSER_PREFS.hostRules
  }
}

/** Stored profiles, one bad entry dropped rather than the whole list; a
 *  second entry with an id already seen is dropped too. */
function parseProfiles(raw: string | null): readonly BrowserProfile[] {
  if (!raw) return DEFAULT_BROWSER_PREFS.profiles
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return DEFAULT_BROWSER_PREFS.profiles
    const seen = new Set<string>()
    const out: BrowserProfile[] = []
    for (const entry of parsed) {
      if (!isBrowserProfile(entry) || seen.has(entry.id)) continue
      seen.add(entry.id)
      out.push({ id: entry.id, name: entry.name.trim() })
    }
    return out
  } catch {
    return DEFAULT_BROWSER_PREFS.profiles
  }
}

/** Whether `id` names a profile that exists: the default one or a listed one. */
export function browserProfileExists(
  prefs: Pick<BrowserPrefsSnapshot, "profiles">,
  id: string
): boolean {
  return (
    id === DEFAULT_BROWSER_PROFILE_ID ||
    prefs.profiles.some((profile) => profile.id === id)
  )
}

function read(): BrowserPrefsSnapshot {
  const defaultTarget = {} as Record<LinkSource, LinkTarget>
  for (const source of LINK_SOURCES) {
    defaultTarget[source] =
      parseTarget(readRaw(targetKey(source))) ??
      DEFAULT_BROWSER_PREFS.defaultTarget[source]
  }
  const profiles = parseProfiles(readRaw(PROFILES_KEY))
  const storedNewTab = readRaw(NEW_TAB_PROFILE_KEY)
  const newTabProfile =
    isBrowserProfileId(storedNewTab) &&
    browserProfileExists({ profiles }, storedNewTab)
      ? storedNewTab
      : DEFAULT_BROWSER_PROFILE_ID
  return {
    defaultTarget,
    devtools: readRaw(DEVTOOLS_KEY) !== "false",
    surfaceOverride:
      parseSurface(readRaw(SURFACE_KEY)) ??
      DEFAULT_BROWSER_PREFS.surfaceOverride,
    firstOpenSeen: readRaw(FIRST_OPEN_KEY) === "true",
    suspendBackgroundTabs: readRaw(SUSPEND_KEY) === "true",
    hostRules: parseHostRules(readRaw(HOST_RULES_KEY)),
    terminalClickMenu: readRaw(TERMINAL_MENU_KEY) === "true",
    htmlPreviewEngine:
      readRaw(HTML_PREVIEW_KEY) === "inline" ? "inline" : "guest",
    profiles,
    newTabProfile,
    signInUserAgent: readRaw(SIGN_IN_UA_KEY) !== "false",
    defaultAgentGrant: parseAgentGrant(readRaw(AGENT_GRANT_KEY)),
    evalApproval: parseEvalApproval(readRaw(EVAL_APPROVAL_KEY)),
    serviceAutoOpen: parseServiceAutoOpen(readRaw(SERVICE_AUTO_OPEN_KEY)),
  }
}

let cached: BrowserPrefsSnapshot | null = null

/** Current preferences. Cached until a write or a cross-window change. */
export function getBrowserPrefs(): BrowserPrefsSnapshot {
  if (cached === null) cached = read()
  return cached
}

function write(key: string, value: string | null): void {
  if (typeof window === "undefined") return
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    /* quota / privacy mode: keep the in-memory value only */
  }
  cached = null
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT))
}

export function setDefaultLinkTarget(
  source: LinkSource,
  target: LinkTarget
): void {
  write(targetKey(source), target)
}

/** The "always use the system browser" toast action: every source at once. */
export function setAllDefaultLinkTargets(target: LinkTarget): void {
  for (const source of LINK_SOURCES) write(targetKey(source), target)
}

export function setBrowserDevtools(enabled: boolean): void {
  write(DEVTOOLS_KEY, enabled ? "true" : "false")
}

export function setBrowserSurfaceOverride(value: SurfaceOverride): void {
  write(SURFACE_KEY, value === "auto" ? null : value)
}

export function markBrowserFirstOpenSeen(): void {
  write(FIRST_OPEN_KEY, "true")
}

export function setBrowserSuspendBackgroundTabs(enabled: boolean): void {
  write(SUSPEND_KEY, enabled ? "true" : null)
}

/** Replace the site-rule table (an empty table removes the key). */
export function setBrowserHostRules(rules: readonly HostRule[]): void {
  const cleaned = rules
    .filter(isHostRule)
    .map((rule) => ({ pattern: rule.pattern, action: rule.action }))
  write(HOST_RULES_KEY, cleaned.length > 0 ? JSON.stringify(cleaned) : null)
}

export function setBrowserTerminalClickMenu(enabled: boolean): void {
  write(TERMINAL_MENU_KEY, enabled ? "true" : null)
}

export function setBrowserHtmlPreviewEngine(engine: HtmlPreviewEngine): void {
  write(HTML_PREVIEW_KEY, engine === "inline" ? "inline" : null)
}

/** Replace the profile list (an empty list removes the key). */
export function setBrowserProfiles(profiles: readonly BrowserProfile[]): void {
  const seen = new Set<string>()
  const cleaned: BrowserProfile[] = []
  for (const profile of profiles) {
    if (!isBrowserProfile(profile) || seen.has(profile.id)) continue
    seen.add(profile.id)
    cleaned.push({ id: profile.id, name: profile.name.trim() })
  }
  write(PROFILES_KEY, cleaned.length > 0 ? JSON.stringify(cleaned) : null)
}

/** The stored list as of now, not as of the last read: another window's
 *  write may not have reached this one's `storage` listener yet, and a
 *  read-modify-write from the cached snapshot would drop it. */
function currentProfiles(): readonly BrowserProfile[] {
  cached = null
  return getBrowserPrefs().profiles
}

/** Create a profile named `name`; returns it (with its new id). */
export function addBrowserProfile(name: string): BrowserProfile {
  const profile = { id: mintBrowserProfileId(), name: name.trim() }
  setBrowserProfiles([...currentProfiles(), profile])
  return profile
}

/** Forget a profile. The "new tabs" choice falls back to the default profile
 *  on its own (it is resolved against the list on every read). */
export function removeBrowserProfile(id: string): void {
  setBrowserProfiles(currentProfiles().filter((profile) => profile.id !== id))
}

/** The profile new tabs open in (the default one removes the key). */
export function setBrowserNewTabProfile(id: string): void {
  write(NEW_TAB_PROFILE_KEY, id === DEFAULT_BROWSER_PROFILE_ID ? null : id)
}

export function setBrowserSignInUserAgent(enabled: boolean): void {
  write(SIGN_IN_UA_KEY, enabled ? null : "false")
}

/** The level new pages are shared at (`control`, the default, removes the
 *  key). */
export function setBrowserDefaultAgentGrant(level: DefaultAgentGrant): void {
  write(AGENT_GRANT_KEY, level === "read" || level === "none" ? level : null)
}

/** Whether each snippet is put in front of the person (`silent`, the default,
 *  removes the key). */
export function setBrowserEvalApproval(value: BrowserEvalApproval): void {
  write(EVAL_APPROVAL_KEY, value === "ask" ? "ask" : null)
}

/**
 * The stored answer as of right now, read past the cached snapshot — same
 * reasoning as `currentProfiles` above.
 *
 * For the one reader that must not be a beat behind. `BrowserEvalConfirm`
 * answers for the person when this says `silent`, so reading it late is a
 * snippet running without the confirmation they had just asked for. The cache
 * is dropped when a `storage` event is *delivered*, and that is both later
 * than the other window's write and conditional on something being subscribed
 * at the time; `localStorage` is neither. A snapshot is the right thing to
 * render from and the wrong thing to decide from.
 */
export function readBrowserEvalApprovalNow(): BrowserEvalApproval {
  return parseEvalApproval(readRaw(EVAL_APPROVAL_KEY))
}

/** What a newly announced local server does (`notify`, the default, removes
 *  the key). */
export function setBrowserServiceAutoOpen(mode: ServiceAutoOpen): void {
  write(SERVICE_AUTO_OPEN_KEY, mode === "off" || mode === "open" ? mode : null)
}

export function subscribeBrowserPrefs(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {}
  const onChange = () => listener()
  const onStorage = (event: StorageEvent) => {
    // A `null` key is `localStorage.clear()`; anything under our prefix is ours.
    if (event.key === null || event.key.startsWith(KEY_PREFIX)) {
      cached = null
      listener()
    }
  }
  window.addEventListener(CHANGE_EVENT, onChange)
  window.addEventListener("storage", onStorage)
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange)
    window.removeEventListener("storage", onStorage)
  }
}

function getServerSnapshot(): BrowserPrefsSnapshot {
  return DEFAULT_BROWSER_PREFS
}

/** Reactive read; re-renders on same-window and cross-window changes. */
export function useBrowserPrefs(): BrowserPrefsSnapshot {
  return useSyncExternalStore(
    subscribeBrowserPrefs,
    getBrowserPrefs,
    getServerSnapshot
  )
}

/** Drop the cache and every stored key (tests only). */
export function resetBrowserPrefsForTests(): void {
  cached = null
  if (typeof window === "undefined") return
  try {
    for (const source of LINK_SOURCES)
      localStorage.removeItem(targetKey(source))
    localStorage.removeItem(DEVTOOLS_KEY)
    localStorage.removeItem(SURFACE_KEY)
    localStorage.removeItem(FIRST_OPEN_KEY)
    localStorage.removeItem(SUSPEND_KEY)
    localStorage.removeItem(HOST_RULES_KEY)
    localStorage.removeItem(TERMINAL_MENU_KEY)
    localStorage.removeItem(HTML_PREVIEW_KEY)
    localStorage.removeItem(PROFILES_KEY)
    localStorage.removeItem(NEW_TAB_PROFILE_KEY)
    localStorage.removeItem(SIGN_IN_UA_KEY)
    localStorage.removeItem(AGENT_GRANT_KEY)
    localStorage.removeItem(EVAL_APPROVAL_KEY)
    localStorage.removeItem(SERVICE_AUTO_OPEN_KEY)
  } catch {
    /* ignore */
  }
}
