"use client"

/**
 * Display names for the desktop-alert event catalogue (`NOTIFY_EVENT_IDS`),
 * shared by every settings section that lists it — desktop notifications and
 * taskbar / Dock alerts — so one trigger reads identically in both.
 */

import { useCallback } from "react"
import { useTranslations } from "next-intl"

import type { NotifyEventId } from "@/lib/desktop-notification-prefs"

/**
 * Where an event's name lives. Literal keys, because next-intl only resolves
 * literal keys; a table rather than a switch so the rows stay data-driven.
 *
 * `channel` names reuse the chat-channel Events tab, exactly as the sound
 * panel does, so one trigger reads identically everywhere it is configurable.
 * `local` names are for the app-level events that have no channel counterpart.
 */
type EventLabel =
  | {
      source: "channel"
      key: "turnComplete" | "permissionRequest" | "questionRequest" | "error"
    }
  | { source: "local"; key: "eventBackgroundTask" | "eventWorkTask" }

const EVENT_LABELS = {
  turn_complete: { source: "channel", key: "turnComplete" },
  permission_request: { source: "channel", key: "permissionRequest" },
  question_request: { source: "channel", key: "questionRequest" },
  error: { source: "channel", key: "error" },
  background_task: { source: "local", key: "eventBackgroundTask" },
  work_task: { source: "local", key: "eventWorkTask" },
} as const satisfies Record<NotifyEventId, EventLabel>

/** The localized name of a desktop-alert event. */
export function useNotifyEventLabel(): (eventId: NotifyEventId) => string {
  const t = useTranslations("DesktopNotificationSettings")
  const tEvents = useTranslations("ChatChannelSettings.events")
  return useCallback(
    (eventId: NotifyEventId): string => {
      const label: EventLabel = EVENT_LABELS[eventId]
      return label.source === "channel" ? tEvents(label.key) : t(label.key)
    },
    [t, tEvents]
  )
}
