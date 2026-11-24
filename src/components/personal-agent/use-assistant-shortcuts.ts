"use client"

/**
 * The assistants page's keys (10.9), by the owner's bindings (Settings →
 * Shortcuts):
 * - ⌘1–⌘9 (Ctrl on Windows and Linux): the Nth assistant in the roster's
 *   order — 1 is the primary, the hidden ones left out.
 * - ⌥↑ / ⌥↓: the one above or below in that order, round the ends; not
 *   while the focused field has text in it (the keys move its caret then).
 * - Ctrl+Tab: the assistants in the order they were last opened. Tapped
 *   once it goes back to the one before; with Ctrl held, each Tab goes one
 *   further back, through the order as it stood at the first press.
 *
 * They act only while the page is mounted — that is, the current page; the
 * workspace's tab keys on the same chords stand down meanwhile
 * (`isAssistantsPageCurrent`) and act as before everywhere else.
 */

import { useEffect, useRef } from "react"
import { useLocale } from "next-intl"

import { useShortcutSettings } from "@/hooks/use-shortcut-settings"
import { holdAssistantsPage } from "@/lib/assistants-page"
import {
  assistantShortcutFromEvent,
  isShortcutRecorderArmed,
} from "@/lib/keyboard-shortcuts"
import type { RosterEntry } from "@/lib/types"
import {
  usePersonalAgentRoster,
  useRoster,
} from "@/stores/personal-agent-roster-store"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

import { rosterOrder } from "./roster-order"

/** What the page shows: an assistant's id, or `null` for the primary (as
 *  `viewBot` has it). */
type View = number | null

/** Assistants opened, the latest first. */
let recent: View[] = []
/** A Ctrl+Tab walk in progress: the order at its first press, and where it
 *  is in it. Ends when Ctrl (or ⌘) is let go, or the window loses focus. */
let walk: { order: View[]; at: number } | null = null

/** Forget what was opened (tests). */
export function resetAssistantShortcuts(): void {
  recent = []
  walk = null
}

function noteOpened(view: View): void {
  recent = [view, ...recent.filter((v) => v !== view)].slice(0, 50)
}

function viewOf(entry: RosterEntry): View {
  return entry.kind === "primary" ? null : entry.id
}

/** `viewBot` as the roster has it: the primary's own id is the primary. */
function normalize(view: View, entries: readonly RosterEntry[]): View {
  if (view == null) return null
  const entry = entries.find((e) => e.id === view)
  return entry && entry.kind === "primary" ? null : view
}

/** Whether a key there would edit text the owner wrote. */
function editsText(target: EventTarget | null): boolean {
  const el =
    target instanceof Element ? target : (document.activeElement ?? null)
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return el.value.length > 0
  }
  if (el instanceof HTMLElement && el.isContentEditable) {
    const root =
      el.closest('[contenteditable="true"], [contenteditable=""]') ?? el
    return (root.textContent ?? "").trim().length > 0
  }
  return false
}

export function useAssistantShortcuts(): void {
  // The roster stays read while the page is up.
  useRoster()
  const { shortcuts } = useShortcutSettings()
  const locale = useLocale()
  const viewBot = usePersonalAgentUi((s) => s.viewBot)
  const shortcutsRef = useRef(shortcuts)
  const localeRef = useRef(locale)
  useEffect(() => {
    shortcutsRef.current = shortcuts
    localeRef.current = locale
  })

  useEffect(() => holdAssistantsPage(), [])

  useEffect(() => {
    const entries = usePersonalAgentRoster.getState().entries ?? []
    noteOpened(normalize(viewBot, entries))
  }, [viewBot])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isShortcutRecorderArmed()) return
      const action = assistantShortcutFromEvent(e, shortcutsRef.current)
      if (!action) return
      // A Ctrl chord belongs to a focused terminal, as for the tab keys.
      if (
        e.ctrlKey &&
        !e.metaKey &&
        e.target instanceof Element &&
        e.target.closest('[data-terminal-panel-region="true"]')
      ) {
        return
      }
      const entries = usePersonalAgentRoster.getState().entries
      if (!entries || entries.length === 0) return
      const views = rosterOrder(entries, Date.now(), localeRef.current).map(
        viewOf
      )
      if (views.length === 0) return
      const current = normalize(usePersonalAgentUi.getState().viewBot, entries)
      let target: View | undefined
      switch (action.kind) {
        case "switch":
          target = views[action.index]
          if (target === undefined) return
          break
        case "prev":
        case "next": {
          if (editsText(e.target)) return
          const at = views.indexOf(current)
          const step = action.kind === "next" ? 1 : -1
          const from = at < 0 ? (step > 0 ? -1 : 0) : at
          target = views[(from + step + views.length) % views.length]
          break
        }
        case "cycle": {
          if (!walk) {
            const shown = new Set(views)
            const order: View[] = [current]
            for (const v of [...recent, ...views]) {
              if (v !== current && shown.has(v) && !order.includes(v)) {
                order.push(v)
              }
            }
            walk = { order, at: 0 }
          }
          if (walk.order.length < 2) return
          walk.at = (walk.at + 1) % walk.order.length
          target = walk.order[walk.at]
          break
        }
      }
      e.preventDefault()
      if (target !== current) {
        usePersonalAgentUi.getState().setViewBot(target)
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Control" || e.key === "Meta") walk = null
    }
    const onBlur = () => {
      walk = null
    }
    document.addEventListener("keydown", onKeyDown)
    document.addEventListener("keyup", onKeyUp)
    window.addEventListener("blur", onBlur)
    return () => {
      document.removeEventListener("keydown", onKeyDown)
      document.removeEventListener("keyup", onKeyUp)
      window.removeEventListener("blur", onBlur)
      walk = null
    }
  }, [])
}
