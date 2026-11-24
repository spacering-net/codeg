"use client"

import { ExternalLink, FileText, Mail } from "lucide-react"
import { useTranslations } from "next-intl"

import {
  canOpenLinkOrFile,
  parseLocalFileTarget,
  useOpenLinkOrFile,
} from "@/components/ai-elements/link-safety"
import { ContextMenuItem } from "@/components/ui/context-menu"
import type { TextToken } from "@/lib/text-token-at"

/**
 * Where a right-clicked token's "open" action would go, or null when it has
 * nowhere: a plain word, a path the shared opener cannot resolve on its own
 * (a bare `src/x.ts` needs a folder to sit in — that resolution belongs to the
 * transcript's file badge, not to a half-typed draft), or a url on a protocol
 * the opener refuses (`ftp://`, `vscode://`, …).
 *
 * Each kind is asked the question the opener would actually answer for it, so a
 * row is never offered for a target whose only outcome would be the opener's
 * failure toast — nor under a label that describes the wrong destination.
 *
 * Exported so the menu can decide whether the row exists at all before mounting
 * anything for it.
 */
export function composerTokenOpenTarget(
  token: TextToken | null
): string | null {
  if (!token) return null
  // A path opens as itself, and only if it really is a local file: a
  // protocol-relative `//cdn.example.com/app.js` is classified as a path here,
  // and the opener would happily load it as https — behind an "Open file" label.
  if (token.kind === "path") {
    return parseLocalFileTarget(token.value) ? token.value : null
  }
  // The rest carry a canonical uri (`mailto:` for an address, an `https://`
  // completion for a bare host); the opener's allow-list is the judge.
  return token.href && canOpenLinkOrFile(token.href) ? token.href : null
}

/**
 * The one row a right-clicked token adds above the composer's ordinary editing
 * items: open a link, write to an address, open a local file.
 *
 * It routes through the same opener the transcript's links use, so the protocol
 * allow-list, the desktop/web/remote routing and the failure toasts are the
 * ones already in place — nothing here opens anything by itself. Cut, Copy and
 * the rest still apply to the token, which the right click has already
 * selected.
 */
export function ComposerTokenAction({ token }: { token: TextToken }) {
  const t = useTranslations("Folder.chat.messageInput")
  const openTarget = useOpenLinkOrFile()
  const target = composerTokenOpenTarget(token)
  if (!target) return null

  const { icon: Icon, label } =
    token.kind === "email"
      ? { icon: Mail, label: t("sendEmail") }
      : token.kind === "path"
        ? { icon: FileText, label: t("openFile") }
        : { icon: ExternalLink, label: t("openLink") }

  return (
    <ContextMenuItem onSelect={() => void openTarget(target)}>
      <Icon className="size-4" />
      {label}
    </ContextMenuItem>
  )
}
