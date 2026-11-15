"use client"

/**
 * A process skill an assistant wrote down (7.8): "I made 'Release' a process
 * skill — next time you ask for it I follow it", when it is for, the skill
 * itself and the change when asked for — with [View] (in its settings),
 * [Turn off] / [Turn on], [Delete] and [Undo]. A change to one is the same
 * card; kept as a draft, it is [Install] or [Not this one].
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Workflow } from "lucide-react"

import { CompactDiff } from "@/components/diff/compact-diff"
import { Button } from "@/components/ui/button"
import { SyncedSpinner } from "@/components/ui/synced-spinner"
import { useBotId } from "@/contexts/personal-agent-context"
import { personalAgentNoticeAct } from "@/lib/api"
import { cn } from "@/lib/utils"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

import type { MessageItem } from "./message-items"
import { bubbleCorners, MessageRow } from "./message-row"
import { AGENT_SURFACE, str, usePageScope } from "./shared"

type NoticeItem = Extract<MessageItem, { kind: "notice" }>

/** How a skill's card can stand, and those that say a word more. */
const STATES = new Set([
  "acted",
  "draft",
  "applied",
  "undone",
  "discarded",
  "stale",
  "deleted",
])
const NOTES = new Set([
  "draft",
  "applied",
  "undone",
  "discarded",
  "stale",
  "deleted",
])

type Act = "undo" | "apply" | "dismiss" | "disable" | "enable" | "delete"

export function SkillCard({ item }: { item: NoticeItem }) {
  const t = useTranslations("PersonalAgent.skill")
  const tm = useTranslations("PersonalAgent.memory")
  const tn = useTranslations("PersonalAgent.notice")
  const { readOnly } = usePageScope()
  const botId = useBotId()
  const openBotPage = usePersonalAgentUi((s) => s.openBotPage)
  const row = item.row
  const data = row.data
  const raw = str(data, "state") ?? "acted"
  const state = STATES.has(raw) ? raw : "acted"
  const status = str(data, "status") ?? "added"
  const title = str(data, "title") || str(data, "name") || ""
  const description = str(data, "description") ?? ""
  const path = str(data, "path") ?? ""
  const content = str(data, "content") ?? ""
  const diff = str(data, "diff") ?? ""
  const off = data?.off === true
  const [shown, setShown] = useState<"content" | "diff" | null>(null)
  const [busy, setBusy] = useState<Act | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const act = async (action: Act) => {
    const id = Number(row.ref_id)
    if (!Number.isFinite(id) || busy) return
    setBusy(action)
    setFailed(null)
    try {
      await personalAgentNoticeAct(id, action, botId)
      setConfirming(false)
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }
  const draft = state === "draft"
  const line = draft
    ? t("line.draft", { title })
    : status === "deleted"
      ? t("line.removed", { title })
      : status === "added"
        ? t("line.learned", { title })
        : t("line.changed", { title })
  // In effect now: installed, or its change taken in.
  const standing = state === "acted" || state === "applied"
  const spinner = (a: Act) =>
    busy === a ? <SyncedSpinner small className="size-3.5" /> : null
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
        data-pa-skill-card={state}
        data-pa-skill-off={off ? "" : undefined}
        className={cn(
          AGENT_SURFACE,
          bubbleCorners("start", item.tail),
          "flex min-w-0 flex-col gap-2 p-3 text-sm text-foreground"
        )}
      >
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Workflow className="size-3.5 shrink-0" aria-hidden />
          <span className="font-medium">
            {t(
              `heading.${draft ? "draft" : status === "added" ? "added" : status === "deleted" ? "deleted" : "modified"}` as "heading.added"
            )}
          </span>
        </p>
        <p className="text-sm break-words" data-pa-skill-line>
          {line}
        </p>
        {description ? (
          <p className="text-xs break-words text-muted-foreground">
            {t("when", { text: description })}
          </p>
        ) : null}
        {str(data, "not_aside") ? (
          <p className="text-xs text-muted-foreground" data-pa-skill-not-aside>
            {t(off ? "note.notAside" : "note.notAsideOn", {
              why: str(data, "not_aside") ?? "",
            })}
          </p>
        ) : null}
        {off && standing ? (
          <p className="text-xs text-muted-foreground" data-pa-skill-note="off">
            {t("note.off")}
          </p>
        ) : null}
        {NOTES.has(state) ? (
          <p
            className="text-xs text-muted-foreground"
            data-pa-skill-note={state}
          >
            {t(`note.${state}` as "note.draft")}
          </p>
        ) : null}
        {shown === "content" && content ? (
          <pre
            className="field-scrollbar max-h-72 overflow-auto rounded-md border border-border/70 bg-background/60 p-2 font-mono text-[0.6875rem] leading-relaxed whitespace-pre-wrap"
            data-pa-skill-content
          >
            {content}
          </pre>
        ) : null}
        {shown === "diff" ? (
          <div
            className="overflow-hidden rounded-md border border-border/70 bg-background/60"
            data-pa-skill-diff
          >
            <CompactDiff diffText={diff} />
            {data?.diff_cut === true ? (
              <p className="border-t border-border/50 px-2 py-1 text-[0.6875rem] text-muted-foreground">
                {tm("diffCut")}
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          {content ? (
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={shown === "content"}
              onClick={() =>
                setShown((v) => (v === "content" ? null : "content"))
              }
            >
              {shown === "content" ? t("hide") : t("show")}
            </Button>
          ) : null}
          {diff && status !== "added" ? (
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={shown === "diff"}
              onClick={() => setShown((v) => (v === "diff" ? null : "diff"))}
            >
              {shown === "diff" ? tm("hideDiff") : tm("showDiff")}
            </Button>
          ) : null}
          {standing && status !== "deleted" && path ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => openBotPage("persona", { entry: path })}
              data-pa-skill-act="view"
            >
              {t("view")}
            </Button>
          ) : null}
          {standing && status !== "deleted" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={readOnly || busy != null}
              onClick={() => void act(off ? "enable" : "disable")}
              data-pa-skill-act={off ? "enable" : "disable"}
            >
              {spinner(off ? "enable" : "disable")}
              {off ? t("enable") : t("disable")}
            </Button>
          ) : null}
          {standing ? (
            <Button
              size="sm"
              variant="outline"
              disabled={readOnly || busy != null}
              onClick={() => void act("undo")}
              data-pa-skill-act="undo"
            >
              {spinner("undo")}
              {t("undo")}
            </Button>
          ) : null}
          {standing && status !== "deleted" ? (
            confirming ? (
              <>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={readOnly || busy != null}
                  onClick={() => void act("delete")}
                  data-pa-skill-act="delete"
                >
                  {spinner("delete")}
                  {t("confirmDelete")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy != null}
                  onClick={() => setConfirming(false)}
                >
                  {t("cancel")}
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground hover:text-destructive"
                disabled={readOnly || busy != null}
                onClick={() => setConfirming(true)}
                data-pa-skill-act="ask-delete"
              >
                {t("delete")}
              </Button>
            )
          ) : null}
          {draft ? (
            <>
              <Button
                size="sm"
                disabled={readOnly || busy != null}
                onClick={() => void act("apply")}
                data-pa-skill-act="apply"
              >
                {spinner("apply")}
                {t("install")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={readOnly || busy != null}
                onClick={() => void act("dismiss")}
                data-pa-skill-act="dismiss"
              >
                {t("dismiss")}
              </Button>
            </>
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
