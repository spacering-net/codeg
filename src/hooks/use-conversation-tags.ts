import { useMemo } from "react"
import { useShallow } from "zustand/react/shallow"
import { resolveTags, type BranchChipView } from "@/lib/conversation-tags"
import type { ConversationTagDetail } from "@/lib/types"
import { useConversationTagsStore } from "@/stores/conversation-tags-store"

/**
 * A conversation's `tag_ids` resolved to the tags this window knows, in
 * display order — unknown ids (a tag deleted elsewhere) dropped.
 *
 * Cheap enough for every sidebar row. It reads the tag store only, so a
 * conversation status event never reaches it, and the shallow compare means a
 * change to tag DEFINITIONS re-renders just the rows actually showing the tag
 * that changed: every other row resolves to the very same tag objects (or the
 * shared empty list) and bails out.
 */
export function useResolvedTags(
  tagIds: readonly number[] | undefined
): readonly ConversationTagDetail[] {
  return useConversationTagsStore(
    useShallow((s) => resolveTags(tagIds, s.tagsById))
  )
}

/**
 * The branch chip to draw for a conversation that started on `gitBranch`, or
 * null: when the branch tag is off (or not loaded yet), and when there is no
 * branch — a folder outside git, chat mode, a detached HEAD. Two primitive
 * reads, so a sidebar row re-renders only when the setting really changes.
 */
export function useBranchChip(
  gitBranch: string | null | undefined
): BranchChipView | null {
  const enabled = useConversationTagsStore((s) => s.branchTag.enabled)
  const color = useConversationTagsStore((s) => s.branchTag.color)
  return useMemo(
    () => (enabled && gitBranch ? { name: gitBranch, color } : null),
    [enabled, gitBranch, color]
  )
}
