"use client"

import { useCallback, useRef, useState, type PointerEvent } from "react"
import { Reorder, useDragControls } from "motion/react"
import { Clock, GripVertical, Pencil, X, Zap } from "lucide-react"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import { draftRidesBlocks } from "@/lib/prompt-draft"
import type { QueuedMessage } from "@/hooks/use-message-queue"

interface MessageQueueDisplayProps {
  queue: QueuedMessage[]
  onReorder: (items: QueuedMessage[]) => void
  onEdit: (id: string) => void
  onDelete: (id: string) => void
  editingItemId: string | null
  /**
   * Send one queued item straight into the RUNNING turn over the session's
   * live-feedback channel (same delivery as the composer's mid-turn send).
   * Present only while the session has a working channel AND a turn is in
   * flight; the host decides whether the row is removed (it stays queued on
   * the turn-end race). Resolves once delivery is settled.
   */
  onSteerItem?: (id: string) => Promise<void> | void
  /** Which channel {@link onSteerItem} rides; picks the honest icon/copy,
   *  mirroring the composer's split-button (`Zap` = instant insert,
   *  `Clock` = note the agent reads on its next check). */
  steerChannel?: "native" | "pull"
}

interface QueueItemProps {
  item: QueuedMessage
  index: number
  isEditing: boolean
  onEdit: (id: string) => void
  onDelete: (id: string) => void
  onSteerItem?: (id: string) => Promise<void> | void
  steerChannel: "native" | "pull"
  /** Whether an insert from ANY row is in flight — every row's button is
   *  disabled for the duration, so two rows can't race the one channel. */
  steering: boolean
  onSteerStart: (id: string) => Promise<void>
}

function QueueItem({
  item,
  index,
  isEditing,
  onEdit,
  onDelete,
  onSteerItem,
  steerChannel,
  steering,
  onSteerStart,
}: QueueItemProps) {
  const t = useTranslations("Folder.chat.messageQueue")
  const dragControls = useDragControls()

  // Which rows may offer the insert at all. Two rows can't, and offering a
  // click that provably does nothing is worse than offering none:
  // * The row under edit. Its authoritative text is in the composer now, so
  //   inserting would send the PRE-edit draft and then drop the row the edit
  //   was going to save into. (The composer hides its own mid-turn send while
  //   editing for the same reason.)
  // * A draft carrying attachments on a pull-tool session. The pull channel
  //   delivers text, so the backend rejects blocks there — every click would
  //   land on the turn-end fallback, which for an already-queued row is a
  //   no-op. It still goes out whole with the next turn, via the queue.
  const canSteer =
    Boolean(onSteerItem) &&
    !isEditing &&
    (steerChannel === "native" || !draftRidesBlocks(item.draft))

  const startDrag = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      event.preventDefault()
      event.stopPropagation()
      dragControls.start(event)
    },
    [dragControls]
  )

  return (
    <Reorder.Item
      as="div"
      value={item}
      dragListener={false}
      dragControls={dragControls}
      className={cn(
        "flex items-center gap-1 rounded-md border px-1.5 py-1 text-3xs leading-none select-none [text-box-trim:both] [text-box-edge:cap_alphabetic]",
        "bg-muted/40 border-border/70",
        isEditing && "border-primary/50 bg-primary/5"
      )}
    >
      <button
        type="button"
        className="shrink-0 cursor-grab touch-none active:cursor-grabbing p-0"
        onPointerDown={startDrag}
      >
        <GripVertical className="h-3 w-3 text-muted-foreground/60" />
      </button>
      <span className="shrink-0 font-mono text-3xs text-muted-foreground/70">
        #{index + 1}
      </span>
      <span className="min-w-0 flex-1 truncate text-3xs text-foreground/80">
        {item.draft.displayText}
      </span>
      {canSteer && (
        <button
          type="button"
          onClick={() => void onSteerStart(item.id)}
          disabled={steering}
          className="shrink-0 rounded-sm p-0.5 hover:bg-muted-foreground/15 text-muted-foreground disabled:opacity-50"
          title={t(
            steerChannel === "pull" ? "steerItemAsNote" : "steerItemNow"
          )}
        >
          {steerChannel === "pull" ? (
            <Clock className="h-2.5 w-2.5" />
          ) : (
            <Zap className="h-2.5 w-2.5" />
          )}
        </button>
      )}
      <button
        type="button"
        onClick={() => onEdit(item.id)}
        className="shrink-0 rounded-sm p-0.5 hover:bg-muted-foreground/15 text-muted-foreground"
        title={t("editItem")}
      >
        <Pencil className="h-2.5 w-2.5" />
      </button>
      <button
        type="button"
        onClick={() => onDelete(item.id)}
        className="shrink-0 rounded-sm p-0.5 hover:bg-muted-foreground/15 text-muted-foreground"
        title={t("deleteItem")}
      >
        <X className="h-2.5 w-2.5" />
      </button>
    </Reorder.Item>
  )
}

export function MessageQueueDisplay({
  queue,
  onReorder,
  onEdit,
  onDelete,
  editingItemId,
  onSteerItem,
  steerChannel = "pull",
}: MessageQueueDisplayProps) {
  // The id whose insert is in flight. A per-row `steering` would let a
  // concurrent click on another row race the same channel; one shared id
  // both disables the clicked row and (via `steeringId !== null`) the others
  // — matching the composer's single-flight `steering` guard.
  const [steeringId, setSteeringId] = useState<string | null>(null)
  // Latest steeringId for the click handler's re-entrancy check without
  // re-binding it on every state commit.
  const steeringIdRef = useRef<string | null>(null)
  steeringIdRef.current = steeringId

  const handleSteerStart = useCallback(
    async (id: string) => {
      if (!onSteerItem || steeringIdRef.current !== null) return
      setSteeringId(id)
      try {
        await onSteerItem(id)
      } finally {
        setSteeringId(null)
      }
    },
    [onSteerItem]
  )

  if (queue.length === 0) return null

  return (
    <div className="max-h-28 overflow-y-auto pb-1">
      <Reorder.Group
        as="div"
        axis="y"
        values={queue}
        onReorder={onReorder}
        className="flex flex-col gap-0.5"
      >
        {queue.map((item, index) => (
          <QueueItem
            key={item.id}
            item={item}
            index={index}
            isEditing={editingItemId === item.id}
            onEdit={onEdit}
            onDelete={onDelete}
            onSteerItem={onSteerItem}
            steerChannel={steerChannel}
            steering={steeringId !== null}
            onSteerStart={handleSteerStart}
          />
        ))}
      </Reorder.Group>
    </div>
  )
}
