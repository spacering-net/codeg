"use client"

/**
 * Who an assistant is, at the head of its own page — laid out as the first
 * setup has it: its face alive over its glow, its name under it, what it
 * is and what it does now, and on to its conversation. Its face is changed
 * where it is (the face editor's bubble, saved at once) and so is its name
 * (pressed, a field in its place, as the side panel's head has it).
 */

import { useTranslations } from "next-intl"
import { ArrowRight, MessageCircle } from "lucide-react"

import { Button } from "@/components/ui/button"
import type {
  BotAvatar as BotAvatarValue,
  BotLook,
  PersonalAgentSnapshot,
} from "@/lib/types"
import { cn } from "@/lib/utils"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

import { HeadName } from "../aux-parts/aux-head"
import { BotAvatar } from "../bot-avatar"
import { BotFacePicker } from "../bot-face-picker"

/** The face at the head of the page, in px at 100% zoom. */
const HERO_FACE = 88

/** The dot by what it does now: busy, wanting the owner, done, gone wrong,
 *  or at rest. */
const LOOK_DOT: Record<BotLook, string> = {
  idle: "bg-muted-foreground/40",
  sleeping: "bg-muted-foreground/40",
  thinking: "bg-sky-500 motion-safe:animate-pulse",
  working: "bg-sky-500 motion-safe:animate-pulse",
  waiting: "bg-amber-500",
  stuck: "bg-amber-500",
  done: "bg-emerald-500",
  failed: "bg-destructive",
}

export function BotHero({
  read,
  name,
  avatar,
  onAvatar,
  resetTo,
  primary,
  subtitle,
  look,
  readOnly,
}: {
  /** The assistant as read; `null` while it is read (its roster row
   *  shows meanwhile). */
  read: PersonalAgentSnapshot | null
  name: string
  /** Its face as shown (one being saved, too). */
  avatar: BotAvatarValue | null
  /** A face picked; `undefined` where it cannot be changed. */
  onAvatar?: (face: BotAvatarValue) => void
  /** What its face editor's [Reset] goes back to. */
  resetTo?: BotAvatarValue | null
  primary: boolean
  subtitle: string
  look: BotLook | null
  readOnly: boolean
}) {
  const t = useTranslations("PersonalAgent")
  const tp = useTranslations("PersonalAgent.botPage")
  const showConversation = usePersonalAgentUi((s) => s.showConversation)
  const agent = read?.agent ?? null
  return (
    <div
      className="flex w-full flex-col items-center text-center"
      data-pa-bot-page-head
      data-pa-face-host
    >
      <div className="relative">
        <span aria-hidden className="pa-setup-halo" />
        {onAvatar && avatar ? (
          <BotFacePicker
            value={avatar}
            name={name || t("title")}
            onChange={onAvatar}
            disabled={readOnly}
            resetTo={resetTo}
            size={HERO_FACE}
            look={look ?? undefined}
            star={primary}
          />
        ) : (
          <BotAvatar
            avatar={avatar}
            name={name}
            size={HERO_FACE}
            star={primary}
            look={look ?? undefined}
          />
        )}
      </div>
      <div className="mt-7 flex w-full justify-center">
        {read && agent ? (
          <HeadName
            // Another assistant's: its own, from what is saved.
            key={agent.id}
            snapshot={read}
            name={name}
            hero
          />
        ) : (
          <h1
            title={name}
            className="max-w-full truncate text-2xl leading-9 font-semibold tracking-tight"
          >
            {name}
          </h1>
        )}
      </div>
      <p
        className="mt-1 max-w-full truncate text-sm leading-5 text-muted-foreground"
        data-pa-bot-page-subtitle
      >
        {subtitle}
      </p>
      {look ? (
        <p
          className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-background/70 px-2.5 py-0.5 text-xs leading-5 text-muted-foreground"
          data-pa-bot-page-look={look}
        >
          <span
            aria-hidden
            className={cn("size-1.5 rounded-full", LOOK_DOT[look])}
          />
          {t(`face.${look}` as "face.idle")}
        </p>
      ) : null}
      {name ? (
        <Button
          type="button"
          size="lg"
          onClick={showConversation}
          className="group/chat mt-8 h-11 w-full max-w-xs rounded-full text-[0.9375rem]"
          data-pa-bot-page-chat
        >
          <MessageCircle aria-hidden />
          <span className="truncate">{tp("chat")}</span>
          <ArrowRight
            className="transition-transform group-hover/chat:translate-x-0.5 rtl:rotate-180 rtl:group-hover/chat:-translate-x-0.5"
            aria-hidden
          />
        </Button>
      ) : null}
    </div>
  )
}
