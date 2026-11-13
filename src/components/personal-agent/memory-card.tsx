"use client"

/**
 * What a turn changed in an assistant's memory (7.7) — the owner's profile,
 * the index, its entries, its persona and its rules — as codeg read it off
 * the turn's commit: the files, the diff when asked for, and [Undo], which
 * takes that change back. A file changed again since is left as it is, and
 * the card says so.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Brain } from "lucide-react"

import { CompactDiff } from "@/components/diff/compact-diff"
import { Button } from "@/components/ui/button"
import { SyncedSpinner } from "@/components/ui/synced-spinner"
import { useBotId } from "@/contexts/personal-agent-context"
import { personalAgentNoticeAct } from "@/lib/api"
import type { MemoryFileChange } from "@/lib/types"
import { cn } from "@/lib/utils"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

import type { MessageItem } from "./message-items"
import { bubbleCorners, MessageRow } from "./message-row"
import { AGENT_SURFACE, str, usePageScope } from "./shared"

type NoticeItem = Extract<MessageItem, { kind: "notice" }>

const KINDS = new Set(["entry", "index", "user", "soul", "rules"])
const STATUSES = new Set(["added", "modified", "deleted"])

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

export function MemoryCard({ item }: { item: NoticeItem }) {
  const t = useTranslations("PersonalAgent.memory")
  const tn = useTranslations("PersonalAgent.notice")
  const { readOnly } = usePageScope()
  const botId = useBotId()
  const openSettings = usePersonalAgentUi((s) => s.openSettings)
  const label = useMemoryFileLabel()
  const row = item.row
  const data = row.data
  const state = str(data, "state") ?? "acted"
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
  const shown = files.filter((f) => f.kind !== "index" || entries.length === 0)
  const undo = async () => {
    const id = Number(row.ref_id)
    if (!Number.isFinite(id) || busy) return
    setBusy(true)
    setFailed(null)
    try {
      await personalAgentNoticeAct(id, "undo", botId)
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
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
      <div
        data-bubble
        data-pa-memory-card={state}
        className={cn(
          AGENT_SURFACE,
          bubbleCorners("start", item.tail),
          "flex min-w-0 flex-col gap-2 p-3 text-sm text-foreground"
        )}
      >
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Brain className="size-3.5 shrink-0" aria-hidden />
          <span className="font-medium">
            {state === "undone" ? t("undoneTitle") : t("title")}
          </span>
        </p>
        <p className="text-sm break-words">{summary.join(t("sep"))}</p>
        <ul className="flex flex-col gap-0.5" data-pa-memory-files>
          {shown.map((f) => (
            <li
              key={f.path}
              className="flex min-w-0 items-baseline gap-1.5 text-xs leading-5"
              data-pa-memory-file={f.path}
            >
              <span className="shrink-0 text-muted-foreground">
                {t(`status.${f.status}` as "status.added")}
              </span>
              {f.status !== "deleted" && state !== "undone" ? (
                <button
                  type="button"
                  className="min-w-0 truncate text-start font-medium underline-offset-2 hover:underline"
                  title={f.path}
                  onClick={() => openSettings("persona", null, f.path)}
                >
                  {label(f)}
                </button>
              ) : (
                <span className="min-w-0 truncate font-medium" title={f.path}>
                  {label(f)}
                </span>
              )}
            </li>
          ))}
        </ul>
        {state === "undone" && keptNames.length > 0 ? (
          <p className="text-xs text-muted-foreground" data-pa-memory-kept>
            {t("kept", { files: keptNames.join(t("listSep")) })}
          </p>
        ) : null}
        {showDiff ? (
          <div
            className="overflow-hidden rounded-md border border-border/70 bg-background/60"
            data-pa-memory-diff
          >
            <CompactDiff diffText={diff} />
            {cut ? (
              <p className="border-t border-border/50 px-2 py-1 text-[0.6875rem] text-muted-foreground">
                {t("diffCut")}
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={showDiff}
            onClick={() => setShowDiff((v) => !v)}
          >
            {showDiff ? t("hideDiff") : t("showDiff")}
          </Button>
          {state === "acted" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={readOnly || busy}
              onClick={() => void undo()}
            >
              {busy ? <SyncedSpinner small className="size-3.5" /> : null}
              {t("undo")}
            </Button>
          ) : null}
        </div>
        {failed ? (
          <p role="alert" className="text-xs break-words text-destructive">
            {tn("failed", { error: failed })}
          </p>
        ) : null}
      </div>
    </MessageRow>
  )
}
