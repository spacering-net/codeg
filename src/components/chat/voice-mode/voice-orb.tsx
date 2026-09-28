"use client"

import { useCallback } from "react"
import { ExternalLink, X } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { useTabActions } from "@/contexts/tab-context"
import { cn } from "@/lib/utils"
import {
  requestVoiceMode,
  useVoiceModeState,
  type VoiceModePhase,
} from "@/lib/voice-mode/voice-mode-store"

function getPhaseStyles(phase: VoiceModePhase) {
  switch (phase) {
    case "starting":
    case "waiting":
      return "animate-[voice-orb-shimmer_3s_ease-in-out_infinite]"
    case "listening":
      return "animate-[voice-orb-breathe_2.5s_ease-in-out_infinite]"
    case "capturing":
      return "[transform:scale(calc(1+var(--voice-level,0)*0.35))] transition-transform duration-100 ease-out"
    case "speaking":
      return "animate-[voice-orb-pulse_1.2s_ease-in-out_infinite]"
    case "confirming":
      return "ring-4 ring-amber-500/80 shadow-[0_0_20px_rgba(245,158,11,0.5)]"
    case "transcribing":
      return "animate-pulse opacity-90"
    default:
      return ""
  }
}

export function VoiceOrb() {
  const t = useTranslations("VoiceMode")
  const { phase, level, assistant } = useVoiceModeState()
  const { openTab } = useTabActions()

  const handleOpenTranscript = useCallback(() => {
    if (!assistant) return
    openTab(
      assistant.folderId,
      assistant.conversationId,
      assistant.agentType,
      true
    )
  }, [assistant, openTab])

  const handleClose = useCallback(() => {
    requestVoiceMode(false)
  }, [])

  if (phase === "off") {
    return null
  }

  const phaseLabel = t(`phases.${phase}`, { fallback: phase })

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 pointer-events-none mb-[env(safe-area-inset-bottom)]">
      <div className="pointer-events-auto flex items-center gap-2 p-2 rounded-full bg-background/80 backdrop-blur-md border border-border shadow-xl">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 rounded-full hover:bg-accent text-muted-foreground hover:text-foreground"
          onClick={handleOpenTranscript}
          disabled={!assistant}
          title={t("openTranscript")}
          aria-label={t("openTranscript")}
          data-testid="voice-orb-transcript-btn"
        >
          <ExternalLink className="h-4 w-4" />
        </Button>

        <div
          role="status"
          aria-label={phaseLabel}
          data-testid="voice-orb"
          data-phase={phase}
          data-level={level}
          className={cn(
            "relative w-14 h-14 rounded-full flex items-center justify-center select-none shadow-lg overflow-hidden",
            "bg-gradient-to-tr from-primary/80 via-accent/60 to-primary/90",
            "motion-reduce:animate-none motion-reduce:transition-none motion-reduce:transform-none",
            getPhaseStyles(phase)
          )}
          style={{ "--voice-level": level } as React.CSSProperties}
        >
          <div className="absolute inset-0 rounded-full bg-[radial-gradient(circle_at_center,var(--tw-gradient-stops))] from-white/20 via-transparent to-black/20" />
          <span
            className="sr-only"
            aria-live="polite"
            data-testid="voice-orb-aria-live"
          >
            {phaseLabel}
          </span>
        </div>

        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 rounded-full hover:bg-accent text-muted-foreground hover:text-foreground"
          onClick={handleClose}
          title={t("close")}
          aria-label={t("close")}
          data-testid="voice-orb-close-btn"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
