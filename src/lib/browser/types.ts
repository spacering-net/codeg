// Wire types of the built-in browser — the TypeScript mirror of
// `src-tauri/src/browser/types.rs`. Field names are camelCase and enum values
// kebab-case on both sides; change them together.

export type SurfaceKind = "child" | "window"

/** What a tab shows: a web page, or a local HTML file through the document
 *  guest (`codeg-doc:`), which the file column hosts in place of the inline
 *  HTML preview. */
export type TabKind = "page" | "document"

export type ChannelKind = "native" | "degraded" | "legacy"

/** Logical pixels, the unit `getBoundingClientRect()` reports. */
export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

export type BrowserErrorKind =
  | "dns"
  | "tls"
  | "blocked"
  | "failed"
  | "popup-denied"
  // A remote tab's page, as the tunnel to the remote host saw it fail (see
  // `browser::remote`): nothing listens on that port there, the remote host
  // cannot reach the address, its server's policy keeps the tunnel off it,
  // it took too long — or the tunnel itself is down.
  | "remote-refused"
  | "remote-unreachable"
  | "remote-not-allowed"
  | "remote-timeout"
  | "tunnel-down"

export interface BrowserErrorInfo {
  kind: BrowserErrorKind
  message: string
  url: string | null
}

/** What an agent may do with a tab. Nothing is ever granted automatically —
 *  not by address, not by which process is listening, not by an allow-list,
 *  and not for a tab the agent opened itself. The only way in is a person
 *  sharing the tab. Reading counts: an unshared page leaks through a snapshot
 *  exactly as much as through a click. */
export type GrantLevel = "none" | "read" | "control"

/** A grant in force on one tab. Absent means none. */
export interface AgentGrant {
  /** Never `"none"`: a tab with no grant carries no `AgentGrant`. */
  level: GrantLevel
  /** The origin the tab was showing when it was shared. The grant ends the
   *  moment the page leaves it, so one share covers a whole dev loop —
   *  reloads and route changes on the same site — and nothing beyond it. */
  origin: string
  /** Unix milliseconds. */
  grantedAt: number
  /** For a grant on a loopback address, the program that was serving it when
   *  the tab was shared. `http://localhost:3000` names a port rather than a
   *  site, so the origin alone does not say that the thing behind it is still
   *  the thing the person meant; the backend re-checks this before each read.
   *  Absent for every other address, and for one it could not look into. */
  listener?: ListenerIdentity
}

/** What was answering on a loopback address. Recorded and compared as a whole
 *  — the *program*, deliberately not the process: a dev server under
 *  `nodemon` or `cargo watch` gets a new pid on every save, and pinning the
 *  instance would end the sharing several times a minute. */
export interface ListenerIdentity {
  /** Absolute path of the listening process's executable. */
  program?: string
  /** Its working directory. Absent on Windows, where a process's working
   *  directory is not reachable through a documented API. */
  workdir?: string
}

/** Why a tab's grant changed (`browser://agent-grant`). The level itself
 *  travels with the tab on `browser://state`, which stays the one place to
 *  read what it is now; this says what the state cannot — that the change was
 *  the page's doing rather than the user's. */
export type GrantChange = "granted" | "revoked" | "navigated" | "replaced"

export interface AgentGrantPayload {
  tabId: string
  change: GrantChange
  level: GrantLevel
  /** The origin just granted, or the one just lost. */
  origin: string | null
}

/** What an agent did to a page: read it, or one of the five ways of acting
 *  on it. One value per kind, so a run of clicks on the activity strip does
 *  not swallow the keystroke among them. */
export type AgentAction =
  | "read"
  | "click"
  | "hover"
  | "type"
  | "press"
  | "select"
  /** Took a screenshot. */
  | "capture"
  /** Read the console. */
  | "console"
  /** Ran its own code, with the person's say-so for that snippet. */
  | "eval"
  /** Opened this tab. */
  | "open"
  /** Pointed this tab at another address. */
  | "navigate"
  /** Asked for this tab to be closed. Only ever seen as a refusal or a
   *  failure: a strip dies with its tab, so a close that worked has nowhere
   *  to leave a line. */
  | "close"

export type PointerButton = "left" | "right"

/** What an agent asks to do to an element (`browser_agent_act`). Mirrors
 *  `agent::ActionKind`; the world bundle takes the same shape. */
export type ActionKind =
  | { kind: "click"; button?: PointerButton; count?: number }
  | { kind: "hover" }
  /** Replaces the field's value. */
  | { kind: "type"; text: string; submit?: boolean }
  /** `ref` may be left out: the key goes to whatever has focus. */
  | { kind: "press"; key: string }
  | { kind: "select"; values: string[] }

export interface ActionRequest {
  /** The `generation` of the snapshot that named `ref`. */
  generation: string
  ref?: string
  action: ActionKind
}

/** How an action reached the page: events dispatched by script, or a real
 *  input event the platform delivered (WebView2 only). */
export type Fidelity = "synthetic" | "trusted"

export interface ActionOutcome {
  fidelity: Fidelity
  /** Where the page was when the action was done. */
  url: string
}

/** Whether it happened. Refusals and failures are reported too: the activity
 *  strip is only worth reading if seeing nothing on it means nothing
 *  happened. */
export type AgentOutcome = "done" | "refused" | "failed"

/** One agent's one attempt on one tab (`browser://agent-activity`). */
export interface AgentActivityPayload {
  tabId: string
  action: AgentAction
  outcome: AgentOutcome
  /** Unix milliseconds. */
  at: number
}

/** A page as an agent reads it (`browser_agent_snapshot`). */
export interface PageSnapshot {
  /** Opaque token a later ref must quote. */
  generation: string
  /** The address the page was at when it was walked. */
  url: string
  title: string
  viewport: { width: number; height: number; dpr: number }
  /** The aria tree, in Playwright's `ai` rendering. */
  tree: string
  refsCount: number
  /** The tree stops at `maxChars` rather than at the end of the page. */
  truncated: boolean
}

/** Severity of a console line, lowest first. */
export type ConsoleLevel = "debug" | "log" | "info" | "warn" | "error"

/** Where a console line came from: a `console.*` call, an exception nothing
 *  caught, a promise rejection nothing handled, a resource that failed to
 *  load. */
export type ConsoleSource = "console" | "exception" | "rejection" | "resource"

/** One line a shared page printed (`browser_agent_console`). What the page
 *  chose to print: data about the page, never more. */
export interface ConsoleEntry {
  /** Position in the tab's stream; `since` on the next query continues
   *  after it. */
  seq: number
  /** Unix milliseconds. */
  at: number
  level: ConsoleLevel
  source: ConsoleSource
  text: string
  url?: string
  line?: number
  column?: number
  /** Printed by the top-level document rather than a frame in it. */
  top: boolean
}

export interface ConsoleQuery {
  /** Only lines after this seq; 0 or absent is everything kept. */
  since?: number
  /** Only lines at this level or above. */
  minLevel?: ConsoleLevel
  /** At most this many, oldest first. Defaults to 100. */
  limit?: number
}

export interface ConsoleReadout {
  /** Where the tab was when the lines were read. */
  url: string
  /** Oldest first. */
  entries: ConsoleEntry[]
  /** Lines this document printed that are no longer kept, or never were. */
  dropped: number
  /** The `since` to pass next time. */
  nextSince: number
  /** Whether matching lines remain beyond `limit`. */
  more: boolean
}

export type CaptureFormat = "png" | "jpeg"

/** What a screenshot is asked for (`browser_agent_capture`). `generation`
 *  and `ref` together name an element to crop to; neither for the whole
 *  viewport. */
export interface CaptureRequest {
  generation?: string
  ref?: string
  /** Widest the image should be, in pixels. Defaults to 1568. */
  maxWidth?: number
  format?: CaptureFormat
}

/** A rectangle of the page in viewport CSS pixels. */
export interface CaptureRegion {
  x: number
  y: number
  width: number
  height: number
}

export interface CaptureOutcome {
  mime: string
  /** The image, base64. */
  data: string
  width: number
  height: number
  /** Where the page was when the pixels were taken. */
  url: string
  /** The part of the viewport the image shows. */
  region: CaptureRegion
  /** Whether `region` is an element rather than the viewport. */
  clipped: boolean
}

/** Full per-tab state; every `browser://state` event carries one. */
export interface BrowserTabState {
  tabId: string
  ownerWindow: string
  kind: TabKind
  surface: SurfaceKind
  channel: ChannelKind
  /** Why the page channel could not be installed, in the engine's own words.
   *  Null while it is fine — and also while it is merely still coming up,
   *  which is what `channel: "degraded"` means until the helper says hello. */
  channelError: string | null
  /** Last committed URL ("" until the first document commits). */
  url: string
  /** URL the last navigation asked for. */
  requestedUrl: string
  title: string
  favicon: string | null
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  origin: string | null
  zoom: number
  error: BrowserErrorInfo | null
  remoteHost: string | null
  /** Set on a tab adopted from a page-initiated new-window request. */
  openerTabId: string | null
  /** The browser profile (cookie jar, storage) the tab lives in; a popup
   *  shares its opener's. Null for a document guest. */
  profile: string | null
  /** What an agent may do with this tab. Null is the default and the resting
   *  state. */
  agentGrant: AgentGrant | null
}

/** How the platform takes a change of the app's proxy setting. */
export type BrowserProxyApplies =
  | "live"
  | "next-tab"
  | "restart"
  | "unsupported"

export interface BrowserProxyStatus {
  /** Proxy browser tabs use, as `scheme://host:port`; null = direct. */
  url: string | null
  applies: BrowserProxyApplies
  /** Why `url` is null although a proxy is configured, or why the shown proxy
   *  is not the configured one (Windows until a restart). */
  reason: string | null
}

/** A site rule as the backend sees it (same shape as `host-rules.ts`). */
export interface WireHostRule {
  pattern: string
  action: "builtin" | "system" | "block"
}

/** The administrator's policy in force. */
export interface BrowserPolicyStatus {
  /** `false`: the built-in browser is turned off machine-wide. */
  enabled: boolean
  /** Rules fixed by the administrator; shown read-only, consulted first. */
  managedRules: WireHostRule[]
  /** Path of the policy file, when one was read. */
  managedSource: string | null
}

export interface BrowserCapabilities {
  available: boolean
  surface: SurfaceKind | null
  platform: string
  channel: ChannelKind
  reasons: string[]
  /** Browsing data lives apart from the app's own web storage. */
  isolatedStorage: boolean
  proxy: BrowserProxyStatus
  /** Absolute path a page's downloads land in. */
  downloadsDir: string
  policy: BrowserPolicyStatus
  /** Local HTML files can be shown through the document guest (an embedded
   *  surface with a handler for `codeg-doc:`). */
  docGuest: boolean
  /** More than the default browser profile can exist (macOS 14+, Windows,
   *  Linux); the settings offer to create, clear and delete them. */
  profiles: boolean
  /** Tabs present the sign-in user agent to Google's sign-in hosts when the
   *  preference is on (embedded tabs, and the owned window on Linux). */
  signInUserAgent: boolean
  /** A tab shown in an owned window still answers find, history, stop and
   *  snapshots, and its page still talks to the host — true where the owned
   *  window is the surface the platform shim is written for (Linux). */
  ownedWindowControls: boolean
  /** A remote-workspace window's tabs can reach the remote host through its
   *  codeg-server: a profile of their own to proxy (macOS 14+), and on macOS
   *  the embedded surface. Whether a given remote server carries the traffic
   *  is only known when a tab asks. */
  remoteEgress: boolean
}

/** Where a remote connection's egress stands (`browser://egress`). */
export type BrowserEgressStatus =
  | { state: "idle" | "connecting" | "ready" | "unsupported" | "disabled" }
  | { state: "down"; reason: string }

export interface BrowserEgressPayload {
  connectionId: number
  status: BrowserEgressStatus
}

/** How a document guest serves its file: as a picture of itself (no script,
 *  no connection), or with its own scripts running, confined to its folder. */
export type DocMode = "safe" | "dynamic"

export type DocResetReason = "newer" | "changed"

/** Why a guest fell back to safe mode on its own: `path` (relative to the
 *  root) was found newer than the approval, or different from what had been
 *  served since it. */
export interface DocReset {
  path: string
  reason: DocResetReason
}

/** `browser://doc-state`: mode and status of one document guest. */
export interface DocGuestState {
  tabId: string
  mode: DocMode
  /** Absolute directory every request is confined to. */
  root: string
  /** Absolute path of the document. */
  entry: string
  /** The document's URL inside the guest. */
  url: string
  reset: DocReset | null
}

/** The last frame of a page, returned by a hide-with-freeze: the placeholder
 *  paints it while the surface is hidden under an overlay. */
export interface FrozenFrame {
  mime: string
  /** Base64 of the encoded image. */
  data: string
  width: number
  height: number
}

export type BrowserDownloadState = "started" | "completed" | "failed"

/** `browser://download`: one record, emitted when it starts and when it ends. */
export interface BrowserDownload {
  id: string
  tabId: string
  url: string
  fileName: string
  /** Absolute path the engine writes to; never overwrites an existing file. */
  path: string
  state: BrowserDownloadState
}

export type SurfaceChoice = "auto" | "child" | "window"

/**
 * A tab's web inspector closed; put the page back where the host wants it.
 *
 * Raised for the kind the host can ask about — macOS, embedded surface;
 * Windows hands DevTools to WebView2 and never sends this. Normally there is
 * nothing to put back, because the inspector opens in a window of its own and
 * the page never moves. But WebKit docks one into the host window for whoever
 * has asked it to, and a docked inspector resizes the page to fill that
 * window, ignores any bounds set while it is up, and leaves the page
 * full-window after it goes — which nothing else would notice, since the
 * placeholder it is laid out against never moved.
 */
export interface BrowserDevtoolsClosedPayload {
  tabId: string
}

export interface BrowserClosedPayload {
  tabId: string
  ownerWindow: string
  /** Echoes the id passed to `browserClose`, so the caller can tell this
   *  event from one it did not ask for. Four different things close a tab —
   *  the workspace, an agent's `browser_close_tab`, a profile being deleted,
   *  the user closing an owned window — and exactly one event is emitted per
   *  tab, so the tab id alone cannot say which of them this is. Absent for
   *  the three nobody here asked for. */
  requestId: string | null
}

export type PopupPresentation = "adopted" | "denied"

export interface BrowserPopupPayload {
  presentation: PopupPresentation
  openerTabId: string
  tabId: string | null
  url: string
  requestedSize: [number, number] | null
  reason: string | null
  /** The profile an adopted popup lives in (its opener's, as the backend
   *  knows it); null when denied. */
  profile: string | null
}

/** `browser://telemetry`: page-side data forwarded as-is; never trust it. */
export interface BrowserTelemetryPayload {
  tabId: string
  kind: "gesture"
  untrusted: true
  mainFrame: boolean
  top: boolean
  payload: unknown
}

/** Backend → frontend: open this URL as a browser tab (agent tools, deep
 *  links, the dev puppet). The frontend owns the tab records. */
export interface BrowserOpenRequestPayload {
  url: string
  source: string
  activate: boolean
  ownerWindow: string | null
  /** Backend id of the tab the request came from (modifier-click), if any. */
  openerTabId: string | null
  /** The profile the new tab belongs in (the opener's for a modifier-click);
   *  null leaves the choice to the frontend. */
  profile: string | null
  /** Set when the asker is waiting to be told which tab this became — an
   *  agent tool, which has to answer with the tab's id. Absent for the
   *  fire-and-forget askers (a deep link, a modifier-click). */
  requestId?: string | null
}

/** Where a detected address was printed. */
export type ServiceSource = "terminal" | "agent"

/** A loopback address something codeg started printed, and that answered a
 *  connection when the backend probed it.
 *
 *  Carried both by `browser://service-detected` (one, as it appears) and by
 *  `browser_list_services` (all of this window's, minus the ones that have
 *  stopped answering). Nothing has been opened at this point. */
export interface DetectedService {
  /** The full address to open: fragment dropped, query kept (a Jupyter
   *  address without its `?token=` opens a login page nobody can pass). */
  url: string
  /** `scheme://host[:port]` — what the backend dedupes and lists by. */
  origin: string
  /** `host:port`, the socket the liveness probe connects to. */
  authority: string
  /** Window whose workspace this belongs to; `web` in server mode. */
  ownerWindow: string
  source: ServiceSource
  /** The terminal that printed it. Not a title: the name a person sees on a
   *  terminal tab only exists on this side, and this is what puts one to it. */
  terminalId: string
}

export const BROWSER_SERVICE_DETECTED_EVENT = "browser://service-detected"
export const BROWSER_OPEN_REQUEST_EVENT = "browser://open-request"
export const BROWSER_STATE_EVENT = "browser://state"
export const BROWSER_CLOSED_EVENT = "browser://closed"
export const BROWSER_POPUP_EVENT = "browser://popup"
export const BROWSER_TELEMETRY_EVENT = "browser://telemetry"
export const BROWSER_DOWNLOAD_EVENT = "browser://download"
export const BROWSER_SHORTCUT_EVENT = "browser://shortcut"
export const BROWSER_NAVIGATION_BLOCKED_EVENT = "browser://navigation-blocked"
export const BROWSER_DOC_STATE_EVENT = "browser://doc-state"
export const BROWSER_AGENT_GRANT_EVENT = "browser://agent-grant"
export const BROWSER_AGENT_ACTIVITY_EVENT = "browser://agent-activity"
export const BROWSER_CONSOLE_ERRORS_EVENT = "browser://console-errors"
export const BROWSER_EVAL_REQUEST_EVENT = "browser://eval-request"
/** A tab's web inspector is gone; see `BrowserDevtoolsClosedPayload`. */
export const BROWSER_DEVTOOLS_CLOSED_EVENT = "browser://devtools-closed"
/** A remote connection's egress changed; see `BrowserEgressPayload`. */
export const BROWSER_EGRESS_EVENT = "browser://egress"

/** `browser://eval-request`: one `browser_eval` snippet, waiting on a person.
 *
 *  Broadcast to every window and shown by exactly one — the one that owns the
 *  tab. Two windows raising the same question would be two chances to answer
 *  it, and only the first answer would count. */
export interface BrowserEvalRequestPayload {
  /** Names this one question; goes back with the answer. */
  requestId: string
  tabId: string
  ownerWindow: string
  /** The origin the grant is bound to, which is where the code will run. */
  origin: string
  title: string
  /** The snippet, verbatim. The backend has already refused anything longer
   *  than a person could read. */
  code: string
  /** Unix milliseconds at which it lapses into a refusal. */
  expiresAt: number
}

/** `browser://console-errors`: whether the document in a tab has printed an
 *  error. At most two per document — `false` when a new one commits and the
 *  tab's console ring is cleared, `true` on the first error after that, since
 *  within one document the answer only goes from no to yes. */
export interface BrowserConsoleErrorsPayload {
  tabId: string
  errors: boolean
}

/** What the browser hands to a conversation when a person picks an element,
 *  asks for a screenshot, or sends the console (`browser_pick_element`,
 *  `browser_page_capture`, `browser_page_console`).
 *
 *  `text` is page content: it carries its own "data, not instructions" header
 *  and is what the agent reads. `label` is only set for a picked element (the
 *  page's own `tag#id.class`); for the others the frontend names the badge in
 *  the user's language, using `count` for the console. */
export interface PageHandoff {
  /** The person called the pick off; nothing else here is meaningful. */
  cancelled: boolean
  label: string
  text: string
  /** Where the page was, with anything secret-looking left out. */
  url: string
  image?: CaptureOutcome
  /** How many console lines `text` holds; 0 for everything else. */
  count: number
}

/** `external` and `download` come from document guests only: a web address
 *  the document pointed at (the user may open it in a tab), and a download
 *  it tried to start (documents do not download). */
export type NavigationBlockReason =
  | "host-rule"
  | "scheme"
  | "external"
  | "download"

/** `browser://navigation-blocked`: a top-level navigation a tab attempted
 *  was refused by policy; the tab itself is unchanged. */
export interface BrowserNavigationBlockedPayload {
  tabId: string
  url: string
  reason: NavigationBlockReason
}

/** A browser shortcut the page had keyboard focus for. */
export interface BrowserShortcutPayload {
  tabId: string
  /** A name from the host's closed set; `find` today. */
  shortcut: string
}
