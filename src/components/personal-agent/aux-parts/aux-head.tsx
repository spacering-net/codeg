"use client"

/** The panel's head: who it is — its face and its name, each changed in
 *  place — the bell
 *  that says whether it notifies the owner, and the "⋯" of what acts on
 *  it. How it is (its state) is on the conversation's title. */

import { useEffect, useRef, useState, type ReactNode } from "react"
import { useLocale, useTranslations } from "next-intl"
import { Bell, BellOff } from "lucide-react"
import { toast } from "sonner"
import { Toggle } from "@/components/ui/toggle"
import { usePersonalAgent } from "@/contexts/personal-agent-context"
import { useImeGuard } from "@/hooks/use-ime-guard"
import { personalAgentRosterAct, personalAgentSave } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type { BotLook, PersonalAgentSnapshot } from "@/lib/types"
import { cn } from "@/lib/utils"
import {
  usePersonalAgentRoster,
  useRoster,
} from "@/stores/personal-agent-roster-store"

import { AgentMenu } from "../agent-menu"
import { BotAvatar, defaultFaceOf } from "../bot-avatar"
import { BotFacePicker } from "../bot-face-picker"
import { usePendingFace, useSaveFace } from "../face-save"
import { useBotLook } from "../shared"

/** The assistant's face at the head of the panel, in px at 100% zoom. */
const HEAD_AVATAR_SIZE = 64
/** The looks of a reply (under way, or just ended): the roster's face and
 *  the pill's act them out, this one does not — it stays at rest. */
const REPLY_LOOKS: ReadonlySet<BotLook> = new Set<BotLook>([
  "thinking",
  "working",
  "done",
  "failed",
])

/** What the face at the head shows for the look it has live: at rest
 *  through a reply and after it, as it is otherwise (waiting, stuck,
 *  asleep). It still follows the pointer. */
function headLookOf(look: BotLook): BotLook {
  return REPLY_LOOKS.has(look) ? "idle" : look
}

/** Who the panel is about, over its tabs: its face — alive, following
 *  the pointer, its star on the primary's; not acting out a reply, which
 *  the roster's and the pill's do (`headLookOf`) — and its name;
 *  in the top's corners,
 *  as far from either edge, whether it notifies the owner (the bell, at the
 *  start) and what acts on it (the "⋯", at the end — in the drawer left of
 *  its close button, which has the right). */
export function AuxHead({
  snapshot,
  inDrawer,
  children,
}: {
  snapshot: PersonalAgentSnapshot
  inDrawer: boolean
  children: ReactNode
}) {
  const t = useTranslations("PersonalAgent")
  const agent = snapshot.agent
  const name = agent?.name?.trim() || t("title")
  const look = headLookOf(useBotLook(agent?.id ?? null))
  return (
    // The whole head is where its face follows the pointer: over its name,
    // its buttons and its tabs too, not only over the face.
    <header
      data-pa-aux-head
      data-pa-face-host
      className="relative flex shrink-0 flex-col items-center gap-3 px-4 pt-7 pb-3"
    >
      {agent ? (
        <>
          {/* Their boxes as far from the top as from the sides, by
              measure — not nudged for the "⋯" being a flat row of dots
              in the middle of its own. */}
          <NotifyToggle
            snapshot={snapshot}
            className={cn(
              "absolute",
              inDrawer ? "top-2.5 left-3" : "start-2 top-2"
            )}
          />
          <AgentMenu
            className={cn(
              "absolute",
              inDrawer ? "top-2.5 right-12" : "end-2 top-2"
            )}
          />
        </>
      ) : null}
      {agent ? (
        <HeadFace
          // Another assistant's: what is being saved is its own.
          key={`face:${agent.id}`}
          snapshot={snapshot}
          name={name}
          look={look}
        />
      ) : null}
      <HeadName
        // Another assistant's: its own, from what is saved.
        key={agent?.id ?? "none"}
        snapshot={snapshot}
        name={name}
      />
      {children}
    </header>
  )
}

/** Its face — pressed ("Edit avatar" under the pointer), the face
 *  editor's bubble under it, a face picked saved at once. Not changed
 *  where it runs elsewhere. */
function HeadFace({
  snapshot,
  name,
  look,
}: {
  snapshot: PersonalAgentSnapshot
  name: string
  look: BotLook
}) {
  const { botId } = usePersonalAgent()
  const agent = snapshot.agent
  const face = usePendingFace(agent?.id ?? null, agent?.avatar ?? null)
  const saveFace = useSaveFace(botId, face.pick)
  if (!agent || !face.shown) return null
  if (snapshot.status.engine !== "here")
    return (
      <BotAvatar
        avatar={face.shown}
        name={name}
        size={HEAD_AVATAR_SIZE}
        star={botId == null}
        look={look}
      />
    )
  return (
    <BotFacePicker
      value={face.shown}
      name={name}
      onChange={saveFace}
      resetTo={defaultFaceOf(agent)}
      size={HEAD_AVATAR_SIZE}
      star={botId == null}
      look={look}
    />
  )
}

/** The longest name saved (the backend's cap too). */
const NAME_MAX = 40

/** Its name: deeper under the pointer, and pressed, a field in its place —
 *  Enter or leaving it saves it, Escape takes it back. A work assistant's
 *  is not left empty (it goes back to what it was); the primary's may be
 *  (it goes by the default one). Not renamed where it runs elsewhere. */
export function HeadName({
  snapshot,
  name,
  hero = false,
}: {
  snapshot: PersonalAgentSnapshot
  /** What it goes by now. */
  name: string
  /** The assistant's own page's: large, its page's heading. */
  hero?: boolean
}) {
  const t = useTranslations("PersonalAgent.aux")
  const tPage = useTranslations("PersonalAgent")
  const tEdit = useTranslations("PersonalAgent.bots.edit")
  const locale = useLocale()
  const { botId } = usePersonalAgent()
  const agent = snapshot.agent
  const saved = agent?.name?.trim() ?? ""
  const editable = agent != null && snapshot.status.engine === "here"
  const [draft, setDraft] = useState<string | null>(null)
  // Saved, before the assistant read back says so: shown meanwhile — while
  // what is read back is still what it was over.
  const [saving, setSaving] = useState<{ name: string; over: string } | null>(
    null
  )
  // Read back as something else (what was saved, or a rename from
  // elsewhere): what is read back stands.
  if (saving != null && saving.over !== saved) setSaving(null)
  const pending = saving != null && saving.over === saved ? saving.name : null
  const ime = useImeGuard()
  const input = useRef<HTMLInputElement | null>(null)
  // Ended once: Enter, then the field going away, is not a second save.
  const ended = useRef(false)
  const editing = draft != null

  useEffect(() => {
    if (!editing) return
    const el = input.current
    el?.focus()
    el?.select()
    // Escape takes the name back and goes no further — not to the drawer
    // round the panel, which would close on it.
    // While a word is being composed, Escape is the input method's.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.target !== el || ime.isComposing(e)) return
      e.stopPropagation()
      e.preventDefault()
      ended.current = true
      setDraft(null)
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [editing, ime])

  const commit = () => {
    if (ended.current || draft == null) return
    ended.current = true
    const next = draft.trim()
    setDraft(null)
    // Unchanged from what it shows — saved or being saved — nothing to do.
    if (next === (pending ?? saved) || (agent?.kind !== "primary" && !next))
      return
    const mine = { name: next, over: saved }
    setSaving(mine)
    personalAgentSave({ name: next, locale }, botId).catch((e) => {
      setSaving((s) => (s === mine ? null : s))
      toast.error(toErrorMessage(e))
    })
  }

  // The primary's left empty goes by the default name.
  const fallback = tPage("title")
  const shown = pending != null ? pending || fallback : name
  if (editing) {
    return (
      <input
        ref={input}
        dir="auto"
        value={draft}
        maxLength={NAME_MAX}
        placeholder={agent?.kind === "primary" ? fallback : undefined}
        aria-label={tEdit("name")}
        data-pa-aux-head-name-input
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        {...ime.props}
        onKeyDown={(e) => {
          // Not while a word is being composed (an input method's Enter
          // picks it — WebKit's says so only by its key code).
          if (e.key === "Enter" && !ime.isComposing(e)) {
            e.preventDefault()
            commit()
          }
        }}
        className={cn(
          "w-full min-w-0 border border-input bg-background text-center font-semibold outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50",
          hero
            ? "h-11 max-w-xs rounded-xl px-3 text-2xl leading-9 tracking-tight"
            : "h-8 max-w-60 rounded-full px-3 text-base leading-6"
        )}
      />
    )
  }
  const Heading = hero ? "h1" : "h2"
  if (!editable) {
    return (
      <Heading
        title={shown}
        className={cn(
          "max-w-full truncate font-semibold",
          hero ? "text-2xl leading-9 tracking-tight" : "text-base leading-6"
        )}
      >
        {shown}
      </Heading>
    )
  }
  return (
    <Heading className="flex max-w-full min-w-0">
      <button
        type="button"
        title={`${shown}\n${t("rename")}`}
        aria-label={`${shown} · ${t("rename")}`}
        data-pa-aux-head-name
        onClick={() => {
          ended.current = false
          setDraft(pending ?? saved)
        }}
        className={cn(
          "max-w-full min-w-0 truncate font-semibold transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50",
          hero
            ? "h-11 rounded-xl px-3 text-2xl leading-9 tracking-tight hover:bg-muted/70"
            : "h-8 rounded-full px-3 text-base leading-6"
        )}
      >
        {shown}
      </button>
    </Heading>
  )
}

/** "Notify me" (10.10): whether it notifies the owner when it is done or
 *  waits for them — the roster's switch, a bell pressed while it does. */
function NotifyToggle({
  snapshot,
  className,
}: {
  snapshot: PersonalAgentSnapshot
  className?: string
}) {
  const t = useTranslations("PersonalAgent.detail")
  const { botId } = usePersonalAgent()
  const readOnly = snapshot.status.engine !== "here"
  const entry = usePersonalAgentRoster((s) =>
    s.entries?.find((e) => e.id === (snapshot.agent?.id ?? botId))
  )
  useRoster()
  const on = entry?.roster.notify ?? true
  const label = `${t("notify")} · ${on ? t("notifyOn") : t("notifyOff")}`
  return (
    <Toggle
      size="sm"
      pressed={on}
      disabled={readOnly || !entry}
      onPressedChange={(next) => {
        if (!entry) return
        void personalAgentRosterAct(entry.id, {
          act: "notify",
          on: next,
        }).catch((e) => toast.error(toErrorMessage(e)))
      }}
      aria-label={t("notify")}
      title={`${label}\n${t("notifyHint")}`}
      data-pa-detail-notify={on ? "on" : "off"}
      className={cn(
        "size-8 min-w-8 px-0 text-muted-foreground aria-pressed:bg-transparent aria-pressed:text-foreground hover:aria-pressed:bg-muted",
        className
      )}
    >
      {on ? <Bell aria-hidden /> : <BellOff aria-hidden />}
    </Toggle>
  )
}
