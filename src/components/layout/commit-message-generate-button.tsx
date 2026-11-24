"use client"

import { Loader2, Sparkles, Square } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface CommitMessageGenerateButtonProps {
  generating: boolean
  elapsedSeconds: number
  /** Why a generation can't start now; `null` when it can. */
  disabledReason: string | null
  onGenerate: () => void
  onStop: () => void
  className?: string
}

/**
 * The ✨ by a commit box. While a message is being written it spins, and
 * turns into a stop button under the pointer (or keyboard focus).
 */
export function CommitMessageGenerateButton({
  generating,
  elapsedSeconds,
  disabledReason,
  onGenerate,
  onStop,
  className,
}: CommitMessageGenerateButtonProps) {
  const t = useTranslations("CommitMessageGeneration")
  const label = generating
    ? t("stop", { seconds: elapsedSeconds })
    : (disabledReason ?? t("generate"))
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn("group", className)}
      disabled={!generating && disabledReason !== null}
      title={label}
      aria-label={label}
      aria-busy={generating}
      onClick={generating ? onStop : onGenerate}
    >
      {generating ? (
        <>
          <Loader2 className="size-3.5 animate-spin group-hover:hidden group-focus-visible:hidden" />
          <Square className="hidden size-3 fill-current group-hover:block group-focus-visible:block" />
        </>
      ) : (
        <Sparkles className="size-3.5" />
      )}
    </Button>
  )
}
