import { listAllConversations, updateConversationTags } from "@/lib/api"
import type { DbConversationSummary } from "@/lib/types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"

function applyDelta(
  current: readonly number[],
  add: readonly number[],
  remove: readonly number[]
): number[] {
  // Same rule as the backend: removals first, so an id in both ends up on.
  const next = new Set(current)
  for (const id of remove) next.delete(id)
  for (const id of add) next.add(id)
  return [...next].sort((a, b) => a - b)
}

/**
 * Re-read one conversation's tags from the server after a failed change whose
 * outcome is unknown — the request may have failed after the write committed.
 * Reads the conversation's folder (there is no single-row read) and applies
 * ONLY `tag_ids`, and only if the row's tags are still the very array they
 * were when the read went out: anything that replaced them meanwhile (a
 * broadcast, another toggle) is at least as current as this read, and a later
 * write's broadcast is still on its way if not. Deleted and unknown rows are
 * left alone. Best-effort: a failed read changes nothing.
 */
async function resyncConversationTags(
  conversationId: number,
  folderId: number
): Promise<void> {
  const find = () =>
    useAppWorkspaceStore
      .getState()
      .conversations.find((c) => c.id === conversationId)
  const atRequest = find()?.tag_ids
  let fresh: DbConversationSummary | undefined
  try {
    const list = await listAllConversations({ folder_ids: [folderId] })
    fresh = list.find((c) => c.id === conversationId)
  } catch {
    return
  }
  const now = find()
  if (!fresh || !now || now.tag_ids !== atRequest) return
  useAppWorkspaceStore
    .getState()
    .updateConversationLocal(conversationId, { tag_ids: fresh.tag_ids ?? [] })
}

/**
 * Put tags on / take tags off a conversation, optimistically.
 *
 * The sidebar row updates at once; the backend's broadcast of the
 * conversation's fresh summary then replaces it, in every client. A failure
 * takes the guess back if it is still what is shown, then re-reads the row's
 * tags either way (see `resyncConversationTags`): a failed request does not
 * prove the write did not land, and a revert can only restore what was on
 * screen before — which may itself have been another toggle's unconfirmed
 * guess. Rejects with the backend's error so the caller can say what went
 * wrong.
 *
 * Root conversations only get the optimistic step — delegation children live
 * in the sidebar's lazily-loaded subtree cache, which converges on the
 * broadcast alone.
 */
export async function changeConversationTags(
  conversationId: number,
  delta: { add?: readonly number[]; remove?: readonly number[] }
): Promise<void> {
  const add = delta.add ?? []
  const remove = delta.remove ?? []
  if (add.length === 0 && remove.length === 0) return

  const store = useAppWorkspaceStore.getState()
  const before = store.conversations.find((c) => c.id === conversationId)
  const prevIds = before?.tag_ids ?? []
  // The array our patch installs. Ownership is decided by its IDENTITY, not
  // its value: a broadcast — even one confirming the very same tags — brings
  // a new array, and from then on the tags are the server's, not our guess.
  // Status patches spread the row and keep this array, so they do not count.
  const installed = applyDelta(prevIds, add, remove)
  if (before) {
    store.updateConversationLocal(conversationId, { tag_ids: installed })
  }

  try {
    // The reply carries the fresh summary, but it is deliberately not applied:
    // the backend broadcasts that same summary on `conversation://changed`
    // before replying, so it arrives anyway — through the one channel every
    // other write to this row arrives on too. Applying the reply as well would
    // give the row a second, separately timed source, which could land after a
    // newer broadcast (another window toggling another tag) and roll it back.
    await updateConversationTags({
      conversationId,
      add: [...add],
      remove: [...remove],
    })
  } catch (err) {
    if (before) {
      const latest = useAppWorkspaceStore.getState()
      const now = latest.conversations.find((c) => c.id === conversationId)
      if (now && now.tag_ids === installed) {
        // Still our guess on screen: take it back at once.
        latest.updateConversationLocal(conversationId, { tag_ids: prevIds })
      }
      void resyncConversationTags(conversationId, before.folder_id)
    }
    throw err
  }
}
