"use client"

import { memo, useEffect, useRef, useState } from "react"
import { NodeResizer, type Node, type NodeProps } from "@xyflow/react"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import type { NoteNodeData } from "../canvas-model"
import { ColorWash } from "../canvas-swatches"
import { useCanvasView } from "../canvas-view-context"

export type NoteFlowNode = Node<NoteNodeData, "note">

/**
 * A sticky note. Two states, because a note has to be both movable and
 * writable and a textarea cannot be both:
 *
 *   at rest — plain text, no `nodrag`, so the WHOLE note is a drag handle
 *   editing — a focused textarea, `nodrag nowheel`, entered by double-click
 *
 * It used to be a textarea at all times, filling the node and carrying
 * `nodrag`, which left the note with no grabbable pixel anywhere: typing worked
 * and dragging was impossible. Double-click is the same gesture that renames a
 * region, so "double-click to edit the text" already reads as the board's rule.
 *
 * Edits commit on exit (blur or Escape) as a single patch — notes are
 * annotations, not collaborative documents, so LWW per edit session is plenty.
 * Colour and delete live in the action dock with every other element's verbs;
 * the note itself is just the paper.
 */
export const NoteNode = memo(function NoteNode({
  data,
  selected,
}: NodeProps<NoteFlowNode>) {
  const t = useTranslations("Canvas")
  const { dbNode } = data
  const { patchNode, endNodeResize } = useCanvasView()
  const [draft, setDraft] = useState(dbNode.content ?? "")
  const [editing, setEditing] = useState(false)
  // Remote edits land while we're NOT editing; while editing the local draft
  // wins (same freeze idea as dragging). Adjust-during-render, not an effect:
  // track the last remote value seen and resync the draft when it moves.
  const [lastRemote, setLastRemote] = useState(dbNode.content ?? "")
  const remote = dbNode.content ?? ""
  if (remote !== lastRemote) {
    setLastRemote(remote)
    if (!editing) setDraft(remote)
  }

  // Unsaved text, mirrored for the unmount path below. Written from the event
  // handlers — never from an effect: a passive effect for the last keystroke
  // may still be queued when the node goes away, and it is exactly that last
  // keystroke the unmount save exists to keep. Cleared synchronously by
  // `commit` so a blur followed immediately by an unmount can't send the same
  // patch twice.
  const pendingRef = useRef<{
    text: string
    nodeId: number
    patch: typeof patchNode
  } | null>(null)

  const commit = () => {
    setEditing(false)
    pendingRef.current = null
    // On save failure the draft is KEPT (patchNode toasts): resetting to the
    // stored value would throw away the user's text, and the kept draft doubles
    // as the retry payload for the next commit.
    if (draft !== (dbNode.content ?? "")) {
      void patchNode(dbNode.id, { content: draft })
    }
  }

  const edit = (text: string) => {
    setDraft(text)
    pendingRef.current =
      text === (dbNode.content ?? "")
        ? null
        : { text, nodeId: dbNode.id, patch: patchNode }
  }

  // Blur is the normal way out, but not the only way the editor can end: the
  // canvas route unmounts on a view switch, ReactFlow culls off-screen nodes,
  // and a remote delete takes the node with it — none of which fire blur. Save
  // whatever was typed on the way out rather than dropping it.
  useEffect(
    () => () => {
      const pending = pendingRef.current
      if (pending) void pending.patch(pending.nodeId, { content: pending.text })
    },
    []
  )

  return (
    <div
      className={cn(
        // Sized by the RF node wrapper (derive feeds width/height, including
        // live NodeResizer dimensions), and written in those same units —
        // `canvas-board-units` keeps the text from outgrowing a box the board
        // measures in flow units (see globals.css).
        "canvas-board-units relative flex h-full w-full flex-col rounded-xl border bg-card transition-colors",
        "border-foreground/15 hover:border-foreground/30",
        selected && "border-primary ring-2 ring-primary/25"
      )}
      onDoubleClick={() => setEditing(true)}
    >
      <NodeResizer
        isVisible={Boolean(selected)}
        minWidth={140}
        minHeight={96}
        lineClassName="!border-primary/40"
        handleClassName="!size-2 !rounded-sm !border-primary !bg-background"
        onResizeEnd={(_e, params) =>
          endNodeResize(dbNode.id, {
            width: params.width,
            height: params.height,
            x: params.x,
            y: params.y,
          })
        }
      />
      <ColorWash color={dbNode.color} className="rounded-xl" />
      {editing ? (
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => edit(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            // Escape leaves edit mode; every other key belongs to the text, and
            // must not reach the board's element shortcuts (Delete would remove
            // the note out from under the cursor).
            if (e.key === "Escape") {
              e.stopPropagation()
              e.currentTarget.blur()
              return
            }
            e.stopPropagation()
          }}
          placeholder={t("notePlaceholder")}
          className="nodrag nowheel relative min-h-0 flex-1 resize-none rounded-xl bg-transparent p-3 text-[13px] leading-relaxed outline-none select-text placeholder:text-muted-foreground/50"
        />
      ) : (
        // `overflow-hidden` rather than a scrollbar: at rest the note is a card
        // to be moved, and a scroll region here would swallow the drag.
        <div
          className={cn(
            "relative min-h-0 flex-1 overflow-hidden p-3 text-[13px] leading-relaxed whitespace-pre-wrap",
            !draft && "text-muted-foreground/50"
          )}
        >
          {draft || t("noteEmptyHint")}
        </div>
      )}
    </div>
  )
})
