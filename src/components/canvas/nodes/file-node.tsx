"use client"

import { memo, useCallback, useEffect, useMemo, useState } from "react"
import { type Node, type NodeProps } from "@xyflow/react"
import {
  Code,
  Eye,
  ExternalLink,
  FileText,
  RefreshCw,
  Trash2,
} from "lucide-react"
import { useTranslations } from "next-intl"

import {
  CenteredNotice,
  FileDocumentView,
} from "@/components/files/file-document-view"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import {
  useWorkspaceActions,
  useWorkspaceFileTabs,
} from "@/contexts/workspace-context"
import { buildFileTabId } from "@/lib/file-tab-id"
import { findOwningFolder, splitAbsPath } from "@/lib/file-open-target"
import { isHtmlPreviewable } from "@/lib/language-detect"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import {
  FILE_CARD_MIN_HEIGHT,
  FILE_CARD_MIN_WIDTH,
  type FileNodeData,
} from "../canvas-model"
import { useCanvasView } from "../canvas-view-context"
import { CARD_HEADER_BUTTON_CLASS, CardFrame } from "./card-frame"

export type FileFlowNode = Node<FileNodeData, "file">

/**
 * A file pinned to the board, rendered read-only.
 *
 * It is a VIEW of the ordinary workspace file tab, not a second file system:
 * opening goes through `openFilePreview`, so the tab, its content cache, its
 * watcher subscription (external edits mark it stale and the next activation
 * refetches) and its markdown/source toggle are the very ones the file column
 * uses — "open in workspace" is then a route switch away from this exact tab.
 * The body is `FileDocumentView`, shared with the transcript's file viewer
 * drawer, so all three surfaces branch identically on image / office /
 * markdown / HTML / source.
 *
 * The open is a BACKGROUND one. A board can hold a dozen file cards and mounts
 * them all at once on every visit to the route; the ordinary open would bring
 * the (currently covered) files pane forward and re-point its selection a dozen
 * times, rearranging a workspace the user is not even looking at.
 *
 * Editing deliberately stays a file-column affordance — this card is for
 * reading, and a board full of dirty buffers with no save affordance in sight
 * would be a trap.
 */
export const FileNode = memo(function FileNode({
  data,
  selected,
}: NodeProps<FileFlowNode>) {
  const t = useTranslations("Canvas")
  // The unavailable notice reuses the file viewer's wording — the card and the
  // transcript's drawer are the same answer to the same situation.
  const tv = useTranslations("Folder.fileViewer")
  const { endNodeResize, deleteNode } = useCanvasView()
  const {
    openFilePreview,
    reloadOpenFileBackground,
    switchFileTab,
    toggleFileTabPreview,
  } = useWorkspaceActions()
  const { fileTabs, previewFileTabIds } = useWorkspaceFileTabs()
  const { openConversations } = useWorkbenchRoute()
  const allFolders = useAppWorkspaceStore((s) => s.allFolders)

  const { dbNode, path, label } = data
  const tabId = path ? buildFileTabId({ kind: "file", path }) : null
  const tab = useMemo(
    () => (tabId ? (fileTabs.find((it) => it.id === tabId) ?? null) : null),
    [fileTabs, tabId]
  )
  const hasTab = tab !== null

  // Set when the open settled without producing a tab at all — the path names
  // nothing this client can read. A LOAD failure is not this: that comes back
  // as a tab whose body is the error, which the shared renderer shows in place
  // (the same thing the file column does). Without this the card would sit on
  // its loading notice forever, since the effect below only fires once.
  const [unresolvable, setUnresolvable] = useState(false)

  // Keep the tab in hand. Re-arms whenever it is missing — the user may have
  // closed it in the file column while the card was off-screen — and costs
  // nothing when it is already there: `decideLoad` short-circuits on the cache.
  useEffect(() => {
    if (!path || hasTab) return
    let cancelled = false
    const settle = (absPath: string | null) => {
      if (!cancelled) setUnresolvable(absPath === null)
    }
    void openFilePreview(path, { background: true }).then(settle, () =>
      settle(null)
    )
    return () => {
      cancelled = true
    }
  }, [hasTab, openFilePreview, path])

  const io = useMemo(() => (path ? splitAbsPath(path) : null), [path])
  // Root for markdown/HTML sub-resource resolution — the owning registered
  // folder when the file sits in one, else its own directory. Same rule the
  // file column and the viewer drawer apply.
  const previewRoot = useMemo(() => {
    if (!path) return null
    return findOwningFolder(path, allFolders)?.rootPath ?? io?.rootPath ?? null
  }, [allFolders, io, path])

  const isPreview = tabId ? previewFileTabIds.has(tabId) : false
  const canTogglePreview =
    tab?.kind === "file" &&
    (tab.language === "markdown" || isHtmlPreviewable(tab.path))

  const openInWorkspace = useCallback(() => {
    if (!tabId) return
    openConversations()
    switchFileTab(tabId)
  }, [openConversations, switchFileTab, tabId])

  // A link followed inside a rendered markdown card opens in the workspace
  // rather than re-binding this card: the card is pinned to one file on
  // purpose, and silently swapping which one it shows would lose the pin.
  const openMarkdownLink = useCallback(
    (linked: string) => {
      openConversations()
      void openFilePreview(linked).catch(() => {})
    },
    [openConversations, openFilePreview]
  )

  // Offered only when there is something safe to re-read. `reloadOpenFileBackground`
  // is the dirty-safe refresh (it refuses a tab with unsaved edits rather than
  // clobbering what someone typed in the file column), and it reads TEXT — an
  // office tab holds no bytes at all, just a live officecli watch that pushes
  // its own refreshes, so re-reading a .docx as text would reject the tab.
  const canReload =
    tab != null && tab.language !== "office" && tab.isDirty !== true
  const reload = useCallback(() => {
    if (!path) return
    void reloadOpenFileBackground(path).catch(() => {})
  }, [path, reloadOpenFileBackground])

  return (
    <CardFrame
      selected={selected}
      color={dbNode.color}
      minWidth={FILE_CARD_MIN_WIDTH}
      minHeight={FILE_CARD_MIN_HEIGHT}
      onResizeEnd={(geometry) => endNodeResize(dbNode.id, geometry)}
      icon={<FileText className="size-3.5 shrink-0 text-muted-foreground" />}
      title={
        // The absolute path on hover: the label is a basename, and two cards
        // showing `index.ts` are otherwise indistinguishable.
        <span title={path || label} className="block truncate">
          {label}
        </span>
      }
      actions={
        <>
          {canTogglePreview && tabId && (
            <button
              type="button"
              className={CARD_HEADER_BUTTON_CLASS}
              aria-label={isPreview ? t("fileSource") : t("filePreview")}
              title={isPreview ? t("fileSource") : t("filePreview")}
              onClick={() => toggleFileTabPreview(tabId)}
            >
              {isPreview ? (
                <Code className="size-3.5" />
              ) : (
                <Eye className="size-3.5" />
              )}
            </button>
          )}
          {canReload && (
            <button
              type="button"
              className={CARD_HEADER_BUTTON_CLASS}
              aria-label={t("reloadFile")}
              title={t("reloadFile")}
              onClick={reload}
            >
              <RefreshCw className="size-3.5" />
            </button>
          )}
          <button
            type="button"
            className={CARD_HEADER_BUTTON_CLASS}
            aria-label={t("openInWorkspace")}
            title={t("openInWorkspace")}
            onClick={openInWorkspace}
            disabled={!tabId}
          >
            <ExternalLink className="size-3.5" />
          </button>
          <button
            type="button"
            className={CARD_HEADER_BUTTON_CLASS}
            aria-label={t("removeFileCard")}
            title={t("removeFileCard")}
            onClick={() => void deleteNode(dbNode.id)}
          >
            <Trash2 className="size-3.5" />
          </button>
        </>
      }
    >
      {/* `nowheel` so scrolling the document doesn't zoom the board, `nodrag`
          so a selection drag inside it isn't read as moving the card (the
          title bar is the handle). */}
      <div className="nodrag nowheel relative min-h-0 flex-1 overflow-hidden">
        {!path || unresolvable ? (
          // A row whose path is gone (or names nothing readable) stays on the
          // board as a frame the user can delete — the same soft-reference
          // stance every other binding on this canvas takes.
          <CenteredNotice>{tv("cannotResolve")}</CenteredNotice>
        ) : (
          <FileDocumentView
            tab={tab}
            io={io}
            previewRoot={previewRoot}
            isPreview={isPreview}
            onOpenMarkdownLink={openMarkdownLink}
          />
        )}
      </div>
    </CardFrame>
  )
})
