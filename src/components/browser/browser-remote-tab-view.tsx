"use client"

import { Copy, ExternalLink, RotateCw, Server } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import {
  useOptionalWorkspaceActions,
  type BrowserWorkspaceTab,
} from "@/contexts/workspace-context"
import { hostnameOf, isLoopbackHost } from "@/lib/browser/browser-url"
import {
  remoteHostAddress,
  remoteHostDisplayName,
} from "@/lib/browser/remote-host"
import { copyTextToClipboard } from "@/lib/utils"

const ACTION_BTN =
  "inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs hover:bg-primary/8"

/**
 * The same address on the remote host's own name instead of `localhost` —
 * worth a try when the page there listens on every interface and its port is
 * reachable from this computer. Null when there is nothing to try: no explicit
 * port (the default port of the remote's name is whatever fronts codeg there),
 * or no name of the remote host to put in its place.
 */
function onRemoteHostName(url: string, host: string | null): string | null {
  if (!host) return null
  try {
    const parsed = new URL(url)
    if (!parsed.port) return null
    parsed.hostname = host.includes(":") ? `[${host}]` : host
    return parsed.toString()
  } catch {
    return null
  }
}

/**
 * A browser tab on an address of the remote codeg host — a loopback or
 * private address seen from a window bound to that host (see
 * `BrowserTabSeed.remote`) — that could not be opened through that host
 * (`reason` says why). There is no page here, on purpose: loaded from this
 * computer, `localhost:3000` would be THIS machine's port 3000, which is not
 * the server the agent started. The tab says where the address lives and
 * offers the ways a person can still get there.
 */
export function BrowserRemoteTabView({
  tab,
  reason = null,
  onRetry,
}: {
  tab: BrowserWorkspaceTab
  /** Why the page cannot be opened through the remote host, in words. */
  reason?: string | null
  /** Try opening it through the remote host again. */
  onRetry?: () => void
}) {
  const t = useTranslations("Browser.remote")
  const openBrowserTab = useOptionalWorkspaceActions()?.openBrowserTab ?? null
  // As the remote host knows it: a record brought back from a suspended
  // page can hold the macOS alias its page was loaded by.
  const url = remoteHostAddress(tab.browser.initialUrl)
  const host = remoteHostDisplayName()
  const hostname = hostnameOf(url)
  const loopback = hostname !== null && isLoopbackHost(hostname)
  const tryUrl = loopback ? onRemoteHostName(url, host) : null

  const copyAddress = async () => {
    const ok = await copyTextToClipboard(url)
    if (ok) toast.success(t("copied"))
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* The file column's top row, as every browser tab has one (see
          `browser-toolbar.tsx`); nothing in it acts, since there is no page
          here to act on — what can be done is below. */}
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/50 px-2 text-xs">
        <Server className="mx-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span
          className="min-w-0 flex-1 truncate px-1 text-muted-foreground"
          title={url}
        >
          {url}
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <Server className="h-8 w-8 text-muted-foreground/60" />
        <p className="text-sm font-medium text-foreground">
          {host ? t("title", { host }) : t("titleUnnamed")}
        </p>
        <p className="max-w-md break-all text-xs text-muted-foreground">
          {url}
        </p>
        {reason ? (
          <p className="max-w-md text-xs text-muted-foreground">{reason}</p>
        ) : null}
        <p className="max-w-md text-xs text-muted-foreground/80">
          {t("description")}
        </p>
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
          {onRetry ? (
            <button type="button" className={ACTION_BTN} onClick={onRetry}>
              <RotateCw className="h-3.5 w-3.5" />
              {t("retry")}
            </button>
          ) : null}
          <button
            type="button"
            className={ACTION_BTN}
            onClick={() => void copyAddress()}
          >
            <Copy className="h-3.5 w-3.5" />
            {t("copyAddress")}
          </button>
          {/* Both open an ordinary tab of this computer — the person has
              decided the address is reachable from here, and that tab is what
              they asked for, so they say `remote: false` rather than leave it
              to the address (which would make it remote again). */}
          {tryUrl && openBrowserTab ? (
            <button
              type="button"
              className={ACTION_BTN}
              title={t("tryHostHint", { address: tryUrl })}
              onClick={() => openBrowserTab(tryUrl, { remote: false })}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {t("tryHost", {
                host: new URL(tryUrl).host,
              })}
            </button>
          ) : null}
          {!loopback && openBrowserTab ? (
            <button
              type="button"
              className={ACTION_BTN}
              title={t("openHereHint")}
              onClick={() => openBrowserTab(url, { remote: false })}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {t("openHere")}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
