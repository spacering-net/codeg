"use client"

import { useTranslations } from "next-intl"
import { toast } from "sonner"

import {
  ContextMenuItem,
  ContextMenuSubContent,
} from "@/components/ui/context-menu"
import { toErrorMessage } from "@/lib/app-error"
import { copyFilesToClipboard } from "@/lib/clipboard-files"
import { copyTextFromMenu } from "@/lib/utils"

/**
 * The file tree's "Copy" submenu, shared by the file rows, the directory rows
 * and the workspace-root row so the three can't drift apart.
 *
 * Two entries are text: the workspace-relative path (what a prompt or a `git`
 * invocation wants) and the absolute one (what another app wants). The third
 * puts the entry ITSELF on the OS clipboard, so pasting in Finder / Explorer
 * writes a copy of the file — and it renders only on a real desktop.
 * `remote` covers both the browser and a remote-desktop window: there the
 * workspace lives on another host, so the copy would land on the *server's*
 * clipboard rather than the user's.
 */
export function FileTreeCopySubContent({
  name,
  relativePath,
  absolutePath,
  kind,
  remote,
}: {
  /** Display name of the entry, for the copy-the-file-itself toasts. */
  name: string
  relativePath: string
  absolutePath: string
  kind: "file" | "dir"
  remote: boolean
}) {
  const t = useTranslations("Folder.fileTreeTab")

  const copyPath = async (value: string) => {
    // copyTextFromMenu defers the write until this context menu has closed, so
    // the execCommand clipboard fallback works in non-secure web contexts.
    const ok = await copyTextFromMenu(value)
    if (ok) {
      toast.success(t("toasts.pathCopied"))
    } else {
      toast.error(t("toasts.copyPathFailed"))
    }
  }

  const copyEntry = async () => {
    try {
      await copyFilesToClipboard([absolutePath])
      toast.success(t("toasts.fileCopied", { name }))
    } catch (error) {
      toast.error(t("toasts.copyFileFailed", { name }), {
        description: toErrorMessage(error),
      })
    }
  }

  return (
    <ContextMenuSubContent>
      <ContextMenuItem onSelect={() => void copyPath(relativePath)}>
        {t("copyRelativePath")}
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => void copyPath(absolutePath)}>
        {t("copyAbsolutePath")}
      </ContextMenuItem>
      {!remote && (
        <ContextMenuItem onSelect={() => void copyEntry()}>
          {kind === "dir" ? t("copyDirectoryItself") : t("copyFileItself")}
        </ContextMenuItem>
      )}
    </ContextMenuSubContent>
  )
}
