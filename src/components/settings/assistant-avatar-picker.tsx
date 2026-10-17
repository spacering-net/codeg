"use client"

/**
 * The assistant editor's avatar picker: a popover with three pages — the
 * name's monogram, an emoji, or an uploaded picture — and the ten-colour
 * palette under the first two. An upload is cropped and scaled client-side
 * (`imageFileToAvatarDataUrl`) and stored as a data URL.
 */

import { useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Check, ImageUp, Pencil } from "lucide-react"

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
import {
  AvatarImageError,
  avatarEmojiFrom,
  imageFileToAvatarDataUrl,
} from "@/lib/assistant-avatar"
import {
  ASSISTANT_AVATAR_COLORS,
  type AssistantAvatar as AssistantAvatarValue,
  type AssistantAvatarColor,
} from "@/lib/types"
import { cn } from "@/lib/utils"

/** A handful of common picks; anything else can be typed or pasted. */
export const EMOJI_CHOICES = [
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
  "📐",
  "🚀",
  "⚡",
  "🔥",
  "✨",
  "🎯",
  "🧩",
  "🛡️",
  "🔒",
  "🐛",
  "🧹",
  "♻️",
  "🧭",
  "🗺️",
  "🏗️",
  "🧱",
  "⚙️",
  "💡",
  "🎨",
  "✍️",
  "🗣️",
  "📣",
  "🔔",
  "📦",
  "🧾",
  "🌐",
  "🖥️",
  "📱",
  "☁️",
  "🗄️",
  "🔗",
  "🧮",
  "⏱️",
  "🌱",
  "🌊",
  "🌙",
  "☀️",
] as const

type Page = "monogram" | "emoji" | "image"

export interface AssistantAvatarPickerProps {
  avatar: AssistantAvatarValue
  /** The name a monogram is drawn from. */
  name: string
  onChange: (avatar: AssistantAvatarValue) => void
  disabled?: boolean
}

function colorOf(avatar: AssistantAvatarValue): AssistantAvatarColor {
  return avatar.kind === "image" ? "slate" : avatar.color
}

export function AssistantAvatarPicker({
  avatar,
  name,
  onChange,
  disabled,
}: AssistantAvatarPickerProps) {
  const t = useTranslations("AcpAgentSettings.multiAgent.assistants")
  const [open, setOpen] = useState(false)
  const [page, setPage] = useState<Page>(avatar.kind)
  const [customEmoji, setCustomEmoji] = useState("")
  const [imageError, setImageError] = useState<string | null>(null)
  const [processing, setProcessing] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)
  /** Bumped by every pick, so an upload still being scaled when the user
   *  picks something else is dropped instead of replacing that pick. */
  const pickSeq = useRef(0)
  const color = colorOf(avatar)

  const pick = (next: AssistantAvatarValue) => {
    pickSeq.current += 1
    onChange(next)
  }

  const pickColor = (next: AssistantAvatarColor) => {
    if (avatar.kind === "emoji") pick({ ...avatar, color: next })
    else pick({ kind: "monogram", color: next })
  }

  const pickEmoji = (text: string) => {
    const emoji = avatarEmojiFrom(text)
    if (emoji) pick({ kind: "emoji", emoji, color })
  }

  const onFile = async (file: File | undefined) => {
    if (!file) return
    const seq = ++pickSeq.current
    setImageError(null)
    setProcessing(true)
    try {
      const dataUrl = await imageFileToAvatarDataUrl(file)
      if (pickSeq.current === seq)
        onChange({ kind: "image", data_url: dataUrl })
    } catch (err) {
      if (pickSeq.current === seq) {
        setImageError(
          err instanceof AvatarImageError && err.reason === "too_large"
            ? t("avatarTooLarge")
            : t("avatarUnreadable")
        )
      }
    } finally {
      setProcessing(false)
      if (fileRef.current) fileRef.current.value = ""
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setPage(avatar.kind)
      }}
    >
      <PopoverTrigger asChild>
        {/* The pencil chip is what says "this picture can be changed" — a bare
            avatar reads as decoration, not as a control. */}
        <button
          type="button"
          disabled={disabled}
          aria-label={t("avatarChange")}
          title={t("avatarChange")}
          className="group/avatar relative shrink-0 rounded-full outline-none ring-offset-background transition focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
        >
          <AssistantAvatar avatar={avatar} name={name} size={48} />
          <span
            aria-hidden
            className="absolute -end-0.5 -bottom-0.5 flex size-5 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-sm transition-colors group-hover/avatar:text-foreground"
          >
            <Pencil className="size-2.5" />
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-3">
        <Tabs value={page} onValueChange={(v) => setPage(v as Page)}>
          <TabsList className="w-full">
            <TabsTrigger value="monogram" className="flex-1">
              {t("avatarMonogram")}
            </TabsTrigger>
            <TabsTrigger value="emoji" className="flex-1">
              {t("avatarEmoji")}
            </TabsTrigger>
            <TabsTrigger value="image" className="flex-1">
              {t("avatarImage")}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="monogram" className="pt-3">
            <div className="flex items-center gap-3">
              <AssistantAvatar
                avatar={{ kind: "monogram", color }}
                name={name}
                size={40}
              />
              <p className="text-xs text-muted-foreground">
                {t("avatarMonogramHint")}
              </p>
            </div>
            {avatar.kind !== "monogram" ? (
              <Button
                size="sm"
                variant="outline"
                className="mt-3"
                onClick={() => pick({ kind: "monogram", color })}
              >
                {t("avatarUseMonogram")}
              </Button>
            ) : null}
          </TabsContent>

          <TabsContent value="emoji" className="pt-3">
            <div className="grid grid-cols-8 gap-1">
              {EMOJI_CHOICES.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => pickEmoji(emoji)}
                  className={cn(
                    "flex size-8 items-center justify-center rounded-md text-lg transition hover:bg-accent",
                    avatar.kind === "emoji" &&
                      avatar.emoji === emoji &&
                      "bg-accent ring-1 ring-ring"
                  )}
                  aria-label={emoji}
                >
                  {emoji}
                </button>
              ))}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <Input
                value={customEmoji}
                onChange={(e) => setCustomEmoji(e.target.value)}
                placeholder={t("avatarEmojiPlaceholder")}
                className="h-8 text-sm"
                aria-label={t("avatarEmojiPlaceholder")}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={!avatarEmojiFrom(customEmoji)}
                onClick={() => {
                  pickEmoji(customEmoji)
                  setCustomEmoji("")
                }}
              >
                {t("avatarEmojiUse")}
              </Button>
            </div>
          </TabsContent>

          <TabsContent value="image" className="pt-3">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              data-testid="assistant-avatar-file"
              onChange={(e) => void onFile(e.target.files?.[0])}
            />
            <div className="flex items-center gap-3">
              {avatar.kind === "image" ? (
                <AssistantAvatar avatar={avatar} name={name} size={40} />
              ) : null}
              <Button
                size="sm"
                variant="outline"
                disabled={processing}
                onClick={() => fileRef.current?.click()}
              >
                <ImageUp className="size-3.5" aria-hidden />
                {t("avatarUpload")}
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {t("avatarUploadHint")}
            </p>
            {imageError ? (
              <p className="mt-1 text-xs text-destructive">{imageError}</p>
            ) : null}
          </TabsContent>
        </Tabs>

        {page !== "image" ? (
          <div className="mt-3 border-t pt-3">
            <p className="mb-2 text-xs text-muted-foreground">
              {t("avatarColor")}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {ASSISTANT_AVATAR_COLORS.map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => pickColor(key)}
                  aria-label={key}
                  aria-pressed={color === key && avatar.kind !== "image"}
                  className={cn(
                    "flex size-6 items-center justify-center rounded-full text-white transition hover:scale-110",
                    SWATCH_CLASSES[key]
                  )}
                >
                  {color === key && avatar.kind !== "image" ? (
                    <Check className="size-3.5" aria-hidden />
                  ) : null}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
