"use client"

/**
 * What a turn changed in an assistant's memory (7.7) — the owner's profile,
 * the index, its entries, its persona and its rules — as codeg read it off
 * the turn's commit: the files, the diff when asked for, and [Undo], which
 * takes that change back. A file changed again since is left as it is, and
 * the card says so.
 *
 * The nightly tidy-up's card is the same (`notice: "tidy"`): what it merged,
 * changed and removed as one commit, [Undo all] taking it back as a whole —
 * or, kept as a draft, [Apply] and [Not this one]; a draft the memory moved
 * past since is stale, and the next night tidies again.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Brain, ChevronDown, ChevronUp, Sparkles } from "lucide-react"

import { CompactDiff } from "@/components/diff/compact-diff"
import { Button } from "@/components/ui/button"
import { SyncedSpinner } from "@/components/ui/synced-spinner"
import { useBotId } from "@/contexts/personal-agent-context"
import { personalAgentNoticeAct } from "@/lib/api"
import type { MemoryFileChange } from "@/lib/types"
import { cn } from "@/lib/utils"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

import type { MessageItem } from "./message-items"
import { MessageRow } from "./message-row"
import {
  OutcomeLine,
  ToneChip,
  type ChipTone,
  type OutcomeTone,
} from "./outcome-line"
import {
  CardMessage,
  SHEET_TITLE,
  SheetActions,
  SheetNote,
  SheetPart,
  str,
  usePageScope,
} from "./shared"

type NoticeItem = Extract<MessageItem, { kind: "notice" }>

const KINDS = new Set(["entry", "index", "user", "soul", "rules"])
const STATUSES = new Set(["added", "modified", "deleted"])
/** How a tidy-up's card can stand (7.7), and those that say a word more. */
const TIDY_STATES = new Set([
  "acted",
  "draft",
  "applied",
  "undone",
  "discarded",
  "stale",
])
const TIDY_NOTES = new Set(["draft", "applied", "discarded", "stale"])
/** A tidy-up's note on its tone: a draft a word, applied through, not used
 *  let be, out of date a caution. */
const TIDY_TONE: Record<string, OutcomeTone> = {
  draft: "info",
  applied: "done",
  discarded: "off",
  stale: "warn",
}
/** How a file changed, on its tone. */
const STATUS_TONE: Record<MemoryFileChange["status"], ChipTone> = {
  added: "emerald",
  modified: "sky",
  deleted: "red",
}

export function memoryFilesOf(v: unknown): MemoryFileChange[] {
  return Array.isArray(v)
    ? v.filter(
        (f): f is MemoryFileChange =>
          f != null &&
          typeof f === "object" &&
          typeof (f as MemoryFileChange).path === "string" &&
          KINDS.has((f as MemoryFileChange).kind) &&
          STATUSES.has((f as MemoryFileChange).status)
      )
    : []
}

/** What the card calls a file: an entry by its title, the others by what
 *  they are. */
export function useMemoryFileLabel(): (f: MemoryFileChange) => string {
  const t = useTranslations("PersonalAgent.memory")
  return (f) =>
    f.kind === "entry" ? f.title || f.path : t(`file.${f.kind}` as "file.soul")
}

/** What a change did, said in parts: "2 new · 1 updated · rules changed". */
export function useMemorySummary(): (files: MemoryFileChange[]) => string[] {
  const t = useTranslations("PersonalAgent.memory")
  const label = useMemoryFileLabel()
  return (files) => {
    const entries = files.filter((f) => f.kind === "entry")
    const count = (status: MemoryFileChange["status"]) =>
      entries.filter((f) => f.status === status).length
    const summary = [
      count("added") > 0 ? t("added", { count: count("added") }) : null,
      count("modified") > 0 ? t("updated", { count: count("modified") }) : null,
      count("deleted") > 0 ? t("removed", { count: count("deleted") }) : null,
      ...files
        .filter(
          (f) => f.kind === "user" || f.kind === "soul" || f.kind === "rules"
        )
        .map((f) => t("changedFile", { file: label(f) })),
    ].filter((p): p is string => p != null)
    // The index alone (no entry with it) is a change of its own.
    if (summary.length === 0 && files.length > 0) {
      summary.push(t("changedFile", { file: t("file.index") }))
    }
    return summary
  }
}

export function MemoryCard({ item }: { item: NoticeItem }) {
  const t = useTranslations("PersonalAgent.memory")
  const tt = useTranslations("PersonalAgent.tidy")
  const tn = useTranslations("PersonalAgent.notice")
  const { readOnly } = usePageScope()
  const botId = useBotId()
  const openBotPage = usePersonalAgentUi((s) => s.openBotPage)
  const label = useMemoryFileLabel()
  const row = item.row
  const data = row.data
  const state = str(data, "state") ?? "acted"
  // The nightly tidy-up (7.7): one commit, taken back as a whole.
  const tidy = str(data, "notice") === "tidy"
  const day = str(data, "day") ?? ""
  const files = memoryFilesOf(data?.files)
  const kept = Array.isArray(data?.kept)
    ? (data.kept as unknown[]).filter((k): k is string => typeof k === "string")
    : []
  const diff = str(data, "diff") ?? ""
  const cut = data?.diff_cut === true
  const [showDiff, setShowDiff] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const entries = files.filter((f) => f.kind === "entry")
  const summary = useMemorySummary()(files)
  const shown = files.filter((f) => f.kind !== "index" || entries.length === 0)
  const act = async (action: "undo" | "apply" | "dismiss") => {
    const id = Number(row.ref_id)
    if (!Number.isFinite(id) || busy) return
    setBusy(true)
    setFailed(null)
    try {
      await personalAgentNoticeAct(id, action, botId)
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const undoable = state === "acted" || (tidy && state === "applied")
  const title = tidy
    ? tt(`title.${TIDY_STATES.has(state) ? state : "acted"}` as "title.acted", {
        day,
      })
    : state === "undone"
      ? t("undoneTitle")
      : t("title")
  const keptNames = kept.map((p) => {
    const f = files.find((x) => x.path === p)
    return f ? label(f) : p
  })
  return (
    <MessageRow
      rowId={row.id}
      side="start"
      gap={item.gap}
      tail={item.tail}
      roomy
      actions={{ rowId: row.id, text: row.body || null, at: row.created_at }}
    >
      <CardMessage
        data-pa-memory-card={tidy ? undefined : state}
        data-pa-tidy-card={tidy ? state : undefined}
        head={
          <>
            {tidy ? <Sparkles aria-hidden /> : <Brain aria-hidden />}
            <span className="font-medium">{title}</span>
          </>
        }
      >
        {/* What changed, and what came of it. */}
        <SheetPart className="flex flex-col gap-1.5">
          <p className={SHEET_TITLE}>{summary.join(t("sep"))}</p>
          {state === "undone" && keptNames.length > 0 ? (
            <OutcomeLine tone="warn" data-pa-memory-kept>
              {t("kept", { files: keptNames.join(t("listSep")) })}
            </OutcomeLine>
          ) : null}
          {tidy && TIDY_NOTES.has(state) ? (
            <OutcomeLine tone={TIDY_TONE[state] ?? "info"} data-pa-tidy-note>
              {tt(`note.${state}` as "note.draft")}
            </OutcomeLine>
          ) : null}
          {tidy && str(data, "not_aside") ? (
            <OutcomeLine tone="warn" data-pa-tidy-not-aside>
              {tt("note.notAside", { why: str(data, "not_aside") ?? "" })}
            </OutcomeLine>
          ) : null}
        </SheetPart>
        {/* File by file: how it changed — on its tone — and which. */}
        {shown.length > 0 ? (
          <SheetPart>
            <ul className="flex flex-col gap-1.5" data-pa-memory-files>
              {shown.map((f) => (
                <li
                  key={f.path}
                  className="flex min-w-0 items-center gap-2 text-xs leading-5"
                  data-pa-memory-file={f.path}
                >
                  <ToneChip tone={STATUS_TONE[f.status]}>
                    {t(`status.${f.status}` as "status.added")}
                  </ToneChip>
                  {f.status !== "deleted" &&
                  state !== "undone" &&
                  (!tidy || state === "acted" || state === "applied") ? (
                    <button
                      type="button"
                      className="min-w-0 truncate rounded-sm text-start font-medium underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      title={f.path}
                      onClick={() => openBotPage("persona", { entry: f.path })}
                    >
                      {label(f)}
                    </button>
                  ) : (
                    <span
                      className={cn(
                        "min-w-0 truncate font-medium",
                        f.status === "deleted" &&
                          "text-muted-foreground line-through decoration-muted-foreground/50"
                      )}
                      title={f.path}
                    >
                      {label(f)}
                    </span>
                  )}
                  {f.kind === "entry" && f.title && f.title !== f.path ? (
                    <span
                      className="min-w-0 shrink truncate font-mono text-[0.6875rem] text-muted-foreground"
                      dir="ltr"
                    >
                      {f.path}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </SheetPart>
        ) : null}
        {/* The diff, the width of the card. */}
        {showDiff ? (
          <div className="min-w-0" data-pa-memory-diff>
            <CompactDiff diffText={diff} />
            {cut ? (
              <p className="border-t border-border/50 px-3.5 py-1.5 text-[0.6875rem] text-muted-foreground">
                {t("diffCut")}
              </p>
            ) : null}
          </div>
        ) : null}
        <SheetActions>
          {tidy && state === "draft" ? (
            <>
              <Button
                size="sm"
                disabled={readOnly || busy}
                onClick={() => void act("apply")}
                data-pa-tidy-act="apply"
              >
                {busy ? <SyncedSpinner small className="size-3.5" /> : null}
                {tt("apply")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={readOnly || busy}
                onClick={() => void act("dismiss")}
                data-pa-tidy-act="dismiss"
              >
                {tt("dismiss")}
              </Button>
            </>
          ) : null}
          {undoable ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={readOnly || busy}
              onClick={() => void act("undo")}
              data-pa-tidy-act={tidy ? "undo" : undefined}
            >
              {busy ? <SyncedSpinner small className="size-3.5" /> : null}
              {tidy ? tt("undoAll") : t("undo")}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={showDiff}
            onClick={() => setShowDiff((v) => !v)}
          >
            {showDiff ? <ChevronUp aria-hidden /> : <ChevronDown aria-hidden />}
            {showDiff ? t("hideDiff") : t("showDiff")}
          </Button>
        </SheetActions>
        {failed ? (
          <SheetNote>
            <p role="alert" className="break-words text-destructive">
              {tn("failed", { error: failed })}
            </p>
          </SheetNote>
        ) : null}
      </CardMessage>
    </MessageRow>
  )
}
