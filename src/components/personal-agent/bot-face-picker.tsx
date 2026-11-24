"use client"

/**
 * An assistant's face, and the bubble that edits it (10.6): pressed — "Edit
 * avatar" over it under the pointer — it opens under it with three pages
 * and [Reset] at the end of their row:
 *
 * - "Bot": one of the thirteen shapes, in one of the eleven colours, each
 *   taken at once;
 * - "Text": a face made of a character — its name's first, or an emoji
 *   picked or typed — on one of the ten colours;
 * - "Upload": a picture dropped, pasted (anywhere in the bubble) or picked,
 *   framed in a round window — moved and zoomed — and [Set as avatar].
 *
 * [Reset] goes back to the face it was given by default. The same bubble
 * on the side panel's head, an assistant's own page, the first setup and
 * the "new work assistant" box.
 */

import { useRef, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { Tooltip as TooltipPrimitive } from "radix-ui"

import {
  AssistantAvatar,
  SWATCH_CLASSES,
} from "@/components/assistants/assistant-avatar"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useImeGuard } from "@/hooks/use-ime-guard"
import { avatarEmojiFrom } from "@/lib/assistant-avatar"
import {
  ASSISTANT_AVATAR_COLORS,
  type AssistantAvatarColor,
  type BotAvatar as BotAvatarValue,
  type BotColor,
  type BotLook,
} from "@/lib/types"
import { cn } from "@/lib/utils"

import { BOT_COLORS, BOT_SHAPES, BotAvatar } from "./bot-avatar"
import { shapeOf } from "./bot-shapes"
import {
  FaceUpload,
  pastedImage,
  useOsImageDrop,
  usePicture,
} from "./face-upload"

/** The swatch of each colour, as the face draws it. */
const SWATCH: Record<BotColor, string> = {
  black: "bg-neutral-900 dark:bg-neutral-200",
  brown: "bg-amber-800 dark:bg-amber-600",
  red: "bg-red-500 dark:bg-red-400",
  orange: "bg-orange-500 dark:bg-orange-400",
  yellow: "bg-yellow-400 dark:bg-yellow-300",
  green: "bg-green-500 dark:bg-green-400",
  teal: "bg-teal-500 dark:bg-teal-400",
  blue: "bg-blue-500 dark:bg-blue-400",
  purple: "bg-violet-500 dark:bg-violet-400",
  magenta: "bg-fuchsia-500 dark:bg-fuchsia-400",
  gray: "bg-slate-400 dark:bg-slate-500",
}

/** A face's colour, on the "Text" page: the nearest of its ten. */
const NEAREST: Record<BotColor, AssistantAvatarColor> = {
  black: "slate",
  brown: "amber",
  red: "red",
  orange: "orange",
  yellow: "amber",
  green: "green",
  teal: "teal",
  blue: "blue",
  purple: "violet",
  magenta: "pink",
  gray: "slate",
}

/** The emoji the "Text" page offers beside the name's first
 *  character; any other can be typed. */
/** The emoji offered as faces; anything else can be typed or pasted. */
const EMOJI_OFFERED = [
  "🤖",
  "🧠",
  "🦉",
  "🦊",
  "🐙",
  "🐝",
  "🦄",
  "🐳",
  "🧑‍💻",
  "👩‍🔬",
  "🕵️",
  "🧙",
  "🥷",
  "🧑‍🏫",
  "🧑‍🎨",
  "🧑‍🔧",
  "🔍",
  "🛠️",
  "🧪",
  "📝",
  "📚",
  "🗂️",
  "📊",
] as const

type Page = "bot" | "make" | "upload"

function pageOf(face: BotAvatarValue): Page {
  if (face.kind === "face") return "bot"
  if (face.kind === "image") return "upload"
  return "make"
}

function same(a: BotAvatarValue | null | undefined, b: BotAvatarValue) {
  return a != null && JSON.stringify(a) === JSON.stringify(b)
}

/** The ring round what is picked. */
const PICKED = "ring-[1.5px] ring-border ring-offset-2 ring-offset-popover"

export interface FacePickerProps {
  value: BotAvatarValue
  name: string
  /** A face picked — at once on the first two pages, on [Set as avatar]
   *  on the third. */
  onChange: (next: BotAvatarValue) => void
  disabled?: boolean
  /** What [Reset] goes back to; no [Reset] without one. */
  resetTo?: BotAvatarValue | null
}

/** The bubble's pages. */
export function FaceEditor({
  value,
  name,
  onChange,
  disabled,
  resetTo,
  onDone,
}: FacePickerProps & {
  /** A picture set: the bubble may close. */
  onDone?: () => void
}) {
  const t = useTranslations("PersonalAgent.bots.face")
  const [page, setPage] = useState<Page>(() => pageOf(value))
  const picture = usePicture()
  const host = useRef<HTMLDivElement | null>(null)
  const lastDomDrop = useRef(0)
  const takeDropped = (file: Blob | Promise<Blob>, fileName: string) => {
    if (disabled) return
    setPage("upload")
    void picture.take(file, fileName)
  }
  useOsImageDrop(host, takeDropped, lastDomDrop)
  return (
    // A drag in it (the picture in its window) is its own, not a swipe of
    // the drawer it may be in.
    <div
      ref={host}
      data-pa-face-editor
      data-base-ui-swipe-ignore
      onPaste={(e) => {
        const file = pastedImage(e)
        if (!file) return
        e.preventDefault()
        takeDropped(file, file.name)
      }}
    >
      <Tabs
        value={page}
        onValueChange={(v) => setPage(v as Page)}
        className="gap-0"
      >
        <div className="flex items-center gap-2 border-b border-border/70 px-3 py-2.5">
          <TabsList className="h-auto gap-1 bg-transparent p-0 group-data-horizontal/tabs:h-auto">
            {(["bot", "make", "upload"] as const).map((p) => (
              <TabsTrigger
                key={p}
                value={p}
                data-pa-face-page={p}
                className="h-8 flex-none rounded-full px-3.5 text-sm font-normal data-active:bg-muted data-active:shadow-none dark:data-active:border-transparent dark:data-active:bg-muted"
              >
                {t(`pages.${p}`)}
              </TabsTrigger>
            ))}
          </TabsList>
          {resetTo ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ms-auto rounded-full px-3 font-normal text-muted-foreground"
              disabled={disabled || same(value, resetTo)}
              onClick={() => {
                picture.clear()
                setPage(pageOf(resetTo))
                onChange(resetTo)
              }}
              data-pa-face-reset
            >
              {t("reset")}
            </Button>
          ) : null}
        </div>
        <TabsContent value="bot" className="p-4">
          <BotPage
            value={value}
            name={name}
            onChange={onChange}
            disabled={disabled}
          />
        </TabsContent>
        <TabsContent value="make" className="p-4">
          <MakePage
            value={value}
            name={name}
            onChange={onChange}
            disabled={disabled}
          />
        </TabsContent>
        <TabsContent value="upload" className="p-4">
          <FaceUpload
            state={picture}
            disabled={disabled}
            onDomDrop={() => {
              lastDomDrop.current = Date.now()
            }}
            onSet={(dataUrl) => {
              onChange({ kind: "image", data_url: dataUrl })
              picture.clear()
              onDone?.()
            }}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function BotPage({ value, name, onChange, disabled }: FacePickerProps) {
  const t = useTranslations("PersonalAgent.bots.face")
  const color: BotColor = value.kind === "face" ? value.color : "blue"
  return (
    <div className="flex flex-col gap-5">
      <div
        role="group"
        aria-label={t("shape")}
        className="flex flex-wrap justify-center gap-x-[calc((100%-15rem-1px)/4)] gap-y-3"
      >
        {BOT_SHAPES.map((s) => {
          const on = value.kind === "face" && shapeOf(value.shape) === s
          return (
            <button
              key={s}
              type="button"
              disabled={disabled}
              data-pa-shape={s}
              aria-pressed={on}
              aria-label={t(`shapes.${s}`)}
              title={t(`shapes.${s}`)}
              onClick={() => onChange({ kind: "face", shape: s, color })}
              className={cn(
                "flex size-12 items-center justify-center rounded-xl transition-colors hover:bg-muted disabled:opacity-50",
                on && "ring-[1.5px] ring-border"
              )}
            >
              <BotAvatar
                avatar={{ kind: "face", shape: s, color }}
                name={name}
                size={36}
              />
            </button>
          )
        })}
      </div>
      <div
        role="group"
        aria-label={t("color")}
        className="flex flex-wrap justify-center gap-x-[calc((100%-12rem-1px)/5)] gap-y-3"
      >
        {BOT_COLORS.map((c) => {
          const on = value.kind === "face" && value.color === c
          return (
            <button
              key={c}
              type="button"
              disabled={disabled}
              data-pa-color={c}
              aria-pressed={on}
              aria-label={t(`colors.${c}`)}
              title={t(`colors.${c}`)}
              onClick={() =>
                onChange({
                  kind: "face",
                  shape:
                    value.kind === "face" ? shapeOf(value.shape) : "terminal",
                  color: c,
                })
              }
              className={cn(
                "size-8 rounded-full transition-transform hover:scale-110 disabled:opacity-50",
                SWATCH[c],
                on && PICKED
              )}
            />
          )
        })}
      </div>
    </div>
  )
}

function MakePage({ value, name, onChange, disabled }: FacePickerProps) {
  const t = useTranslations("PersonalAgent.bots.face")
  const [typed, setTyped] = useState("")
  const ime = useImeGuard()
  const color: AssistantAvatarColor =
    value.kind === "monogram" || value.kind === "emoji"
      ? value.color
      : value.kind === "face"
        ? NEAREST[value.color]
        : "slate"
  const tile = (
    key: string,
    avatar: BotAvatarValue,
    label: string,
    on: boolean,
    attrs: Record<string, string>
  ): ReactNode => (
    <button
      key={key}
      type="button"
      disabled={disabled}
      aria-pressed={on}
      aria-label={label}
      title={label}
      onClick={() => onChange(avatar)}
      className={cn(
        "flex size-10 items-center justify-center rounded-xl transition-colors hover:bg-muted disabled:opacity-50",
        on && "ring-[1.5px] ring-border"
      )}
      {...attrs}
    >
      <AssistantAvatar
        avatar={avatar.kind === "face" ? null : avatar}
        name={name}
        size={30}
      />
    </button>
  )
  const use = () => {
    const emoji = avatarEmojiFrom(typed)
    if (!emoji) return
    onChange({ kind: "emoji", emoji, color })
    setTyped("")
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-6 justify-items-center gap-1.5">
        {tile(
          "monogram",
          { kind: "monogram", color },
          t("monogram"),
          value.kind === "monogram",
          { "data-pa-face-monogram": "" }
        )}
        {EMOJI_OFFERED.map((emoji) =>
          tile(
            emoji,
            { kind: "emoji", emoji, color },
            emoji,
            value.kind === "emoji" && value.emoji === emoji,
            { "data-pa-face-emoji": emoji }
          )
        )}
      </div>
      {/* No form of its own: its submit would reach the form round the
          bubble (the new assistant's, the first setup's) and send that. */}
      <div className="flex items-center gap-2">
        <Input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          {...ime.props}
          onKeyDown={(e) => {
            // Not the Enter that picks an input method's word.
            if (e.key !== "Enter" || ime.isComposing(e)) return
            e.preventDefault()
            e.stopPropagation()
            use()
          }}
          placeholder={t("typeOne")}
          aria-label={t("typeOne")}
          disabled={disabled}
          className="h-8 rounded-full text-sm"
          data-pa-face-typed
        />
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="rounded-full"
          disabled={disabled || !avatarEmojiFrom(typed)}
          onClick={use}
        >
          {t("useIt")}
        </Button>
      </div>
      <div
        role="group"
        aria-label={t("color")}
        className="flex flex-wrap justify-center gap-x-[calc((100%-10rem-1px)/4)] gap-y-3"
      >
        {ASSISTANT_AVATAR_COLORS.map((c) => {
          const on =
            (value.kind === "monogram" || value.kind === "emoji") &&
            value.color === c
          return (
            <button
              key={c}
              type="button"
              disabled={disabled}
              data-pa-make-color={c}
              aria-pressed={on}
              aria-label={c}
              title={c}
              onClick={() =>
                onChange(
                  value.kind === "emoji"
                    ? { ...value, color: c }
                    : { kind: "monogram", color: c }
                )
              }
              className={cn(
                "size-8 rounded-full transition-transform hover:scale-110 disabled:opacity-50",
                SWATCH_CLASSES[c],
                on && PICKED
              )}
            />
          )
        })}
      </div>
    </div>
  )
}

/** The face, and the bubble behind it. */
export function BotFacePicker({
  value,
  name,
  onChange,
  disabled,
  resetTo,
  size = 48,
  look,
  star,
  align = "center",
  className,
}: FacePickerProps & {
  size?: number
  /** Alive, as the roster's faces are: it blinks and glances about. */
  look?: BotLook
  /** The primary's: its star at the foot. */
  star?: boolean
  align?: "start" | "center" | "end"
  className?: string
}) {
  const t = useTranslations("PersonalAgent.bots.face")
  const [open, setOpen] = useState(false)
  const [hint, setHint] = useState(false)
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setHint(false)
      }}
    >
      <TooltipPrimitive.Provider delayDuration={300}>
        <TooltipPrimitive.Root
          open={hint && !open && !disabled}
          onOpenChange={setHint}
        >
          <TooltipPrimitive.Trigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                disabled={disabled}
                aria-label={t("edit")}
                data-pa-face-picker
                className={cn(
                  "relative shrink-0 rounded-full outline-none ring-offset-background transition focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 enabled:cursor-pointer disabled:opacity-50",
                  className
                )}
              >
                <BotAvatar
                  avatar={value}
                  name={name}
                  size={size}
                  look={look}
                  star={star}
                />
              </button>
            </PopoverTrigger>
          </TooltipPrimitive.Trigger>
          <TooltipPrimitive.Portal>
            <TooltipPrimitive.Content
              side="bottom"
              sideOffset={6}
              data-pa-face-hint
              className="z-50 rounded-xl border border-border/70 bg-popover px-3 py-1 text-sm text-popover-foreground shadow-md duration-150 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0"
            >
              {t("edit")}
            </TooltipPrimitive.Content>
          </TooltipPrimitive.Portal>
        </TooltipPrimitive.Root>
      </TooltipPrimitive.Provider>
      <PopoverContent
        align={align}
        sideOffset={10}
        className="w-80 overflow-hidden rounded-3xl p-0"
        data-pa-face-bubble
      >
        <FaceEditor
          value={value}
          name={name}
          onChange={onChange}
          disabled={disabled}
          resetTo={resetTo}
          onDone={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  )
}
