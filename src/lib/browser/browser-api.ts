// Thin transport wrappers over the `browser_*` commands. Desktop only: the
// commands exist in the Tauri runtime alone, and `browserCapabilities()`
// answers `{ available: false }` everywhere else so callers can branch on one
// value instead of on the runtime.
//
// Always this app's own shell, never `getTransport()`: in a window bound to a
// remote codeg-server that one talks to the remote host, which has no browser
// at all — the built-in browser is a webview of THIS computer, whichever
// server the window's workspace lives on.

import { getShellTransport, isDesktop } from "@/lib/transport"

import type { HostRule } from "./host-rules"
import type {
  ActionOutcome,
  ActionRequest,
  CaptureOutcome,
  CaptureRequest,
  ConsoleQuery,
  ConsoleReadout,
  Bounds,
  BrowserCapabilities,
  BrowserDownload,
  BrowserTabState,
  DetectedService,
  DocGuestState,
  DocMode,
  FrozenFrame,
  GrantLevel,
  PageHandoff,
  PageSnapshot,
  SurfaceChoice,
} from "./types"

const UNAVAILABLE: BrowserCapabilities = {
  available: false,
  surface: null,
  platform: "web",
  channel: "degraded",
  reasons: ["built-in browser needs the desktop runtime"],
  isolatedStorage: false,
  proxy: { url: null, applies: "unsupported", reason: null },
  downloadsDir: "",
  policy: { enabled: false, managedRules: [], managedSource: null },
  docGuest: false,
  profiles: false,
  signInUserAgent: false,
  ownedWindowControls: false,
  remoteEgress: false,
}

let capabilitiesPromise: Promise<BrowserCapabilities> | null = null
let resolvedCapabilities: BrowserCapabilities | null = null

/** Cached for the session: the answer cannot change while the app runs. */
export function browserCapabilities(): Promise<BrowserCapabilities> {
  if (!isDesktop()) {
    resolvedCapabilities = UNAVAILABLE
    return Promise.resolve(UNAVAILABLE)
  }
  if (!capabilitiesPromise) {
    capabilitiesPromise = getShellTransport()
      .call<BrowserCapabilities>("browser_capabilities", {})
      .then((caps) => {
        resolvedCapabilities = caps
        return caps
      })
      .catch((error: unknown) => {
        capabilitiesPromise = null
        return {
          ...UNAVAILABLE,
          reasons: [`browser_capabilities failed: ${String(error)}`],
        }
      })
  }
  return capabilitiesPromise
}

/**
 * Synchronous view of the answer, for decisions that must happen inside a
 * click's call stack. `null` until `browserCapabilities()` has resolved once
 * (the events bridge asks at startup); callers treat null as "not available"
 * and fall back to the system browser, which is always a safe answer.
 */
export function browserCapabilitiesSnapshot(): BrowserCapabilities | null {
  return resolvedCapabilities
}

/**
 * Fresh answer, bypassing the session cache: the proxy part changes whenever
 * the user edits the app's proxy setting, and the settings section shows it.
 */
export function browserCapabilitiesNow(): Promise<BrowserCapabilities> {
  if (!isDesktop()) return Promise.resolve(UNAVAILABLE)
  return getShellTransport().call<BrowserCapabilities>(
    "browser_capabilities",
    {}
  )
}

/** Tests only. */
export function resetBrowserCapabilitiesCacheForTests(): void {
  capabilitiesPromise = null
  resolvedCapabilities = null
}

/** Tests only: pretend the capabilities already resolved. */
export function setBrowserCapabilitiesForTests(
  caps: BrowserCapabilities | null
): void {
  resolvedCapabilities = caps
}

export interface OpenBrowserTabParams {
  tabId: string
  url: string
  bounds: Bounds
  background?: boolean
  surface?: SurfaceChoice
  folderId?: number | null
  /** Build the surface with the web inspector available. */
  devtools?: boolean
  /** The browser profile to open in (`default` when omitted). */
  profile?: string
  /** A remote connection's id: the tab is one of the remote host's, opened in
   *  that connection's own profile once its egress is ready (the profile
   *  above is then ignored). Rejects with the reason when it cannot be. */
  egress?: number | null
}

export function browserOpenTab(
  params: OpenBrowserTabParams
): Promise<BrowserTabState> {
  return getShellTransport().call<BrowserTabState>("browser_open_tab", {
    tabId: params.tabId,
    url: params.url,
    bounds: params.bounds,
    background: params.background ?? false,
    surface: params.surface ?? "auto",
    folderId: params.folderId ?? null,
    devtools: params.devtools ?? false,
    profile: params.profile ?? "default",
    egress: params.egress ?? null,
  })
}

export interface OpenDocGuestParams {
  tabId: string
  /** Absolute path of the HTML file. */
  path: string
  /** Directory to confine the document to (the owning workspace folder);
   *  null = the file's own directory. */
  root: string | null
  bounds: Bounds
  background?: boolean
  devtools?: boolean
}

export interface DocGuestOpenResult {
  state: BrowserTabState
  doc: DocGuestState
}

/** Show a local HTML file through a document guest (see the Rust
 *  `doc_guest` module): an embedded surface registered like a tab's, whose
 *  requests the backend answers from the file's folder. */
export function browserDocOpen(
  params: OpenDocGuestParams
): Promise<DocGuestOpenResult> {
  return getShellTransport().call<DocGuestOpenResult>("browser_doc_open", {
    tabId: params.tabId,
    path: params.path,
    root: params.root,
    bounds: params.bounds,
    background: params.background ?? false,
    devtools: params.devtools ?? false,
  })
}

/** Switch a document guest between safe and dynamic mode; the guest reloads
 *  so the new policy travels with the document. */
export function browserDocSetMode(
  tabId: string,
  mode: DocMode
): Promise<DocGuestState> {
  return getShellTransport().call<DocGuestState>("browser_doc_set_mode", {
    tabId,
    mode,
  })
}

export function browserDocState(tabId: string): Promise<DocGuestState> {
  return getShellTransport().call<DocGuestState>("browser_doc_state", { tabId })
}

/** `requestId` comes back on the `browser://closed` this produces, so the
 *  caller can tell it from a close of the same tab it did not ask for. */
export function browserClose(tabId: string, requestId?: string): Promise<void> {
  return getShellTransport().call<void>("browser_close", { tabId, requestId })
}

/**
 * Show the engine's web inspector for a tab's page. It opens in a window of
 * its own, so the page keeps its slot and the workspace has nothing to do
 * about it.
 *
 * Rejects when that tab was opened with the inspector switched off — every
 * engine takes it as a creation-time webview attribute, so there is nothing
 * to turn on now, and saying so beats a menu item that does nothing. The
 * error carries `browser.inspector.error.switchedOff`.
 */
export function browserOpenDevtools(tabId: string): Promise<void> {
  return getShellTransport().call<void>("browser_open_devtools", { tabId })
}

export function browserSetBounds(tabId: string, bounds: Bounds): Promise<void> {
  return getShellTransport().call<void>("browser_set_bounds", { tabId, bounds })
}

/**
 * Show or hide a tab's surface. Hiding with `freeze` asks for the frame the
 * page shows at that moment, to paint in the placeholder while an overlay is
 * open over it; `null` when the platform cannot provide one in time.
 */
export function browserSetVisible(
  tabId: string,
  visible: boolean,
  handoffFocus = false,
  freeze = false
): Promise<FrozenFrame | null> {
  return getShellTransport()
    .call<FrozenFrame | null | undefined>("browser_set_visible", {
      tabId,
      visible,
      handoffFocus,
      freeze,
    })
    .then((frame) => frame ?? null)
}

/**
 * The frame a tab's surface shows right now, without touching its visibility.
 *
 * Taken BEFORE an overlay hide so the placeholder can paint the still while
 * the native view is still up and hiding it: hide first and the placeholder
 * is blank for the length of a round trip, which is seen as a flash. `null`
 * when there is no frame to be had — a hidden or windowed surface, or a
 * capture that did not come back in time.
 */
export function browserFreezeFrame(tabId: string): Promise<FrozenFrame | null> {
  return getShellTransport()
    .call<FrozenFrame | null | undefined>("browser_freeze_frame", { tabId })
    .then((frame) => frame ?? null)
}

/** The user's site rules, for the backend to enforce `block` on navigations. */
export function browserSetHostRules(rules: readonly HostRule[]): Promise<void> {
  return getShellTransport().call<void>("browser_set_host_rules", {
    rules: rules.map((rule) => ({
      pattern: rule.pattern,
      action: rule.action,
    })),
  })
}

export function browserNavigate(
  tabId: string,
  url: string
): Promise<BrowserTabState> {
  return getShellTransport().call<BrowserTabState>("browser_navigate", {
    tabId,
    url,
  })
}

export function browserReload(tabId: string): Promise<void> {
  return getShellTransport().call<void>("browser_reload", { tabId })
}

export function browserStop(tabId: string): Promise<void> {
  return getShellTransport().call<void>("browser_stop", { tabId })
}

export function browserGoBack(tabId: string): Promise<void> {
  return getShellTransport().call<void>("browser_go_back", { tabId })
}

export function browserGoForward(tabId: string): Promise<void> {
  return getShellTransport().call<void>("browser_go_forward", { tabId })
}

export function browserGetState(tabId: string): Promise<BrowserTabState> {
  return getShellTransport().call<BrowserTabState>("browser_get_state", {
    tabId,
  })
}

export function browserListTabs(): Promise<BrowserTabState[]> {
  return getShellTransport().call<BrowserTabState[]>("browser_list_tabs", {})
}

/** The local servers this window has seen start and that still answer.
 *
 *  A round trip per call on purpose: the backend probes every entry while
 *  answering, so the list a menu shows is the list that was true when it
 *  opened. Empty off the desktop, where the command does not exist. */
export function browserListServices(): Promise<DetectedService[]> {
  if (!isDesktop()) return Promise.resolve([])
  return getShellTransport().call<DetectedService[]>(
    "browser_list_services",
    {}
  )
}

/** Share this tab with agents at `level`, or take it back with `"none"`.
 *
 *  Only ever called for a person. There is no path by which an agent grants
 *  itself anything, and adding one would empty the model of its content: the
 *  backend refuses a tab with no web origin to bind to, and drops the grant
 *  by itself the moment the page leaves that origin. */
export function browserAgentGrant(
  tabId: string,
  level: GrantLevel
): Promise<BrowserTabState> {
  return getShellTransport().call<BrowserTabState>("browser_agent_grant", {
    tabId,
    level,
  })
}

/** Read a shared page as the tree an agent operates on. Rejects with a
 *  permission error when the tab has not been shared, or when the page moved
 *  off the shared origin while the read was in flight. */
export function browserAgentSnapshot(
  tabId: string,
  maxChars?: number
): Promise<PageSnapshot> {
  return getShellTransport().call<PageSnapshot>("browser_agent_snapshot", {
    tabId,
    maxChars: maxChars ?? null,
  })
}

/** Act on a shared page by a ref from a snapshot of it. Needs the tab shared
 *  at `control`; rejects with a permission error otherwise, and with an
 *  invalid-input error carrying `browser.agent.error.staleRef` when the ref
 *  is from a page that has moved on. */
export function browserAgentAct(
  tabId: string,
  request: ActionRequest
): Promise<ActionOutcome> {
  return getShellTransport().call<ActionOutcome>("browser_agent_act", {
    tabId,
    request,
  })
}

/** What a shared page has printed to its console. A read: needs the tab
 *  shared, and rejects with a permission error otherwise. */
export function browserAgentConsole(
  tabId: string,
  query: ConsoleQuery = {}
): Promise<ConsoleReadout> {
  return getShellTransport().call<ConsoleReadout>("browser_agent_console", {
    tabId,
    query,
  })
}

/** A screenshot of a shared page, or of one element of it by ref. A read:
 *  needs the tab shared; a ref from a page that has moved on rejects with
 *  `browser.agent.error.staleRef`. */
export function browserAgentCapture(
  tabId: string,
  request: CaptureRequest = {}
): Promise<CaptureOutcome> {
  return getShellTransport().call<CaptureOutcome>("browser_agent_capture", {
    tabId,
    request,
  })
}

/** The person's answer to one `browser://eval-request`.
 *
 *  Resolves `false` when that question is no longer waiting — it lapsed, or
 *  something else answered it first — which is the signal to stop showing a
 *  dialog nobody is listening to. */
export function browserEvalDecide(
  requestId: string,
  allow: boolean
): Promise<boolean> {
  return getShellTransport().call<boolean>("browser_eval_decide", {
    requestId,
    allow,
  })
}

/** Tell the backend which tab a `browser://open-request` became.
 *
 *  Only for a request that carried a `requestId`: something on the backend is
 *  parked waiting for the id (an agent's `browser_open_tab`). `null` says the
 *  workspace could not open one, so the waiter fails now instead of timing
 *  out. Resolves `false` when nobody is waiting any more, which is not an
 *  error — the tab that was opened is a real tab either way. */
export function browserAnswerOpenRequest(
  requestId: string,
  tabId: string | null
): Promise<boolean> {
  return getShellTransport().call<boolean>("browser_answer_open_request", {
    requestId,
    tabId,
  })
}

/** Let the person point at an element of the page and hand it to a
 *  conversation. Resolves when they pick one, or with `cancelled` when they
 *  press Escape, start another pick, navigate, or leave it armed too long —
 *  none of which is an error. */
export function browserPickElement(tabId: string): Promise<PageHandoff> {
  return getShellTransport().call<PageHandoff>("browser_pick_element", {
    tabId,
  })
}

/** Take the picker's highlight down without picking anything. */
export function browserPickCancel(tabId: string): Promise<void> {
  return getShellTransport().call<void>("browser_pick_cancel", { tabId })
}

/** A screenshot of the page as it is on screen, for a conversation. */
export function browserPageCapture(tabId: string): Promise<PageHandoff> {
  return getShellTransport().call<PageHandoff>("browser_page_capture", {
    tabId,
  })
}

/** What the page has printed, for a conversation. Not the agent's read: no
 *  grant is involved and nothing is written to the activity strip. */
export function browserPageConsole(
  tabId: string,
  errorsOnly = true
): Promise<PageHandoff> {
  return getShellTransport().call<PageHandoff>("browser_page_console", {
    tabId,
    errorsOnly,
  })
}

/** Wipe cookies, caches and storage shared by every tab of a profile. */
export function browserClearData(profile = "default"): Promise<void> {
  return getShellTransport().call<void>("browser_clear_data", { profile })
}

/** Delete a profile: its tabs are closed, then its store is removed. The
 *  default profile cannot be deleted. */
export function browserRemoveProfile(profile: string): Promise<void> {
  return getShellTransport().call<void>("browser_remove_profile", { profile })
}

/** The "sign-in user agent" preference, for the backend to apply on
 *  navigations to Google's sign-in hosts. */
export function browserSetSignInUserAgent(enabled: boolean): Promise<void> {
  return getShellTransport().call<void>("browser_set_sign_in_user_agent", {
    enabled,
  })
}

/** The colours the empty tab's page is painted with: the running theme's
 *  `--background` as `#rrggbb`, and whether that is a dark scheme. The blank
 *  document a tab commits is the engine's, and the engine's is white in every
 *  theme — see the Rust `browser::blank_page`. */
export function browserSetBlankPageTheme(theme: {
  background: string
  dark: boolean
}): Promise<void> {
  return getShellTransport().call<void>("browser_set_blank_page_theme", {
    background: theme.background,
    dark: theme.dark,
  })
}

/**
 * Highlight the next (or previous) match of `query` in the page and answer
 * whether anything matched. An empty query clears the highlight.
 */
export function browserFind(
  tabId: string,
  query: string,
  forward = true
): Promise<boolean> {
  return getShellTransport().call<boolean>("browser_find", {
    tabId,
    query,
    forward,
  })
}

/** Downloads this run started, oldest first. */
export function browserListDownloads(): Promise<BrowserDownload[]> {
  return getShellTransport().call<BrowserDownload[]>(
    "browser_list_downloads",
    {}
  )
}

/** Show a finished download in the file manager. The backend reveals the path
 *  it recorded for that download, so this cannot point anywhere else. */
export function browserRevealDownload(id: string): Promise<void> {
  return getShellTransport().call<void>("browser_reveal_download", { id })
}

/** Forget the records; the downloaded files stay where they are. */
export function browserClearDownloads(): Promise<void> {
  return getShellTransport().call<void>("browser_clear_downloads", {})
}
