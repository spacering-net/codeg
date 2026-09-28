"use client"

import { useEffect, useState } from "react"

import {
  AlertTriangle,
  Check,
  Download,
  ExternalLink,
  FolderOpen,
  RotateCw,
  ShieldAlert,
  Unplug,
  X,
} from "lucide-react"
import { useTranslations } from "next-intl"

import type { BrowserWorkspaceTab } from "@/contexts/workspace-context"
import { useOptionalWorkspaceActions } from "@/contexts/workspace-context"
import {
  browserAgentGrant,
  browserReload,
  browserRevealDownload,
} from "@/lib/browser/browser-api"
import {
  dismissBrowserDownload,
  useBrowserTabDownloads,
} from "@/lib/browser/browser-downloads-store"
import {
  egressIsDown,
  useBrowserEgressStatus,
} from "@/lib/browser/browser-egress-store"
import {
  clearBrowserAgentActivity,
  setBrowserTabNotice,
  useBrowserTabNotice,
  useBrowserTabState,
  type BrowserTabNotice,
} from "@/lib/browser/browser-tab-store"
import { displayHostPort } from "@/lib/browser/browser-url"
import { remoteConnectionOfProfile } from "@/lib/browser/remote-host"
import type {
  BrowserDownload,
  BrowserErrorInfo,
  BrowserErrorKind,
  BrowserTabState,
} from "@/lib/browser/types"
import { browserTabBackendId } from "@/lib/file-tab-id"
import { getAllowedExternalProtocol } from "@/lib/link-classify"
import { openWithOsHandler } from "@/lib/link-open"
import { openUrl, revealItemInDir } from "@/lib/platform"
import { cn } from "@/lib/utils"

function noticeText(
  t: ReturnType<typeof useTranslations<"Browser.status">>,
  notice: BrowserTabNotice
): string {
  if (notice.kind === "agent-grant-lost") {
    return t("agentGrantLost", {
      origin: displayHostPort(notice.origin) ?? notice.origin,
    })
  }
  if (notice.kind === "agent-grant-replaced") {
    return t("agentGrantReplaced", {
      origin: displayHostPort(notice.origin) ?? notice.origin,
    })
  }
  const host = displayHostPort(notice.url) ?? notice.url
  if (notice.kind === "navigation-blocked") {
    if (notice.reason === "scheme") {
      // Not a web address, so its "host" would mislead (`vscode://file/…`
      // has a host of `file`): name the whole thing, as typed by the page.
      return `${t("navigationBlocked", { host: notice.url })} · ${t("navigationBlockedScheme")}`
    }
    // Windows: the page asked to take several files at once without having
    // been clicked, and the host answered the engine's permission for it.
    if (notice.reason === "download") {
      return `${t("downloadsDenied", { host })} · ${t("downloadsDeniedNoGesture")}`
    }
    // `external` is raised by document guests, which have a notice bar of
    // their own; a browser tab otherwise only ever sees a site rule.
    if (notice.reason !== "host-rule") {
      return t("navigationBlocked", { host })
    }
    return `${t("navigationBlocked", { host })} · ${t("navigationBlockedRule")}`
  }
  const why =
    notice.reason === "no-gesture"
      ? t("popupDeniedNoGesture")
      : notice.reason === "blocked-scheme"
        ? t("popupDeniedBlockedScheme")
        : notice.reason === "blocked-host"
          ? t("popupDeniedBlockedHost")
          : null
  return why
    ? `${t("popupDenied", { host })} · ${why}`
    : t("popupDenied", { host })
}

/** How long a finished page may sit on the fallback channel before it counts
 *  as degraded. The helper says hello at document start, long before the load
 *  ends, so this only absorbs the delivery of that one message. */
const CHANNEL_GRACE_MS = 1500

/**
 * True once this tab is knowably stuck without its page channel: the page is
 * done loading, it is not an error page (our helper does not run in one), and
 * `hello` still has not arrived. Held for a grace period so the ordinary
 * open — degraded until the first hello — never flashes the bar.
 *
 * `legacy` is not degraded: the page-world helper works, it is only
 * unprotected from the page. An owned window has no channel by design.
 */
function useChannelDegraded(state: BrowserTabState | null): boolean {
  const degraded =
    state?.surface === "child" &&
    state.channel === "degraded" &&
    !state.loading &&
    !state.error
  const [settled, setSettled] = useState(false)
  // Cleared during render, not in the effect, so a channel that comes up
  // takes the bar away in the same paint.
  const [wasDegraded, setWasDegraded] = useState(degraded)
  if (wasDegraded !== degraded) {
    setWasDegraded(degraded)
    setSettled(false)
  }
  useEffect(() => {
    if (!degraded) return
    const timer = setTimeout(() => setSettled(true), CHANNEL_GRACE_MS)
    return () => clearTimeout(timer)
  }, [degraded])
  return degraded && settled
}

/** Bars that sit OUTSIDE the native surface's rect (a native view paints over
 *  any DOM placed on top of it): blocked popups, remote-egress banner, a page
 *  channel that never came up. */
export function BrowserNoticeBar({
  tab,
  state,
}: {
  tab: BrowserWorkspaceTab
  state: BrowserTabState | null
}) {
  const t = useTranslations("Browser.status")
  const notice = useBrowserTabNotice(tab.id)
  // A remote tab's tunnel: the banner that names the remote host turns red
  // while it carries nothing, and back once a page's next request has opened
  // it again.
  const tunnelDown = egressIsDown(
    useBrowserEgressStatus(remoteConnectionOfProfile(state?.profile))
  )
  // Null outside the workspace providers (the viewer drawer on a full-screen
  // route); the bar then only reports the block.
  const actions = useOptionalWorkspaceActions()
  const channelDegraded = useChannelDegraded(state)
  const backendId = browserTabBackendId(tab.id)
  // Where the tab is NOW — the notice names where it was. Null unless that is
  // a web origin, which is the only thing a grant can be tied to.
  const origin = state?.origin ?? null
  const landedOn =
    origin && (origin.startsWith("http://") || origin.startsWith("https://"))
      ? origin
      : null
  if (!notice && !state?.remoteHost && !channelDegraded) return null
  return (
    <div className="flex flex-col">
      {channelDegraded ? (
        <div
          className="flex h-7 items-center gap-2 border-b border-border/60 bg-muted/60 px-3 text-xs text-muted-foreground"
          // The engine's own words are for a bug report, not for the bar.
          title={[t("channelDegradedHint"), state?.channelError]
            .filter(Boolean)
            .join("\n\n")}
        >
          <Unplug className="h-3.5 w-3.5 shrink-0 text-amber-600" />
          <span className="min-w-0 flex-1 truncate">
            {t("channelDegraded")}
          </span>
        </div>
      ) : null}
      {state?.remoteHost ? (
        <div
          className={cn(
            "flex h-7 items-center gap-2 border-b px-3 text-xs",
            tunnelDown
              ? "border-destructive/30 bg-destructive/10 text-foreground"
              : "border-border/60 bg-muted/60 text-muted-foreground"
          )}
        >
          <span
            aria-hidden
            className={cn(
              "h-1.5 w-1.5 shrink-0 rounded-full",
              tunnelDown ? "bg-destructive" : "bg-emerald-500"
            )}
          />
          <span className="min-w-0 flex-1 truncate">
            {tunnelDown
              ? t("remoteBannerDown", { host: state.remoteHost })
              : t("remoteBanner", { host: state.remoteHost })}
          </span>
        </div>
      ) : null}
      {notice ? (
        <div className="flex h-8 items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 text-xs text-foreground">
          <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-amber-600" />
          <span className="min-w-0 flex-1 truncate">
            {noticeText(t, notice)}
          </span>
          {/* A `mailto:` / `tel:` link the page pointed at: not a page, so
              not for a tab, but the OS has a handler for it — the same
              hand-off the transcript makes for those two schemes. Any
              other refused scheme stays refused. */}
          {notice.kind === "navigation-blocked" &&
          notice.reason === "scheme" &&
          getAllowedExternalProtocol(notice.url) ? (
            <button
              type="button"
              className="shrink-0 rounded px-1.5 py-0.5 text-xs font-medium text-primary hover:bg-primary/8"
              onClick={() => {
                void openWithOsHandler(notice.url)
                setBrowserTabNotice(tab.id, null)
              }}
            >
              {t("navigationBlockedOpenSystem")}
            </button>
          ) : null}
          {/* The page walked out of what was shared. Offering to share where
              it landed is not a way around the revocation — it is the same
              person making the same decision about a different site, named
              in the button. Only offered when there is a web origin to bind
              to; otherwise the notice just reports. */}
          {notice.kind === "agent-grant-lost" && landedOn ? (
            <button
              type="button"
              className="shrink-0 rounded px-1.5 py-0.5 text-xs font-medium text-primary hover:bg-primary/8"
              onClick={() => {
                if (!backendId) return
                void browserAgentGrant(backendId, "read")
                  .then(() => setBrowserTabNotice(tab.id, null))
                  .catch(() => {
                    /* the notice stays; the tab moved on again */
                  })
              }}
            >
              {t("agentGrantLostShare", {
                origin: displayHostPort(landedOn) ?? landedOn,
              })}
            </button>
          ) : null}
          {/* The tab did not move, so there is nowhere new to name: the
              button offers the same address, now that the person knows
              something else is behind it. Re-sharing pins whatever is
              serving it at the moment they press this. */}
          {notice.kind === "agent-grant-replaced" && landedOn ? (
            <button
              type="button"
              className="shrink-0 rounded px-1.5 py-0.5 text-xs font-medium text-primary hover:bg-primary/8"
              onClick={() => {
                if (!backendId) return
                void browserAgentGrant(backendId, "read")
                  .then(() => setBrowserTabNotice(tab.id, null))
                  .catch(() => {
                    /* the notice stays; the tab moved on again */
                  })
              }}
            >
              {t("agentGrantReplacedShare")}
            </button>
          ) : null}
          {/* Opens the blocked address as a plain tab: the page's own
              `window.open` is gone, so there is no opener to preserve — the
              same trade a browser's "show blocked pop-up" makes. A pop-up a
              site rule refused stays refused. */}
          {notice.kind === "popup-denied" &&
          notice.reason !== "blocked-host" &&
          actions ? (
            <button
              type="button"
              className="shrink-0 rounded px-1.5 py-0.5 text-xs font-medium text-primary hover:bg-primary/8"
              onClick={() => {
                actions.openBrowserTab(notice.url, { openerTabId: tab.id })
                setBrowserTabNotice(tab.id, null)
              }}
            >
              {t("popupOpenAnyway")}
            </button>
          ) : null}
          <button
            type="button"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-primary/8"
            title={t("dismiss")}
            aria-label={t("dismiss")}
            onClick={() => setBrowserTabNotice(tab.id, null)}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}
    </div>
  )
}

function errorLabel(
  t: ReturnType<typeof useTranslations<"Browser.status">>,
  error: BrowserErrorInfo
): string {
  switch (error.kind) {
    case "dns":
      return t("errorDns")
    case "tls":
      return t("errorTls")
    case "blocked":
      return t("errorBlocked")
    case "popup-denied":
      return t("errorPopupDenied")
    case "remote-refused":
      return t("errorRemoteRefused")
    case "remote-unreachable":
      return t("errorRemoteUnreachable")
    case "remote-not-allowed":
      return t("errorRemoteNotAllowed")
    case "remote-timeout":
      return t("errorRemoteTimeout")
    case "tunnel-down":
      return t("errorTunnelDown")
    default:
      return t("errorFailed")
  }
}

/** What to do about a failure, in the user's language; "" when the label
 *  says it all. */
function errorHint(
  t: ReturnType<typeof useTranslations<"Browser.status">>,
  error: BrowserErrorInfo,
  remoteHost: string | null
): string {
  const host = remoteHost ?? ""
  switch (error.kind) {
    case "failed":
      return t("errorFailedHint")
    case "blocked":
      return t("errorBlockedHint")
    case "remote-refused":
      return t("errorRemoteRefusedHint", { host })
    case "remote-unreachable":
      return t("errorRemoteUnreachableHint", { host })
    case "remote-not-allowed":
      return t("errorRemoteNotAllowedHint", { host })
    case "remote-timeout":
      return t("errorRemoteTimeoutHint", { host })
    case "tunnel-down":
      return t("errorTunnelDownHint", { host })
    default:
      return ""
  }
}

/** A failure the tunnel to the remote host explained: the engine's own text
 *  for it is its word for any failed proxied connection, and says nothing. */
function isRemoteFailure(kind: BrowserErrorKind): boolean {
  return (
    kind === "remote-refused" ||
    kind === "remote-unreachable" ||
    kind === "remote-not-allowed" ||
    kind === "remote-timeout" ||
    kind === "tunnel-down"
  )
}

/** DOM error page shown INSTEAD of the native surface (the host hides it). */
export function BrowserErrorPage({
  tab,
  error,
  url,
}: {
  tab: BrowserWorkspaceTab
  error: BrowserErrorInfo
  url: string
}) {
  const t = useTranslations("Browser.status")
  const backendId = browserTabBackendId(tab.id)
  const remoteHost = useBrowserTabState(tab.id)?.remoteHost ?? null
  // Platform errors carry their own text (in the system language); the
  // hint is ours, in the user's, and says what to do about it.
  const detail = isRemoteFailure(error.kind) ? "" : error.message
  const hint = errorHint(t, error, remoteHost)
  // A site rule means "not this host": offering the system browser would
  // undo the rule with one click. And a remote tab's address is the remote
  // host's: the system browser would take it to this computer.
  const noSystemBrowser =
    error.kind === "blocked" || tab.browser.remote === true
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <ShieldAlert className="h-8 w-8 text-muted-foreground/60" />
      <p className="text-sm font-medium text-foreground">
        {errorLabel(t, error)}
      </p>
      <p className="max-w-md break-all text-xs text-muted-foreground">
        {error.url || url}
      </p>
      {detail ? (
        <p className="max-w-md text-xs text-muted-foreground/80">{detail}</p>
      ) : null}
      {hint ? (
        <p className="max-w-md text-xs text-muted-foreground/80">{hint}</p>
      ) : null}
      <div className="mt-1 flex items-center gap-2">
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs hover:bg-primary/8"
          // The toolbar's reload button by another name, so it forgets what
          // agents did here on the same terms (`browser-toolbar.tsx`): the
          // lines are about a document this is asking to replace.
          onClick={() => {
            if (!backendId) return
            const asOf = Date.now()
            void browserReload(backendId).then(
              () => clearBrowserAgentActivity(tab.id, asOf),
              () => {
                /* the tab's surface is gone; the error page stays */
              }
            )
          }}
        >
          <RotateCw className="h-3.5 w-3.5" />
          {t("retry")}
        </button>
        {noSystemBrowser ? null : (
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs hover:bg-primary/8"
            onClick={() => void openUrl(error.url || url)}
          >
            <ExternalLink className="h-3.5 w-3.5" />
            {t("openInSystem")}
          </button>
        )}
      </div>
    </div>
  )
}

/** Placeholder shown in the pane when the page lives in an owned window
 *  (Linux, or the fallback surface): nothing is embedded here. */
export function BrowserOwnedWindowCard({
  url,
  onShow,
}: {
  url: string
  onShow: () => void
}) {
  const t = useTranslations("Browser.status")
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-sm text-muted-foreground">{t("ownedWindow")}</p>
      <p className="max-w-md break-all text-xs text-muted-foreground/80">
        {url}
      </p>
      <button
        type="button"
        className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs hover:bg-primary/8"
        onClick={onShow}
      >
        {t("ownedWindowShow")}
      </button>
    </div>
  )
}

/**
 * "Show in folder" for a downloaded file. The opener plugin first, because it
 * is the one path that works everywhere; the backend second, because the
 * plugin resolves the path before handing it to the shell and a Windows
 * network location comes out as `\\?\UNC\…`, which the shell refuses. The
 * backend reveals the path IT recorded for that download, so nothing new is
 * reachable through the fallback.
 */
async function revealDownload(download: BrowserDownload): Promise<void> {
  try {
    await revealItemInDir(download.path)
  } catch {
    await browserRevealDownload(download.id)
  }
}

/**
 * Downloads of this tab, above the page. A download is never opened for the
 * user — the bar offers "show in folder", which is what a file arriving from
 * the web deserves; running it is their decision, in their file manager.
 */
export function BrowserDownloadBar({ tab }: { tab: BrowserWorkspaceTab }) {
  const t = useTranslations("Browser.download")
  const downloads = useBrowserTabDownloads(tab.id)
  if (downloads.length === 0) return null
  return (
    <div className="flex flex-col border-b border-border/60 bg-muted/40">
      {downloads.map((download) => (
        <div
          key={download.id}
          className="flex h-8 items-center gap-2 px-3 text-xs text-foreground"
        >
          {download.state === "completed" ? (
            <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
          ) : download.state === "failed" ? (
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" />
          ) : (
            <Download className="h-3.5 w-3.5 shrink-0 animate-pulse text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 truncate" title={download.path}>
            {download.fileName}
            <span className="ml-2 text-muted-foreground">
              {download.state === "completed"
                ? t("completed")
                : download.state === "failed"
                  ? t("failed")
                  : t("started")}
            </span>
          </span>
          {download.state === "completed" ? (
            <button
              type="button"
              className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-medium text-primary hover:bg-primary/8"
              onClick={() => void revealDownload(download)}
            >
              <FolderOpen className="h-3.5 w-3.5" />
              {t("reveal")}
            </button>
          ) : null}
          <button
            type="button"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-primary/8"
            title={t("dismiss")}
            aria-label={t("dismiss")}
            onClick={() => dismissBrowserDownload(download.id)}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  )
}
