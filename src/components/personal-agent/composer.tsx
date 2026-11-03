"use client"

/**
 * The personal agent's input box. Everything sent here is queued on the
 * timeline first and delivered by the engine: right away when the agent is
 * idle, with the next delivery when it is busy. While a reply runs, a message
 * can instead be folded into that turn (the live-feedback channel). Beside it:
 * stop, compact, new session, and the brain the agent runs on.
 */

import { useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ArrowUp,
  CornerDownRight,
  Loader2,
  RotateCcw,
  Shrink,
  Square,
} from "lucide-react"
import { toast } from "sonner"

import { AgentIcon } from "@/components/agent-icon"
import {
  TaskMessageComposer,
  type TaskMessageComposerHandle,
} from "@/components/tasks/task-message-composer"
import { Button } from "@/components/ui/button"
import { useShortcutSettings } from "@/hooks/use-shortcut-settings"
import {
  personalAgentCancel,
  personalAgentCompact,
  personalAgentNewSession,
  personalAgentSend,
  personalAgentSupplement,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type { PersonalAgentInfo, PersonalAgentStatus } from "@/lib/types"
import { cn } from "@/lib/utils"

interface ComposerProps {
  agent: PersonalAgentInfo
  status: PersonalAgentStatus
  onOpenBrain: () => void
}

export function PersonalAgentComposer({
  agent,
  status,
  onOpenBrain,
}: ComposerProps) {
  const t = useTranslations("PersonalAgent.composer")
  const { shortcuts } = useShortcutSettings()
  const composer = useRef<TaskMessageComposerHandle | null>(null)
  const [text, setText] = useState("")
  const [attachments, setAttachments] = useState(0)
  const [sending, setSending] = useState(false)
  const [acting, setActing] = useState(false)
  const readOnly = status.engine !== "here"
  const turn = status.turn
  const compacting = turn?.kind === "compaction"
  const replying = turn?.kind === "delivery"
  const model = agent.label_snapshot.options.find(
    (o) => o.id === "model"
  )?.value_label

  const canSend =
    !readOnly && !sending && (text.trim().length > 0 || attachments > 0)

  const send = async () => {
    if (!canSend || !composer.current) return
    if (composer.current.hasUploadingImage()) {
      toast.message(t("waitForUpload"))
      return
    }
    const body = composer.current.getText()
    const blocks = composer.current.getAttachmentBlocks()
    setSending(true)
    try {
      await personalAgentSend(body, blocks)
      composer.current.clear()
      setText("")
    } catch (e) {
      toast.error(toErrorMessage(e))
    } finally {
      setSending(false)
    }
  }

  const supplement = async () => {
    if (!composer.current) return
    const body = composer.current.getText().trim()
    if (!body) return
    setSending(true)
    try {
      const result = await personalAgentSupplement(body)
      composer.current.clear()
      setText("")
      toast.message(result.steered ? t("supplemented") : t("queuedInstead"))
    } catch (e) {
      toast.error(toErrorMessage(e))
    } finally {
      setSending(false)
    }
  }

  const act = async (fn: () => Promise<void>, done?: string) => {
    setActing(true)
    try {
      await fn()
      if (done) toast.message(done)
    } catch (e) {
      toast.error(toErrorMessage(e))
    } finally {
      setActing(false)
    }
  }

  return (
    <div className="border-t border-border/60 px-4 pt-2 pb-4">
      <div className="mx-auto w-full max-w-[48rem]">
        <div className="mb-1.5 flex min-h-6 items-center gap-2 text-xs text-muted-foreground">
          <button
            type="button"
            className="inline-flex min-w-0 items-center gap-1.5 rounded-full px-1.5 py-0.5 hover:bg-muted disabled:opacity-60"
            onClick={onOpenBrain}
            disabled={readOnly}
            title={t("brain")}
          >
            <AgentIcon agentType={agent.agent_type} className="size-3.5" />
            <span className="truncate">
              {agent.label_snapshot.agent}
              {model ? ` · ${model}` : ""}
            </span>
          </button>
          {compacting ? (
            <span className="inline-flex items-center gap-1">
              <Loader2 className="size-3 animate-spin" aria-hidden />
              {t("compacting")}
            </span>
          ) : replying ? (
            <span className="inline-flex items-center gap-1">
              <Loader2 className="size-3 animate-spin" aria-hidden />
              {t("replying")}
            </span>
          ) : null}
          {status.queued_messages > 0 ? (
            <span>{t("queuedCount", { count: status.queued_messages })}</span>
          ) : null}
          <span className="ml-auto flex items-center gap-1">
            {turn ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-2 text-xs"
                disabled={readOnly || acting}
                onClick={() => void act(personalAgentCancel)}
              >
                <Square className="size-3" aria-hidden />
                {compacting ? t("cancelCompaction") : t("stop")}
              </Button>
            ) : (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 px-2 text-xs"
                  disabled={readOnly || acting || !status.segment}
                  title={t("compactHint")}
                  onClick={() => void act(personalAgentCompact)}
                >
                  <Shrink className="size-3" aria-hidden />
                  {t("compact")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 px-2 text-xs"
                  disabled={readOnly || acting || !status.segment}
                  title={t("newSessionHint")}
                  onClick={() =>
                    void act(personalAgentNewSession, t("newSessionQueued"))
                  }
                >
                  <RotateCcw className="size-3" aria-hidden />
                  {t("newSession")}
                </Button>
              </>
            )}
          </span>
        </div>
        <div
          className={cn(
            "rounded-2xl border border-border bg-background shadow-xs",
            readOnly && "opacity-60"
          )}
        >
          <TaskMessageComposer
            ref={composer}
            agentType={agent.agent_type}
            folderPath={agent.workdir}
            defaultText=""
            placeholder={
              readOnly
                ? t("readOnly")
                : turn
                  ? t("placeholderBusy")
                  : t("placeholder")
            }
            ariaLabel={t("ariaLabel")}
            submitShortcut={shortcuts.send_message}
            newlineShortcut={shortcuts.newline_in_message}
            onChange={setText}
            onSubmit={() => void send()}
            onAttachmentsChange={setAttachments}
            editorClassName="max-h-60 min-h-16 px-3.5 pt-3 text-sm"
            bottomBarExtra={
              <div className="ml-auto flex items-center gap-1.5">
                {replying ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1 px-2 text-xs"
                    disabled={readOnly || sending || text.trim().length === 0}
                    title={t("supplementHint")}
                    onClick={() => void supplement()}
                  >
                    <CornerDownRight className="size-3.5" aria-hidden />
                    {t("supplement")}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  size="icon"
                  className="size-7 rounded-full"
                  disabled={!canSend}
                  title={turn ? t("queue") : t("send")}
                  aria-label={turn ? t("queue") : t("send")}
                  onClick={() => void send()}
                >
                  {sending ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <ArrowUp className="size-3.5" />
                  )}
                </Button>
              </div>
            }
          />
        </div>
      </div>
    </div>
  )
}
