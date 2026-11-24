import { isUnsupportedCommandError } from "@/lib/harness/errors"
import { parseItemRef } from "@/lib/harness/item-ref"
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

/**
 * Claim the Harness link the desktop app was opened (or re-activated) with —
 * `codeg://harness/install?ref=<publisher>/<name>` — as the item's address.
 *
 * The backend parks it in a slot of its own, beside the conversation one: the
 * two are told apart by where they wait, not by their shape, and this one is
 * validated as an item address rather than a conversation target. Otherwise it
 * is the same handover as {@link takePendingDeepLink}: an atomic take, from
 * the local desktop workspace only (a link opens the item on this computer, so
 * a remote workspace window never claims one), and `null` for everything else.
 *
 * A backend that has no such command is `null` as well, and worth no more than
 * a debug line: it is a build from before the command existed, not a failure.
 */
export async function takePendingHarnessLink(): Promise<string | null> {
  if (!isDesktop() || isRemoteDesktopMode()) return null
  try {
    const ref = await getTransport().call<unknown>("take_pending_harness_link")
    // The backend checked it already; it is checked again because it goes on
    // to the Harness page, and nothing that reaches it is taken on trust.
    return parseItemRef(ref)?.ref ?? null
  } catch (err) {
    if (isUnsupportedCommandError(err)) {
      console.debug("[deep-link] take_pending_harness_link is not available")
      return null
    }
    console.warn("[deep-link] take_pending_harness_link failed:", err)
    return null
  }
}
