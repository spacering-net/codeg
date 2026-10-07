"use client"

import type { ReactNode } from "react"
import { useTranslations } from "next-intl"
import type { DbConversationSummary } from "@/lib/types"
import { formatConversationTitle } from "@/lib/conversation-title"
import { cn } from "@/lib/utils"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { Badge } from "@/components/ui/badge"
import { FolderAliasLabel } from "./folder-alias-label"
import { InfoItem, SessionIdentityChips } from "./session-details-content"
import { ConversationTagChip } from "./conversation-tag-chip"
import { useResolvedTags } from "@/hooks/use-conversation-tags"

interface SidebarConversationHoverDetailsProps {
  conversation: DbConversationSummary
}

/**
 * A technical identifier — a filesystem path, a branch, a model id. Pinned to
 * `dir="ltr"` because these read left to right in every locale: under an RTL
 * document the bidi algorithm treats a leading `/` as neutral and moves it to
 * the end, rendering `/Users/me/codeg` as `Users/me/codeg/`. The folder picker
 * gives `folder.path` the same treatment (`shared/folder-select.tsx`).
 */
function LtrValue({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <span
      dir="ltr"
      className={cn(
        "block min-w-0 text-start font-mono text-xs break-all",
        className
      )}
    >
      {children}
    </span>
  )
}

/**
 * The body of the sidebar row's hover bubble: where a conversation *lives* —
 * its folder, that folder's absolute path, and the git branch — plus the
 * identity bits the row itself has to truncate away.
 *
 * Deliberately request-free. The sidebar card holds only a
 * `DbConversationSummary`, and everything here comes from it or from the
 * workspace store, so the bubble paints the instant it opens. Token usage and
 * the session/extension ids are NOT shown: those need a
 * `getFolderConversation` round-trip per conversation, which is what the
 * right-click "Session Details" dialog (`SessionDetailsContent`) is for.
 *
 * Subscribing to the store here is safe even though one card renders per
 * visible sidebar row: Radix mounts hover-card content only while open, so at
 * most one of these exists at a time. (Contrast the card body itself, which
 * reads `useTabStore` imperatively precisely to avoid a per-row subscription.)
 */
export function SidebarConversationHoverDetails({
  conversation,
}: SidebarConversationHoverDetailsProps) {
  const t = useTranslations("Folder.sessionDetails")
  const tSidebar = useTranslations("Folder.sidebar")
  const tTags = useTranslations("ConversationTags")
  const tags = useResolvedTags(conversation.tag_ids)

  const folderId = conversation.folder_id
  // `allFolders` rather than `folders`: a conversation can live in a folder the
  // user has closed, or in a hidden `kind: "chat"` folder, and the bubble should
  // still name it. Selecting the found row (not the array) keeps this from
  // re-rendering when unrelated folders change.
  const folder = useAppWorkspaceStore((s) =>
    s.allFolders.find((f) => f.id === folderId)
  )
  // The folder's live HEAD, kept fresh by the workspace branch poll. Only used
  // as a fallback — see below.
  const liveBranch = useAppWorkspaceStore((s) => s.branches.get(folderId))

  const none = t("none")
  const isWorktree = folder != null && folder.parent_id != null
  // The branch the conversation was STARTED on wins over the folder's current
  // HEAD: the row describes that session, and the user may well have checked
  // something else out since. The live branch only fills in for rows that
  // predate the column being written (imported sessions).
  const branch = conversation.git_branch || liveBranch || null
  const model = conversation.model?.trim() || null

  return (
    // `select-none` is load-bearing, not cosmetic. Radix refuses to close a
    // hover card while a text selection exists (`handleClose` bails on
    // `hasSelectionRef`), and that flag is only cleared when the content
    // unmounts — which it never does, because it won't close. In a LIST that
    // deadlock is visible: select text in one row's bubble and it stays pinned
    // on screen while the next row opens a second one beside it. The bubble is
    // read-only and meant to vanish the moment the pointer leaves, so the fix
    // is to make it unselectable and let Radix's selection path stay dormant.
    // (Copyable values live in the right-click "Session Details" dialog.)
    // Set on this inner root rather than on `HoverCardContent`: Radix writes an
    // inline `user-select: text` onto the content element once a pointer goes
    // down inside it, and an explicit value here wins over that inherited one
    // without needing `!important`.
    <div className="min-w-0 space-y-3 text-[0.8125rem] select-none">
      <div className="min-w-0 space-y-1.5">
        {/* Clamped rather than truncated: the row already shows a one-line
            ellipsis, so the whole point of the bubble is to reveal more of the
            title — just not an unbounded amount of it. */}
        <p className="wrap-anywhere line-clamp-3 text-sm font-medium leading-snug">
          {formatConversationTitle(conversation.title) || t("untitled")}
        </p>
        {/* No status chip: the row the pointer is resting on already badges the
            two states worth flagging — a spinner while running, a cross when
            cancelled — and the rest read as ordinary either way. `model` is
            empty for most live sessions (the column is only filled for imported
            ones), and the chip drops out with it. */}
        <SessionIdentityChips
          agentType={conversation.agent_type}
          model={model}
        />
        {/* Every tag, wrapping: the row itself shows at most two. */}
        {tags.length > 0 && (
          <div
            className="flex flex-wrap gap-1"
            aria-label={tTags("tags")}
            role="list"
          >
            {tags.map((tag) => (
              <span key={tag.id} role="listitem" className="min-w-0 max-w-full">
                <ConversationTagChip tag={tag} className="max-w-full" />
              </span>
            ))}
          </div>
        )}
      </div>

      {/* A plain stack rather than a grid: every field here is a folder, a
          branch or a path — long, wrapping values that each want the full
          width. */}
      <dl className="min-w-0 space-y-2.5 border-t pt-3">
        {/* The worktree badge annotates the FIELD, so it rides on the label
            rather than on the value — a worktree directory name is long enough
            that a trailing badge would routinely wrap onto a line of its own. */}
        <InfoItem
          label={
            <>
              {t("folder")}
              {isWorktree && (
                <Badge
                  variant="secondary"
                  className="h-4 px-1.5 text-[0.625rem] font-normal"
                >
                  {t("worktree")}
                </Badge>
              )}
            </>
          }
          valueClassName="wrap-anywhere"
        >
          {folder ? (
            <FolderAliasLabel name={folder.name} alias={folder.alias} />
          ) : (
            none
          )}
        </InfoItem>
        <InfoItem label={t("gitBranch")}>
          <LtrValue>{branch || none}</LtrValue>
        </InfoItem>
        <InfoItem label={t("folderPath")}>
          <LtrValue>{folder?.path || none}</LtrValue>
        </InfoItem>
        {/* Re-parented out of a removed worktree: the path above is where the
            conversation lives NOW, so surface where it originally ran. */}
        {conversation.origin_cwd && (
          <InfoItem label={tSidebar("worktreeRemovedBadge")}>
            <LtrValue>{conversation.origin_cwd}</LtrValue>
          </InfoItem>
        )}
      </dl>
    </div>
  )
}
