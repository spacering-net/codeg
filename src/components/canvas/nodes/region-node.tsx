"use client"

import { memo, useState } from "react"
import { NodeResizer, type Node, type NodeProps } from "@xyflow/react"
import { ChevronDown, Folder, Layers, Sparkles, Unlink } from "lucide-react"
import { useTranslations } from "next-intl"
import { AgentIcon } from "@/components/agent-icon"
import { getAgentLabel } from "@/lib/custom-agents"
import { formatFolderLabelWithAlias } from "@/lib/folder-display"
import { cn } from "@/lib/utils"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import {
  REGION_FOOTER_HEIGHT,
  REGION_HEADER_HEIGHT,
  type RegionNodeData,
} from "../canvas-model"
import { ColorWash } from "../canvas-swatches"
import { useCanvasView } from "../canvas-view-context"

export type RegionFlowNode = Node<RegionNodeData, "region">

/**
 * A canvas region: a live binding (folder / folder group / agent) or a
 * hand-curated `custom` collection. Member cards are separate RF child nodes
 * laid out by `layoutRegionGrid`; this component renders only the frame and
 * header, so its height must track `renderedHeight` (grid growth) rather than
 * the stored one.
 *
 * Its verbs (rename, grid, colour, collapse, delete) live in the action dock,
 * not in a header menu — one action surface for every element type. Renaming is
 * the one that still happens HERE, because the input belongs on the title;
 * `renamingRegionId` is what the dock flips to start it.
 */
export const RegionNode = memo(function RegionNode({
  data,
  selected,
}: NodeProps<RegionFlowNode>) {
  const t = useTranslations("Canvas")
  const { dbNode, memberTotal, visibleCount, runningCount, unresolved } = data
  const {
    expandedRegions,
    setRegionExpanded,
    renamingRegionId,
    setRenamingRegionId,
    dropTargetRegionId,
    patchNode,
    endNodeResize,
  } = useCanvasView()
  // `null` = untouched since the rename started, so the input shows the stored
  // title. Rename can begin from the dock (which knows nothing about this
  // component's state) as well as from a double-click here, so seeding on the
  // way IN would leave the dock's path editing an empty string — and committing
  // it would wipe the title.
  const [draft, setDraft] = useState<string | null>(null)

  const folder = useAppWorkspaceStore((s) =>
    dbNode.kind === "folder" && dbNode.folder_id != null
      ? s.allFolders.find((f) => f.id === dbNode.folder_id)
      : undefined
  )
  const folderGroup = useAppWorkspaceStore((s) =>
    dbNode.kind === "group" && dbNode.folder_group_id != null
      ? s.folderGroups.find((g) => g.id === dbNode.folder_group_id)
      : undefined
  )

  const fallbackName =
    dbNode.kind === "folder"
      ? folder
        ? formatFolderLabelWithAlias(folder)
        : t("unresolvedFolder")
      : dbNode.kind === "group"
        ? (folderGroup?.name ?? t("unresolvedGroup"))
        : dbNode.kind === "agent"
          ? getAgentLabel(dbNode.agent_type ?? "")
          : t("customRegion")
  const name = dbNode.title?.trim() || fallbackName

  const collapsed = dbNode.collapsed
  const expanded = expandedRegions.has(dbNode.id)
  // Derived from what the grid ACTUALLY laid out — the cap moves with the
  // region's grid shape (`grid_rows × columns`), so a constant would lie.
  const hiddenCount = expanded ? 0 : memberTotal - visibleCount
  const editing = renamingRegionId === dbNode.id
  // A card is hovering this region mid-drag: show where it would land.
  const dropTarget = dropTargetRegionId === dbNode.id

  const stored = dbNode.title ?? ""
  const draftValue = draft ?? stored

  const endRename = () => {
    setRenamingRegionId(null)
    setDraft(null)
  }

  const commitRename = () => {
    endRename()
    const next = draftValue.trim()
    if (next !== stored) {
      void patchNode(dbNode.id, { title: next })
    }
  }

  const headerIcon =
    dbNode.kind === "agent" && dbNode.agent_type ? (
      <AgentIcon agentType={dbNode.agent_type} className="size-3.5 shrink-0" />
    ) : dbNode.kind === "folder" ? (
      <Folder className="size-3.5 shrink-0 text-muted-foreground" />
    ) : dbNode.kind === "group" ? (
      <Layers className="size-3.5 shrink-0 text-muted-foreground" />
    ) : (
      <Sparkles className="size-3.5 shrink-0 text-muted-foreground" />
    )

  return (
    <div
      className={cn(
        // Size comes from the RF node wrapper (derive feeds width/height,
        // including live NodeResizer dimensions) — never from local style, and
        // `canvas-board-units` puts the contents in those same units: the header
        // band and the "+N" footer are fixed flow-unit heights the grid math
        // reserves, so type that grew with the appearance zoom would spill out
        // of them.
        "canvas-board-units relative flex h-full w-full flex-col rounded-2xl border bg-card/50 transition-colors",
        collapsed && "rounded-full",
        unresolved
          ? "border-dashed border-foreground/20"
          : "border-foreground/15",
        selected && "border-primary ring-2 ring-primary/25",
        dropTarget && "border-primary bg-primary/5 ring-2 ring-primary/40"
      )}
    >
      {/* Behind everything, clipped to the frame's own radius — including the
          capsule shape a collapsed region takes. */}
      <ColorWash
        color={dbNode.color}
        className={collapsed ? "rounded-full" : "rounded-2xl"}
      />
      <NodeResizer
        isVisible={Boolean(selected) && !collapsed}
        minWidth={260}
        minHeight={160}
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
      <div
        className={cn(
          "relative flex shrink-0 items-center gap-1.5 px-3",
          // The band is 40 and the grid below it starts at 40 + REGION_PADDING,
          // so a title centred in the band has 10.25 above it and 22.25 to the
          // first card — it reads as pinned to the top of the region. Twelve of
          // top padding moves a centred row down by six, which is exactly half
          // the padding that follows, and both gaps land on 16.25.
          //
          // Not when collapsed: the region is then a 40-tall capsule with
          // nothing under it, and there is no gap below to compensate for.
          !collapsed && "pt-3"
        )}
        style={{ height: REGION_HEADER_HEIGHT }}
      >
        {headerIcon}
        {editing ? (
          <input
            autoFocus
            value={draftValue}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename()
              if (e.key === "Escape") endRename()
            }}
            placeholder={fallbackName}
            className="nodrag min-w-0 flex-1 rounded-md border border-input bg-background px-1.5 py-0.5 text-[13px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        ) : (
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-[13px] font-semibold",
              unresolved && "text-muted-foreground"
            )}
            onDoubleClick={() => setRenamingRegionId(dbNode.id)}
          >
            {name}
          </span>
        )}
        {runningCount > 0 && (
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-1.5 py-px font-mono text-[10px] font-medium leading-4 text-primary"
            title={t("runningCount", { count: runningCount })}
          >
            <span className="size-1.5 rounded-full bg-primary motion-safe:animate-pulse" />
            {runningCount}
          </span>
        )}
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
          {memberTotal}
        </span>
      </div>

      {!collapsed && unresolved && (
        <div className="flex flex-1 flex-col items-center justify-center gap-1.5 p-4 text-center">
          <Unlink
            className="size-5 text-muted-foreground/50"
            aria-hidden="true"
          />
          <p className="max-w-56 text-xs text-muted-foreground">
            {dbNode.kind === "group"
              ? t("unresolvedGroupHint")
              : t("unresolvedFolderHint")}
          </p>
        </div>
      )}

      {!collapsed && !unresolved && memberTotal === 0 && (
        <div className="flex flex-1 items-center justify-center p-4">
          <p className="text-xs text-muted-foreground/70">
            {dbNode.kind === "custom" ? t("emptyCustomHint") : t("emptyRegion")}
          </p>
        </div>
      )}

      {/* A real footer ROW, not a floating chip: the derive layer reserves
          REGION_FOOTER_HEIGHT for it, so it can never sit on top of the last
          card row — and a full-width bar with its own rule reads as an action
          instead of decoration. */}
      {!collapsed && hiddenCount > 0 && (
        <button
          type="button"
          className="nodrag absolute inset-x-0 bottom-0 flex items-center justify-center gap-1.5 rounded-b-2xl border-t border-foreground/10 bg-card/80 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground supports-backdrop-filter:backdrop-blur-sm"
          style={{ height: REGION_FOOTER_HEIGHT }}
          onClick={() => setRegionExpanded(dbNode.id, true)}
        >
          <ChevronDown className="size-3.5" aria-hidden="true" />
          {t("showMore", { count: hiddenCount })}
        </button>
      )}
    </div>
  )
})
