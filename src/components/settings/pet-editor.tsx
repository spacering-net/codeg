"use client"

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Upload } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import {
  addPet,
  replacePetSprite,
  slugifyPetId,
  updatePetMeta,
} from "@/lib/pet/api"
import type { PetSummary } from "@/lib/pet/types"

interface PetEditorProps {
  open: boolean
  target: PetSummary | null
  onClose: () => void
  onSaved: () => Promise<void> | void
}

export function PetEditor({ open, target, onClose, onSaved }: PetEditorProps) {
  const t = useTranslations("Pet.manager")
  const [id, setId] = useState("")
  const [displayName, setDisplayName] = useState("")
  const [description, setDescription] = useState("")
  const [spritesheet, setSpritesheet] = useState<{
    base64: string
    name: string
  } | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const idTouched = useRef(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!open) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- form seeding when the parent opens the editor (also resets the idTouched ref)
    setError(null)
    setSpritesheet(null)
    if (target) {
      setId(target.id)
      setDisplayName(target.displayName)
      setDescription(target.description ?? "")
      idTouched.current = true
    } else {
      setId("")
      setDisplayName("")
      setDescription("")
      idTouched.current = false
    }
  }, [open, target])

  const onChooseFile = async (file: File) => {
    setError(null)
    if (file.size > 16 * 1024 * 1024) {
      setError(t("errors.missingSpritesheet"))
      return
    }
    const buffer = await file.arrayBuffer()
    const bytes = new Uint8Array(buffer)
    const base64 = arrayBufferToBase64(bytes)
    setSpritesheet({ base64, name: file.name })
  }

  const handleSubmit = async () => {
    setError(null)
    if (!target) {
      if (!id.trim()) {
        setError(t("errors.missingId"))
        return
      }
      if (!displayName.trim()) {
        setError(t("errors.missingName"))
        return
      }
      if (!spritesheet) {
        setError(t("errors.missingSpritesheet"))
        return
      }
      setSubmitting(true)
      try {
        await addPet({
          id: id.trim(),
          displayName: displayName.trim(),
          description: description.trim() || null,
          spritesheetBase64: spritesheet.base64,
        })
        await onSaved()
      } catch (err) {
        setError(toMessage(err))
      } finally {
        setSubmitting(false)
      }
    } else {
      if (!displayName.trim()) {
        setError(t("errors.missingName"))
        return
      }
      setSubmitting(true)
      try {
        await updatePetMeta(target.id, {
          displayName: displayName.trim(),
          description: description.trim() ? description.trim() : null,
        })
        if (spritesheet) {
          await replacePetSprite(target.id, spritesheet.base64)
        }
        await onSaved()
      } catch (err) {
        setError(toMessage(err))
      } finally {
        setSubmitting(false)
      }
    }
  }

  const isCreate = !target
  const fileButtonLabel = isCreate
    ? t("form.chooseFile")
    : t("form.replaceFile")

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isCreate ? t("addPet") : t("edit")}</DialogTitle>
          <DialogDescription>{t("specRequirement")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="pet-id">{t("form.id")}</Label>
            <Input
              id="pet-id"
              value={id}
              onChange={(e) => {
                idTouched.current = true
                setId(slugifyPetId(e.target.value))
              }}
              disabled={!isCreate}
              placeholder="my-pet"
            />
            <p className="text-xs text-muted-foreground">{t("form.idHelp")}</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pet-name">{t("form.displayName")}</Label>
            <Input
              id="pet-name"
              value={displayName}
              onChange={(e) => {
                setDisplayName(e.target.value)
                if (isCreate && !idTouched.current) {
                  setId(slugifyPetId(e.target.value))
                }
              }}
              placeholder="My Pet"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pet-desc">{t("form.description")}</Label>
            <Textarea
              id="pet-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="resize-none break-all"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pet-sprite">{t("form.spritesheet")}</Label>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload className="mr-1 h-3.5 w-3.5" />
                {fileButtonLabel}
              </Button>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {spritesheet?.name ?? ""}
              </span>
            </div>
            <input
              ref={fileInputRef}
              id="pet-sprite"
              type="file"
              accept=".webp,.png,image/webp,image/png"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) void onChooseFile(file)
              }}
            />
          </div>
          {error ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
              {error}
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={submitting}
          >
            {t("form.cancel")}
          </Button>
          <Button type="button" onClick={handleSubmit} disabled={submitting}>
            {isCreate ? t("form.saveCreate") : t("form.saveUpdate")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function arrayBufferToBase64(bytes: Uint8Array): string {
  let binary = ""
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + chunk))
    )
  }
  return btoa(binary)
}

function toMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === "string") return err
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message: unknown }).message
    if (typeof m === "string") return m
  }
  return String(err)
}
