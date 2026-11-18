"use client"

/**
 * A change to the settings, worded as the settings view words it: an
 * item's name and its values — a work assistant's or an executor config's
 * by its name, a role by its name in the owner's language. The changed
 * card (`notice-card.tsx`) lists its changes so; "today" names a changed
 * row by them (`ChangesText`).
 */

import { useTranslations } from "next-intl"

import type { AssistantLabelSnapshot, ChangedItem } from "@/lib/types"
import { useAssistants } from "@/stores/assistants-store"

import { choiceKey, isClockItem } from "./settings/pref-pages"
import { useBotTemplates } from "./use-templates"

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

/** Display names of the uids a card's keys and values hold:
 *  `bot:<uid>`, `assistant:<uid>` (the card's `names`). */
export type Names = Record<string, string>

export function namesOf(v: unknown): Names {
  if (!v || typeof v !== "object") return {}
  const out: Names = {}
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
    if (typeof n === "string") out[k] = n
  }
  return out
}

/** `bot.<uid>.<field>` / `assistant.<uid>.<field>`: whose, and which item. */
export function teamKey(
  key: string
): { kind: "bot" | "assistant"; uid: string; field: string } | null {
  const m = /^(bot|assistant)\.(.+)\.([a-z_]+)$/.exec(key)
  return m
    ? { kind: m[1] as "bot" | "assistant", uid: m[2], field: m[3] }
    : null
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

/** A long text, cut to a line for a change's row. */
function clip(text: string, max = 80): string {
  const one = text.replace(/\s+/g, " ").trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/** An item's name and its values, as the settings view words them;
 *  `names` names the work assistants and executor configs by uid. */
export function useChangeText(names: Names = {}) {
  const ts = useTranslations("PersonalAgent.settings")
  const tp = useTranslations("PersonalAgent.settings.prefs")
  const tk = useTranslations("PersonalAgent.settings.division")
  const tt = useTranslations("PersonalAgent.notice.changed.team")
  const tf = useTranslations("PersonalAgent.bots.face")
  const assistants = useAssistants()
  const ownLabel: Record<string, string> = {
    auto_compact_percent: ts("autoCompact"),
    compact_command: ts("compactCommand"),
    handoff_budget_chars: ts("handoffBudget"),
    dispatch_concurrency: ts("concurrency"),
    skill_enabled: ts("skill"),
    brain: ts("brain"),
  }
  const byUid = (uid: string) =>
    names[`assistant:${uid}`] ??
    assistants.find((a) => a.uid === uid)?.name ??
    uid
  const pickName = (pick: string) => {
    if (names[pick]) return names[pick]
    const [kind, uid] = pick.split(":")
    return kind === "assistant" ? byUid(uid ?? "") : (uid ?? pick)
  }
  const label = (key: string): string => {
    if (key.startsWith("prefs.")) {
      return tp(`${key.slice(6)}.title` as "reply_length.title")
    }
    if (key.startsWith("own.")) return ownLabel[key.slice(4)] ?? key
    if (key.startsWith("team.division.")) {
      return tk(key.slice(14) as "code")
    }
    if (key.startsWith("team.usage.")) {
      return ts("changed.usageOf", { name: byUid(key.slice(11)) })
    }
    const team = teamKey(key)
    if (team) {
      const name =
        team.kind === "bot"
          ? (names[`bot:${team.uid}`] ?? team.uid)
          : byUid(team.uid)
      const field =
        team.kind === "bot"
          ? tt(`botField.${team.field}` as "botField.name")
          : tt(`assistantField.${team.field}` as "assistantField.name")
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
      (team?.kind === "assistant" && team.field === "agent")
    ) {
      const text = selectionText(v)
      if (text) return text
    }
    if (team?.field === "executor" && typeof v === "string") {
      return byUid(v)
    }
    if (team?.field === "avatar" && v && typeof v === "object") {
      const face = v as { kind?: string; shape?: string; color?: string }
      if (face.kind === "face" && face.shape && face.color) {
        return [
          tf(`shapes.${face.shape}` as "shapes.blob"),
          tf(`colors.${face.color}` as "colors.black"),
        ].join(" · ")
      }
      return tt("avatarOther")
    }
    if (
      team &&
      (team.field === "instructions" || team.field === "description") &&
      typeof v === "string"
    ) {
      return v.trim() ? clip(v) : tt("empty")
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
    if (key.startsWith("team.division.")) {
      if (typeof v !== "string") return ts("team.auto")
      return pickName(v)
    }
    if (key.startsWith("team.usage.")) {
      return v == null ? ts("changed.usageDefault") : ts("changed.usageSet")
    }
    if (typeof v === "boolean") return v ? ts("changed.on") : ts("changed.off")
    if (v == null) return ts("changed.default")
    return String(v)
  }
  return { label, value }
}

/** A work assistant's role by its name in the owner's language (the
 *  templates are read only when a card shows one). */
function TemplateName({ id }: { id: string }) {
  const templates = useBotTemplates()
  return <>{templates?.find((x) => x.id === id)?.name ?? id}</>
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
  if (teamKey(item)?.field === "template" && typeof value === "string") {
    return <TemplateName id={value} />
  }
  return <>{text(item, value)}</>
}

/** A changed row's name (`TodayRow.changes`): each change as its card
 *  words it — "Goose's role: Blank → Research" — one after another. */
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
