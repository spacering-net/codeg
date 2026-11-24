"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react"
import { useTranslations } from "next-intl"
import { AppWindow, ShieldCheck, ShieldOff } from "lucide-react"
import { readWorkspaceFileBase64 } from "@/lib/api"
import {
  extractHtmlTitle,
  inlineHtmlResources,
  withSandboxCsp,
} from "@/lib/html-preview-inline"
import type { FileWorkspaceTab } from "@/contexts/workspace-context"
import { DocGuestPreview } from "@/components/files/doc-guest-preview"
import {
  usePublishHtmlPreviewControls,
  type HtmlPreviewChrome,
} from "@/components/files/html-preview-controls"
import {
  useBrowserPrefs,
  type HtmlPreviewEngine,
} from "@/lib/browser/browser-prefs"
import { useBrowserCapabilities } from "@/lib/browser/use-browser-capabilities"
import { isRemoteDesktopMode } from "@/lib/transport"
import { cn } from "@/lib/utils"

// Trusted sandbox: scripts run, popups/forms/modals work, but the frame still
// has an opaque origin (no allow-same-origin) and cannot navigate the top
// window (no allow-top-navigation). The default untrusted mode uses an empty
// sandbox, which renders markup/CSS/images but blocks ALL script execution —
// the actual in-app security boundary for previewing untrusted HTML.
const SANDBOX_TRUSTED = "allow-scripts allow-popups allow-forms allow-modals"

// A per-file choice of engine made from a preview's own menu, kept for the
// session (a preview unmounts whenever its file leaves the screen). Module
// state with a tiny subscription so every mount of the same file agrees.
const engineOverrides = new Map<string, HtmlPreviewEngine>()
const overrideListeners = new Set<() => void>()

function setEngineOverride(tabId: string, engine: HtmlPreviewEngine): void {
  engineOverrides.set(tabId, engine)
  for (const listener of [...overrideListeners]) listener()
}

function subscribeOverrides(listener: () => void): () => void {
  overrideListeners.add(listener)
  return () => {
    overrideListeners.delete(listener)
  }
}

function useEngineOverride(tabId: string): HtmlPreviewEngine | null {
  return useSyncExternalStore(
    subscribeOverrides,
    () => engineOverrides.get(tabId) ?? null,
    () => null
  )
}

/** Tests only. */
export function resetHtmlPreviewEngineOverridesForTests(): void {
  engineOverrides.clear()
}

/**
 * The preview of an HTML file. On the desktop, where the backend offers the
 * document guest, that is what renders it (see `DocGuestPreview`); the inline
 * `srcdoc` iframe remains the web build's renderer and one menu choice away
 * everywhere. The choice is the user's setting, overridden per file from the
 * preview's own menu.
 */
export function HtmlPreview({
  tab,
  rootPath,
  chrome = "bar",
}: {
  tab: FileWorkspaceTab
  // Sub-resource resolution root: the owning workspace folder when the
  // file sits inside one (so ../-style and root-relative references keep
  // working), else the file's own directory — a natural sandbox for
  // outside-workspace files. The tab path itself is absolute.
  rootPath: string | null
  /** Where the preview's controls go. `"bar"` — its own header strip, for
   *  hosts with nowhere else to put them (the file viewer drawer, the canvas
   *  file card). `"hoisted"` — no strip; the controls are published for the
   *  host's own header instead (see `html-preview-controls`), which is what
   *  the file column does so the document does not sit under two rows of
   *  chrome. */
  chrome?: HtmlPreviewChrome
}) {
  const prefs = useBrowserPrefs()
  const capabilities = useBrowserCapabilities()
  const override = useEngineOverride(tab.id)
  // The document viewer reads the file straight off THIS computer's disk. A
  // window bound to a remote codeg-server shows that host's files, which only
  // the inline preview reads, through the server — on this disk the same
  // path is some other file or none at all.
  const guestAvailable =
    capabilities?.docGuest === true &&
    Boolean(tab.path) &&
    !isRemoteDesktopMode()
  const engine: HtmlPreviewEngine = !guestAvailable
    ? "inline"
    : (override ?? prefs.htmlPreviewEngine)
  const tabId = tab.id
  const useInline = useCallback(
    () => setEngineOverride(tabId, "inline"),
    [tabId]
  )
  const useGuest = useCallback(() => setEngineOverride(tabId, "guest"), [tabId])
  if (engine === "guest") {
    return (
      <DocGuestPreview
        key={tab.id}
        tab={tab}
        rootPath={rootPath}
        chrome={chrome}
        onUseInline={useInline}
      />
    )
  }
  return (
    <InlineHtmlPreview
      key={tab.id}
      tab={tab}
      rootPath={rootPath}
      chrome={chrome}
      onUseGuest={guestAvailable ? useGuest : null}
    />
  )
}

/** The inline renderer: the file's markup, its local sub-resources inlined,
 *  in a sandboxed `srcdoc` iframe. */
export function InlineHtmlPreview({
  tab,
  rootPath,
  chrome = "bar",
  onUseGuest,
}: {
  tab: FileWorkspaceTab
  rootPath: string | null
  chrome?: HtmlPreviewChrome
  /** Offered when a document guest is available and the user chose the
   *  inline renderer for this file. */
  onUseGuest: (() => void) | null
}) {
  const t = useTranslations("Folder.fileWorkspacePanel")
  const tDoc = useTranslations("Browser.doc")
  const [inlined, setInlined] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [trusted, setTrusted] = useState(false)

  const content = tab.content ?? ""
  const path = tab.path ?? ""

  // The document's own <title>, shown at the left of the header bar; falls back
  // to the file name when the document has none. Parsed from the raw source
  // (not the inlined output) so it updates immediately, without loading any
  // resource.
  const title = useMemo(() => extractHtmlTitle(content), [content])
  const heading = title || path.split("/").pop() || path

  const toggleTrusted = useCallback(() => setTrusted((v) => !v), [])
  // Same two labels the document guest uses: one renderer or the other, the
  // switch is the same promise to the user. The HINT is not shared — this one
  // also hands the document the network.
  const scriptsLabel = trusted ? tDoc("scriptsOn") : tDoc("scriptsOff")
  usePublishHtmlPreviewControls(
    tab.id,
    useMemo(
      () =>
        chrome !== "hoisted"
          ? null
          : {
              scripts: {
                on: trusted,
                disabled: false,
                label: scriptsLabel,
                hint: t("htmlPreviewTrustHint"),
                toggle: toggleTrusted,
              },
              reload: null,
              switchEngine: onUseGuest
                ? {
                    to: "guest" as const,
                    label: tDoc("useGuest"),
                    run: onUseGuest,
                  }
                : null,
              note: null,
            },
      [chrome, onUseGuest, scriptsLabel, t, tDoc, toggleTrusted, trusted]
    )
  )

  useEffect(() => {
    let cancelled = false
    const root = rootPath ?? ""
    // The tab path IS the absolute file location; its directory anchors
    // relative references, while `root` anchors root-relative ones and
    // confines every read.
    const absFilePath = path || null
    const fileDir = absFilePath ? absFilePath.replace(/\/[^/]*$/, "") : root
    inlineHtmlResources(content, {
      fileDir,
      folderPath: root,
      // The inliner hands us absolute, lexically in-root paths; convert to a
      // root-relative path and read through the symlink-safe, confined
      // backend command (defense-in-depth over the lexical check).
      readFileBase64: (absPath) => {
        const r = root.replace(/\\/g, "/").replace(/\/+$/, "")
        const a = absPath.replace(/\\/g, "/")
        const rel =
          a === r ? "" : a.startsWith(r + "/") ? a.slice(r.length + 1) : a
        return readWorkspaceFileBase64(root, rel)
      },
    })
      .then((html) => {
        if (!cancelled) {
          setInlined(html)
          setError(null)
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setInlined(null)
          setError(String(err))
        }
      })
    return () => {
      cancelled = true
    }
  }, [content, path, rootPath])

  const srcDoc = inlined != null ? withSandboxCsp(inlined, { trusted }) : ""
  const loading = inlined == null && error == null

  return (
    <div className="h-full flex flex-col min-h-0">
      {chrome === "bar" && (
        <div className="h-9 shrink-0 flex items-center justify-between gap-3 px-3 border-b border-border bg-muted/20">
          <span
            className="min-w-0 truncate text-xs font-medium text-foreground/80"
            title={heading || undefined}
          >
            {heading}
          </span>
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              onClick={toggleTrusted}
              aria-pressed={trusted}
              title={t("htmlPreviewTrustHint")}
              className={cn(
                "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition-colors",
                trusted
                  ? "text-amber-600 dark:text-amber-500 hover:bg-amber-500/10"
                  : "text-muted-foreground hover:bg-primary/8"
              )}
            >
              {trusted ? (
                <ShieldOff className="h-3.5 w-3.5" />
              ) : (
                <ShieldCheck className="h-3.5 w-3.5" />
              )}
              {scriptsLabel}
            </button>
            {onUseGuest ? (
              <button
                type="button"
                onClick={onUseGuest}
                title={tDoc("useGuest")}
                aria-label={tDoc("useGuest")}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-primary/8"
              >
                <AppWindow className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        </div>
      )}
      <div className="relative flex-1 min-h-0">
        {loading && (
          <div className="absolute top-2 right-3 z-10 rounded-md bg-background/70 px-2 py-1 text-2xs text-muted-foreground backdrop-blur-sm">
            {t("loading")}
          </div>
        )}
        {error ? (
          <div className="h-full flex items-center justify-center px-6 text-center text-xs text-muted-foreground">
            {error}
          </div>
        ) : (
          inlined != null && (
            <iframe
              key={trusted ? "trusted" : "strict"}
              title={t("htmlPreviewTitle")}
              sandbox={trusted ? SANDBOX_TRUSTED : ""}
              srcDoc={srcDoc}
              className="absolute inset-0 h-full w-full border-0 bg-white"
            />
          )
        )}
      </div>
    </div>
  )
}
