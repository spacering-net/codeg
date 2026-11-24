"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  Copy,
  MoreHorizontal,
  RotateCw,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  X,
} from "lucide-react"

import { NativeSurfaceHost } from "@/components/browser/browser-surface-host"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  usePublishHtmlPreviewControls,
  type HtmlPreviewChrome,
} from "@/components/files/html-preview-controls"
import type { FileWorkspaceTab } from "@/contexts/workspace-context"
import { useOpenUrlTarget } from "@/hooks/use-open-url-target"
import {
  browserDocOpen,
  browserDocSetMode,
  browserReload,
} from "@/lib/browser/browser-api"
import { getBrowserPrefs } from "@/lib/browser/browser-prefs"
import {
  browserWorkspaceTabId,
  setBrowserTabNotice,
  setDocGuestState,
  useBrowserTabNotice,
  useBrowserTabState,
  useDocGuestState,
} from "@/lib/browser/browser-tab-store"
import { displayHostPort } from "@/lib/browser/browser-url"
import type { Bounds, DocMode, DocReset } from "@/lib/browser/types"
import { extractHtmlTitle } from "@/lib/html-preview-inline"
import { getAllowedExternalProtocol } from "@/lib/link-classify"
import { openWithOsHandler } from "@/lib/link-open"
import { cn, copyTextToClipboard } from "@/lib/utils"

function dirname(path: string): string {
  const cut = path.replace(/[\\/]+$/, "")
  const at = Math.max(cut.lastIndexOf("/"), cut.lastIndexOf("\\"))
  return at > 0 ? cut.slice(0, at) : cut
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

const headerBtn =
  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs transition-colors text-muted-foreground hover:bg-primary/8 disabled:opacity-50"
const iconBtn =
  "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-primary/8 disabled:opacity-50"

/**
 * An HTML file shown through the document guest (see the Rust `doc_guest`
 * module): a native surface in the preview's slot, served by the backend
 * from the file's folder. Safe mode by default — no script, no connection —
 * and a per-file switch to dynamic mode, which the backend revokes on its
 * own if any served file changes afterwards.
 *
 * Deliberately NOT a browser tab: the file column, the viewer drawer and
 * the canvas card all render `HtmlPreview`, so hosting the guest inside it
 * switches every entrance at once, keeps one tab per file, and needs no new
 * persistence — a guest is recreated from disk whenever its preview mounts.
 */
export function DocGuestPreview({
  tab,
  rootPath,
  chrome = "bar",
  onUseInline,
}: {
  tab: FileWorkspaceTab
  /** Sub-resource resolution root: the owning workspace folder, else null
   *  (the file's own directory). Same value the inline preview takes. */
  rootPath: string | null
  /** Its own header strip, or the host's (see `html-preview-controls`). */
  chrome?: HtmlPreviewChrome
  /** The user prefers the inline preview for this file. */
  onUseInline: () => void
}) {
  const t = useTranslations("Browser.doc")
  const path = tab.path ?? ""
  // One backend id per MOUNT. The guest is torn down when its preview
  // unmounts and created afresh when a preview mounts again, so two previews
  // of one file at the same time — the file column kept mounted (hidden)
  // behind a full-page route and the viewer drawer on that route — are two
  // guests, each fitted to its own placeholder and each with its own state,
  // sharing nothing but the document's grant on the backend. A fresh id per
  // mount also means a create that answers after its preview is gone lands
  // under an id nobody is looking at.
  const [backendId] = useState(() => `doc-${crypto.randomUUID()}`)
  const storeKey = browserWorkspaceTabId(backendId)
  const state = useBrowserTabState(storeKey)
  const doc = useDocGuestState(storeKey)
  // Notices about an address this preview refused to follow. The store's
  // other kinds — a tab losing the sharing it was given, either way it can
  // lose it — cannot reach a document guest: it shows a local file, and a
  // local file has no origin to tie a grant to, so one is never made here in
  // the first place.
  const raw = useBrowserTabNotice(storeKey)
  const notice =
    raw?.kind === "agent-grant-lost" || raw?.kind === "agent-grant-replaced"
      ? null
      : raw
  const openUrlTarget = useOpenUrlTarget()
  const [switching, setSwitching] = useState(false)
  const [dismissedReset, setDismissedReset] = useState<DocReset | null>(null)
  const root = rootPath ?? dirname(path)

  const create = useCallback(
    (bounds: Bounds) =>
      browserDocOpen({
        tabId: backendId,
        path,
        root,
        bounds,
        devtools: getBrowserPrefs().devtools,
      }).then((result) => {
        setDocGuestState(result.doc)
        return result.state
      }),
    [backendId, path, root]
  )

  // The file on disk changed under the guest — a save from the editor, an
  // external change the watcher picked up: show the new one. The value at
  // mount is what the guest is being created from; a change is only
  // consumed once there is a guest to reload, so a save that lands while
  // the guest is still being created is applied as soon as it exists.
  const savedRef = useRef(tab.savedContent)
  useEffect(() => {
    if (!state) return
    if (savedRef.current === tab.savedContent) return
    savedRef.current = tab.savedContent
    void browserReload(backendId).catch(() => {})
  }, [backendId, state, tab.savedContent])

  // When the backend drops the guest back to safe mode (a served file
  // changed after scripts were enabled) it reloads the document itself; the
  // preview only has to say so, and offer to approve again.
  const mode: DocMode = doc?.mode ?? "safe"
  const setMode = useCallback(
    async (next: DocMode) => {
      setSwitching(true)
      try {
        setDocGuestState(await browserDocSetMode(backendId, next))
      } catch {
        /* the guest is gone; the next mount starts over */
      } finally {
        setSwitching(false)
      }
    },
    [backendId]
  )

  const heading =
    state?.title || extractHtmlTitle(tab.content ?? "") || basename(path)
  const error = state?.error ?? null
  const reset = doc?.reset && doc.reset !== dismissedReset ? doc.reset : null

  const reload = useCallback(
    () => void browserReload(backendId).catch(() => {}),
    [backendId]
  )
  const toggleScripts = useCallback(
    () => void setMode(mode === "dynamic" ? "safe" : "dynamic"),
    [mode, setMode]
  )
  const scriptsLabel = mode === "dynamic" ? t("scriptsOn") : t("scriptsOff")
  // Whether there is a guest behind the surface at all. A BOOLEAN, not `state`
  // itself: the published controls only care that one exists, and `state` is a
  // fresh object on every page event (url, title, loading), which would
  // republish — and re-render the host header — on each one.
  const guestReady = Boolean(state)
  const scriptsDisabled = switching || !guestReady
  // Hoisted: the host header shows all of this, so the strip below is not
  // rendered at all. Copying the path is NOT published — a host with a header
  // of its own already names the file and can offer that itself.
  usePublishHtmlPreviewControls(
    tab.id,
    useMemo(
      () =>
        chrome !== "hoisted"
          ? null
          : {
              scripts: {
                on: mode === "dynamic",
                disabled: scriptsDisabled,
                label: scriptsLabel,
                hint: t("scriptsHint"),
                toggle: toggleScripts,
              },
              reload: guestReady ? { label: t("reload"), run: reload } : null,
              switchEngine: {
                to: "inline" as const,
                label: t("useInline"),
                run: onUseInline,
              },
              note: tab.isDirty ? t("unsaved") : null,
            },
      [
        chrome,
        guestReady,
        mode,
        onUseInline,
        reload,
        scriptsDisabled,
        scriptsLabel,
        t,
        tab.isDirty,
        toggleScripts,
      ]
    )
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      {chrome === "bar" && (
        <div className="flex h-9 shrink-0 items-center justify-between gap-3 border-b border-border bg-muted/20 px-3">
          <span
            className="min-w-0 truncate text-xs font-medium text-foreground/80"
            title={heading || undefined}
          >
            {heading}
          </span>
          <div className="flex shrink-0 items-center gap-0.5">
            {tab.isDirty ? (
              <span className="mr-1 truncate text-2xs text-muted-foreground">
                {t("unsaved")}
              </span>
            ) : null}
            <button
              type="button"
              onClick={toggleScripts}
              aria-pressed={mode === "dynamic"}
              disabled={scriptsDisabled}
              title={t("scriptsHint")}
              className={cn(
                headerBtn,
                mode === "dynamic" &&
                  "text-amber-600 hover:bg-amber-500/10 dark:text-amber-500"
              )}
            >
              {mode === "dynamic" ? (
                <ShieldOff className="h-3.5 w-3.5" />
              ) : (
                <ShieldCheck className="h-3.5 w-3.5" />
              )}
              {scriptsLabel}
            </button>
            <button
              type="button"
              className={iconBtn}
              title={t("reload")}
              aria-label={t("reload")}
              disabled={!state}
              onClick={reload}
            >
              <RotateCw className="h-3.5 w-3.5" />
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={iconBtn}
                  title={t("more")}
                  aria-label={t("more")}
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onSelect={() => void copyTextToClipboard(path)}
                >
                  <Copy className="h-3.5 w-3.5" />
                  {t("copyPath")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={onUseInline}>
                  {t("useInline")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      )}
      {reset ? (
        <NoticeRow
          text={t("reset", { file: reset.path })}
          onDismiss={() => setDismissedReset(reset)}
        >
          <NoticeAction
            label={t("enableAgain")}
            onClick={() => {
              setDismissedReset(reset)
              void setMode("dynamic")
            }}
          />
        </NoticeRow>
      ) : null}
      {notice ? (
        <NoticeRow
          text={
            notice.kind === "navigation-blocked" && notice.reason === "download"
              ? t("downloadRefused")
              : notice.reason === "external" ||
                  (notice.kind === "popup-denied" &&
                    /^https?:/i.test(notice.url))
                ? t("externalLink", {
                    host: displayHostPort(notice.url) ?? notice.url,
                  })
                : t("schemeBlocked", { url: notice.url })
          }
          onDismiss={() => setBrowserTabNotice(storeKey, null)}
        >
          {notice.reason === "external" ||
          (notice.kind === "popup-denied" && /^https?:/i.test(notice.url)) ? (
            <NoticeAction
              label={t("openLink")}
              onClick={() => {
                // The same decision every link in the app takes: the user's
                // default for the editor, site rules included.
                openUrlTarget(notice.url, { source: "editor" })
                setBrowserTabNotice(storeKey, null)
              }}
            />
          ) : notice.kind === "navigation-blocked" &&
            notice.reason === "scheme" &&
            getAllowedExternalProtocol(notice.url) ? (
            <NoticeAction
              label={t("openWithSystem")}
              onClick={() => {
                void openWithOsHandler(notice.url)
                setBrowserTabNotice(storeKey, null)
              }}
            />
          ) : null}
        </NoticeRow>
      ) : null}
      <div className="relative min-h-0 flex-1">
        <NativeSurfaceHost
          backendId={backendId}
          storeKey={storeKey}
          create={create}
          destroyOnUnmount
          hidden={error !== null}
          className={error ? "invisible" : undefined}
        />
        {error ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background px-6 text-center">
            <ShieldAlert className="h-8 w-8 text-muted-foreground/60" />
            <p className="text-sm font-medium text-foreground">
              {t("cannotShow")}
            </p>
            {error.message ? (
              <p className="max-w-md text-xs text-muted-foreground/80">
                {error.message}
              </p>
            ) : null}
            <button
              type="button"
              className="mt-1 inline-flex h-7 items-center gap-1.5 rounded-full border border-border px-3 text-xs hover:bg-primary/8"
              onClick={reload}
            >
              <RotateCw className="h-3.5 w-3.5" />
              {t("reload")}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** A dismissible line between the header and the document. Outside the
 *  native surface's rect on purpose: a native view paints over any DOM
 *  placed on top of it. */
function NoticeRow({
  text,
  onDismiss,
  children,
}: {
  text: string
  onDismiss: () => void
  children?: React.ReactNode
}) {
  const t = useTranslations("Browser.doc")
  return (
    <div
      role="status"
      className="flex h-8 shrink-0 items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 text-xs text-foreground"
    >
      <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-amber-600" />
      <span className="min-w-0 flex-1 truncate" title={text}>
        {text}
      </span>
      {children}
      <button
        type="button"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full hover:bg-primary/8"
        title={t("dismiss")}
        aria-label={t("dismiss")}
        onClick={onDismiss}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

function NoticeAction({
  label,
  onClick,
}: {
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className="shrink-0 rounded-full px-2 py-0.5 text-xs font-medium text-primary hover:bg-primary/8"
      onClick={onClick}
    >
      {label}
    </button>
  )
}
