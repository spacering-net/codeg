import { getTransport, isDesktop, isRemoteDesktopMode } from "@/lib/transport"
import type { AgentType } from "@/lib/types"

/** A `codeg://` link the backend resolved before the workspace was listening. */
export interface PendingDeepLink {
  folderId: number
  conversationId: number
  agent: AgentType
}

/**
 * Drain the deep link the desktop app was opened with.
 *
 * `workspace://focus-conversation` reaches only webviews that have already
 * subscribed, so a cold-start `codeg://session/<id>` — resolved in Rust while
 * the window is still loading — would otherwise be dropped. The backend parks
 * the resolved target; this takes it (once) when `PetFocusBridge` is ready.
 *
 * Desktop-only, and never on a remote-workspace window: that window's
 * transport targets a `codeg-server`, which has no such command (nor a local
 * OS scheme). Returns `null` for everything else, including failures — a
 * missing deep link is the overwhelmingly common case, not an error.
 */
export async function takePendingDeepLink(): Promise<PendingDeepLink | null> {
  if (!isDesktop() || isRemoteDesktopMode()) return null
  try {
    const target = await getTransport().call<PendingDeepLink | null>(
      "take_pending_deep_link"
    )
    if (
      !target ||
      !Number.isFinite(target.folderId) ||
      !Number.isFinite(target.conversationId) ||
      !target.agent
    ) {
      return null
    }
    return target
  } catch (err) {
    console.warn("[deep-link] take_pending_deep_link failed:", err)
    return null
  }
}
