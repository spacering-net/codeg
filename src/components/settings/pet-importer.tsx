"use client"

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Loader2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { importCodexPets, listImportableCodexPets } from "@/lib/pet/api"
import type { ImportablePet } from "@/lib/pet/types"

interface PetImporterProps {
  open: boolean
  onClose: () => void
  onDone: () => Promise<void> | void
}

export function PetImporter({ open, onClose, onDone }: PetImporterProps) {
  const t = useTranslations("Pet.import")
  const [items, setItems] = useState<ImportablePet[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [overwriteWithSuffix, setOverwriteWithSuffix] = useState(true)
  const [resultMessage, setResultMessage] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    setResultMessage(null)
    try {
      const list = await listImportableCodexPets()
      setItems(list)
      setSelected(
        new Set(list.filter((p) => !p.alreadyImported).map((p) => p.id))
      )
    } catch (err) {
      setError(toMessage(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- importable pet list fetch on open
    if (open) void refresh()
  }, [open, refresh])

  const toggle = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }

  const toggleAll = () => {
    if (selected.size === items.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(items.map((p) => p.id)))
    }
  }

  const handleImport = async () => {
    setSubmitting(true)
    setError(null)
    try {
      const result = await importCodexPets({
        ids: Array.from(selected),
        overwriteWithSuffix,
      })
      setResultMessage(t("imported"))
      await onDone()
      if (result.skipped.length > 0) {
        setResultMessage(`${t("imported")} (${result.importedIds.length})`)
      }
    } catch (err) {
      setError(toMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("subtitle")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          ) : items.length === 0 ? (
            <div className="rounded-md border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground">
              {t("noneFound")}
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={toggleAll}
                >
                  {t("selectAll")}
                </Button>
                <div className="flex items-center gap-2 text-xs">
                  <Switch
                    id="overwrite-suffix"
                    checked={overwriteWithSuffix}
                    onCheckedChange={setOverwriteWithSuffix}
                  />
                  <Label htmlFor="overwrite-suffix" className="text-xs">
                    {t("renameOnConflict")}
                  </Label>
                </div>
              </div>
              <div className="max-h-72 space-y-1 overflow-auto">
                {items.map((p) => (
                  <label
                    key={p.id}
                    className="flex cursor-pointer items-center gap-2 rounded border border-border px-2 py-1.5 hover:bg-accent"
                  >
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={selected.has(p.id)}
                      onChange={() => toggle(p.id)}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">
                        {p.displayName}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {p.id}
                      </div>
                    </div>
                    {p.alreadyImported ? (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-3xs text-muted-foreground">
                        {t("alreadyImported")}
                      </span>
                    ) : null}
                  </label>
                ))}
              </div>
            </>
          )}

          {error ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
              {error}
            </div>
          ) : null}
          {resultMessage ? (
            <div className="rounded-md border border-primary/40 bg-primary/10 px-2 py-1.5 text-xs text-primary">
              {resultMessage}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("close")}
          </Button>
          <Button
            type="button"
            onClick={handleImport}
            disabled={submitting || selected.size === 0}
          >
            {t("import")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
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
