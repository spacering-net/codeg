"use client"

/**
 * A change to the settings, worded as the settings view words it: an
 * item's name and its values — a work assistant's by its name. The changed
 * card (`notice-card.tsx`) lists its changes so; "today" names a changed
 * row by them (`ChangesText`).
 */

import { useTranslations } from "next-intl"

import type { AssistantLabelSnapshot, ChangedItem } from "@/lib/types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"

import { BOT_SHAPES } from "./bot-shapes"
import { choiceKey, isClockItem } from "./settings/pref-pages"

export type Change = ChangedItem

export function changesOf(v: unknown): Change[] {
  return Array.isArray(v)
    ? v.filter(
        (c): c is Change =>
          c != null &&
          typeof c === "object" &&
          typeof (c as Change).key === "string"
      )
    : []
}

/** Display names of the uids a card's keys hold: `bot:<uid>` (the card's
 *  `names`). */
export type Names = Record<string, string>

export function namesOf(v: unknown): Names {
  if (!v || typeof v !== "object") return {}
  const out: Names = {}
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
    if (typeof n === "string") out[k] = n
  }
  return out
}

/** `bot.<uid>.<field>`: whose, and which item. */
export function teamKey(key: string): { uid: string; field: string } | null {
  const m = /^bot\.(.+)\.([a-z_]+)$/.exec(key)
  return m ? { uid: m[1], field: m[2] } : null
}

/** "Codex · GPT-5.5 · High": an agent and its picks, as saved. */
function selectionText(v: unknown): string | null {
  if (!v || typeof v !== "object") return null
  const snap = (v as { label_snapshot?: AssistantLabelSnapshot }).label_snapshot
  if (!snap) return null
  return [snap.agent, snap.mode, ...snap.options.map((o) => o.value_label)]
    .filter(Boolean)
    .join(" · ")
}

/** The projects a list names, shown by name, at most this many. */
const PROJECTS_NAMED = 3

/** A long text, cut to a line for a change's row. */
export function clip(text: string, max = 80): string {
  const one = text.replace(/\s+/g, " ").trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/** An item's name and its values, as the settings view words them;
 *  `names` names the assistants by uid. */
export function useChangeText(names: Names = {}) {
  const ts = useTranslations("PersonalAgent.settings")
  const tp = useTranslations("PersonalAgent.settings.prefs")
  const tt = useTranslations("PersonalAgent.notice.changed.team")
  const tf = useTranslations("PersonalAgent.bots.face")
  const tj = useTranslations("PersonalAgent.meet.connect")
  const folders = useAppWorkspaceStore((s) => s.folders)
  /** The projects watched: "all", or the projects by name — one codeg no
   *  longer has by its id. */
  const projectsText = (v: unknown): string | null => {
    if (v === "all") return tp("projects.all")
    if (!Array.isArray(v)) return null
    if (v.length === 0) return tp("projects.none")
    const names = v.map((id) => {
      const f = folders.find((x) => x.id === id)
      return f ? f.alias || f.name : `#${id}`
    })
    const shown = names.slice(0, PROJECTS_NAMED).join(tj("joiner"))
    return names.length > PROJECTS_NAMED
      ? tp("projects.more", {
          names: shown,
          count: names.length,
          rest: names.length - PROJECTS_NAMED,
        })
      : shown
  }
  const ownLabel: Record<string, string> = {
    auto_compact_percent: ts("autoCompact"),
    compact_command: ts("compactCommand"),
    handoff_budget_chars: ts("handoffBudget"),
    dispatch_concurrency: ts("concurrency"),
    skill_enabled: ts("skill"),
    brain: ts("brain"),
  }
  const label = (key: string): string => {
    if (key.startsWith("prefs.")) {
      return tp(`${key.slice(6)}.title` as "reply_length.title")
    }
    if (key.startsWith("own.")) return ownLabel[key.slice(4)] ?? key
    const team = teamKey(key)
    if (team) {
      const name = names[`bot:${team.uid}`] ?? team.uid
      const field = tt(`botField.${team.field}` as "botField.name")
      return tt("of", { name, field })
    }
    return key
  }
  const value = (key: string, v: unknown): string => {
    const team = teamKey(key)
    // "Codex · GPT-5.5 · High": the agent and the picks, as saved.
    if (
      key === "own.brain" ||
      team?.field === "brain" ||
      team?.field === "work_agent"
    ) {
      const text = selectionText(v)
      if (text) return text
      if (team?.field === "work_agent" && v == null) return tt("nothingSet")
    }
    if (team?.field === "avatar" && v && typeof v === "object") {
      const face = v as { kind?: string; shape?: string; color?: string }
      // A shape codeg no longer draws (a change recorded before): the
      // colour alone.
      if (face.kind === "face" && face.shape && face.color) {
        return [
          ...((BOT_SHAPES as readonly string[]).includes(face.shape)
            ? [tf(`shapes.${face.shape}` as "shapes.ring")]
            : []),
          tf(`colors.${face.color}` as "colors.black"),
        ].join(" · ")
      }
      return tt("avatarOther")
    }
    if (team?.field === "persona" && typeof v === "string") {
      return v.trim() ? clip(v) : tt("empty")
    }
    if (key === "prefs.projects") {
      const text = projectsText(v)
      if (text) return text
    }
    // A zone is its own name; only `system` has words.
    if (key === "prefs.time_zone" && typeof v === "string") {
      return v === "system" ? tp("time_zone.system") : v
    }
    // A time of day is its own words.
    if (key.startsWith("prefs.") && isClockItem(key.slice(6))) {
      return typeof v === "string" ? v : String(v ?? "")
    }
    if (key.startsWith("prefs.") && typeof v === "string") {
      return tp(choiceKey(key.slice(6), v) as "reply_length.short")
    }
    if (typeof v === "boolean") return v ? ts("changed.on") : ts("changed.off")
    if (v == null) return ts("changed.default")
    return String(v)
  }
  return { label, value }
}

/** One value of a change, as its item words it. */
export function ChangeValue({
  item,
  value,
  text,
}: {
  item: string
  value: unknown
  text: (key: string, v: unknown) => string
}) {
  return <>{text(item, value)}</>
}

/** A changed row's name (`TodayRow.changes`): each change as its card
 *  words it — "Goose's name: Goose → Gander" — one after another. */
export function ChangesText({
  changes,
  names,
}: {
  changes: unknown
  names: unknown
}) {
  const list = changesOf(changes)
  const { label, value } = useChangeText(namesOf(names))
  return (
    <>
      {list.map((c, i) => (
        <span key={c.key} data-pa-today-change={c.key}>
          {i > 0 ? "; " : null}
          {label(c.key)}
          {": "}
          <ChangeValue item={c.key} value={c.from} text={value} />
          {" → "}
          <ChangeValue item={c.key} value={c.to} text={value} />
        </span>
      ))}
    </>
  )
}
