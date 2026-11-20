"use client"

import { useEffect, useState } from "react"
import { Download, Loader2 } from "lucide-react"
import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { ModelProviderService } from "@/lib/model-provider-service"
import type {
  BuiltinProviderInfo,
  ModelProviderDraft,
} from "@/lib/model-provider-types"

interface BuiltinProviderPickerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  service: ModelProviderService
  /** Called with the clone draft (API key already blank) for the user to fill. */
  onClone: (draft: ModelProviderDraft) => void
}

/** "Import from built-in provider" template picker: clone a curated provider
 *  into an editable custom provider. Credentials are never copied. */
export function BuiltinProviderPicker({
  open,
  onOpenChange,
  service,
  onClone,
}: BuiltinProviderPickerProps) {
  const t = useTranslations("ModelProviderSettings")
  const [builtins, setBuiltins] = useState<BuiltinProviderInfo[] | null>(null)
  const [cloningId, setCloningId] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let alive = true
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate reset: reopening the dialog drops stale rows so the loader shows while refetching
    setBuiltins(null)
    service
      .listBuiltins()
      .then((rows) => {
        if (alive) setBuiltins(rows)
      })
      .catch(() => {
        if (alive) setBuiltins([])
      })
    return () => {
      alive = false
    }
  }, [open, service])

  const handleClone = async (id: string) => {
    setCloningId(id)
    try {
      const draft = await service.cloneBuiltin(id)
      onClone(draft)
    } finally {
      setCloningId(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("pickerTitle")}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{t("pickerDesc")}</p>

        {!builtins ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <ScrollArea className="max-h-80">
            <div className="space-y-2 pr-3">
              {builtins.map((b) => (
                <div
                  key={b.id}
                  className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5"
                >
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{b.id}</span>
                      <Badge
                        variant={b.configured ? "default" : "secondary"}
                        className="text-3xs px-1.5 py-0"
                      >
                        {b.configured ? t("configured") : t("notConfigured")}
                      </Badge>
                    </div>
                    <div className="truncate text-xs text-muted-foreground font-mono">
                      {b.apiType} · {b.baseUrl} · {b.models.length}{" "}
                      {t("modelsCount")}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    className="h-7 shrink-0 text-xs"
                    disabled={cloningId !== null}
                    onClick={() => handleClone(b.id)}
                  >
                    {cloningId === b.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Download className="h-3.5 w-3.5 mr-1" />
                    )}
                    {cloningId === b.id ? t("cloning") : t("importTemplate")}
                  </Button>
                </div>
              ))}
              {builtins.length === 0 && (
                <p className="py-6 text-center text-xs text-muted-foreground">
                  {t("noBuiltins")}
                </p>
              )}
            </div>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  )
}
