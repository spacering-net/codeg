"use client"

import {
  AppWindow,
  Code,
  Copy,
  EllipsisVertical,
  ExternalLink,
  Eye,
  Frame,
  RotateCw,
  ShieldCheck,
  ShieldOff,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { openPath } from "@/lib/platform"
import { isHtmlPreviewable } from "@/lib/language-detect"
import {
  useWorkspaceActions,
  useWorkspaceFileTabs,
} from "@/contexts/workspace-context"
import { FilePathBreadcrumb } from "@/components/files/file-path-breadcrumb"
import { useHtmlPreviewControls } from "@/components/files/html-preview-controls"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn, copyTextFromMenu } from "@/lib/utils"

/**
 * Desktop file-detail header: the active file's name on the left, its file-type
 * actions on the right — the markdown/html preview⇄source toggle, the HTML
 * preview's own controls (see below) and a "more" menu for everything that does
 * not earn a permanent button (open in the system browser, copy path, reload,
 * switch renderer). Self-hides for a browser tab, whose toolbar is its own
 * header (see below). Maximize/restore lives in the file tab strip
 * (`FileWorkspaceTabBar`, embedded) instead, flush right of the tabs.
 *
 * An HTML preview rendered in this column draws NO header strip of its own
 * (`chrome="hoisted"`); it publishes its controls and they are shown here, so
 * the document sits under one row of chrome instead of two. Its scripts switch
 * stays a visible button — it is the one security decision on this row, and a
 * toggle whose state you cannot see without opening a menu is not a toggle.
 * The other surfaces that render the same preview (the transcript's file
 * viewer drawer, the canvas file card) have no such header and keep the
 * preview's own strip.
 *
 * Rendered in two places (`app/workspace/layout.tsx`): under the desktop file
 * column's tab strip, and as the mobile file view's ONLY header — there is no
 * tab strip there, so a mobile browser tab ends up with no header at all. That
 * is intended: on mobile a browser tab is a `BrowserBridgeView`, which carries
 * the address and its own buttons in a row of the same shape.
 *
 * Sits above every `FileWorkspacePanel` render branch (editor / preview /
 * diff / image / office), so it wraps them all uniformly.
 */
export function FileWorkspaceHeader() {
  const t = useTranslations("Folder.fileWorkspace")
  // Copying a path is the file tree's own menu row, word for word — same
  // action, same wording, no second set of strings to keep in step.
  const tFileTree = useTranslations("Folder.fileTreeTab")
  const { activeFileTab, activeFileTabId, previewFileTabIds } =
    useWorkspaceFileTabs()
  const { toggleFileTabPreview } = useWorkspaceActions()
  // Present only while an HTML preview is on screen in this column — its
  // renderer publishes them and takes them away when it unmounts.
  const preview = useHtmlPreviewControls(activeFileTabId)

  // A browser tab has no title row: its own toolbar (address bar and page
  // controls) becomes the top row of the column instead. Two rows of chrome
  // above a web page is one too many, and neither said anything the other
  // did not — the page title is already on the tab (in full on hover), and
  // the address bar names the page better than a repeated title. None of the
  // actions below apply to a browser tab either; they are all `kind: "file"`.
  if (!activeFileTab || activeFileTab.kind === "browser") return null

  const displayTitle = activeFileTab.title

  const isDiff =
    activeFileTab.kind === "diff" || activeFileTab.kind === "rich-diff"
  const isDirty =
    activeFileTab.kind === "file" && Boolean(activeFileTab.isDirty)
  // Mirror the gating the file tab strip used (file-workspace-tab-bar.tsx):
  // preview toggle for markdown/html, browser-open for html.
  const canPreview =
    activeFileTab.kind === "file" &&
    (activeFileTab.language === "markdown" ||
      isHtmlPreviewable(activeFileTab.path))
  const canOpenInBrowser =
    activeFileTab.kind === "file" && isHtmlPreviewable(activeFileTab.path)
  const isPreviewActive =
    canPreview && activeFileTabId
      ? previewFileTabIds.has(activeFileTabId)
      : false
  const path = activeFileTab.path
  // The menu is worth a button only if it has something in it: a diff tab has
  // no path to copy and nothing to open.
  const hasMenu = Boolean(
    path || preview?.reload || preview?.switchEngine || canOpenInBrowser
  )

  const actionBtn =
    "flex h-7 w-7 shrink-0 items-center justify-center rounded-full hover:bg-primary/8 transition-colors"

  return (
    // Transparent like the conversation detail header
    // (conversation-detail-header.tsx): the title header merges with the canvas
    // below it (editor / preview) instead of being a frosted band. With a
    // workspace background image on, the tab strip above it is transparent too,
    // so the whole top of the column reveals the canvas.
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/50 px-3">
      {/* No leading file-type icon — the folder name leads the breadcrumb, and
          the text matches the conversation detail header's `text-sm` title.
          `grow shrink basis-32` rather than `flex-1`: a zero basis makes this
          the first thing flex takes width from, so in a narrow column the file
          name vanished while a passive note next to it kept its full width.
          With a basis it gives way in proportion, like everything else on the
          row. (Longhands on purpose — `flex-1` is a shorthand and would fight
          `basis-*` on generated-CSS order rather than on class order.) */}
      <div className="flex min-w-0 shrink grow basis-32 items-center gap-1.5 text-sm">
        {/* Diff tabs have no single navigable path — keep them as a plain
            title. Plain files render a clickable path breadcrumb. */}
        {isDiff || !activeFileTab.path ? (
          <span
            className="truncate text-foreground/90"
            title={activeFileTab.description ?? displayTitle}
          >
            {displayTitle}
            {isDirty ? " *" : ""}
          </span>
        ) : (
          <FilePathBreadcrumb
            path={activeFileTab.path}
            fileName={activeFileTab.title}
            isDirty={isDirty}
          />
        )}
      </div>
      {/* What gives way in a narrow column, in order: the breadcrumb (it is
          `flex-1` on a zero basis, so it holds no width of its own), then the
          note, then the scripts label down to its bare icon. The icon buttons
          are `shrink-0` and stay whole — a row that squeezes its last button
          out of the container has lost an action, not saved space. */}
      <div className="flex min-w-0 shrink items-center gap-0.5">
        {preview?.note && (
          // Capped at 10rem: a remark about the document must not push the
          // file's own name off its header. Past the cap it ellipsizes and the
          // tooltip carries the sentence.
          <span
            className="mr-1 max-w-40 truncate text-2xs text-muted-foreground"
            title={preview.note}
          >
            {preview.note}
          </span>
        )}
        {preview && (
          <button
            type="button"
            onClick={preview.scripts.toggle}
            aria-pressed={preview.scripts.on}
            disabled={preview.scripts.disabled}
            title={preview.scripts.hint}
            className={cn(
              "inline-flex h-7 min-w-0 items-center gap-1.5 rounded-full px-2.5 text-xs transition-colors disabled:opacity-50",
              preview.scripts.on
                ? "text-amber-600 hover:bg-amber-500/10 dark:text-amber-500"
                : "text-muted-foreground hover:bg-primary/8"
            )}
          >
            {preview.scripts.on ? (
              <ShieldOff className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
            )}
            <span className="truncate">{preview.scripts.label}</span>
          </button>
        )}
        {canPreview && activeFileTabId && (
          <button
            type="button"
            onClick={() => toggleFileTabPreview(activeFileTabId)}
            className={cn(actionBtn, isPreviewActive && "text-primary")}
            aria-label={isPreviewActive ? t("editSource") : t("preview")}
            title={isPreviewActive ? t("editSource") : t("preview")}
          >
            {isPreviewActive ? (
              <Code className="h-4 w-4" />
            ) : (
              <Eye className="h-4 w-4" />
            )}
          </button>
        )}
        {hasMenu && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={actionBtn}
                aria-label={t("more")}
                title={t("more")}
              >
                <EllipsisVertical className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-auto min-w-48">
              {preview?.reload && (
                <DropdownMenuItem onSelect={preview.reload.run}>
                  <RotateCw />
                  {preview.reload.label}
                </DropdownMenuItem>
              )}
              {canOpenInBrowser && path && (
                <DropdownMenuItem
                  onSelect={() => {
                    // File tab paths are absolute — hand it straight to the OS.
                    openPath(path).catch(() => {})
                  }}
                >
                  <ExternalLink />
                  {t("openInSystemBrowser")}
                </DropdownMenuItem>
              )}
              {preview?.switchEngine && (
                <DropdownMenuItem onSelect={preview.switchEngine.run}>
                  {preview.switchEngine.to === "guest" ? (
                    <AppWindow />
                  ) : (
                    <Frame />
                  )}
                  {preview.switchEngine.label}
                </DropdownMenuItem>
              )}
              {path && (
                <>
                  {(preview?.reload || preview?.switchEngine) && (
                    <DropdownMenuSeparator />
                  )}
                  {/* Deferred: a menu item that copies while the menu is still
                      open loses the selection to Radix's focus scope in the
                      web build's execCommand fallback. */}
                  <DropdownMenuItem
                    onSelect={() => {
                      void copyTextFromMenu(path).then((ok) => {
                        toast[ok ? "success" : "error"](
                          tFileTree(
                            ok ? "toasts.pathCopied" : "toasts.copyPathFailed"
                          )
                        )
                      })
                    }}
                  >
                    <Copy />
                    {tFileTree("copyPath")}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  )
}
