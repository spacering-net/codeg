"use client"

import { memo, useCallback, useState } from "react"
import { type Node, type NodeProps } from "@xyflow/react"
import { RotateCcw, SquareTerminal, Trash2 } from "lucide-react"
import { useTranslations } from "next-intl"

import { TerminalView } from "@/components/terminal/terminal-view"
import {
  TERMINAL_CARD_MIN_HEIGHT,
  TERMINAL_CARD_MIN_WIDTH,
  canvasTerminalId,
  type TerminalNodeData,
} from "../canvas-model"
import { useCanvasView } from "../canvas-view-context"
import { CARD_HEADER_BUTTON_CLASS, CardFrame } from "./card-frame"

export type TerminalFlowNode = Node<TerminalNodeData, "terminal">

/**
 * A shell running on the board, in the directory the card was created for.
 *
 * The PTY is keyed off the ROW id (`canvasTerminalId`), not off this component:
 * the canvas is a full-page route and really unmounts when the user looks at
 * the task board, and a `pnpm dev` must not die with a view switch. So the view
 * runs in `attach` mode — on mount it asks the backend whether that id is
 * already running, replays its recent output into the fresh emulator if so, and
 * only spawns when it is not. Unmount deliberately kills nothing.
 *
 * The shell is the workspace default; the working directory is the card's, so a
 * board can hold one terminal per repo without touching the terminal panel's
 * tabs (whose lifetime is the session, not the board).
 */
export const TerminalNode = memo(function TerminalNode({
  data,
  selected,
}: NodeProps<TerminalFlowNode>) {
  const t = useTranslations("Canvas")
  const { endNodeResize, deleteNode } = useCanvasView()
  const { dbNode, workingDir, label } = data
  const terminalId = canvasTerminalId(dbNode.id)

  // Bumping this remounts `TerminalView`, which re-runs the attach handshake:
  // after the process exited there is nothing to attach to, so it spawns a
  // fresh shell in the same directory. `exited` is what turns the pane into a
  // restart affordance rather than leaving a dead prompt on the board.
  const [generation, setGeneration] = useState(0)
  const [exited, setExited] = useState(false)

  const handleExited = useCallback(() => setExited(true), [])
  const restart = useCallback(() => {
    setExited(false)
    setGeneration((n) => n + 1)
  }, [])

  return (
    <CardFrame
      selected={selected}
      color={dbNode.color}
      minWidth={TERMINAL_CARD_MIN_WIDTH}
      minHeight={TERMINAL_CARD_MIN_HEIGHT}
      onResizeEnd={(geometry) => endNodeResize(dbNode.id, geometry)}
      icon={
        <SquareTerminal className="size-3.5 shrink-0 text-muted-foreground" />
      }
      title={
        <span title={workingDir || label} className="block truncate">
          {label}
        </span>
      }
      actions={
        <>
          <button
            type="button"
            className={CARD_HEADER_BUTTON_CLASS}
            aria-label={t("restartTerminal")}
            title={t("restartTerminal")}
            onClick={restart}
          >
            <RotateCcw className="size-3.5" />
          </button>
          <button
            type="button"
            className={CARD_HEADER_BUTTON_CLASS}
            aria-label={t("removeTerminalCard")}
            title={t("removeTerminalCard")}
            onClick={() => void deleteNode(dbNode.id)}
          >
            <Trash2 className="size-3.5" />
          </button>
        </>
      }
    >
      {/* `nodrag nowheel`: the shell owns its own scrollback and text
          selection, and the title bar is the card's only drag handle. */}
      <div className="nodrag nowheel relative min-h-0 flex-1 overflow-hidden">
        {workingDir ? (
          <TerminalView
            key={`${terminalId}:${generation}`}
            terminalId={terminalId}
            workingDir={workingDir}
            isActive
            isVisible
            attach
            // The board has its own zoom; the app's would scale the glyphs
            // inside a box that isn't scaling with them.
            ignoreAppZoom
            onProcessExited={handleExited}
          />
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center text-xs text-muted-foreground">
            {t("terminalNoDirectory")}
          </div>
        )}
        {exited && (
          // Over the dead pane rather than instead of it: the last output is
          // usually why the process stopped, and replacing it with a button
          // would throw away the only explanation on screen.
          <button
            type="button"
            onClick={restart}
            className="absolute right-2 bottom-2 inline-flex items-center gap-1.5 rounded-full border border-border bg-background/95 px-2.5 py-1 text-[11px] font-medium text-foreground shadow-sm transition-colors hover:bg-primary/10"
          >
            <RotateCcw className="size-3" />
            {t("restartTerminal")}
          </button>
        )}
      </div>
    </CardFrame>
  )
})
