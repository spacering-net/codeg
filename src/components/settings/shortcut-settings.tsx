"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Keyboard, RotateCcw } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { useIsMac } from "@/hooks/use-is-mac"
import { useShortcutSettings } from "@/hooks/use-shortcut-settings"
import {
  DEFAULT_SHORTCUTS,
  INPUT_SHORTCUT_IDS,
  SHORTCUT_DEFINITIONS,
  type ShortcutActionId,
  canShareShortcut,
  formatShortcutLabel,
  setShortcutRecorderArmed,
  shortcutFromKeyboardEvent,
  shortcutsConflict,
} from "@/lib/keyboard-shortcuts"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"

export function ShortcutSettings() {
  const t = useTranslations("ShortcutSettings")
  const { shortcuts, updateShortcut, resetShortcuts } = useShortcutSettings()
  const isMac = useIsMac()
  const [recordingAction, setRecordingAction] =
    useState<ShortcutActionId | null>(null)
  const actionTitle = useCallback(
    (id: ShortcutActionId) => t(`actions.${id}.title`),
    [t]
  )
  const actionDescription = useCallback(
    (id: ShortcutActionId) => t(`actions.${id}.description`),
    [t]
  )

  const isDefault = useMemo(
    () =>
      SHORTCUT_DEFINITIONS.every(
        (definition) =>
          shortcuts[definition.id] === DEFAULT_SHORTCUTS[definition.id]
      ),
    [shortcuts]
  )

  useEffect(() => {
    setShortcutRecorderArmed(Boolean(recordingAction))
    return () => setShortcutRecorderArmed(false)
  }, [recordingAction])

  useEffect(() => {
    if (!recordingAction) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()

      if (event.key === "Escape") {
        setRecordingAction(null)
        return
      }

      const allowNoModifier = INPUT_SHORTCUT_IDS.has(recordingAction)
      const shortcut = shortcutFromKeyboardEvent(event, allowNoModifier)
      if (!shortcut) return

      // Matcher semantics, not string equality: two different strings can fire
      // on the same event (`mod+=` and `mod+shift++` both match Ctrl/Cmd+Shift+=).
      const conflict = SHORTCUT_DEFINITIONS.find(
        (definition) =>
          definition.id !== recordingAction &&
          !canShareShortcut(definition.id, recordingAction) &&
          shortcutsConflict(shortcuts[definition.id], shortcut)
      )

      if (conflict) {
        toast.error(t("toasts.conflict", { title: actionTitle(conflict.id) }))
        return
      }

      if (updateShortcut(recordingAction, shortcut)) {
        toast.success(t("toasts.updated"))
      } else {
        toast.error(t("toasts.invalid"))
      }

      setRecordingAction(null)
    }

    window.addEventListener("keydown", onKeyDown, true)

    return () => {
      window.removeEventListener("keydown", onKeyDown, true)
    }
  }, [actionTitle, recordingAction, shortcuts, t, updateShortcut])

  return (
    <ScrollArea className="h-full">
      <div className="w-full space-y-4 p-3 md:p-4">
        <section className="rounded-xl border bg-card p-4 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Keyboard className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">{t("sectionTitle")}</h2>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                resetShortcuts()
                setRecordingAction(null)
                toast.success(t("toasts.reset"))
              }}
              disabled={isDefault}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              {t("resetDefault")}
            </Button>
          </div>

          <p className="text-xs text-muted-foreground leading-5">
            {t("recordInstruction")}
          </p>

          <div className="space-y-2">
            {SHORTCUT_DEFINITIONS.map((definition) => {
              const isRecording = recordingAction === definition.id

              return (
                <div
                  key={definition.id}
                  className="rounded-lg border px-3 py-2 flex items-center justify-between gap-4"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium">
                      {actionTitle(definition.id)}
                    </div>
                    <p className="text-xs text-muted-foreground truncate">
                      {actionDescription(definition.id)}
                    </p>
                  </div>
                  <Button
                    variant={isRecording ? "default" : "secondary"}
                    size="sm"
                    className="font-mono min-w-36 justify-center"
                    onClick={() => {
                      setRecordingAction((previous) =>
                        previous === definition.id ? null : definition.id
                      )
                    }}
                  >
                    {isRecording
                      ? t("recording")
                      : shortcuts[definition.id]
                        ? formatShortcutLabel(shortcuts[definition.id], isMac)
                        : t("unassigned")}
                  </Button>
                </div>
              )
            })}
          </div>
        </section>
      </div>
    </ScrollArea>
  )
}
