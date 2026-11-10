"use client"

/**
 * The "Assistants" tab of the Multi-Agent Collaboration settings: the list of
 * assistants — reorder by drag or arrow keys, enable/disable, edit, duplicate,
 * delete — and the entry to create one. Every change is written at once (there
 * is no section-wide save for this tab), and the list stays live across windows
 * through the assistants store.
 *
 * Layout follows the settings house style (`SettingCard`): the rows share one
 * bordered surface with a hairline between them, rather than each floating in
 * a box of its own. A row reads left to right as handle → who (avatar, name,
 * description, the agent and its picks) → its on/off switch → the actions on
 * it (edit, and the rarer ones behind "more"). Clicking anywhere on the row
 * outside a control opens the editor too; the pencil is the keyboard's (and
 * the discoverable) way to the same place.
 */

import {
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react"
import { useTranslations } from "next-intl"
import { Reorder, useDragControls } from "motion/react"
import {
  AlertTriangle,
  Copy,
  GripVertical,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  UserRound,
} from "lucide-react"
import { toast } from "sonner"

import { AgentIcon } from "@/components/agent-icon"
import { AssistantAvatar } from "@/components/assistants/assistant-avatar"
import { SettingsError } from "@/components/shared/settings-section"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { useAcpAgents } from "@/hooks/use-acp-agents"
import {
  toLocalizedErrorMessage,
  type AppErrorTranslator,
} from "@/lib/app-error"
import { getAgentLabel } from "@/lib/custom-agents"
import type { AcpAgentInfo, AssistantInfo } from "@/lib/types"
import { cn } from "@/lib/utils"
import {
  useAssistants,
  useAssistantsStore,
  useAssistantsSync,
} from "@/stores/assistants-store"
import { AssistantEditorDialog, NAME_MAX } from "./assistant-editor-dialog"
import { PanelNotice } from "./panel-notice"

export interface AssistantsPanelProps {
  /** The SAVED multi-agent switch (not the form's draft): while it is off, an
   *  assistant cannot be delegated to. `null` until known. */
  delegationEnabled: boolean | null
  /** Tabs of this section with unsaved changes, by display name. */
  unsavedTabs: string[]
  /** Go back to the first tab with unsaved changes. */
  onShowUnsaved?: () => void
  /** Go to the tab that holds the multi-agent switch. */
  onShowGeneral?: () => void
}

/** The shared surface of the list, its loading placeholder and nothing else:
 *  `SettingCard`'s look, without its `overflow-hidden` — a row being dragged
 *  has to be able to leave the box. */
const LIST_SURFACE =
  "divide-y divide-border/60 rounded-xl border border-border/70 bg-muted/40"

/** What a click on a row must leave alone: its own controls, and anything a
 *  control portals out (React bubbles a menu item's click through the menu's
 *  owner, i.e. into the row). */
const ROW_CONTROLS =
  "button, a, input, textarea, select, [role=switch], [role=menu], [role=menuitem], [role=dialog], [role=alertdialog]"

function sameOrder(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((id, idx) => id === b[idx])
}

/** "Name (2)", "Name (3)" … — the first that no live assistant has, the base
 *  shortened as needed to stay within the name limit. */
export function copyName(base: string, taken: readonly string[]): string {
  const lower = new Set(taken.map((n) => n.toLowerCase()))
  for (let n = 2; n < 1000; n++) {
    const suffix = ` (${n})`
    const room = NAME_MAX - Array.from(suffix).length
    const head = Array.from(base).slice(0, room).join("").trimEnd()
    const candidate = `${head}${suffix}`
    if (!lower.has(candidate.toLowerCase())) return candidate
  }
  return base
}

/** "Codex CLI · GPT-5.5 · High" — the saved agent and picks, read off the
 *  saved names: listing never probes an agent. */
function selectionSummary(
  assistant: AssistantInfo,
  booleanLabels: { on: string; off: string }
): string {
  const labels = assistant.label_snapshot
  const parts = [
    labels.mode,
    ...labels.options.map((o) =>
      o.kind === "boolean"
        ? assistant.agent_options.config_values?.[o.id] === "true"
          ? booleanLabels.on
          : booleanLabels.off
        : o.value_label
    ),
  ].filter((p): p is string => !!p)
  return parts.slice(0, 3).join(" · ")
}

export function AssistantsPanel({
  delegationEnabled,
  unsavedTabs,
  onShowUnsaved,
  onShowGeneral,
}: AssistantsPanelProps) {
  // The settings window has no workspace layout to keep this store live.
  useAssistantsSync()
  const t = useTranslations("AcpAgentSettings.multiAgent.assistants")
  const tm = useTranslations("AcpAgentSettings.multiAgent")
  const assistants = useAssistants()
  const hydrated = useAssistantsStore((s) => s.hydrated)
  const loadError = useAssistantsStore((s) => s.loadError)
  const { agents } = useAcpAgents()
  const agentsByType = useMemo(
    () => new Map(agents.map((a) => [a.agent_type, a])),
    [agents]
  )
  const [editor, setEditor] = useState<{
    key: number
    assistant: AssistantInfo | null
  } | null>(null)
  const editorSeq = useRef(0)
  // What the confirmation shows. The target outlives `open`, so the dialog
  // keeps its name and avatar while it animates closed.
  const [deletion, setDeletion] = useState<{
    open: boolean
    target: AssistantInfo | null
  }>({ open: false, target: null })
  /** What the confirmation deletes: taken — and cleared — by the first press
   *  of Delete, so a second press while the dialog animates out (its button
   *  still under the pointer) finds nothing left to delete. */
  const pendingDeleteRef = useRef<AssistantInfo | null>(null)
  const tErr = t as unknown as AppErrorTranslator
  const booleanLabels = { on: tm("booleanOn"), off: tm("booleanOff") }

  // The order while a drag is in flight; null = the store's. Persisted once,
  // on release.
  const [dragOrder, setDragOrder] = useState<number[] | null>(null)
  const dragOrderRef = useRef<number[] | null>(null)
  const dragStartRef = useRef<number[] | null>(null)
  const shown = useMemo(() => {
    if (!dragOrder) return assistants
    const byId = new Map(assistants.map((a) => [a.id, a]))
    return dragOrder
      .map((id) => byId.get(id))
      .filter((a): a is AssistantInfo => a !== undefined)
  }, [assistants, dragOrder])
  const shownIds = useMemo(() => shown.map((a) => a.id), [shown])

  const persistOrder = useCallback(
    (order: number[]) => {
      useAssistantsStore
        .getState()
        .reorder(order)
        .catch((err: unknown) =>
          toast.error(t("reorderFailed"), {
            description: toLocalizedErrorMessage(err, tErr),
          })
        )
    },
    [t, tErr]
  )

  const handleReorder = useCallback(
    (next: number[]) => {
      dragStartRef.current ??= assistants.map((a) => a.id)
      dragOrderRef.current = next
      setDragOrder(next)
    },
    [assistants]
  )

  const handleDragEnd = useCallback(() => {
    const order = dragOrderRef.current
    const start = dragStartRef.current
    dragOrderRef.current = null
    dragStartRef.current = null
    setDragOrder(null)
    if (!order || !start || sameOrder(order, start)) return
    persistOrder(order)
  }, [persistOrder])

  const move = useCallback(
    (id: number, delta: -1 | 1) => {
      const order = assistants.map((a) => a.id)
      const from = order.indexOf(id)
      const to = from + delta
      if (from < 0 || to < 0 || to >= order.length) return
      ;[order[from], order[to]] = [order[to], order[from]]
      persistOrder(order)
    },
    [assistants, persistOrder]
  )

  const toggle = useCallback(
    (assistant: AssistantInfo, enabled: boolean) => {
      useAssistantsStore
        .getState()
        .update(assistant.id, { enabled })
        .catch((err: unknown) =>
          toast.error(t("saveFailed"), {
            description: toLocalizedErrorMessage(err, tErr),
          })
        )
    },
    [t, tErr]
  )

  const duplicate = useCallback(
    (assistant: AssistantInfo) => {
      const name = copyName(
        assistant.name,
        assistants.map((a) => a.name)
      )
      useAssistantsStore
        .getState()
        .create({
          name,
          description: assistant.description,
          avatar: assistant.avatar,
          agent_config: {
            agent_type: assistant.agent_type,
            agent_options: {
              mode_id: assistant.agent_options.mode_id ?? null,
              config_values: {
                ...(assistant.agent_options.config_values ?? {}),
              },
            },
            label_snapshot: assistant.label_snapshot,
          },
          instructions: assistant.instructions,
          enabled: assistant.enabled,
        })
        .then((row) => toast.success(t("duplicated", { name: row.name })))
        .catch((err: unknown) =>
          toast.error(t("saveFailed"), {
            description: toLocalizedErrorMessage(err, tErr),
          })
        )
    },
    [assistants, t, tErr]
  )

  const askDelete = (assistant: AssistantInfo) => {
    pendingDeleteRef.current = assistant
    setDeletion({ open: true, target: assistant })
  }

  const closeDelete = () => {
    pendingDeleteRef.current = null
    setDeletion((prev) => ({ ...prev, open: false }))
  }

  const confirmDelete = useCallback(() => {
    const target = pendingDeleteRef.current
    pendingDeleteRef.current = null
    setDeletion((prev) => ({ ...prev, open: false }))
    if (!target) return
    useAssistantsStore
      .getState()
      .remove(target.id)
      .catch((err: unknown) =>
        toast.error(t("deleteFailed"), {
          description: toLocalizedErrorMessage(err, tErr),
        })
      )
  }, [t, tErr])

  const openEditor = (assistant: AssistantInfo | null) => {
    editorSeq.current += 1
    setEditor({ key: editorSeq.current, assistant })
  }

  const empty = hydrated && shown.length === 0
  // Nothing read yet: hold the list's place instead of leaving a gap that the
  // rows then push everything down into.
  const loading = !hydrated && !loadError && shown.length === 0

  return (
    // A container, so the header can stack by the width this panel actually
    // gets (the settings sidebar takes its share of the window).
    <div className="@container space-y-3">
      <div className="flex flex-col items-start gap-3 @lg:flex-row @lg:items-center @lg:justify-between @lg:gap-4">
        <p className="min-w-0 text-xs leading-5 text-muted-foreground">
          {t("description")}
        </p>
        {/* The empty state carries its own, larger way in — two "New" buttons
            on one screen would only compete. */}
        {empty ? null : (
          <Button
            size="sm"
            variant="outline"
            className="shrink-0"
            onClick={() => openEditor(null)}
          >
            <Plus aria-hidden />
            {t("create")}
          </Button>
        )}
      </div>

      {delegationEnabled === false ? (
        <PanelNotice
          tone="warning"
          icon={<AlertTriangle className="size-3.5" aria-hidden />}
          action={
            onShowGeneral ? (
              <Button
                size="xs"
                variant="outline"
                className="bg-background"
                onClick={onShowGeneral}
              >
                {t("delegationOffAction", { tab: tm("tabGeneral") })}
              </Button>
            ) : null
          }
        >
          {t("delegationOff")}
        </PanelNotice>
      ) : null}

      {unsavedTabs.length > 0 ? (
        <PanelNotice
          tone="muted"
          // The same amber dot the tab strip marks those tabs with.
          icon={
            <span className="size-1.5 rounded-full bg-amber-500" aria-hidden />
          }
          action={
            onShowUnsaved ? (
              <Button
                size="xs"
                variant="outline"
                className="bg-background"
                onClick={onShowUnsaved}
              >
                {t("unsavedGoBack")}
              </Button>
            ) : null
          }
        >
          {t("unsavedElsewhere", { tabs: unsavedTabs.join(" / ") })}
        </PanelNotice>
      ) : null}

      {loadError && !hydrated ? (
        <SettingsError>
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{t("loadFailed", { detail: loadError })}</span>
            <Button
              size="xs"
              variant="outline"
              className="bg-background text-foreground"
              onClick={() => void useAssistantsStore.getState().fetchAll()}
            >
              {tm("retry")}
            </Button>
          </span>
        </SettingsError>
      ) : null}

      {loading ? (
        <div className={LIST_SURFACE} aria-hidden>
          {[0, 1].map((i) => (
            <div key={i} className="flex items-center gap-3 px-3 py-3">
              <Skeleton className="ms-6 size-9 shrink-0 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3 w-28 rounded-full" />
                <Skeleton className="h-2.5 w-52 rounded-full" />
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {empty ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border/70 px-6 py-10 text-center">
          <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <UserRound className="size-5" aria-hidden />
          </span>
          <div className="space-y-1">
            <p className="text-sm font-medium">{t("emptyTitle")}</p>
            <p className="max-w-sm text-xs leading-5 text-balance text-muted-foreground">
              {t("empty")}
            </p>
          </div>
          <Button size="sm" onClick={() => openEditor(null)}>
            <Plus aria-hidden />
            {t("create")}
          </Button>
        </div>
      ) : null}

      {shown.length > 0 ? (
        <Reorder.Group
          as="ul"
          axis="y"
          values={shownIds}
          onReorder={handleReorder}
          aria-label={tm("tabAssistants")}
          className={LIST_SURFACE}
        >
          {shown.map((assistant, index) => (
            <AssistantRow
              key={assistant.id}
              assistant={assistant}
              agent={agentsByType.get(assistant.agent_type) ?? null}
              agentsKnown={agents.length > 0}
              summary={selectionSummary(assistant, booleanLabels)}
              isFirst={index === 0}
              isLast={index === shown.length - 1}
              onMove={move}
              onDragEnd={handleDragEnd}
              onToggle={toggle}
              onEdit={() => openEditor(assistant)}
              onDuplicate={() => duplicate(assistant)}
              onDelete={() => askDelete(assistant)}
            />
          ))}
        </Reorder.Group>
      ) : null}

      {editor ? (
        <AssistantEditorDialog
          key={editor.key}
          open
          onOpenChange={(open) => {
            if (!open) setEditor(null)
          }}
          assistant={editor.assistant}
        />
      ) : null}

      <AlertDialog
        open={deletion.open}
        onOpenChange={(open) => {
          if (!open) closeDelete()
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            {/* Whose deletion this is, at a glance — the name alone can be one
                of several similar ones. */}
            <AlertDialogMedia className="bg-transparent">
              <AssistantAvatar
                avatar={deletion.target?.avatar}
                name={deletion.target?.name ?? ""}
                size={56}
              />
            </AlertDialogMedia>
            <AlertDialogTitle>
              {t("deleteTitle", { name: deletion.target?.name ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirmDelete}>
              {t("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

interface AssistantRowProps {
  assistant: AssistantInfo
  agent: AcpAgentInfo | null
  /** The agent list has loaded, so a missing entry means "not installed". */
  agentsKnown: boolean
  summary: string
  isFirst: boolean
  isLast: boolean
  onMove: (id: number, delta: -1 | 1) => void
  onDragEnd: () => void
  onToggle: (assistant: AssistantInfo, enabled: boolean) => void
  onEdit: () => void
  onDuplicate: () => void
  onDelete: () => void
}

function AssistantRow({
  assistant,
  agent,
  agentsKnown,
  summary,
  isFirst,
  isLast,
  onMove,
  onDragEnd,
  onToggle,
  onEdit,
  onDuplicate,
  onDelete,
}: AssistantRowProps) {
  const t = useTranslations("AcpAgentSettings.multiAgent.assistants")
  const dragControls = useDragControls()
  const [dragging, setDragging] = useState(false)
  /** The press that ends in the next click started on the drag handle: that
   *  click (wherever the row has carried the pointer to) is the drop, not a
   *  request to open the editor. */
  const pressedHandleRef = useRef(false)
  const agentProblem = !agentsKnown
    ? null
    : !agent || !agent.available
      ? t("agentNotInstalled")
      : !agent.enabled
        ? t("agentDisabled")
        : null
  const agentLabel = agent
    ? getAgentLabel(assistant.agent_type)
    : assistant.label_snapshot.agent || getAgentLabel(assistant.agent_type)

  const startDrag = (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault()
    dragControls.start(event)
  }
  // The keyboard way to do what the handle does.
  const onHandleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowUp" && !isFirst) {
      event.preventDefault()
      onMove(assistant.id, -1)
    } else if (event.key === "ArrowDown" && !isLast) {
      event.preventDefault()
      onMove(assistant.id, 1)
    }
  }
  const onRowClick = (event: MouseEvent<HTMLLIElement>) => {
    if (pressedHandleRef.current) return
    const target = event.target as Element | null
    if (target?.closest(ROW_CONTROLS)) return
    // Selecting the description to copy it is not a request to edit.
    if (window.getSelection()?.toString()) return
    onEdit()
  }

  return (
    <Reorder.Item
      as="li"
      value={assistant.id}
      drag="y"
      dragListener={false}
      dragControls={dragControls}
      dragMomentum={false}
      layout="position"
      onDragStart={() => setDragging(true)}
      onDragEnd={() => {
        setDragging(false)
        onDragEnd()
      }}
      onPointerDownCapture={(event: PointerEvent<HTMLLIElement>) => {
        pressedHandleRef.current = !!(event.target as Element | null)?.closest(
          "[data-drag-handle]"
        )
      }}
      onClick={onRowClick}
      data-assistant-row={assistant.id}
      className={cn(
        "group/row relative flex cursor-pointer items-center gap-3 py-2.5 ps-2 pe-3 transition-colors first:rounded-t-xl last:rounded-b-xl",
        // Lifted while dragged: opaque (the rows it passes over must not show
        // through), its own outline instead of the hairline it shared.
        dragging
          ? "z-10 cursor-grabbing rounded-xl border-transparent bg-card shadow-lg ring-1 ring-border"
          : "hover:bg-muted/60"
      )}
    >
      <button
        type="button"
        data-drag-handle
        onPointerDown={startDrag}
        onKeyDown={onHandleKeyDown}
        title={t("move", { name: assistant.name })}
        aria-label={t("move", { name: assistant.name })}
        className="flex h-8 w-5 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground/50 transition-colors group-hover/row:text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none active:cursor-grabbing"
      >
        <GripVertical className="size-3.5" aria-hidden />
      </button>

      <div
        className={cn(
          "flex min-w-0 flex-1 items-center gap-3",
          // An assistant that is off fades as a whole — its picture included —
          // so the switch beside it is not the only sign.
          !assistant.enabled && "opacity-55"
        )}
      >
        <AssistantAvatar
          avatar={assistant.avatar}
          name={assistant.name}
          size={36}
        />
        <div className="min-w-0 flex-1">
          {/* What the user typed keeps its own direction (`dir="auto"`, an
              isolated inline run) while the line stays aligned to the row's
              start — a Chinese name in an Arabic window still ends with its
              own full stop, and still sits next to its avatar. */}
          <p className="truncate text-sm leading-5 font-medium">
            <span dir="auto">{assistant.name}</span>
          </p>
          {assistant.description ? (
            <p className="truncate text-xs leading-5 text-muted-foreground">
              <span dir="auto">{assistant.description}</span>
            </p>
          ) : null}
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[0.6875rem] leading-4 text-muted-foreground">
            {/* The label right beside it already names the agent. */}
            <span aria-hidden className="flex shrink-0">
              <AgentIcon
                agentType={assistant.agent_type}
                className="size-3.5"
              />
            </span>
            <span className="truncate">
              {agentLabel}
              {summary ? ` · ${summary}` : ""}
            </span>
            {/* On the agent's line, so it reads as the agent's state rather
                than the assistant's — the switch says that one. */}
            {agentProblem ? (
              <Badge
                variant="outline"
                className="h-4 gap-0.5 border-amber-500/40 bg-amber-500/10 px-1.5 text-[0.625rem] text-amber-700 dark:text-amber-400"
              >
                <AlertTriangle aria-hidden />
                {agentProblem}
              </Badge>
            ) : null}
          </div>
        </div>
      </div>

      {/* State, then actions: the switch stands apart from the two buttons
          that act on the row, which sit together as one group. */}
      <div className="flex shrink-0 items-center gap-1.5 @lg:gap-3">
        <Switch
          checked={assistant.enabled}
          aria-label={t("enableAssistant", { name: assistant.name })}
          onCheckedChange={(enabled) => onToggle(assistant, enabled)}
        />
        <div className="flex items-center gap-0.5">
          <Button
            size="icon-sm"
            variant="ghost"
            className="text-muted-foreground"
            title={t("edit", { name: assistant.name })}
            aria-label={t("edit", { name: assistant.name })}
            onClick={onEdit}
          >
            <Pencil className="size-3.5" aria-hidden />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon-sm"
                variant="ghost"
                className="text-muted-foreground"
                aria-label={t("more", { name: assistant.name })}
              >
                <MoreHorizontal aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-40">
              <DropdownMenuItem onSelect={onDuplicate}>
                <Copy className="size-3.5" aria-hidden />
                {t("duplicate")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                <Trash2 className="size-3.5" aria-hidden />
                {t("delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </Reorder.Item>
  )
}
