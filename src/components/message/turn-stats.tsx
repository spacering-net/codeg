"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowUpToLine,
  BrainCog,
  CheckIcon,
  Coins,
  CopyIcon,
  ListTodo,
  Split,
} from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useMessageScroll } from "@/components/message/message-scroll-context"
import { useModelLabel } from "@/components/message/model-label-context"
import { useCreateTaskFromMessage } from "./use-create-task-from-message"
import { formatTokenCount } from "@/lib/token-format"
import { cn, copyTextToClipboard } from "@/lib/utils"
import type { TurnUsage } from "@/lib/types"

interface TurnStatsProps {
  usage?: TurnUsage | null
  duration_ms?: number | null
  model?: string | null
  models?: string[]
  previousUserIndex?: number | null
  isResponseComplete?: boolean
  copyText?: string
  /** ISO timestamp marking when the assistant reply finished. */
  completedAt?: string | null
  /** Fork the session at THIS reply. Undefined hides the affordance — the
   * session has no live connection, the agent has no `session/fork`, or this
   * surface doesn't own the conversation. */
  onForkFromHere?: () => void
  /** Forking is possible here but not right now. The button stays in place,
   * greyed out, and says why on hover — it used to vanish for the length of
   * every reply, which moved the whole icon row. */
  forkDisabled?: boolean
  /** Why it is greyed out: a turn is in flight (`busy`), or this reply has no
   * name the backend can resolve yet (`unnamed` — the post-turn reparse fills
   * it in a moment later). Only read while `forkDisabled`. */
  forkDisabledReason?: "busy" | "unnamed"
}

const iconButtonClass =
  "inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"

export function TurnStats({
  usage,
  duration_ms,
  model,
  models,
  previousUserIndex,
  isResponseComplete = true,
  copyText = "",
  completedAt,
  onForkFromHere,
  forkDisabled = false,
  forkDisabledReason = "busy",
}: TurnStatsProps) {
  const locale = useLocale()
  const t = useTranslations("Folder.chat.messageList")
  const tTasks = useTranslations("Tasks")
  const scroll = useMessageScroll()
  const modelLabel = useModelLabel()
  const [isCopied, setIsCopied] = useState(false)
  const timeoutRef = useRef<number>(0)
  const shortTimeFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        hour: "2-digit",
        minute: "2-digit",
      }),
    [locale]
  )
  const fullTimeFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "medium",
      }),
    [locale]
  )

  const completedAtDate = useMemo(() => {
    if (!isResponseComplete) return null
    if (!completedAt) return null
    const ms = new Date(completedAt).getTime()
    if (Number.isNaN(ms)) return null
    return new Date(ms)
  }, [completedAt, isResponseComplete])
  const completedLabel = completedAtDate
    ? shortTimeFormatter.format(completedAtDate)
    : null
  const completedTooltip = completedAtDate
    ? fullTimeFormatter.format(completedAtDate)
    : null

  // The transcript records whatever id the agent's backend used, which for some
  // agents is an account-internal key (qoder writes `qfmodel` for the model its
  // own picker calls `Qwen3.8-Flash`). Show the picker's name so this row and
  // the composer's selector can't disagree; unknown ids pass through unchanged.
  const displayModels = (models?.length ? models : model ? [model] : []).map(
    (id) => modelLabel(id) ?? id
  )
  const hasCopy = copyText.trim().length > 0
  const hasUsage = Boolean(usage)
  // An all-zero usage means "nobody said", not "nothing was spent": a reply
  // that exists cannot have cost zero tokens. Qoder zeroes every counter for
  // its own hosted models (see `QODER_EXPOSE_TOKEN_USAGE` in the registry), and
  // a confident "Input 0" reads as a broken counter rather than as absent data.
  // Same judgement the composer's context popover makes about cache rows.
  //
  // Deliberately NOT folded into `hasUsage`: that one gates `hasJump`, where a
  // reply IS substantial whether or not its counters survived.
  const hasTokenCounts =
    usage != null &&
    usage.input_tokens +
      usage.output_tokens +
      usage.cache_creation_input_tokens +
      usage.cache_read_input_tokens >
      0
  // The duration itself is shown by the reply's fold header
  // (`CompletedTurnContent`), not here — this row only uses it as a signal that
  // the turn was substantial.
  const hasDuration = typeof duration_ms === "number" && duration_ms > 0
  const hasCompletedAt = Boolean(completedLabel)
  // Usage OR duration: some agents (Cursor) never report per-turn token
  // usage, but a turn that took real time is still a substantial reply
  // worth jumping back from.
  const hasJump =
    isResponseComplete &&
    (hasUsage || hasDuration) &&
    typeof previousUserIndex === "number" &&
    Boolean(scroll?.scrollToIndex)

  const handleJump = useCallback(() => {
    if (typeof previousUserIndex !== "number") return
    scroll?.scrollToIndex(previousUserIndex, { align: "start", smooth: true })
  }, [previousUserIndex, scroll])

  const getTaskText = useCallback(() => copyText ?? "", [copyText])
  const handleCreateTask = useCreateTaskFromMessage(getTaskText)

  const handleCopy = useCallback(async () => {
    if (isCopied || !hasCopy) return
    window.clearTimeout(timeoutRef.current)
    const ok = await copyTextToClipboard(copyText)
    if (!ok) return
    setIsCopied(true)
    timeoutRef.current = window.setTimeout(() => setIsCopied(false), 2000)
  }, [copyText, hasCopy, isCopied])

  useEffect(
    () => () => {
      window.clearTimeout(timeoutRef.current)
    },
    []
  )

  if (!isResponseComplete) return null
  // Deliberately not gated on `hasDuration`: nothing in this row renders a
  // duration any more, so a turn carrying only one would open an empty row.
  if (!hasCopy && !hasUsage && !hasCompletedAt && !hasJump && !onForkFromHere)
    return null

  return (
    <div className="mt-2 -ms-[0.3125rem] flex items-center justify-start gap-1 text-xs text-muted-foreground">
      <TooltipProvider delayDuration={150}>
        {hasCopy && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleCopy}
                className={iconButtonClass}
                aria-label={isCopied ? t("copied") : t("copyMessage")}
              >
                {isCopied ? (
                  <CheckIcon aria-hidden="true" className="h-3.5 w-3.5" />
                ) : (
                  <CopyIcon aria-hidden="true" className="h-3.5 w-3.5" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {isCopied ? t("copied") : t("copyMessage")}
            </TooltipContent>
          </Tooltip>
        )}
        {hasCopy && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleCreateTask}
                className={iconButtonClass}
                aria-label={tTasks("createFromMessage")}
              >
                <ListTodo aria-hidden="true" className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {tTasks("createFromMessage")}
            </TooltipContent>
          </Tooltip>
        )}
        {onForkFromHere && (
          <Tooltip>
            <TooltipTrigger asChild>
              {/* `aria-disabled`, deliberately NOT the native `disabled`: a
                  disabled element receives no pointer events, so the tooltip —
                  the only thing that says WHY the button is dead — would never
                  open. Staying focusable also keeps it reachable by keyboard. */}
              <button
                type="button"
                onClick={forkDisabled ? undefined : onForkFromHere}
                aria-disabled={forkDisabled || undefined}
                className={cn(
                  iconButtonClass,
                  forkDisabled &&
                    "cursor-not-allowed opacity-50 hover:bg-transparent hover:text-muted-foreground"
                )}
                aria-label={t("forkFromHere")}
              >
                <Split aria-hidden="true" className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {forkDisabled
                ? forkDisabledReason === "unnamed"
                  ? t("forkNotReady")
                  : t("forkBusy")
                : t("forkFromHere")}
            </TooltipContent>
          </Tooltip>
        )}
        {displayModels.length > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={cn(iconButtonClass, "cursor-default")}
                aria-label={t("model")}
              >
                <BrainCog aria-hidden="true" className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-xs break-words">
              <span className="font-medium" translate="no">
                {displayModels.join(", ")}
              </span>
            </TooltipContent>
          </Tooltip>
        )}
        {hasTokenCounts && usage && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={cn(iconButtonClass, "cursor-default")}
                aria-label={t("tokenStats")}
              >
                <Coins aria-hidden="true" className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-xs">
              <div className="flex flex-col gap-0.5">
                <div className="flex justify-between gap-3">
                  <span>{t("tokenInput")}</span>
                  <span className="font-mono tabular-nums">
                    {formatTokenCount(usage.input_tokens)}
                  </span>
                </div>
                {/* An agent that reports no output split at all would otherwise
                    show a misleading "Output: 0" row. Symmetric with the cache
                    rows' `> 0` gating below. */}
                {usage.output_tokens > 0 && (
                  <div className="flex justify-between gap-3">
                    <span>{t("tokenOutput")}</span>
                    <span className="font-mono tabular-nums">
                      {formatTokenCount(usage.output_tokens)}
                    </span>
                  </div>
                )}
                {usage.cache_read_input_tokens > 0 && (
                  <div className="flex justify-between gap-3">
                    <span>{t("tokenCacheRead")}</span>
                    <span className="font-mono tabular-nums">
                      {formatTokenCount(usage.cache_read_input_tokens)}
                    </span>
                  </div>
                )}
                {usage.cache_creation_input_tokens > 0 && (
                  <div className="flex justify-between gap-3">
                    <span>{t("tokenCacheWrite")}</span>
                    <span className="font-mono tabular-nums">
                      {formatTokenCount(usage.cache_creation_input_tokens)}
                    </span>
                  </div>
                )}
              </div>
            </TooltipContent>
          </Tooltip>
        )}
        {hasJump && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleJump}
                className={iconButtonClass}
                aria-label={t("jumpToPreviousUserMessage")}
              >
                <ArrowUpToLine aria-hidden="true" className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {t("jumpToPreviousUserMessage")}
            </TooltipContent>
          </Tooltip>
        )}
        {hasCompletedAt && completedTooltip && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="inline-flex h-6 cursor-default items-center rounded-full px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                aria-label={`${t("completedAt")}: ${completedTooltip}`}
              >
                <span aria-hidden="true">{completedLabel}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">
              <div className="flex flex-col gap-0.5">
                <span className="text-muted-foreground">
                  {t("completedAt")}
                </span>
                <span className="font-mono tabular-nums">
                  {completedTooltip}
                </span>
              </div>
            </TooltipContent>
          </Tooltip>
        )}
      </TooltipProvider>
    </div>
  )
}
