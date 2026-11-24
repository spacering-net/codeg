"use client"

import { useState, useEffect } from "react"
import { useTranslations } from "next-intl"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Plus, Trash2 } from "lucide-react"
import {
  gitListRemotes,
  gitFetchRemote,
  gitAddRemote,
  gitRemoveRemote,
  gitSetRemoteUrl,
} from "@/lib/api"

interface RemoteDraft {
  originalName: string | null
  originalUrl: string
  name: string
  url: string
  deleted: boolean
}

interface RemoteManageDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  folderPath: string
  onSaved: () => void
}

export function RemoteManageDialog({
  open,
  onOpenChange,
  folderPath,
  onSaved,
}: RemoteManageDialogProps) {
  const t = useTranslations("Folder.branchDropdown.dialogs")
  const tCommon = useTranslations("Folder.common")
  const [drafts, setDrafts] = useState<RemoteDraft[]>([])
  const [saving, setSaving] = useState(false)
  const [loadingRemotes, setLoadingRemotes] = useState(false)
  const [errors, setErrors] = useState<Record<number, string>>({})

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset paired with an external fetch on open
      setErrors({})
      setLoadingRemotes(true)
      gitListRemotes(folderPath)
        .then((remotes) => {
          setDrafts(
            remotes.map((r) => ({
              originalName: r.name,
              originalUrl: r.url,
              name: r.name,
              url: r.url,
              deleted: false,
            }))
          )
        })
        .catch((err) => {
          console.error("Failed to load remotes:", err)
          setDrafts([])
        })
        .finally(() => setLoadingRemotes(false))
    }
  }, [open, folderPath])

  const addDraft = () => {
    setDrafts((prev) => [
      ...prev,
      {
        originalName: null,
        originalUrl: "",
        name: "",
        url: "",
        deleted: false,
      },
    ])
  }

  const updateDraft = (index: number, field: "name" | "url", value: string) => {
    setDrafts((prev) =>
      prev.map((d, i) => (i === index ? { ...d, [field]: value } : d))
    )
  }

  const removeDraft = (index: number) => {
    setDrafts((prev) =>
      prev.map((d, i) => (i === index ? { ...d, deleted: true } : d))
    )
  }

  const extractError = (err: unknown): string => {
    if (err && typeof err === "object") {
      const e = err as Record<string, unknown>
      if (typeof e.detail === "string" && e.detail) return e.detail
      if (typeof e.message === "string" && e.message) return e.message
    }
    return String(err)
  }

  const handleSave = async () => {
    setSaving(true)
    setErrors({})
    const newErrors: Record<number, string> = {}
    try {
      // Process deletions first
      for (const draft of drafts) {
        if (draft.deleted && draft.originalName != null) {
          await gitRemoveRemote(folderPath, draft.originalName)
        }
      }
      // Process additions
      for (let i = 0; i < drafts.length; i++) {
        const draft = drafts[i]
        if (draft.deleted) continue
        if (draft.originalName == null && draft.name && draft.url) {
          try {
            await gitAddRemote(folderPath, draft.name, draft.url)
          } catch (err) {
            newErrors[i] = extractError(err)
          }
        }
      }
      // Process URL modifications
      for (let i = 0; i < drafts.length; i++) {
        const draft = drafts[i]
        if (draft.deleted || draft.originalName == null) continue
        if (draft.url !== draft.originalUrl) {
          try {
            await gitSetRemoteUrl(folderPath, draft.originalName, draft.url)
          } catch (err) {
            newErrors[i] = extractError(err)
          }
        }
      }
      // Fetch all surviving remotes
      for (let i = 0; i < drafts.length; i++) {
        const draft = drafts[i]
        if (draft.deleted || newErrors[i]) continue
        const remoteName = draft.originalName ?? draft.name
        if (!remoteName) continue
        try {
          await gitFetchRemote(folderPath, remoteName)
        } catch (err) {
          newErrors[i] = extractError(err)
        }
      }
      if (Object.keys(newErrors).length > 0) {
        setErrors(newErrors)
      } else {
        onSaved()
        onOpenChange(false)
      }
    } catch (err) {
      console.error("Failed to save remotes:", err)
    } finally {
      setSaving(false)
    }
  }

  const visibleDrafts = drafts.filter((d) => !d.deleted)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("manageRemotesTitle")}</DialogTitle>
        </DialogHeader>
        <ScrollArea className="max-h-72">
          <div className="space-y-2 pr-2">
            {loadingRemotes ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                ...
              </p>
            ) : visibleDrafts.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                {t("manageRemotesEmpty")}
              </p>
            ) : (
              drafts.map(
                (draft, index) =>
                  !draft.deleted && (
                    <div key={index} className="space-y-1">
                      <div className="flex items-center gap-2">
                        <Input
                          placeholder={t("remoteNamePlaceholder")}
                          value={draft.name}
                          onChange={(e) =>
                            updateDraft(index, "name", e.target.value)
                          }
                          disabled={draft.originalName != null}
                          className={`h-8 text-sm w-32 shrink-0 ${errors[index] ? "border-destructive" : ""}`}
                        />
                        <Input
                          placeholder={t("remoteUrlPlaceholder")}
                          value={draft.url}
                          onChange={(e) =>
                            updateDraft(index, "url", e.target.value)
                          }
                          className={`h-8 text-sm font-mono flex-1 ${errors[index] ? "border-destructive" : ""}`}
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0"
                          onClick={() => removeDraft(index)}
                        >
                          <Trash2 className="h-3.5 w-3.5 text-destructive" />
                        </Button>
                      </div>
                      {errors[index] && (
                        <p className="text-xs text-destructive pl-1 truncate">
                          {errors[index]}
                        </p>
                      )}
                    </div>
                  )
              )
            )}
          </div>
        </ScrollArea>
        <DialogFooter className="flex items-center justify-between sm:justify-between">
          <Button variant="outline" size="sm" onClick={addDraft}>
            <Plus className="h-3.5 w-3.5 mr-1" />
            {t("addRemote")}
          </Button>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
            >
              {tCommon("cancel")}
            </Button>
            {/* Also inert while the list loads: the rows are hidden behind the
                loading placeholder then, so saving would apply drafts the user
                can't currently see (a reopen re-reads `folderPath`, and until it
                resolves `drafts` still holds the previous session's edits). */}
            <Button
              size="sm"
              onClick={handleSave}
              disabled={saving || loadingRemotes}
            >
              {saving ? t("savingRemotes") : tCommon("save")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
