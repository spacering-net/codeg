"use client"

import { memo, useState } from "react"

import { OfficePreview } from "@/components/files/office-preview"
import {
  useWorkspaceFileTabs,
  type FileWorkspaceTab,
} from "@/contexts/workspace-context"
import { splitAbsPath } from "@/lib/file-open-target"
import { isOfficePreviewable } from "@/lib/language-detect"
import { cn } from "@/lib/utils"

/** A file tab the column shows as an office preview (.docx/.xlsx/.pptx). */
export function isOfficeFileTab(tab: FileWorkspaceTab): boolean {
  return tab.kind === "file" && isOfficePreviewable(tab.path)
}

/**
 * The office tabs whose previews stay mounted once `activeId` is on screen and
 * every tab outside `openIds` is gone: every open tab that has been shown, in
 * the order its preview mounted.
 *
 * The order never changes. An id joins at the end and leaves from where it
 * is, because React re-inserts a keyed child whose position changes, and a
 * re-inserted iframe reloads — the very thing this exists to stop. Reordering
 * the tab strip must not cause it either, so the order is not the strip's.
 *
 * Returns `prev` itself when nothing changed, so a caller adjusting state
 * while rendering settles.
 */
export function nextKeptOfficePreviews(
  prev: readonly string[],
  activeId: string | null,
  openIds: ReadonlySet<string>
): readonly string[] {
  const kept = prev.filter((id) => openIds.has(id))
  if (activeId !== null && openIds.has(activeId) && !kept.includes(activeId)) {
    kept.push(activeId)
  }
  return sameIds(kept, prev) ? prev : kept
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index])
}

/**
 * The file column's office previews, kept mounted while other tabs are in
 * front.
 *
 * The column renders only the active tab, so switching away from an office
 * tab used to unmount its preview. That released its `officecli watch`, the
 * backend killed the process, and coming back spawned a new one: seconds of
 * spinner, then the document reloaded from the top. Now a tab's preview
 * mounts the first time the tab is shown and stays mounted, hidden, while
 * other tabs are in front, so coming back is instant and keeps the scroll
 * position. It unmounts, releasing the watch, when its tab closes. There is
 * no limit: every kept preview is a live `officecli watch` process (about
 * 65 MB resident for a one-paragraph document, more for a real one), held as
 * long as its tab is open. In a browser window a hidden one holds no live
 * connection to it (see `OfficePreview`).
 *
 * `FileWorkspacePanel` renders this beside its body, over the same box. The
 * body renders nothing for an office tab; both decide with `isOfficeFileTab`.
 */
export function KeptOfficePreviews() {
  const { activeFileTab, fileTabs } = useWorkspaceFileTabs()
  const activeId =
    activeFileTab && isOfficeFileTab(activeFileTab) ? activeFileTab.id : null
  const paths = new Map<string, string | null>()
  for (const tab of fileTabs) {
    if (isOfficeFileTab(tab)) paths.set(tab.id, tab.path)
  }

  const [kept, setKept] = useState<readonly string[]>([])
  const next = nextKeptOfficePreviews(kept, activeId, new Set(paths.keys()))
  if (next !== kept) setKept(next)

  return (
    <>
      {next.map((id) => (
        <KeptOfficePreview
          key={id}
          path={paths.get(id) ?? null}
          shown={id === activeId}
        />
      ))}
    </>
  )
}

/**
 * One kept preview. A hidden one keeps its box (`invisible`, not
 * `display: none`, so the page inside is not laid out again at zero size and
 * loses its scroll) and is `inert`: out of the tab order and the
 * accessibility tree. `conversation-tab-hidden` is the shared hardening for a
 * hidden kept-mounted subtree (see globals.css).
 *
 * Memoized on two primitives: `fileTabs` changes on every keystroke in a text
 * tab, and none of that reaches a preview.
 */
const KeptOfficePreview = memo(function KeptOfficePreview({
  path,
  shown,
}: {
  path: string | null
  shown: boolean
}) {
  const io = path ? splitAbsPath(path) : null
  return (
    <div
      className={cn(
        "absolute inset-0",
        !shown && "conversation-tab-hidden invisible"
      )}
      aria-hidden={!shown || undefined}
      inert={!shown || undefined}
    >
      <OfficePreview
        rootPath={io?.rootPath ?? null}
        relPath={io?.ioPath ?? null}
        active={shown}
      />
    </div>
  )
})
