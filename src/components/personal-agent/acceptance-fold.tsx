"use client"

/** A piece of work's acceptance, on its head in the conversation (A4): its
 *  check under way ("Being checked · round N"), or what it found — the
 *  verdict, the evidence a click away — and the way to the check's own
 *  session either way; for a round its assistant accepted on a pass, the
 *  board's next step as the board says it: [Merge…] or [Open on the board]
 *  to the task's details, where it is merged or delivered; queued to merge,
 *  said so. */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronRight } from "lucide-react"

import { useTaskDialogs } from "@/components/tasks/use-task-dialogs"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { usePersonalAgent } from "@/contexts/personal-agent-context"
import { useOptionalTasksView } from "@/contexts/tasks-view-context"
import type { DispatchInfo, TimelineRow } from "@/lib/types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"

import { asVerdict, CheckLabel, VerdictChip } from "./acceptance-bits"
import type { AcceptanceFold } from "./message-items"
import {
  canOpenWork,
  num,
  str,
  useOpenWork,
  usePageScope,
  workTargetOf,
} from "./shared"

/** The board's next step a button does, by how "today" words it. */
const GO: Record<string, "merge" | "board" | undefined> = {
  merge_ready: "merge",
  needs_delivery: "board",
}
/** The board's next step that is said, nothing to press. */
const SAID = new Set(["accepted_queued", "merge_queued", "needs_delivery"])

/** What the acceptance says on its work's head, between where the work
 *  stands and what came of it. `now` is the work as it stands (the latest
 *  news's), for the board's next step. */
export function AcceptanceFacts({
  fold,
  now,
}: {
  fold: AcceptanceFold
  now: DispatchInfo | null
}) {
  const t = useTranslations("PersonalAgent")
  const { dispatchById } = usePersonalAgent()
  const openWork = useOpenWork()
  const [open, setOpen] = useState(false)
  const { check, result, card } = fold
  const data = (r: TimelineRow | null) => r?.data ?? null
  // What the check found: its result — or, with its rows on another page,
  // the card it was accepted on, which says it too. Not a card of another
  // check than the one under way.
  const cardCheck = num(data(card), "check_dispatch_id")
  const found =
    result ??
    (card != null && (check == null || check.dispatch_id === cardCheck)
      ? card
      : null)
  const round =
    num(data(found), "check_round") ??
    num(data(found), "round") ??
    num(data(check), "check_round")
  const verdict = found ? asVerdict(found.data?.verdict) : null
  const evidence = str(data(found), "evidence")
  // The check's own session: while it runs and after.
  const checkId = check?.dispatch_id ?? result?.dispatch_id ?? cardCheck
  const info = checkId != null ? dispatchById.get(checkId) : undefined
  const target = workTargetOf(info, check ?? result ?? undefined)
  const session =
    checkId != null &&
    (info != null || check != null || result != null) &&
    canOpenWork(target)
      ? target
      : null
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-pa-acceptance-fold>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {found ? (
          <>
            <CheckLabel round={round} />
            <VerdictChip verdict={verdict} />
          </>
        ) : (
          <span
            className="text-xs text-muted-foreground"
            data-pa-acceptance-checking
          >
            {t("feed.checking", { round: round ?? 1 })}
          </span>
        )}
        {session ? (
          <Button
            size="xs"
            variant="ghost"
            className="text-muted-foreground"
            onClick={() => openWork(session)}
            data-pa-acceptance-session
          >
            {t("feed.viewCheck")}
          </Button>
        ) : null}
      </div>
      {found && evidence?.trim() ? (
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger
            className="group/evidence flex items-center gap-1 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:underline"
            data-pa-acceptance-evidence
          >
            <ChevronRight
              aria-hidden
              className="size-3.5 transition-transform group-data-[state=open]/evidence:rotate-90 rtl:-scale-x-100"
            />
            {t("event.acceptanceEvidence")}
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-1 text-xs leading-5 break-words whitespace-pre-line text-muted-foreground">
            {evidence.trim()}
          </CollapsibleContent>
        </Collapsible>
      ) : null}
      {card != null && now != null ? <BoardNext now={now} /> : null}
    </div>
  )
}

/** The board's next step for accepted work, as the board says it. Drawn as
 *  long as the head is — not only while there is a button — so the task's
 *  details it opens stay open when the work moves on under them (a merge
 *  begun says "merging" before its launch answers). */
function BoardNext({ now }: { now: DispatchInfo }) {
  const view = useOptionalTasksView()
  const { readOnly } = usePageScope()
  const openWork = useOpenWork()
  const raw = now.task?.next ?? null
  const next = raw != null && (SAID.has(raw) || GO[raw]) ? raw : null
  const taskId = now.task?.task_id ?? now.work_task_id
  if (taskId == null) return null
  // With the board here, its details are held whatever the next step is
  // now: a merge begun does not close them under the owner.
  if (view && !readOnly) {
    return <BoardNextWithTasks next={next} taskId={taskId} />
  }
  if (next == null) return null
  // No board on the page: the work in the drawer, which opens its task.
  const target = workTargetOf(now)
  const press = !readOnly && canOpenWork(target) ? () => openWork(target) : null
  return <BoardNextLine next={next} press={press} />
}

function BoardNextWithTasks({
  next,
  taskId,
}: {
  next: string | null
  taskId: number
}) {
  const view = useOptionalTasksView()!
  const allFolders = useAppWorkspaceStore((s) => s.allFolders)
  const folderNames = useMemo(() => {
    const map = new Map<number, string>()
    for (const f of allFolders) map.set(f.id, f.alias ?? f.name)
    return map
  }, [allFolders])
  const { openDetail, dialogs } = useTaskDialogs({
    tasks: view.tasks,
    refetch: view.refetch,
    folderNames,
    defaultFolderId: null,
  })
  return (
    <>
      {next != null ? (
        <BoardNextLine next={next} press={() => openDetail(taskId)} />
      ) : null}
      {dialogs}
    </>
  )
}

/** What the board's next step is, and its button (`press` `null`: none —
 *  read-only). */
function BoardNextLine({
  next,
  press,
}: {
  next: string
  press: (() => void) | null
}) {
  const t = useTranslations("PersonalAgent.today")
  const kind = GO[next]
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-2"
      data-pa-acceptance-next={next}
    >
      {SAID.has(next) ? (
        <span className="text-xs text-muted-foreground">
          {t(`reason.${next}` as "reason.merge_ready")}
        </span>
      ) : null}
      {kind && press ? (
        <Button size="sm" onClick={press} data-pa-acceptance-go={kind}>
          {t(`go.${kind}` as "go.merge")}
        </Button>
      ) : null}
    </div>
  )
}
