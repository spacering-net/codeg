import { useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Mic, Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"
import type { UseVoiceInputReturn } from "./use-voice-input"
import { toast } from "sonner"

export interface ComposerVoiceButtonProps {
  voice: UseVoiceInputReturn
  disabled?: boolean
  className?: string
  /** Localized string for default tooltip */
  label?: string
  /** Localized string for listening state tooltip */
  listeningLabel?: string
  /** Localized string for transcribing state tooltip */
  transcribingLabel?: string
  /** Localized string for permission denied */
  permissionDeniedLabel?: string
}

export function ComposerVoiceButton({
  voice,
  disabled = false,
  className,
  label = "语音输入 (点击开始)",
  listeningLabel = "正在录音... 点击完成 (Esc 取消)",
  transcribingLabel = "正在转写...",
  permissionDeniedLabel = "麦克风权限被拒绝，请在设置中允许访问",
}: ComposerVoiceButtonProps) {
  const isListening = voice.status === "listening"
  const isTranscribing = voice.status === "transcribing"

  // Cancel on Escape key while listening
  useEffect(() => {
    if (!isListening) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        voice.cancel()
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [isListening, voice])

  // Toast on permission error
  useEffect(() => {
    if (voice.status === "error" && voice.errorMessage === "micPermissionDenied") {
      toast.error(permissionDeniedLabel)
    }
  }, [voice.status, voice.errorMessage, permissionDeniedLabel])

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (disabled || isTranscribing) return

    if (isListening) {
      voice.stopListening()
    } else {
      void voice.startListening()
    }
  }

  const title = isTranscribing ? transcribingLabel : isListening ? listeningLabel : label

  return (
    <div className="relative inline-flex items-center">
      {/* Live speech interim preview bubble while user is speaking */}
      {isListening && voice.interimText && (
        <div
          data-testid="voice-interim-bubble"
          className="absolute bottom-full right-0 mb-2 z-50 max-w-xs truncate rounded-md bg-popover/95 px-2.5 py-1 text-xs text-popover-foreground shadow-md border border-border/80 backdrop-blur-sm animate-in fade-in zoom-in-95 duration-150"
        >
          <span className="inline-block size-1.5 rounded-full bg-red-500 mr-1.5 animate-pulse" />
          {voice.interimText}
        </div>
      )}

      <Button
        type="button"
        variant={isListening ? "outline" : "ghost"}
        size="icon"
        onClick={handleClick}
        disabled={disabled || isTranscribing || !voice.isSupported}
        title={title}
        aria-label={title}
        data-testid="composer-voice-button"
        className={cn(
          "relative h-8 w-8 transition-colors",
          isListening && [
            "border-red-500/40 bg-red-500/10 text-red-500 hover:bg-red-500/20 hover:text-red-600",
            "dark:border-red-500/50 dark:bg-red-950/30 dark:text-red-400",
          ],
          className
        )}
      >
        {isListening && (
          <span
            className="absolute inset-0 rounded-md bg-red-500/20 animate-ping opacity-75 pointer-events-none"
            style={{
              animationDuration: "1.5s",
              transform: `scale(${1 + voice.volume * 0.3})`,
            }}
          />
        )}
        {isTranscribing ? (
          <Loader2 className="size-4 animate-spin text-primary" />
        ) : (
          <Mic className={cn("size-4", isListening ? "animate-pulse text-red-500" : "text-muted-foreground")} />
        )}
      </Button>
    </div>
  )
}
