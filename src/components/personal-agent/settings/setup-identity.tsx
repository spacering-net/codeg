"use client"

/**
 * The first setup's face and name: the face alive over its glow, a word
 * from it above ("Give me a name?", then "Hi, I'm Nova!"), and its name
 * under it. The face watches the name being typed — its eyes down on the
 * field — and smiles once it has one; a die beside the field offers a name
 * to start from, and the face smiles at that too. Its eyes follow the
 * pointer anywhere round it, not just over it.
 */

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Dices } from "lucide-react"

import { Label } from "@/components/ui/label"
import type { BotAvatar, BotLook } from "@/lib/types"
import { cn } from "@/lib/utils"

import { PRIMARY_FACE } from "../bot-avatar"
import { BotFacePicker } from "../bot-face-picker"

/** How long after the last key the face takes the name as given. */
const SETTLE_MS = 650
/** How long it smiles at a name. */
const SMILE_MS = 1800

/** A name from `list` other than `current` (the list as is when it has
 *  only that one). */
export function anotherName(
  list: readonly string[],
  current: string,
  random: () => number = Math.random
): string {
  const others = list.filter((n) => n !== current.trim())
  const from = others.length > 0 ? others : list
  return from[Math.floor(random() * from.length)] ?? ""
}

export function SetupIdentity({
  avatar,
  name,
  onAvatar,
  onName,
  disabled,
}: {
  avatar: BotAvatar
  name: string
  onAvatar: (next: BotAvatar) => void
  onName: (next: string) => void
  disabled: boolean
}) {
  const t = useTranslations("PersonalAgent.settings")
  const tPage = useTranslations("PersonalAgent")
  const [typing, setTyping] = useState(false)
  const [smiling, setSmiling] = useState(false)
  const [rolls, setRolls] = useState(0)
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null)
  const smile = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (settle.current) clearTimeout(settle.current)
      if (smile.current) clearTimeout(smile.current)
    },
    []
  )

  const smileAt = (given: string) => {
    if (!given.trim()) return
    if (smile.current) clearTimeout(smile.current)
    setSmiling(true)
    smile.current = setTimeout(() => setSmiling(false), SMILE_MS)
  }
  const type = (next: string) => {
    onName(next)
    setTyping(true)
    setSmiling(false)
    if (settle.current) clearTimeout(settle.current)
    settle.current = setTimeout(() => {
      setTyping(false)
      smileAt(next)
    }, SETTLE_MS)
  }
  const roll = () => {
    const names = t("setupNames")
      .split("|")
      .map((n) => n.trim())
      .filter(Boolean)
    const next = anotherName(names, name)
    if (!next) return
    if (settle.current) clearTimeout(settle.current)
    setTyping(false)
    setRolls((r) => r + 1)
    onName(next)
    smileAt(next)
  }

  const shown = name.trim()
  const look: BotLook = smiling ? "done" : typing ? "working" : "idle"

  return (
    // The pointer anywhere here, not just over the face, has its eyes on it
    // (and a hop as it comes): a little way round it on every side.
    <div
      className="-mx-6 -mt-8 flex w-[calc(100%+3rem)] flex-col items-center px-6 pt-8"
      data-pa-face-host
    >
      {/* Its word, over its face: asking for a name, then saying it. */}
      <div
        className="relative z-10 mb-7 max-w-full rounded-2xl border border-border/70 bg-background px-3.5 py-1.5 text-sm leading-6 text-foreground"
        data-pa-setup-bubble
        aria-live="polite"
      >
        <span
          key={shown ? "named" : "unnamed"}
          className="block truncate duration-300 motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95"
        >
          {shown ? t("setupHello", { name: shown }) : t("setupAskName")}
        </span>
        {/* Its tail, pointing down at the face. */}
        <span
          aria-hidden
          className="absolute -bottom-[5px] left-1/2 size-2.5 -translate-x-1/2 rotate-45 border-e border-b border-border/70 bg-background"
        />
      </div>
      <div className="relative">
        <span aria-hidden className="pa-setup-halo" />
        <span aria-hidden className="pa-setup-ripple" />
        <BotFacePicker
          value={avatar}
          name={shown || tPage("title")}
          onChange={onAvatar}
          disabled={disabled}
          size={88}
          look={look}
          resetTo={PRIMARY_FACE}
        />
      </div>
      <Label htmlFor="pa-name" className="sr-only">
        {t("name")}
      </Label>
      <div className="relative mt-10 w-full max-w-xs">
        <input
          id="pa-name"
          dir="auto"
          value={name}
          maxLength={40}
          onChange={(e) => type(e.target.value)}
          onBlur={() => {
            if (!typing) return
            if (settle.current) clearTimeout(settle.current)
            setTyping(false)
            smileAt(name)
          }}
          placeholder={t("namePlaceholder")}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          className="w-full rounded-xl border border-dashed border-transparent bg-transparent px-10 py-1 text-center text-2xl leading-9 font-semibold tracking-tight text-foreground outline-none transition-colors placeholder:text-foreground/35 hover:border-border focus-visible:border-solid focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:opacity-60"
        />
        {/* A name to start from. */}
        <button
          type="button"
          onClick={roll}
          disabled={disabled}
          title={t("setupRandomName")}
          aria-label={t("setupRandomName")}
          className="absolute end-1 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none disabled:opacity-50"
          data-pa-setup-dice
        >
          <Dices
            key={rolls}
            className={cn(
              "size-4",
              rolls > 0 && "motion-safe:animate-[pa-setup-roll_500ms_ease-out]"
            )}
            aria-hidden
          />
        </button>
      </div>
    </div>
  )
}
