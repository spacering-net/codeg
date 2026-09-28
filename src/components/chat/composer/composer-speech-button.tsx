"use client"

import { useCallback, useEffect, type RefObject } from "react"
import { Loader2, Mic, MicOff, Square } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { textToInlineContent } from "@/components/chat/composer/plain-text-content"
import type { RichComposerHandle } from "@/components/chat/composer/rich-composer"
import {
  useSpeechInput,
  type SpeechInputError,
  type SpeechInputStatus,
  type SpeechUnavailableReason,
} from "@/components/chat/composer/use-speech-input"
import { Button } from "@/components/ui/button"
import { isImeCompositionKey } from "@/lib/ime-composition"
import { matchShortcutEvent } from "@/lib/keyboard-shortcuts"
import { cn } from "@/lib/utils"

const UNAVAILABLE_KEYS = {
  "no-engine": "speechUnavailableNoEngine",
  "insecure-context": "speechUnavailableInsecure",
  "no-mic": "speechUnavailableNoMic",
  "cloud-not-configured": "speechUnavailableCloud",
} as const satisfies Record<SpeechUnavailableReason, string>

const ERROR_KEYS = {
  "mic-denied": "speechMicDenied",
  "engine-failed": "speechFailed",
  "cloud-auth": "speechCloudAuthFailed",
  "cloud-not-configured": "speechUnavailableCloud",
} as const satisfies Record<SpeechInputError, string>

interface ComposerSpeechButtonProps {
  status: SpeechInputStatus
  interimText: string
  unavailableReason: SpeechUnavailableReason | null
  onToggle: () => void
}

export function ComposerSpeechButton({
  status,
  interimText,
  unavailableReason,
  onToggle,
}: ComposerSpeechButtonProps) {
  const t = useTranslations("Folder.chat.messageInput")

  const label =
    status === "listening"
      ? t("speechStop")
      : status === "transcribing"
        ? t("speechTranscribing")
        : status === "unavailable" && unavailableReason
          ? t(UNAVAILABLE_KEYS[unavailableReason])
          : t("speechStart")

  return (
    <div className="relative">
      {status === "listening" && (
        <div
          role="status"
          className="absolute right-0 bottom-full z-30 mb-2 w-64 max-w-[calc(100vw-2rem)] rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md"
        >
          {interimText && <p className="line-clamp-2">{interimText}</p>}
          <p className="text-3xs text-muted-foreground">
            {t("speechCancelHint")}
          </p>
        </div>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn(
          "h-8 w-8",
          status === "listening" &&
            "animate-pulse text-destructive ring-2 ring-destructive/40"
        )}
        onClick={onToggle}
        disabled={status === "unavailable" || status === "transcribing"}
        title={label}
        aria-label={label}
        aria-pressed={status === "listening"}
      >
        {status === "listening" ? (
          <Square className="size-4" />
        ) : status === "transcribing" ? (
          <Loader2 className="size-4 animate-spin" />
        ) : status === "unavailable" ? (
          <MicOff className="size-4" />
        ) : (
          <Mic className="size-4" />
        )}
      </Button>
    </div>
  )
}

interface ComposerSpeechControlProps {
  editorRef: RefObject<RichComposerHandle | null>
  isActive: boolean
  shortcut: string
  onInserted: () => void
}

/**
 * Owns one dictation session for a composer: inserts the final transcript at
 * the caret as literal text (never HTML, never sent), cancels on Escape, and
 * toggles on the voice-input shortcut while this composer is the active one.
 */
export function ComposerSpeechControl({
  editorRef,
  isActive,
  shortcut,
  onInserted,
}: ComposerSpeechControlProps) {
  const t = useTranslations("Folder.chat.messageInput")

  const onFinalText = useCallback(
    (text: string) => {
      const editor = editorRef.current?.getEditor()
      if (!editor || !text) return
      const { from } = editor.state.selection
      const before = editor.state.doc.textBetween(
        Math.max(0, from - 1),
        from,
        "\n",
        "\n"
      )
      const prefix = !editor.isEmpty && before && !/\s/.test(before) ? " " : ""
      editor
        .chain()
        .focus()
        .insertContent(textToInlineContent(prefix + text))
        .run()
      onInserted()
    },
    [editorRef, onInserted]
  )

  const onError = useCallback(
    (error: SpeechInputError) => toast.error(t(ERROR_KEYS[error])),
    [t]
  )

  const speech = useSpeechInput({ onFinalText, onError })
  const { status, cancel, toggle } = speech
  const busy = status === "listening" || status === "transcribing"

  useEffect(() => {
    if (!isActive || !busy) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || isImeCompositionKey(event)) return
      event.preventDefault()
      event.stopPropagation()
      cancel()
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [busy, cancel, isActive])

  useEffect(() => {
    if (!isActive || !shortcut || status === "unavailable") return
    const onKeyDown = (event: KeyboardEvent) => {
      if (!matchShortcutEvent(event, shortcut)) return
      event.preventDefault()
      toggle()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [isActive, shortcut, status, toggle])

  return (
    <ComposerSpeechButton
      status={status}
      interimText={speech.interimText}
      unavailableReason={speech.unavailableReason}
      onToggle={toggle}
    />
  )
}
