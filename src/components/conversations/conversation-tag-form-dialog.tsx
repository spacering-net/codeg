"use client"

import { useId, useState } from "react"
import { Check, Loader2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { useImeGuard } from "@/hooks/use-ime-guard"
import {
  toLocalizedErrorMessage,
  type AppErrorTranslator,
} from "@/lib/app-error"
import {
  MAX_TAG_NAME_LENGTH,
  TAG_COLOR_PRESETS,
  TAG_COLOR_STRONG_COUNT,
  normalizeTagColor,
} from "@/lib/conversation-tags"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { ConversationTagChip } from "./conversation-tag-chip"

/**
 * The colour swatches plus a custom-colour well. The presets are the curated
 * rows from `TAG_COLOR_PRESETS` (strong over soft); anything else the native
 * picker returns is shown as the custom well's own colour and ringed there.
 */
export function TagColorPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: string
  onChange: (color: string) => void
  disabled?: boolean
}) {
  const t = useTranslations("ConversationTags.form")
  const normalized = normalizeTagColor(value) ?? value
  const isPreset = (TAG_COLOR_PRESETS as readonly string[]).includes(normalized)
  const rows = [
    TAG_COLOR_PRESETS.slice(0, TAG_COLOR_STRONG_COUNT),
    TAG_COLOR_PRESETS.slice(TAG_COLOR_STRONG_COUNT),
  ]
  return (
    <div className="flex items-start gap-3">
      <div className="grid gap-1.5" role="radiogroup" aria-label={t("color")}>
        {rows.map((row, idx) => (
          <div key={idx} className="flex gap-1.5">
            {row.map((color) => {
              const active = color === normalized
              return (
                <button
                  key={color}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-label={color}
                  title={color}
                  disabled={disabled}
                  onClick={() => onChange(color)}
                  className={cn(
                    "flex size-5 cursor-pointer items-center justify-center rounded-full border border-black/10 outline-none dark:border-white/15",
                    "transition-transform duration-100 hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                    "disabled:cursor-not-allowed disabled:opacity-50",
                    active &&
                      "ring-2 ring-foreground/70 ring-offset-1 ring-offset-background"
                  )}
                  style={{ backgroundColor: color }}
                >
                  {active ? (
                    <Check
                      aria-hidden
                      className={cn(
                        "size-3",
                        // The strong row is dark enough for a white check, the
                        // soft row is not.
                        TAG_COLOR_PRESETS.indexOf(color) <
                          TAG_COLOR_STRONG_COUNT
                          ? "text-white"
                          : "text-black/70"
                      )}
                    />
                  ) : null}
                </button>
              )
            })}
          </div>
        ))}
      </div>
      <label
        className={cn(
          "relative flex size-[2.875rem] shrink-0 cursor-pointer items-center justify-center rounded-xl border border-dashed border-border",
          !isPreset &&
            "border-solid ring-2 ring-foreground/70 ring-offset-1 ring-offset-background",
          disabled && "cursor-not-allowed opacity-50"
        )}
        title={t("customColor")}
        style={isPreset ? undefined : { backgroundColor: normalized }}
      >
        {/* The native well, stretched invisibly over the tile: clicking
            anywhere on the tile opens the platform colour panel. */}
        <input
          type="color"
          aria-label={t("customColor")}
          disabled={disabled}
          value={normalizeTagColor(value) ?? "#000000"}
          onChange={(e) => {
            const next = normalizeTagColor(e.target.value)
            if (next) onChange(next)
          }}
          className="absolute inset-0 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
        />
        {isPreset ? (
          <span
            aria-hidden
            className="size-5 rounded-full"
            style={{
              background:
                "conic-gradient(#cf222e, #9a6700, #1a7f37, #0f766e, #0969da, #8250df, #bf3989, #cf222e)",
            }}
          />
        ) : null}
      </label>
    </div>
  )
}

export interface TagFormValues {
  name: string
  color: string
  /** `null` = global; otherwise the folder the tag belongs to. */
  folderId: number | null
}

/**
 * Create or edit one tag: name, colour, and — when creating from somewhere a
 * folder is in play — whether it is global or that folder's own. A tag never
 * changes scope after it exists, so editing shows no scope choice.
 *
 * `onSubmit` resolves to close the dialog; a rejection keeps it open with the
 * backend's (localized, when it says why) message under the fields.
 */
export function ConversationTagFormDialog({
  open,
  onOpenChange,
  mode,
  initial,
  folderOption,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: "create" | "edit"
  initial: TagFormValues
  /** When creating: the folder the tag could instead belong to, with the label
   *  to show for it. Omitted = global only (chat mode, the global list). */
  folderOption?: { id: number; label: string } | null
  onSubmit: (values: TagFormValues) => Promise<void>
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[26rem]">
        {/* Mounted per open, so each open starts from what the caller passed
            and never from the last edit. `initial` is read on mount only: the
            caller may recompute it while the dialog is up (another window adds
            a tag, which moves the suggested colour), and that must not wipe
            what the user is typing. */}
        {open ? (
          <TagFormBody
            mode={mode}
            initial={initial}
            folderOption={folderOption ?? null}
            onSubmit={onSubmit}
            onCancel={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function TagFormBody({
  mode,
  initial,
  folderOption,
  onSubmit,
  onCancel,
}: {
  mode: "create" | "edit"
  initial: TagFormValues
  folderOption: { id: number; label: string } | null
  onSubmit: (values: TagFormValues) => Promise<void>
  onCancel: () => void
}) {
  const t = useTranslations("ConversationTags")
  const ime = useImeGuard()
  const nameId = useId()
  const [name, setName] = useState(initial.name)
  const [color, setColor] = useState(initial.color)
  const [folderId, setFolderId] = useState<number | null>(initial.folderId)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const trimmed = name.trim()
  const canSubmit = trimmed.length > 0 && !saving

  const submit = async () => {
    if (!canSubmit) return
    setSaving(true)
    setError(null)
    try {
      await onSubmit({ name: trimmed, color, folderId })
    } catch (err) {
      // The backend's refusals carry `errors.*` keys under this namespace;
      // anything else falls back to its English message inside the helper.
      setError(toLocalizedErrorMessage(err, t as unknown as AppErrorTranslator))
      setSaving(false)
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {mode === "create" ? t("form.createTitle") : t("form.editTitle")}
        </DialogTitle>
      </DialogHeader>
      <div className="grid gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor={nameId} className="text-xs">
            {t("form.name")}
          </Label>
          <Input
            id={nameId}
            value={name}
            maxLength={MAX_TAG_NAME_LENGTH}
            onChange={(e) => {
              setName(e.target.value)
              setError(null)
            }}
            {...ime.props}
            onKeyDown={(e) => {
              // Enter must not commit mid-composition: an IME's candidate
              // Enter would otherwise submit a half-typed name.
              if (ime.isComposing(e)) return
              if (e.key === "Enter") {
                e.preventDefault()
                void submit()
              }
            }}
            placeholder={t("form.namePlaceholder")}
            autoFocus
          />
        </div>
        <div className="grid gap-1.5">
          <span className="text-xs font-medium">{t("form.color")}</span>
          <TagColorPicker value={color} onChange={setColor} disabled={saving} />
        </div>
        {mode === "create" && folderOption ? (
          <div className="grid gap-1.5">
            <span className="text-xs font-medium">{t("form.scope")}</span>
            <RadioGroup
              value={folderId == null ? "global" : "folder"}
              onValueChange={(v) =>
                setFolderId(v === "folder" ? folderOption.id : null)
              }
              className="gap-2"
              disabled={saving}
            >
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <RadioGroupItem value="global" />
                {t("form.scopeGlobal")}
              </label>
              <label className="flex min-w-0 cursor-pointer items-center gap-2 text-sm">
                <RadioGroupItem value="folder" />
                <span className="min-w-0 truncate">
                  {t("form.scopeFolder", { folder: folderOption.label })}
                </span>
              </label>
            </RadioGroup>
          </div>
        ) : null}
        {/* What the chip will look like, in the current theme. */}
        <div className="flex min-h-5 items-center">
          {trimmed ? (
            <ConversationTagChip
              tag={{
                id: -1,
                folder_id: folderId,
                name: trimmed,
                color,
                sort_order: 0,
              }}
            />
          ) : null}
        </div>
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={saving}>
          {t("form.cancel")}
        </Button>
        <Button onClick={() => void submit()} disabled={!canSubmit}>
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {mode === "create" ? t("form.create") : t("form.save")}
        </Button>
      </DialogFooter>
    </>
  )
}
