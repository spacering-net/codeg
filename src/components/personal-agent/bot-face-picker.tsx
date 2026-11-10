"use client"

/**
 * Pick an assistant's face (10.6): one of the twelve shapes, one of the
 * eleven colours, or a picture of the owner's. Inline — the "new assistant"
 * box shows it under the name — or behind its avatar as a popover (the
 * identity page).
 */

import { useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Check, ImageUp, Pencil } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  AvatarImageError,
  imageFileToAvatarDataUrl,
} from "@/lib/assistant-avatar"
import type {
  BotAvatar as BotAvatarValue,
  BotColor,
  BotShape,
} from "@/lib/types"
import { cn } from "@/lib/utils"

import { BOT_COLORS, BOT_SHAPES, BotAvatar } from "./bot-avatar"

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

interface FacePickerProps {
  value: BotAvatarValue
  name: string
  onChange: (next: BotAvatarValue) => void
  disabled?: boolean
}

/** The shape and colour grids, and [Upload a picture]. */
export function BotFaceChoices({
  value,
  name,
  onChange,
  disabled,
}: FacePickerProps) {
  const t = useTranslations("PersonalAgent.bots.face")
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const seq = useRef(0)
  const shape: BotShape = value.kind === "face" ? value.shape : "blob"
  const color: BotColor = value.kind === "face" ? value.color : "blue"
  const pick = (next: BotAvatarValue) => {
    seq.current += 1
    setError(null)
    onChange(next)
  }
  const onFile = async (file: File | undefined) => {
    if (!file) return
    const mine = ++seq.current
    setError(null)
    setBusy(true)
    try {
      const dataUrl = await imageFileToAvatarDataUrl(file)
      if (seq.current === mine) onChange({ kind: "image", data_url: dataUrl })
    } catch (err) {
      if (seq.current === mine)
        setError(
          err instanceof AvatarImageError && err.reason === "too_large"
            ? t("tooLarge")
            : t("unreadable")
        )
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ""
    }
  }
  return (
    <div className="flex flex-col gap-2.5" data-pa-face-choices>
      <div>
        <p className="mb-1.5 text-xs text-muted-foreground">{t("shape")}</p>
        <div className="grid grid-cols-6 gap-1.5">
          {BOT_SHAPES.map((s) => {
            const on = value.kind === "face" && value.shape === s
            return (
              <button
                key={s}
                type="button"
                disabled={disabled}
                data-pa-shape={s}
                aria-pressed={on}
                aria-label={t(`shapes.${s}`)}
                title={t(`shapes.${s}`)}
                onClick={() => pick({ kind: "face", shape: s, color })}
                className={cn(
                  "flex items-center justify-center rounded-md p-1 transition-colors hover:bg-muted disabled:opacity-50",
                  on && "bg-accent ring-1 ring-ring"
                )}
              >
                <BotAvatar
                  avatar={{ kind: "face", shape: s, color }}
                  name={name}
                  size={26}
                />
              </button>
            )
          })}
        </div>
      </div>
      <div>
        <p className="mb-1.5 text-xs text-muted-foreground">{t("color")}</p>
        <div className="flex flex-wrap gap-1.5">
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
                onClick={() => pick({ kind: "face", shape, color: c })}
                className={cn(
                  "flex size-6 items-center justify-center rounded-full transition-transform hover:scale-110 disabled:opacity-50",
                  SWATCH[c]
                )}
              >
                {on ? (
                  <Check
                    className="size-3.5 text-white mix-blend-difference"
                    aria-hidden
                  />
                ) : null}
              </button>
            )
          })}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={disabled || busy}
          onClick={() => fileRef.current?.click()}
        >
          <ImageUp aria-hidden />
          {t("upload")}
        </Button>
        {error ? (
          <span className="text-xs text-destructive">{error}</span>
        ) : null}
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
      </div>
    </div>
  )
}

/** The avatar, with the choices behind it. */
export function BotFacePicker({
  value,
  name,
  onChange,
  disabled,
  size = 48,
}: FacePickerProps & { size?: number }) {
  const t = useTranslations("PersonalAgent.bots.face")
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={t("change")}
          title={t("change")}
          data-pa-face-picker
          className="group/avatar relative shrink-0 rounded-full outline-none ring-offset-background transition focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
        >
          <BotAvatar avatar={value} name={name} size={size} />
          <span
            aria-hidden
            className="absolute -end-0.5 -bottom-0.5 flex size-5 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-sm transition-colors group-hover/avatar:text-foreground"
          >
            <Pencil className="size-2.5" />
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-3">
        <BotFaceChoices
          value={value}
          name={name}
          onChange={onChange}
          disabled={disabled}
        />
      </PopoverContent>
    </Popover>
  )
}
