"use client"

import type { ReactNode } from "react"
import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { parseLocalFileTarget } from "@/components/ai-elements/link-safety"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { useActiveFolder } from "@/contexts/active-folder-context"
import {
  downloadWorkspaceFile,
  isWorkspaceFileApiAvailable,
  WORKSPACE_DOWNLOAD_CANCELLED,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import {
  expandHomePath,
  isHomeRelativePath,
  normalizeAbsPath,
} from "@/lib/file-open-target"
import {
  toAbsoluteFilePath,
  toFolderRelativePath,
} from "@/lib/file-path-display"
import { isLocalDesktop, revealItemInDir } from "@/lib/platform"
import { copyTextFromMenu } from "@/lib/utils"

/** The two path forms offered by the badge's action menu. */
export interface FileReferencePaths {
  /**
   * Absolute filesystem path (slash-normalized), or a `~/`-rooted path — the
   * home directory only resolves through the backend, so the tilde form is
   * kept here and expanded at reveal time.
   */
  absolute: string
  /** Path relative to the active folder; null when the file lives outside it. */
  relative: string | null
}

/**
 * Resolve a rendered file reference — a `file://` uri (user-message badge) or a
 * local path (assistant markdown link, as remark-file-uri-links and
 * rehype-relative-file-links leave it) — into its absolute and folder-relative
 * forms.
 *
 * Returns null when the target isn't a local file at all (a web link, an
 * embedded `codeg://` attachment badge) or when a relative target can't be made
 * absolute for lack of an active folder — in those cases the badge shows no
 * action button, since none of the three actions could do anything.
 *
 * Parsing goes through link-safety's {@link parseLocalFileTarget} so the menu
 * resolves the same path a click on the badge would open (line suffixes like
 * `#L10-25` / `:12` are dropped — a path is copied, not a location).
 */
export function resolveFileReferenceTarget(
  rawTarget: string,
  folderPath?: string | null
): FileReferencePaths | null {
  const target = parseLocalFileTarget(rawTarget)
  if (!target) return null

  if (isHomeRelativePath(target.path)) {
    return { absolute: target.path, relative: null }
  }

  const joined = toAbsoluteFilePath(target.path, folderPath ?? undefined)
  if (!joined) return null
  // Resolve `.` / `..` the way the opener does, or `../site/a.md` from `/repo`
  // would read as `/repo/../site/a.md` — inside the folder by its prefix, when
  // the file it opens, `/site/a.md`, is not.
  const absolute = normalizeAbsPath(joined)

  // `toFolderRelativePath` returns the absolute path unchanged when the file
  // lives outside the folder — that's "no relative form", not a relative path.
  // The folder is compared in the same resolved form as the file.
  const relative = folderPath
    ? toFolderRelativePath(absolute, normalizeAbsPath(folderPath))
    : null
  return {
    absolute,
    relative: relative && relative !== absolute ? relative : null,
  }
}

/** The reveal label matching the host OS, mirroring the file tree's "Open in". */
export function systemFileManagerLabelKey():
  | "openInFinder"
  | "openInExplorer"
  | "openInFileManager" {
  if (typeof navigator === "undefined") return "openInFileManager"
  const platform = `${navigator.platform} ${navigator.userAgent}`.toLowerCase()
  if (platform.includes("mac")) return "openInFinder"
  if (platform.includes("win")) return "openInExplorer"
  return "openInFileManager"
}

/**
 * The menu body. Mounted only while the menu is open, so a badge sitting in the
 * transcript pays for neither the active-folder subscription, the path
 * resolution, nor a translator.
 */
function FileReferenceActionsMenu({ target }: { target: string }) {
  const t = useTranslations("Folder.chat.fileActions")
  const { activeFolder } = useActiveFolder()
  // Resolved the way the opener resolves it, so the relative path below and
  // the download that uses it name the file a click opens.
  const folderPath = activeFolder?.path
    ? normalizeAbsPath(activeFolder.path)
    : undefined
  const paths = useMemo(
    () => resolveFileReferenceTarget(target, folderPath),
    [target, folderPath]
  )

  const handleReveal = () => {
    if (!paths) return
    void (async () => {
      try {
        const absolute = isHomeRelativePath(paths.absolute)
          ? await expandHomePath(paths.absolute)
          : paths.absolute
        await revealItemInDir(absolute)
      } catch (error) {
        toast.error(t("openFailed"), { description: toErrorMessage(error) })
      }
    })()
  }

  const handleCopy = (value: string | null) => {
    if (!value) return
    // `copyTextFromMenu` defers the write until this menu has closed, so the
    // execCommand fallback still works in non-secure web contexts.
    void copyTextFromMenu(value).then((ok) => {
      if (ok) toast.success(t("pathCopied"))
      else toast.error(t("copyPathFailed"))
    })
  }

  // Same shape as the file tree's download row: the ticket is issued against
  // the workspace root, so a file outside the active folder — the case where
  // there is no relative form — has nothing to download from.
  const handleDownload = () => {
    const relative = paths?.relative
    if (!relative || !folderPath) return
    const name = relative.split("/").pop() || relative
    void (async () => {
      try {
        const result = await downloadWorkspaceFile(folderPath, relative, name)
        // Web hands off to the browser's download manager ("started"), which
        // shows its own progress — a toast there would just be noise. Only the
        // remote-desktop save-dialog path has an outcome worth reporting.
        if (result.status === "started") return
        if (result.status === WORKSPACE_DOWNLOAD_CANCELLED) return
        if (result.savedPath) {
          toast.success(t("downloadSaved", { name }), {
            description: result.savedPath,
          })
        }
      } catch (error) {
        toast.error(t("downloadFailed", { name }), {
          description: toErrorMessage(error),
        })
      }
    })()
  }

  return (
    <>
      {/* `revealItemInDir` is a no-op in web mode and for a desktop window
          bound to a remote workspace, so the row is hidden rather than dead. */}
      {isLocalDesktop() && (
        <ContextMenuItem disabled={!paths} onSelect={handleReveal}>
          {t(systemFileManagerLabelKey())}
        </ContextMenuItem>
      )}
      <ContextMenuItem
        disabled={!paths?.relative}
        onSelect={() => handleCopy(paths?.relative ?? null)}
      >
        {t("copyRelativePath")}
      </ContextMenuItem>
      <ContextMenuItem
        disabled={!paths?.absolute}
        onSelect={() => handleCopy(paths?.absolute ?? null)}
      >
        {t("copyAbsolutePath")}
      </ContextMenuItem>
      {/* Web and remote-desktop windows have no reach into the machine that
          holds the file, so downloading is how the byte stream gets to the
          user — mirroring the file tree's own row. A local desktop window can
          just open it, so the row is hidden rather than dead. */}
      {isWorkspaceFileApiAvailable() && (
        <ContextMenuItem disabled={!paths?.relative} onSelect={handleDownload}>
          {t("download")}
        </ContextMenuItem>
      )}
    </>
  )
}

/**
 * Wraps an inline file badge in the transcript (user messages via
 * PlainTextWithBadges, assistant markdown via MarkdownLink) so that right-
 * clicking the file name opens its actions: reveal in the OS file manager, copy
 * relative path, copy absolute path, and — where the file lives on another host
 * — download it. A non-file target renders its children untouched, with no menu
 * attached.
 *
 * A context menu (not a hover popover, and not a click target of its own) is
 * what leaves the badge's own behaviour intact: a left click still opens the
 * file in the workspace panel, reading past a file name pops nothing, and Radix
 * gives the long-press gesture on touch, keyboard navigation and Escape for
 * free.
 *
 * The conversation panel wraps the whole transcript in its own context menu
 * (copy text / new conversation / export / …, see
 * conversations/conversation-detail-panel.tsx), so the badge's trigger STOPS the
 * event from bubbling — otherwise both menus open at once. Right-clicking a file
 * name is therefore about that file; right-clicking anywhere else in the
 * transcript still gets the conversation menu.
 */
export function FileReferenceActions({
  target,
  children,
}: {
  target: string
  children: ReactNode
}) {
  // Folder-independent: whether this target is a local file at all. The full
  // resolution (which needs the active folder) happens inside the open menu.
  const isLocalFile = useMemo(
    () => parseLocalFileTarget(target) !== null,
    [target]
  )

  if (!isLocalFile) return <>{children}</>

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <span
          data-file-actions=""
          className="inline-flex max-w-full items-center align-middle"
          // Radix's own handler still runs (it is merged onto this same
          // element); only the ancestor conversation-panel trigger is cut off.
          onContextMenu={(event) => event.stopPropagation()}
          // Touch/pen open a context menu from a long press, which is armed on
          // pointerdown — stop that press from arming the ancestor trigger too.
          // Mouse presses keep bubbling, so the panel's selection bookkeeping is
          // untouched.
          onPointerDown={(event) => {
            if (event.pointerType !== "mouse") event.stopPropagation()
          }}
        >
          {children}
        </span>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <FileReferenceActionsMenu target={target} />
      </ContextMenuContent>
    </ContextMenu>
  )
}
