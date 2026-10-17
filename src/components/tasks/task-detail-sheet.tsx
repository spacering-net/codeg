"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  Archive,
  ArchiveRestore,
  Ban,
  CalendarClock,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  CircleCheck,
  CircleX,
  Clock,
  Coins,
  FileDiff,
  FolderX,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequestArrow,
  Inbox,
  ListX,
  Loader2,
  MessageSquareText,
  Pencil,
  Play,
  RotateCw,
  ListTodo,
  Trash2,
  Undo2,
} from "lucide-react"
import {
  workTaskArchive,
  getFolderConversation,
  workTaskChangedFiles,
  workTaskCleanup,
  workTaskDefer,
  workTaskDelete,
  workTaskDiff,
  workTaskEvents,
  workTaskMergeUnqueue,
  workTaskRequeue,
  workTaskRetry,
  workTaskReturn,
  workTaskStart,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import {
  canSubmitFollowUp,
  DEFAULT_FOLLOW_UP_INTENT,
  followUpComposerTarget,
  followUpScenario,
  FOLLOW_UP_SCENARIOS,
  type FollowUpIntent,
} from "@/lib/task-follow-up"
import { formatTokenCount } from "@/lib/token-format"
import { onTransportReconnect, subscribe } from "@/lib/platform"
import { UnifiedDiffPreview } from "@/components/diff/unified-diff-preview"
import { MessageResponse } from "@/components/ai-elements/message"
import { AgentIcon } from "@/components/agent-icon"
import { getAgentLabel } from "@/lib/custom-agents"
import { useShortcutSettings } from "@/hooks/use-shortcut-settings"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import {
  canDefer,
  canDeliverToPr,
  canRemoveWorktree,
  deliveredPrUrl,
  hasNothingToMerge,
  isDeferred,
  isMergeQueued,
  mustDeliverToPr,
  usesMergeRequests,
} from "./task-acceptance"
import { StatusChip, statusLabelKey } from "./task-card"
import {
  TaskMessageComposer,
  type TaskMessageComposerHandle,
} from "./task-message-composer"
import { TaskTranscriptDialog } from "./task-transcript-dialog"
import {
  duplicateActiveSource,
  duplicateActiveSourceLabel,
  type DuplicateActiveSource,
} from "./task-restart-guard"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { BrowserLink } from "@/components/ui/browser-link"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  SIDE_PANEL_CONTENT_CLASS,
} from "@/components/ui/drawer"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type {
  AgentType,
  PromptInputBlock,
  WorkTask,
  WorkTaskChangedFile,
  WorkTaskEvent,
} from "@/lib/types"

const WORK_TASK_CHANGED_EVENT = "task://changed"

/**
 * Typography for the agent's Markdown result inside the drawer's compact
 * panel. Streamdown sizes its own elements for the full-width chat column
 * (h1 at `text-3xl`, 24px above every heading), which is far too loud at the
 * panel's 12px scale — and a descendant selector outranks the class Streamdown
 * puts on the element itself, so these win without `!important`. Lists and the
 * first/last block's collapsed margin already come from `MessageResponse`.
 * `prose` is deliberately absent: the repo has no typography plugin, so those
 * classes generate nothing.
 */
const RESULT_MARKDOWN =
  "[&_h1]:text-[0.8125rem] [&_h2]:text-[0.8125rem] [&_h3]:text-xs [&_h4]:text-xs " +
  "[&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_h4]:font-semibold " +
  "[&_h1]:mt-3 [&_h2]:mt-3 [&_h3]:mt-2 [&_h4]:mt-2 " +
  "[&_h1]:mb-1 [&_h2]:mb-1 [&_h3]:mb-1 [&_h4]:mb-1 " +
  "[&_p]:mt-0 [&_p]:mb-2 [&_ul]:my-2 [&_ol]:my-2 [&_li]:my-0.5 " +
  "[&_blockquote]:my-2 [&_hr]:my-3"

interface TaskDetailSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The live task row (already refreshed by the board's provider). */
  task: WorkTask | null
  folderName: string | null
  onMerge: (task: WorkTask) => void
  /** Replaces merge when the task changed nothing (see `hasNothingToMerge`). */
  onComplete: (task: WorkTask) => void
  /** Push the task to the forge: a new pull request for an issue-sourced
   *  task, back onto its own branch for a pull-request-sourced one. */
  onDeliverPr: (task: WorkTask) => void
  /** Opens the page-owned cancel dialog, which records the user's reason.
   *  Both "cancel" and a reviewed task's "abandon" go through it — same
   *  backend transition, same thing worth writing down. */
  onCancel: (task: WorkTask) => void
  onEdit: (task: WorkTask) => void
  /** Opens the page-owned schedule dialog (to-do tasks only). */
  onSchedule: (task: WorkTask) => void
}

/** One button of the drawer's action panel (see below). */
interface ZoneAction {
  icon: typeof Play
  label: string
  onClick: () => void
  /** The status's single primary — filled, and it grows to fill the row. */
  filled?: boolean
  /** Pushed to the right edge and rendered ghost: an escape hatch (abandon),
   *  not a step forward. */
  trailing?: boolean
  /** Set on the buttons that only open/close the composer below, so the button
   *  announces the disclosure it drives instead of a state change. */
  expanded?: boolean
}

/**
 * Right-side detail drawer: metadata, the action zone (the status's primary
 * actions — the review acceptance panel takes its slot while reviewing), and
 * the append-only progress timeline (`work_task_event`). The bottom bar keeps
 * utilities only (cleanup recovery + delete).
 */
export function TaskDetailSheet({
  open,
  onOpenChange,
  task,
  folderName,
  onMerge,
  onComplete,
  onDeliverPr,
  onCancel,
  onEdit,
  onSchedule,
}: TaskDetailSheetProps) {
  const t = useTranslations("Tasks")
  // The upload-in-flight toast is the conversation composer's own message —
  // same box, same wording.
  const tChat = useTranslations("Folder.chat.messageInput")
  // Backs the follow-up composer's `@` references and `/` command probe. The
  // whole list, not the opened one: a task's worktree folder is normally not
  // among the folders the user has open.
  const allFolders = useAppWorkspaceStore((s) => s.allFolders)
  const { shortcuts } = useShortcutSettings()
  const [events, setEvents] = useState<WorkTaskEvent[]>([])
  const [files, setFiles] = useState<WorkTaskChangedFile[]>([])
  // The composer under the action row, opened by whichever action wants it: a
  // follow-up on a reviewed task, an optional note on a failed / canceled one.
  // Either way it carries its own send — the button above only unfolds it.
  const [composerOpen, setComposerOpen] = useState(false)
  const [composerText, setComposerText] = useState("")
  const composerRef = useRef<TaskMessageComposerHandle>(null)
  // Mirrors the composer's attached-file count so an image-only follow-up (or
  // restart note) still enables the send — the text alone would read as empty.
  const [composerAttachments, setComposerAttachments] = useState(0)
  /** Set when the resurrection guard refused a restart — see `submitRestart`. */
  const [restartDuplicate, setRestartDuplicate] =
    useState<DuplicateActiveSource | null>(null)
  const [intent, setIntent] = useState<FollowUpIntent>(DEFAULT_FOLLOW_UP_INTENT)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteWorktree, setDeleteWorktree] = useState(false)
  /** Confirm for the footer's standalone worktree removal (`canRemoveWorktree`
   *  decides who is offered it). */
  const [cleanupOpen, setCleanupOpen] = useState(false)
  /**
   * The read-only live session viewer, owned HERE rather than by the board.
   *
   * It used to be raised through an `onViewSession` callback and rendered by
   * `tasks-page.tsx` as a sibling of this sheet. Both are drawers, and Base UI
   * only stacks a drawer that is a React DESCENDANT of the one it opens over
   * (nesting rides `DialogRootContext` — see `useRenderDialogRoot`), so as
   * siblings they could never stack: the viewer just landed on top with the
   * sheet still at full size underneath. Mounting it inside our own `Drawer`
   * gets the real thing — the sheet scales back and dims, and Escape unwinds
   * one layer at a time. The board keeps its own top-level instance for the
   * card's "查看会话" action, which opens with no sheet in play.
   */
  const [sessionOpen, setSessionOpen] = useState(false)
  const [diffFile, setDiffFile] = useState<string | null | false>(false)
  const [busy, setBusy] = useState(false)
  /** Synchronous in-flight latch for the follow-up send (see submitFollowUp). */
  const submittingRef = useRef(false)
  const reqRef = useRef(0)

  const taskId = task?.id ?? null
  const hasWorktree = task?.worktree_folder_id != null
  // Recorded AND still on disk — the only state a diff can be read in. The
  // cleanup / delete entries below stay on `hasWorktree`: converging the
  // leftovers of a vanished worktree is exactly what they are for.
  const worktreeUsable = hasWorktree && task?.worktree_missing !== true
  const conversationId = task?.conversation_id ?? null
  const taskStatus = task?.status ?? null
  // Total token usage of the task's conversation — parsed from the agent's own
  // transcript on open and re-read when the task settles (status flip), not on
  // every progress nudge (the parse is the expensive part).
  const [tokenTotal, setTokenTotal] = useState<number | null>(null)
  // The conversation's own agent — drives the header glyph. Read from the same
  // detail fetch as the token total (a task row carries an agent only when it
  // overrides the folder's default).
  const [convAgentType, setConvAgentType] = useState<AgentType | null>(null)
  useEffect(() => {
    if (!open || conversationId == null) {
      setTokenTotal(null)
      setConvAgentType(null)
      return
    }
    let cancelled = false
    getFolderConversation(conversationId)
      .then((detail) => {
        if (cancelled) return
        setConvAgentType(detail.summary.agent_type ?? null)
        const stats = detail.session_stats
        const usage = stats?.total_usage ?? null
        const total =
          stats?.total_tokens ??
          (usage
            ? usage.input_tokens +
              usage.output_tokens +
              usage.cache_creation_input_tokens +
              usage.cache_read_input_tokens
            : null)
        setTokenTotal(total ?? null)
      })
      .catch(() => {
        // Transcript may be unreadable (agent gone, file pruned) — no chip.
      })
    return () => {
      cancelled = true
    }
  }, [open, conversationId, taskStatus])

  const reload = useCallback(async () => {
    if (taskId == null) return
    const id = ++reqRef.current
    try {
      const [evs, fls] = await Promise.all([
        workTaskEvents(taskId),
        worktreeUsable ? workTaskChangedFiles(taskId) : Promise.resolve([]),
      ])
      if (id === reqRef.current) {
        setEvents(evs)
        setFiles(fls)
      }
    } catch {
      // keep previous data on transient error
    }
  }, [taskId, worktreeUsable])

  useEffect(() => {
    if (!open || taskId == null) return

    setEvents([])
    setFiles([])
    setComposerOpen(false)
    setComposerText("")
    setComposerAttachments(0)
    setRestartDuplicate(null)
    setIntent(DEFAULT_FOLLOW_UP_INTENT)
    void reload()
    let unsub: (() => void) | undefined
    let cancelled = false
    void subscribe(WORK_TASK_CHANGED_EVENT, () => {
      void reload()
    }).then((u: () => void) => {
      if (cancelled) u()
      else unsub = u
    })
    const offReconnect = onTransportReconnect(() => {
      void reload()
    })
    return () => {
      cancelled = true
      unsub?.()
      offReconnect?.()
    }
  }, [open, taskId, reload])

  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      toast.error(toErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }, [])

  // The guard's refusal belongs to the box it was raised in, and to the status
  // it was raised for. Closing the box or the task leaving `failed`/`canceled`
  // retires it — otherwise a later restart could open on a stale "restart
  // anyway" and waive a guard the user never saw refuse anything. (The label
  // and the waiver read the same state, so the two can never disagree; this is
  // about not carrying a decision across the moment it was made.)
  useEffect(() => {
    setRestartDuplicate(null)
  }, [composerOpen, task?.status])

  /// A restart that consumed the note closes the box with it, so the text
  /// cannot be silently attached to a second restart the user did not mean.
  /// A refusal the box answers on the spot (the resurrection guard) reports
  /// `false` instead, and everything stays exactly where the user left it.
  const runRestart = useCallback(
    (fn: () => Promise<boolean>) =>
      run(async () => {
        if (!(await fn())) return
        setComposerOpen(false)
        setComposerText("")
        setComposerAttachments(0)
      }),
    [run]
  )

  // Conversation truth first — that is the agent that actually ran. Before its
  // detail lands (and for a task that has never run) the list's own resolution
  // stands in, so the glyph here is the one the board and the list already
  // showed for this task rather than a placeholder that changes on load.
  const agentType =
    convAgentType ?? task?.agent_type ?? task?.config?.agent_type ?? null

  // Snapshot first (it carries the model the run actually used); otherwise the
  // resolved agent's display name, so a task that simply follows the folder's
  // defaults still names its agent beside the icon.
  const agentLabel = useMemo(() => {
    const snap = task?.config?.label_snapshot
    const name =
      snap?.agent_label ??
      (agentType ? (getAgentLabel(agentType) ?? agentType) : null)
    if (!name) return null
    const model = snap?.config_labels?.model
    return model ? `${name} · ${model}` : name
  }, [task, agentType])

  if (!task) return null

  // The same resolution, plus a folder default and the worktree path, for the
  // composer's commands / skills / file references.
  const composerTarget = followUpComposerTarget({
    task,
    conversationAgentType: convAgentType,
    folders: allFolders,
  })

  // The user-authored brief, as typed (the agent receives the block form).
  const promptText = task.config?.display_text?.trim() || null
  const archived = task.archived_at != null
  /** Set only when this task finished BY delivering — the link to show. */
  const deliveredPr = deliveredPrUrl(task)

  const canEdit = task.status === "todo" || task.status === "failed"

  // The next-step panel's buttons — ONE list for every status, review
  // included, so the panel never changes shape from one status to the next.
  // The board card's filled primary leads; archive is the only other action
  // that advances the task's state. "查看会话" and "编辑" don't advance
  // anything, so they sit in the bottom bar instead.
  const zoneActions: ZoneAction[] = []
  const isReview = task.status === "review" && !archived
  /** Accepted already, waiting for the project's one merge slot. */
  const mergeQueued = isReview && isMergeQueued(task)
  /** Put aside to handle later ("以后处理") — it waits under Done. */
  const deferred = !archived && isDeferred(task)
  /** "以后处理" on a task that can take it, the way back on one that has it. */
  const deferToggle = (): ZoneAction | null =>
    deferred
      ? {
          icon: Inbox,
          label: t("actionUndefer"),
          onClick: () => run(() => workTaskDefer(task.id, false)),
        }
      : canDefer(task)
        ? {
            icon: Clock,
            label: t("actionDefer"),
            onClick: () => run(() => workTaskDefer(task.id, true)),
          }
        : null
  const isRestart =
    !archived && (task.status === "failed" || task.status === "canceled")
  // A note for a restart (failed / canceled): both stopped for a reason the
  // user usually knows and the agent doesn't. The restart button itself opens
  // the box and the box sends — the same shape as "follow up", instead of a
  // separate "add a note" button that did nothing on its own and left the user
  // to go back up to the primary.
  //
  // Read from the editor when the button fires, never from the render's state:
  // `composerText` trails the document by however long React takes to commit
  // the keystroke, so a restart triggered right after typing would carry the
  // previous value. Same rule as the follow-up send below.
  const composerNote = (): string | null => {
    if (!composerOpen) return null
    return (composerRef.current?.getText() ?? composerText).trim() || null
  }
  /** Images / pasted bytes attached to the open box, as their own blocks. */
  const composerBlocks = (): PromptInputBlock[] =>
    composerOpen ? (composerRef.current?.getAttachmentBlocks() ?? []) : []
  if (isReview) {
    // Already accepted and waiting for the project's merge slot: the merge is
    // decided, so the panel offers the two ways to change that decision —
    // edit the queued merge, or leave the queue. Neither is filled: nothing
    // here is waiting on the user, and a filled button would say it is.
    if (mergeQueued) {
      zoneActions.push({
        icon: GitMerge,
        label: t("actionEditQueuedMerge"),
        onClick: () => onMerge(task),
      })
      zoneActions.push({
        icon: ListX,
        label: t("actionUnqueueMerge"),
        onClick: () => run(() => workTaskMergeUnqueue(task.id)),
      })
    } else {
      // A task that changed nothing has no merge to offer — accepting it IS
      // the primary action (same swap the board card makes). A task that came
      // from a pull request has no local merge at all: its work belongs on
      // that pull request's branch, and the backend refuses anything else.
      //
      // A task put aside to handle later keeps every acceptance on offer, but
      // none of them leads: like its card, it leads with the follow-up below.
      if (hasNothingToMerge(task)) {
        zoneActions.push({
          icon: CircleCheck,
          label: t("actionComplete"),
          filled: !deferred,
          onClick: () => onComplete(task),
        })
      } else if (mustDeliverToPr(task)) {
        zoneActions.push({
          icon: GitPullRequestArrow,
          label: t(
            usesMergeRequests(task)
              ? "actionDeliverPrBackMr"
              : "actionDeliverPrBack"
          ),
          filled: !deferred,
          onClick: () => onDeliverPr(task),
        })
      } else {
        zoneActions.push({
          icon: GitMerge,
          label: t("actionMerge"),
          filled: !deferred,
          onClick: () => onMerge(task),
        })
        // A second way to accept, not a replacement: a task that came from an
        // issue can still legitimately be landed locally, so both stay on
        // offer and the merge above keeps the filled slot.
        if (canDeliverToPr(task)) {
          zoneActions.push({
            icon: GitPullRequestArrow,
            label: t(
              usesMergeRequests(task) ? "actionDeliverPrMr" : "actionDeliverPr"
            ),
            onClick: () => onDeliverPr(task),
          })
        }
      }
    }
    const followUp: ZoneAction = {
      icon: Undo2,
      label: t("actionFollowUp"),
      expanded: composerOpen,
      onClick: () => setComposerOpen((v) => !v),
    }
    // Picking a deferred task back up is what the user came here for — the
    // follow-up leads, the way it does on the card in Done.
    if (deferred && !mergeQueued) {
      zoneActions.unshift({ ...followUp, filled: true })
    } else {
      zoneActions.push(followUp)
    }
    const toggle = deferToggle()
    if (toggle) zoneActions.push(toggle)
    zoneActions.push({
      icon: Ban,
      label: t("actionAbandon"),
      trailing: true,
      onClick: () => onCancel(task),
    })
  } else {
    const archive = (label: string, filled?: boolean): ZoneAction => ({
      icon: archived ? ArchiveRestore : Archive,
      label,
      filled,
      onClick: () => run(() => workTaskArchive(task.id, !archived)),
    })
    if (archived) {
      zoneActions.push(archive(t("actionUnarchive"), true))
    } else {
      switch (task.status) {
        case "todo":
          zoneActions.push({
            icon: Play,
            label: t("actionStart"),
            filled: true,
            onClick: () => run(() => workTaskStart(task.id)),
          })
          // Starting later is the same decision as starting now, so it sits
          // beside it rather than in the utility bar below.
          zoneActions.push({
            icon: CalendarClock,
            label: t("actionSchedule"),
            onClick: () => onSchedule(task),
          })
          break
        case "queued":
        case "preparing":
        case "running":
        case "awaiting_input":
          zoneActions.push({
            icon: Ban,
            label: t("actionCancel"),
            filled: true,
            onClick: () => onCancel(task),
          })
          break
        case "merging":
          break
        // The two restarts open the note box rather than firing: the send
        // button inside it is what actually restarts (see `submitRestart`).
        case "failed": {
          zoneActions.push({
            icon: RotateCw,
            label: t("actionRetry"),
            filled: true,
            expanded: composerOpen,
            onClick: () => setComposerOpen((v) => !v),
          })
          const toggle = deferToggle()
          if (toggle) zoneActions.push(toggle)
          zoneActions.push(archive(t("actionArchive")))
          break
        }
        case "done":
          zoneActions.push(archive(t("actionArchive"), true))
          break
        case "canceled":
          zoneActions.push({
            icon: RotateCw,
            label: t("actionRequeue"),
            filled: true,
            expanded: composerOpen,
            onClick: () => setComposerOpen((v) => !v),
          })
          zoneActions.push(archive(t("actionArchive")))
          break
      }
    }
  }

  const hasTrailingAction = zoneActions.some((a) => a.trailing)
  const scenario = followUpScenario(intent)
  const composerPlaceholder = isReview
    ? t(scenario.placeholderKey)
    : task.status === "failed"
      ? t("followUpPlaceholderRetry")
      : t("followUpPlaceholderRequeue")

  const submitFollowUp = () =>
    run(async () => {
      // Straight from the editor: reference badges serialize to their inline
      // token here, and this can't lag a keystroke behind the state.
      const feedback = (composerRef.current?.getText() ?? composerText).trim()
      const blocks = composerBlocks()
      if (!canSubmitFollowUp(intent, feedback, blocks.length > 0)) return
      // An unsettled upload has no server-side uri yet, so its block would
      // reach the agent empty. The draft stays intact — this is "wait a moment".
      if (composerRef.current?.hasUploadingImage()) {
        toast.error(tChat("attachUploadInProgress"))
        return
      }
      // A ref, not `busy`: the send key is read out of a ref inside the
      // editor's own keydown handler, so a second Enter can arrive before
      // React has re-rendered with `busy` set. The backend's CAS would reject
      // the loser anyway — this keeps it from surfacing as an error toast for
      // a keypress the user is entitled to repeat.
      if (submittingRef.current) return
      submittingRef.current = true
      try {
        await workTaskReturn(task.id, feedback, intent, blocks)
      } finally {
        submittingRef.current = false
      }
      setComposerOpen(false)
      setComposerText("")
      setIntent(DEFAULT_FOLLOW_UP_INTENT)
    })

  /// The restart's own send. The note is optional — an empty box restarts the
  /// task exactly the way the button used to on its own. Gated on the status
  /// still being restartable: the row is live while the box is open, so a task
  /// the engine picked back up must not be re-queued by a late click.
  const submitRestart = (allowDuplicateSource = false) => {
    if (!isRestart) return
    // The same ref latch the follow-up send takes, and for the same reason: the
    // box now sends, so the send key reaches this out of the editor's own
    // keydown handler and a second Enter can arrive before React has
    // re-rendered with `busy` set. The backend's CAS rejects the loser, but the
    // user would see an error toast for a keypress they are entitled to repeat.
    if (submittingRef.current) return
    if (composerRef.current?.hasUploadingImage()) {
      toast.error(tChat("attachUploadInProgress"))
      return
    }
    submittingRef.current = true
    const note = composerNote()
    const blocks = composerBlocks()
    return runRestart(async () => {
      try {
        if (task.status === "failed") {
          await workTaskRetry(task.id, note, blocks, allowDuplicateSource)
        } else {
          await workTaskRequeue(task.id, note, blocks, allowDuplicateSource)
        }
        setRestartDuplicate(null)
        return true
      } catch (e) {
        // The resurrection guard is the one refusal with a way through, and it
        // refuses EVERY restart of this card while the other task lives — a
        // toast would leave the user with no next move. Everything else keeps
        // `run`'s toast: there is nothing there to decide.
        const dup = duplicateActiveSource(e)
        if (!dup) throw e
        setRestartDuplicate(dup)
        return false
      } finally {
        submittingRef.current = false
      }
    })
  }

  return (
    <>
      <Drawer open={open} onOpenChange={onOpenChange} swipeDirection="right">
        <DrawerContent className={SIDE_PANEL_CONTENT_CLASS}>
          <DrawerHeader className="shrink-0 gap-0 border-b border-border px-5 py-4">
            {/* Agent glyph, then the title block. The status chip rides
                directly beside the title rather than being pinned to the far
                edge — it reads as part of the name, not as a separate
                column. */}
            <div className="flex items-start gap-3 pr-8">
              {/* The agent that actually ran the task, not a generic glyph. */}
              <span className="mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-xl border border-border bg-muted/40 text-foreground">
                {agentType ? (
                  <AgentIcon
                    agentType={agentType}
                    className="size-[1.125rem]"
                  />
                ) : (
                  <ListTodo
                    className="size-[1.125rem] text-muted-foreground"
                    aria-hidden="true"
                  />
                )}
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex min-w-0 items-start gap-2">
                  <DrawerTitle className="min-w-0 break-words text-[0.9375rem] font-semibold leading-5">
                    {task.title}
                  </DrawerTitle>
                  {/* One title line tall, centring its own content: the chips
                      differ in height (pill vs bare spinner text), so a fixed
                      margin would only ever centre one of them — and a
                      wrapping title still keeps the chip on line one. */}
                  <span className="flex h-5 shrink-0 items-center">
                    <StatusChip task={task} />
                  </span>
                </div>
                {/* Identity only, dot-separated like the board card — git
                    facts live in the Details grid below. One line, never
                    wrapping: the agent and the model it ran belong beside the
                    folder, so the parts truncate proportionally instead of
                    dropping the model onto a line of its own. */}
                <div className="flex min-w-0 items-center gap-1.5 text-[0.6875rem] leading-none text-muted-foreground">
                  {folderName ? (
                    <span className="min-w-0 shrink truncate">
                      {folderName}
                    </span>
                  ) : null}
                  {folderName && agentLabel ? <MetaDot /> : null}
                  {agentLabel ? (
                    <span className="min-w-0 shrink truncate">
                      {agentLabel}
                    </span>
                  ) : null}
                  {(folderName || agentLabel) &&
                  tokenTotal != null &&
                  tokenTotal > 0 ? (
                    <MetaDot />
                  ) : null}
                  {tokenTotal != null && tokenTotal > 0 ? (
                    <span
                      className="inline-flex shrink-0 items-center gap-1 tabular-nums"
                      title={t("detailTokens")}
                    >
                      <Coins className="size-3" aria-hidden="true" />
                      {formatTokenCount(tokenTotal)}
                    </span>
                  ) : null}
                </div>
              </div>
            </div>
            <DrawerDescription className="sr-only">
              {t("detailDescription")}
            </DrawerDescription>
          </DrawerHeader>

          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-5 px-5 py-4">
              {/* A failure can carry anything from one line to a whole stack
                  trace, and unbounded it pushed the brief, the result and the
                  action panel off the first screen. Capped like the brief and
                  the result below. The fade has to match the surface being
                  clipped, and this one is `bg-destructive/10` over the sheet's
                  own `bg-popover` — fading FROM that same translucent token
                  would stack a second 10% on top and read as a dark band, so
                  the equivalent opaque colour is mixed explicitly (both are
                  theme vars, so it tracks the palette and dark mode). */}
              {task.last_error ? (
                <CollapsibleBlock
                  maxPx={160}
                  fadeClass="from-[color-mix(in_oklab,var(--destructive)_10%,var(--popover))]"
                >
                  <div className="flex items-start gap-2 rounded-xl bg-destructive/10 p-3 text-xs text-destructive">
                    <CircleAlert
                      className="mt-0.5 size-3.5 shrink-0"
                      aria-hidden="true"
                    />
                    <span className="min-w-0 whitespace-pre-wrap break-words">
                      {task.last_error}
                    </span>
                  </div>
                </CollapsibleBlock>
              ) : null}

              {/* The original task brief — always above the agent's result. */}
              {promptText ? (
                <section className="flex flex-col gap-1.5">
                  <h3 className="text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
                    {t("promptLabel")}
                  </h3>
                  {/* Filled, not outlined: without a border the fill has to
                      carry the block, so the surface is opaque enough to read
                      on a white drawer. The brief and the result share it —
                      they are the same kind of thing (quoted prose), and the
                      section headings already say whose words they are. */}
                  <CollapsibleBlock maxPx={192} fadeClass="from-muted">
                    <div className="whitespace-pre-wrap break-words rounded-xl bg-muted p-3 text-xs leading-relaxed">
                      {promptText}
                    </div>
                  </CollapsibleBlock>
                </section>
              ) : null}

              {task.result_summary ? (
                <section className="flex flex-col gap-1.5">
                  <h3 className="text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
                    {t("detailSummary")}
                  </h3>
                  {/* The agent writes its verdict the way it writes anything
                      else — bullets, `code`, bold — so it goes through the
                      same renderer as the chat instead of showing its own
                      source. Capped taller than the brief above: this is the
                      thing the drawer was opened to read. */}
                  <CollapsibleBlock maxPx={256} fadeClass="from-muted">
                    <div
                      className={cn(
                        "break-words rounded-xl bg-muted p-3 text-xs leading-relaxed",
                        RESULT_MARKDOWN
                      )}
                    >
                      <MessageResponse>{task.result_summary}</MessageResponse>
                    </div>
                  </CollapsibleBlock>
                </section>
              ) : null}

              {/* Next-step panel — one shell for EVERY status, below the
                  result and above the details. Amber while the task waits on
                  the user's acceptance, neutral otherwise: the tone changes,
                  the shape never does. The primary grows to fill the row, so
                  a single-action status reads as a deliberate call to action
                  rather than a lone button afloat in the drawer. */}
              {zoneActions.length > 0 ? (
                <section
                  className={cn(
                    "flex flex-col gap-3 rounded-xl border p-3",
                    // A deferred review is not waiting on the user right now —
                    // they said so — so it drops the amber with its column.
                    isReview && !deferred
                      ? "border-amber-500/30 bg-amber-500/5 dark:border-amber-400/25"
                      : "border-border/70 bg-muted/30"
                  )}
                >
                  {/* Why there is no merge button here: the task is in line
                      behind another landing of the same project. Without this
                      the panel would read as if the acceptance never
                      registered. */}
                  {mergeQueued ? (
                    <p className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                      <Clock className="size-3.5 shrink-0" aria-hidden="true" />
                      <span className="min-w-0 break-words">
                        {t("badgeMergeQueuedHint")}
                      </span>
                    </p>
                  ) : null}

                  {isReview && task.preflight ? (
                    <div className="flex flex-col gap-1.5">
                      <div
                        className={cn(
                          "flex items-center gap-1.5 text-xs",
                          task.preflight.status === "passed" &&
                            "text-emerald-600 dark:text-emerald-400",
                          task.preflight.status === "failed" &&
                            "text-destructive",
                          task.preflight.status === "running" &&
                            "text-muted-foreground"
                        )}
                      >
                        {task.preflight.status === "running" ? (
                          <Loader2
                            className="size-3.5 shrink-0 animate-spin"
                            aria-hidden="true"
                          />
                        ) : task.preflight.status === "passed" ? (
                          <CircleCheck
                            className="size-3.5 shrink-0"
                            aria-hidden="true"
                          />
                        ) : (
                          <CircleX
                            className="size-3.5 shrink-0"
                            aria-hidden="true"
                          />
                        )}
                        <span className="min-w-0 break-words">
                          {task.preflight.status === "passed"
                            ? t("preflightPassed", {
                                name: task.preflight.command,
                              })
                            : task.preflight.status === "failed"
                              ? t("preflightFailed", {
                                  name: task.preflight.command,
                                })
                              : t("preflightRunning", {
                                  name: task.preflight.command,
                                })}
                        </span>
                      </div>
                      {task.preflight.status === "failed" &&
                      task.preflight.output_tail ? (
                        <pre className="max-h-40 overflow-auto rounded-lg border border-border bg-background/70 p-2 font-mono text-[0.625rem] leading-relaxed whitespace-pre-wrap break-words text-muted-foreground">
                          {task.preflight.output_tail}
                        </pre>
                      ) : null}
                    </div>
                  ) : null}

                  <div className="flex flex-wrap items-center gap-2">
                    {zoneActions.map((action) => (
                      <Button
                        key={action.label}
                        type="button"
                        variant={
                          action.trailing
                            ? "ghost"
                            : action.filled
                              ? "default"
                              : "outline"
                        }
                        disabled={busy}
                        aria-expanded={action.expanded}
                        className={cn(
                          "h-8 gap-1.5",
                          // The primary claims the row unless an escape hatch
                          // holds the right edge — then it sizes to content and
                          // the spacer does the pushing.
                          action.filled && !hasTrailingAction && "flex-1",
                          action.trailing && "ml-auto text-muted-foreground",
                          !action.filled && !action.trailing && "bg-background"
                        )}
                        onClick={action.onClick}
                      >
                        <action.icon className="size-3.5" aria-hidden="true" />
                        {action.label}
                      </Button>
                    ))}
                  </div>

                  {composerOpen && (isReview || isRestart) ? (
                    <div className="flex flex-col gap-2">
                      {/* The real composer, not a textarea: this is the step
                          where naming a file or firing a command matters most.
                          The submit is handed over whole rather than wrapped in
                          a guard that reads render state: the editor calls it
                          out of a ref that a passive effect refreshes, so
                          anything read here could be a render behind the
                          keystroke that triggered it — each submit validates
                          the live document itself. */}
                      <TaskMessageComposer
                        ref={composerRef}
                        agentType={composerTarget.agentType}
                        folderPath={composerTarget.folderPath}
                        defaultText={composerText}
                        placeholder={composerPlaceholder}
                        ariaLabel={
                          isReview ? t("actionFollowUp") : t("actionAddNote")
                        }
                        autoFocus
                        submitShortcut={shortcuts.send_message}
                        newlineShortcut={shortcuts.newline_in_message}
                        onChange={setComposerText}
                        onAttachmentsChange={setComposerAttachments}
                        onSubmit={() => {
                          // Mirrors the send button exactly — including the
                          // waiver once the guard's warning is on screen and
                          // the button reads "restart anyway". Sending without
                          // it there would re-run into the same refusal and
                          // read as a dead key.
                          void (isReview
                            ? submitFollowUp()
                            : submitRestart(restartDuplicate != null))
                        }}
                      />
                      {!isReview && restartDuplicate ? (
                        // Announced, not just drawn: the refusal arrives while
                        // focus is in the editor, so a screen-reader user
                        // would otherwise get silence — the same dead key this
                        // affordance exists to remove.
                        <p role="alert" className="text-xs text-destructive">
                          {t("restartDuplicateSource", {
                            task: duplicateActiveSourceLabel(
                              restartDuplicate,
                              t("restartDuplicateSourceAnon")
                            ),
                          })}
                        </p>
                      ) : null}
                      {/* One footer for every case: the scenario picker on the
                          left (reviewed tasks only — a restart's purpose is
                          already fixed by the button that opened this box) and
                          the send on the right. A restart sends from here too,
                          so the button above is purely the disclosure. */}
                      <div className="flex items-center gap-2">
                        {isReview ? (
                          <Select
                            value={intent}
                            onValueChange={(v) =>
                              setIntent(v as FollowUpIntent)
                            }
                          >
                            {/* The glyph rides inside SelectItem, which wraps
                                its children in ItemText — so the trigger
                                mirrors icon and label together, no separate
                                trigger glyph needed. No radius override: the
                                trigger keeps the pill the design system gives
                                every control, so it matches the send button
                                beside it instead of reading as a stray box. */}
                            <SelectTrigger
                              size="sm"
                              className="w-auto min-w-0 max-w-[14rem] bg-background text-xs"
                              aria-label={t("actionFollowUp")}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {FOLLOW_UP_SCENARIOS.map((option) => (
                                <SelectItem
                                  key={option.intent}
                                  value={option.intent}
                                >
                                  <option.icon
                                    className="size-3.5 text-muted-foreground"
                                    aria-hidden="true"
                                  />
                                  {t(option.labelKey)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : null}
                        <div className="flex-1" />
                        <Button
                          type="button"
                          size="sm"
                          disabled={
                            busy ||
                            (isReview &&
                              !canSubmitFollowUp(
                                intent,
                                composerText,
                                composerAttachments > 0
                              ))
                          }
                          // Arrow-wrapped, never a bare `submitRestart`: the
                          // handler would receive the click event as
                          // `allowDuplicateSource`, and a MouseEvent is truthy
                          // — every restart would waive the guard.
                          onClick={() =>
                            void (isReview
                              ? submitFollowUp()
                              : submitRestart(restartDuplicate != null))
                          }
                        >
                          {!isReview && restartDuplicate
                            ? t("actionRestartAnyway")
                            : t("followUpSubmit")}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </section>
              ) : null}

              {/* Key-value facts: git coordinates, change size, lifecycle. */}
              <section className="flex flex-col gap-1.5">
                <h3 className="text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
                  {t("detailInfo")}
                </h3>
                {/* Boxed and ruled, like the changed-files list. No column
                    gap: the label/value spacing is padding INSIDE the cells,
                    so the two cells' bottom borders meet and each rule runs
                    unbroken across the box. nth-last-child(-n+2) is the dt/dd
                    of the final row, which drops its rule. */}
                <dl className="grid grid-cols-[auto_1fr] overflow-hidden rounded-xl border border-border text-xs [&>*:nth-last-child(-n+2)]:border-b-0">
                  {task.work_branch ? (
                    <InfoRow label={t("detailBranch")}>
                      <span className="inline-flex min-w-0 max-w-full items-center gap-1 font-mono text-[0.6875rem]">
                        <GitBranch
                          className="size-3 shrink-0 text-muted-foreground"
                          aria-hidden="true"
                        />
                        <span className="truncate">
                          {task.work_branch}
                          {task.base_branch ? ` ← ${task.base_branch}` : null}
                        </span>
                      </span>
                    </InfoRow>
                  ) : null}
                  {task.merge_commit ? (
                    <InfoRow label={t("detailMergeCommit")}>
                      <span className="inline-flex items-center gap-1 font-mono text-[0.6875rem]">
                        <GitCommitHorizontal
                          className="size-3 text-muted-foreground"
                          aria-hidden="true"
                        />
                        {task.merge_commit.slice(0, 8)}
                      </span>
                    </InfoRow>
                  ) : null}
                  {deliveredPr ? (
                    <InfoRow
                      label={t(
                        usesMergeRequests(task)
                          ? "detailMergeRequest"
                          : "detailPullRequest"
                      )}
                    >
                      <BrowserLink
                        href={deliveredPr}
                        className="inline-flex min-w-0 items-center gap-1 truncate underline-offset-2 hover:underline"
                        title={deliveredPr}
                      >
                        <GitPullRequestArrow
                          className="size-3 shrink-0 text-muted-foreground"
                          aria-hidden="true"
                        />
                        <span className="truncate">{deliveredPr}</span>
                      </BrowserLink>
                    </InfoRow>
                  ) : null}
                  {task.files_changed != null && task.files_changed > 0 ? (
                    <InfoRow label={t("detailChanges")}>
                      <span className="inline-flex flex-wrap items-center gap-x-1.5">
                        {t("filesChanged", { count: task.files_changed })}
                        <span className="font-mono text-[0.6875rem]">
                          <span className="text-emerald-600 dark:text-emerald-400">
                            +{task.additions ?? 0}
                          </span>{" "}
                          <span className="text-destructive">
                            -{task.deletions ?? 0}
                          </span>
                        </span>
                      </span>
                    </InfoRow>
                  ) : null}
                  {/* Above "created": it is the only date here that is still
                      ahead of the task rather than behind it. */}
                  {task.status === "todo" && task.scheduled_at ? (
                    <InfoRow label={t("detailScheduled")}>
                      <span className="inline-flex items-center gap-1 text-primary">
                        <CalendarClock className="size-3" aria-hidden="true" />
                        {formatDateTime(task.scheduled_at)}
                      </span>
                    </InfoRow>
                  ) : null}
                  <InfoRow label={t("detailCreated")}>
                    {formatDateTime(task.created_at)}
                  </InfoRow>
                  {task.started_at ? (
                    <InfoRow label={t("detailStarted")}>
                      {formatDateTime(task.started_at)}
                    </InfoRow>
                  ) : null}
                  {task.finished_at ? (
                    <InfoRow label={t("detailFinished")}>
                      {formatDateTime(task.finished_at)}
                    </InfoRow>
                  ) : null}
                </dl>
              </section>

              {/* Changed files vs the recorded base — which for a task that
                  came FROM a pull request is the merge base, so this list is
                  "the pull request plus whatever the agent did". The counters
                  above it are the task's own work alone (see
                  `hasNothingToMerge`), so the difference is spelled out rather
                  than left to read as a contradiction. */}
              {worktreeUsable ? (
                <section className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="min-w-0 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
                      {t("detailFiles")}
                      {files.length > 0 ? (
                        <span className="ml-1.5 font-normal text-muted-foreground/70 tabular-nums">
                          {files.length}
                        </span>
                      ) : null}
                      {mustDeliverToPr(task) && files.length > 0 ? (
                        <span className="ml-1.5 font-normal normal-case tracking-normal text-muted-foreground/70">
                          {t(
                            usesMergeRequests(task)
                              ? "detailFilesIncludesMr"
                              : "detailFilesIncludesPr"
                          )}
                        </span>
                      ) : null}
                    </h3>
                    {files.length > 0 ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-6 shrink-0 gap-1 px-2 text-[0.6875rem] text-muted-foreground"
                        onClick={() => setDiffFile(null)}
                      >
                        <FileDiff className="size-3" aria-hidden="true" />
                        {t("detailDiffAll")}
                      </Button>
                    ) : null}
                  </div>
                  {files.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {t("detailNoChanges")}
                    </p>
                  ) : (
                    <CollapsibleBlock maxPx={224}>
                      <ul className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-xl border border-border">
                        {files.map((f) => (
                          <li key={f.file}>
                            <button
                              type="button"
                              onClick={() => setDiffFile(f.file)}
                              className={cn(
                                "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs",
                                "transition-colors hover:bg-accent/50"
                              )}
                            >
                              <span className="min-w-0 flex-1 truncate font-mono text-[0.6875rem]">
                                {f.file}
                              </span>
                              <span className="shrink-0 font-mono text-[0.625rem] text-emerald-600 dark:text-emerald-400">
                                +{f.additions}
                              </span>
                              <span className="shrink-0 font-mono text-[0.625rem] text-destructive">
                                -{f.deletions}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </CollapsibleBlock>
                  )}
                </section>
              ) : null}

              {/* Progress timeline (work_task_event, append-only). */}
              <section className="flex flex-col gap-1.5">
                <h3 className="text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
                  {t("detailTimeline")}
                </h3>
                {events.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {t("detailTimelineEmpty")}
                  </p>
                ) : (
                  <ol className="flex flex-col">
                    {events
                      // `round` markers feed the transcript viewer's phase
                      // dividers; here the status headers already segment.
                      .filter((ev) => ev.kind !== "round")
                      .map((ev) => (
                        <TimelineRow key={ev.id} event={ev} />
                      ))}
                  </ol>
                )}
              </section>
            </div>
          </ScrollArea>

          {/* Footer: everything that does NOT advance the task's state — the
              status's own actions live in the action zone / acceptance panel
              above. Left: session viewer, edit (while editable), cleanup
              retry; right: the worktree a settled (done / canceled) task is
              still holding, then the destructive delete (`merging` cannot be
              deleted), which takes the worktree along as a checkbox in its own
              confirm. */}
          {task.conversation_id != null ||
          canEdit ||
          task.status !== "merging" ? (
            <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-border px-5 py-3">
              {task.conversation_id != null ? (
                <FooterAction
                  icon={MessageSquareText}
                  label={t("actionViewSession")}
                  busy={false}
                  onClick={() => setSessionOpen(true)}
                />
              ) : null}
              {canEdit ? (
                <FooterAction
                  icon={Pencil}
                  label={t("actionEdit")}
                  busy={busy}
                  onClick={() => onEdit(task)}
                />
              ) : null}
              {hasWorktree && task.cleanup_state === "failed" ? (
                <FooterAction
                  icon={FolderX}
                  label={t("actionRetryCleanup")}
                  busy={busy}
                  onClick={() => run(() => workTaskCleanup(task.id))}
                />
              ) : null}
              <div className="flex-1" />
              {/* Beside "delete", because that is the other way to be rid of
                  this worktree — and glyph-only, because a settled task's
                  leftover checkout is a housekeeping detail, not a decision the
                  drawer should press on the user every time they open it. */}
              {canRemoveWorktree(task) ? (
                <FooterIconAction
                  icon={FolderX}
                  label={t("actionDeleteWorktree")}
                  busy={busy}
                  onClick={() => setCleanupOpen(true)}
                />
              ) : null}
              {task.status !== "merging" ? (
                <FooterAction
                  icon={Trash2}
                  label={t("actionDelete")}
                  busy={busy}
                  destructive
                  onClick={() => setDeleteOpen(true)}
                />
              ) : null}
            </div>
          ) : null}
        </DrawerContent>

        {/* Inside the `Drawer` (so it nests) but outside `DrawerContent` (so
            it escapes the content's `overflow-hidden` and the `opacity-0` the
            content takes on while a nested drawer is open). Anywhere under
            the root is enough — nesting is context, not DOM. */}
        <TaskTranscriptDialog
          open={sessionOpen}
          onOpenChange={setSessionOpen}
          task={task}
        />
      </Drawer>

      {/* Per-file / full diff viewer. */}
      <Dialog
        open={diffFile !== false}
        onOpenChange={(o) => !o && setDiffFile(false)}
      >
        <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[56rem]">
          <DialogHeader className="shrink-0 border-b border-border px-4 py-3">
            <DialogTitle className="truncate font-mono text-sm">
              {diffFile === false ? "" : (diffFile ?? t("detailDiffAllTitle"))}
            </DialogTitle>
          </DialogHeader>
          {diffFile !== false ? (
            <TaskDiffBody taskId={task.id} file={diffFile} />
          ) : null}
        </DialogContent>
      </Dialog>

      {/* Worktree removal confirm. Git takes the directory `--force` and the
          work branch `-D`, so anything left uncommitted or unlanded in there
          goes with it — too much to hang off one click on a bare glyph. */}
      <AlertDialog open={cleanupOpen} onOpenChange={setCleanupOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("deleteWorktreeConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteWorktreeConfirmBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                run(async () => {
                  await workTaskCleanup(task.id)
                  setCleanupOpen(false)
                })
              }
            >
              {t("actionDeleteWorktree")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete confirm (optionally with the worktree). */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteConfirmBody", { title: task.title })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {hasWorktree ? (
            <Label className="text-sm font-normal">
              <Checkbox
                checked={deleteWorktree}
                onCheckedChange={(v) => setDeleteWorktree(v === true)}
              />
              {t("deleteWithWorktree")}
            </Label>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                run(async () => {
                  await workTaskDelete(task.id, hasWorktree && deleteWorktree)
                  setDeleteOpen(false)
                  onOpenChange(false)
                })
              }
            >
              {t("actionDelete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function TaskDiffBody({
  taskId,
  file,
}: {
  taskId: number
  file: string | null
}) {
  const t = useTranslations("Tasks")
  const [diff, setDiff] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    /* eslint-disable react-hooks/set-state-in-effect */
    setDiff(null)
    setError(null)
    workTaskDiff(taskId, file)
      .then((d) => {
        if (!cancelled) setDiff(d)
      })
      .catch((e) => {
        if (!cancelled) setError(toErrorMessage(e))
      })
    return () => {
      cancelled = true
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [taskId, file])

  if (error) {
    return <p className="p-4 text-sm text-destructive">{error}</p>
  }
  if (diff == null) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        {t("diffLoading")}
      </div>
    )
  }
  if (!diff.trim()) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        {t("detailNoChanges")}
      </p>
    )
  }
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="p-3">
        {/* `unbounded`: the preview would otherwise put every file in its own
            420px scroll box, nesting a second vertical scroll inside this
            one. Here the whole diff is capped once and revealed on demand. */}
        <CollapsibleBlock maxPx={420}>
          <UnifiedDiffPreview diffText={diff} unbounded />
        </CollapsibleBlock>
      </div>
    </ScrollArea>
  )
}

/**
 * Caps its content at `maxPx` and offers a reveal toggle — but only once the
 * content actually exceeds the cap, so short lists and small diffs render
 * untouched. Measured from the content's own box (not the clipped one) so the
 * toggle survives expanding.
 */
function CollapsibleBlock({
  maxPx,
  fadeClass = "from-background",
  children,
}: {
  maxPx: number
  /** Gradient source for the clip fade — it has to match the surface being
   *  clipped, or the fade reads as a stripe rather than a soft edge. */
  fadeClass?: string
  children: ReactNode
}) {
  const t = useTranslations("Tasks")
  const innerRef = useRef<HTMLDivElement>(null)
  const [contentHeight, setContentHeight] = useState(0)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    const el = innerRef.current
    if (!el) return
    const measure = () => setContentHeight(el.scrollHeight)
    measure()
    // Content grows asynchronously (a diff reparse, a refreshed file list).
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Slack absorbs sub-pixel rounding — a 2px overflow isn't worth a toggle.
  const overflows = contentHeight > maxPx + 8
  const clipped = overflows && !expanded

  return (
    <div className="flex flex-col">
      <div
        className="relative overflow-hidden"
        style={clipped ? { maxHeight: maxPx } : undefined}
      >
        <div ref={innerRef}>{children}</div>
        {clipped ? (
          <div
            aria-hidden="true"
            className={cn(
              // Rounded to the clipped surface's own corners: a square
              // gradient would paint its colour into them. Invisible for the
              // default fade (page colour over the page), load-bearing for a
              // filled panel.
              "pointer-events-none absolute inset-x-0 bottom-0 h-10 rounded-b-xl bg-gradient-to-t to-transparent",
              fadeClass
            )}
          />
        ) : null}
      </div>
      {overflows ? (
        <button
          type="button"
          className="mt-1 inline-flex items-center gap-1 self-center rounded-full px-2 py-0.5 text-[0.6875rem] text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? (
            <ChevronUp className="size-3" aria-hidden="true" />
          ) : (
            <ChevronDown className="size-3" aria-hidden="true" />
          )}
          {expanded ? t("showLess") : t("showMore")}
        </button>
      ) : null}
    </div>
  )
}

/** One label/value pair inside the Details grid (grid supplies the columns).
 *  Both cells carry the row's underline so it spans both columns. */
function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="border-b border-border/60 py-2 pl-3 pr-4 text-muted-foreground">
        {label}
      </dt>
      <dd className="min-w-0 break-words border-b border-border/60 py-2 pr-3">
        {children}
      </dd>
    </>
  )
}

/** Full date-time, minute precision — the Details grid. */
function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

/** Compact date-time for timeline rows (year dropped; events are recent). */
function formatEventTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function FooterAction({
  icon: Icon,
  label,
  onClick,
  busy,
  destructive,
}: {
  icon: typeof Play
  label: string
  onClick: () => void
  busy: boolean
  destructive?: boolean
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      disabled={busy}
      className={cn(
        "h-7 gap-1.5 px-2.5 text-xs",
        destructive
          ? "text-destructive hover:text-destructive"
          : "text-muted-foreground hover:text-foreground"
      )}
      onClick={onClick}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {label}
    </Button>
  )
}

/**
 * A footer action stripped to its glyph. The label lives on twice over: as an
 * `aria-label` (a Radix tooltip only DESCRIBES its trigger — it never names it)
 * and as the tooltip itself, which is the only way a pointer user reads it.
 * Sized to `FooterAction`'s own h-7 so the row keeps one baseline.
 */
function FooterIconAction({
  icon: Icon,
  label,
  onClick,
  busy,
}: {
  icon: typeof Play
  label: string
  onClick: () => void
  busy: boolean
}) {
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            disabled={busy}
            aria-label={label}
            className="size-7 text-muted-foreground hover:text-foreground"
            onClick={onClick}
          >
            <Icon className="size-3.5" aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

const EVENT_KIND_KEYS = {
  created: "eventCreated",
  status_changed: "eventStatusChanged",
  config_effective: "eventConfigEffective",
  init_command: "eventInitCommand",
  agent_progress: "eventAgentProgress",
  agent_verdict: "eventAgentVerdict",
  merge_attempt: "eventMergeAttempt",
  merge_queued: "eventMergeQueued",
  merge_conflict: "eventMergeConflict",
  preflight_result: "eventPreflight",
  cleanup_failed: "eventCleanupFailed",
  resume_fallback: "eventResumeFallback",
  context_compact: "eventContextCompact",
  user_action: "eventUserAction",
  diff_stat: "eventDiffStat",
  forge_writeback: "eventForgeWriteback",
  forge_writeback_failed: "eventForgeWritebackFailed",
} as const

/** What set off the repository panel's auto-processing, for a task it
 *  created — the `auto` field the backend stamps on the `created` event. */
const AUTO_TRIGGER_KEYS = {
  schedule: "eventAutoSchedule",
  webhook: "eventAutoWebhook",
  manual: "eventAutoManual",
} as const

const STATUS_KEYS = new Set([
  "todo",
  "queued",
  "preparing",
  "running",
  "awaiting_input",
  "review",
  "merging",
  "done",
  "failed",
  "canceled",
])

/** Dot tone per status — the same colour language as the board columns. */
function statusDotClass(status: string): string {
  switch (status) {
    case "running":
    case "queued":
    case "preparing":
      return "bg-primary"
    case "awaiting_input":
    case "review":
    case "merging":
      return "bg-amber-500"
    case "failed":
      return "bg-destructive"
    case "done":
      return "bg-emerald-500"
    default:
      return "bg-muted-foreground/50"
  }
}

/**
 * A `status_changed` event is a phase header — a coloured dot plus the status
 * name; every other event hangs off the rail beneath it. The two used to be
 * near-identical single lines, which is what made the log hard to scan: now
 * the header carries the colour and the weight, the rail groups what belongs
 * to it, and each entry's detail gets its own line instead of sharing a
 * baseline with the label and wrapping unpredictably.
 */
function TimelineRow({ event }: { event: WorkTaskEvent }) {
  const t = useTranslations("Tasks")
  if (event.kind === "status_changed") {
    return <TimelineStatusHeader event={event} />
  }
  const key =
    event.kind in EVENT_KIND_KEYS
      ? EVENT_KIND_KEYS[event.kind as keyof typeof EVENT_KIND_KEYS]
      : null
  // A task nobody clicked says where it came from: the repository panel's
  // auto-processing, and which trigger woke it.
  const rawAuto = event.kind === "created" ? event.payload?.auto : undefined
  const autoTrigger = typeof rawAuto === "string" ? rawAuto : null
  const label =
    autoTrigger != null ? t("eventCreatedAuto") : key ? t(key) : event.kind
  const detail =
    autoTrigger != null
      ? autoTrigger in AUTO_TRIGGER_KEYS
        ? t(AUTO_TRIGGER_KEYS[autoTrigger as keyof typeof AUTO_TRIGGER_KEYS])
        : autoTrigger
      : timelineDetail(event)
  return (
    // ml-[3px] puts the rail under the centre of the header's dot above, and
    // 3px + the 1px rail + pl-2.5 lands the text at the same 14px inset as the
    // header's label — the entry hangs off the rail without stepping right.
    <li className="ml-[3px] flex items-baseline gap-2 border-l border-border/70 py-1 pl-2.5">
      {/* Label and detail share one line (truncated, full text on hover) so
          the log scans as a column of events rather than a stack of
          two-line paragraphs. */}
      <p
        className="min-w-0 flex-1 truncate text-[0.6875rem] leading-tight"
        title={detail ? `${label} — ${detail}` : label}
      >
        <span className="font-medium">{label}</span>
        {detail ? (
          <span className="ml-1.5 text-muted-foreground">{detail}</span>
        ) : null}
      </p>
      <TimelineTime iso={event.created_at} />
    </li>
  )
}

function TimelineStatusHeader({ event }: { event: WorkTaskEvent }) {
  const t = useTranslations("Tasks")
  const p = event.payload
  const str = (k: string) =>
    p && typeof p[k] === "string" ? (p[k] as string) : null
  const to = str("to")
  const known = to != null && STATUS_KEYS.has(to)
  const label = known
    ? t(statusLabelKey(to as WorkTask["status"]))
    : (to ?? t("eventStatusChanged"))
  const note = str("error") ?? str("reason")
  return (
    <li className="flex flex-col gap-0.5 pb-1 pt-3 first:pt-0">
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            statusDotClass(known ? (to as string) : "")
          )}
        />
        <span className="min-w-0 flex-1 break-words text-xs font-semibold text-foreground">
          {label}
        </span>
        <TimelineTime iso={event.created_at} />
      </div>
      {note ? (
        <p className="min-w-0 break-words pl-3.5 text-[0.6875rem] leading-relaxed text-muted-foreground">
          {note}
        </p>
      ) : null}
    </li>
  )
}

/** Right-aligned, never wrapping — the log's time gutter. */
function TimelineTime({ iso }: { iso: string }) {
  return (
    <span className="ml-auto shrink-0 text-[0.625rem] tabular-nums text-muted-foreground/70">
      {formatEventTime(iso)}
    </span>
  )
}

/** Muted separator between the header's identity chips. */
function MetaDot() {
  return <span className="shrink-0 text-muted-foreground/40">·</span>
}

/** Human-readable one-liner for an event payload (best-effort, schema-loose). */
function timelineDetail(event: WorkTaskEvent): string | null {
  const p = event.payload
  if (!p) return null
  const str = (k: string) =>
    typeof p[k] === "string" ? (p[k] as string) : null
  switch (event.kind) {
    case "init_command": {
      const command = str("command")
      const exit =
        typeof p.exit_code === "number" ? `exit ${p.exit_code}` : null
      return [command, exit].filter(Boolean).join(" · ") || null
    }
    case "config_effective": {
      const agent = str("agent")
      const model = str("model")
      return [agent, model].filter(Boolean).join(" · ") || null
    }
    case "agent_progress":
      return str("message")
    case "agent_verdict":
      return (
        [str("verdict"), str("summary")].filter(Boolean).join(" · ") || null
      )
    case "merge_attempt":
      return str("strategy")
    case "merge_conflict": {
      const files = Array.isArray(p.files) ? (p.files as string[]) : []
      return files.join(", ") || null
    }
    case "preflight_result": {
      const status = str("status")
      const command = str("command")
      return [command, status].filter(Boolean).join(" · ") || null
    }
    case "cleanup_failed":
      return str("error")
    case "context_compact": {
      const status = str("status")
      const pct = (k: string) =>
        typeof p[k] === "number" ? `${(p[k] as number).toFixed(1)}%` : null
      const before = pct("before_percent")
      const after = pct("after_percent")
      // The pair is the whole story ("91.2% → 34.8%"); a run that never got
      // to compact shows why instead.
      const span =
        before && after ? `${before} → ${after}` : (before ?? str("reason"))
      return (
        [status, span, str("detail"), str("error")]
          .filter(Boolean)
          .join(" · ") || null
      )
    }
    case "user_action": {
      const action = str("action")
      const feedback = str("feedback")
      return [action, feedback].filter(Boolean).join(": ") || null
    }
    case "diff_stat": {
      const fc = p.files_changed
      const a = p.additions
      const d = p.deletions
      if (typeof fc === "number") return `${fc} files · +${a ?? 0} -${d ?? 0}`
      return null
    }
    case "forge_writeback":
      return str("url")
    case "forge_writeback_failed":
      return str("error")
    default:
      return null
  }
}
