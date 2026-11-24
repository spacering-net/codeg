"use client"

import { useState, useMemo } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"
import { cloneRepository } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { joinFsPath } from "@/lib/path-utils"
import type { FolderDetail } from "@/lib/types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useGitCredential } from "@/contexts/git-credential-context"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { DirectoryPathInput } from "@/components/shared/directory-path-input"

interface CloneDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * Called once the cloned repository has been opened as a workspace folder —
   * the same hook `WorkspaceFolderDialog` offers, so a caller can act on the
   * new folder (the sidebar files it into the group the clone started from).
   * It is the callback of the render the Clone click happened in, so a clone
   * still finishing after the dialog was reopened elsewhere reports to the
   * caller that started it.
   */
  onFolderOpened?: (folder: FolderDetail) => void
}

export function CloneDialog({
  open,
  onOpenChange,
  onFolderOpened,
}: CloneDialogProps) {
  const t = useTranslations("Folder.cloneDialog")
  const tToasts = useTranslations("Folder.toasts")
  const openFolder = useAppWorkspaceStore((s) => s.openFolder)
  const { withCredentialRetry } = useGitCredential()
  const [url, setUrl] = useState("")
  const [targetDir, setTargetDir] = useState("")
  const [cloning, setCloning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Derived from the remote URL, so `/` is the right separator to split on
  // regardless of the local OS. Trailing slashes come off before `.git` so
  // `…/codeg.git/` still names the repo `codeg` — the same directory `git
  // clone` would have picked on its own.
  const repoName = useMemo(
    () =>
      url
        .replace(/\/+$/, "")
        .replace(/\.git$/, "")
        .split("/")
        .filter(Boolean)
        .pop() || "repo",
    [url]
  )

  // The target directory is an OS path the user typed or picked, so the clone
  // target has to be joined with THAT path's separator — a hardcoded "/" left
  // Windows previews reading `C:\work/codeg`.
  const fullPath = useMemo(
    () => joinFsPath(targetDir, repoName),
    [targetDir, repoName]
  )

  const resetForm = () => {
    setUrl("")
    setTargetDir("")
    setError(null)
  }

  const handleClone = async () => {
    if (!url || !targetDir) return
    setCloning(true)
    setError(null)
    try {
      await withCredentialRetry(
        (creds) => cloneRepository(url, fullPath, creds),
        { remoteUrl: url }
      )
      const detail = await openFolder(fullPath)
      onFolderOpened?.(detail)
      onOpenChange(false)
      resetForm()
    } catch (err) {
      const msg = toErrorMessage(err)
      setError(msg)
      toast.error(tToasts("cloneFailed"), { description: msg })
    } finally {
      setCloning(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v)
        if (!v) resetForm()
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="clone-repo-url">{t("repositoryUrl")}</Label>
            <Input
              id="clone-repo-url"
              placeholder={t("repositoryUrlPlaceholder")}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={cloning}
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="clone-target-dir">{t("directory")}</Label>
            <DirectoryPathInput
              id="clone-target-dir"
              placeholder={t("directoryPlaceholder")}
              value={targetDir}
              onValueChange={setTargetDir}
              disabled={cloning}
              browseLabel={t("browseDirectory")}
            />
            {targetDir && url && (
              <p className="text-xs text-muted-foreground">
                {t("clonePath", { path: fullPath })}
              </p>
            )}
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={cloning}
            type="button"
          >
            {t("cancel")}
          </Button>
          <Button
            onClick={handleClone}
            disabled={!url || !targetDir || cloning}
            type="button"
          >
            {cloning && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {t("clone")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
