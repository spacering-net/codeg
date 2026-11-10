/**
 * Opening the assistants page's settings from another window (10.5): the
 * settings window's "moved to the assistants page — [Open]", and the
 * composer's "Manage executor configs…" in a window that is not a
 * workspace.
 *
 * - Desktop: the backend brings the workspace window the settings window
 *   was opened from to the front and sends it `workspace://open-personal-
 *   agent` (`open_personal_agent_page`).
 * - Web: an open workspace tab is told over a BroadcastChannel and answers;
 *   when none answers, a new one opens on `/workspace?pa=<page>`.
 *
 * The workspace's `PersonalAgentOpenBridge` takes both, and the query.
 */

import { getShellTransport, isDesktop } from "@/lib/transport"
import type { SettingsPage } from "@/stores/personal-agent-ui-store"

export const PERSONAL_AGENT_OPEN_EVENT = "workspace://open-personal-agent"
export const PERSONAL_AGENT_OPEN_PARAM = "pa"
const CHANNEL = "codeg:personal-agent-open"
/** How long an open workspace tab has to answer. */
const ANSWER_MS = 600

const PAGES: readonly SettingsPage[] = [
  "identity",
  "persona",
  "execution",
  "advanced",
  "workers",
  "executors",
  "division",
  "communication",
  "automation",
]

export function isSettingsPage(v: unknown): v is SettingsPage {
  return typeof v === "string" && (PAGES as readonly string[]).includes(v)
}

type ChannelMessage =
  | { type: "open"; page: SettingsPage; id: string }
  | { type: "taken"; id: string }

/** Open the assistants page's settings at `page`, in the workspace. */
export async function openPersonalAgentPage(page: SettingsPage): Promise<void> {
  if (isDesktop()) {
    await getShellTransport().call("open_personal_agent_page", { page })
    return
  }
  const taken =
    typeof BroadcastChannel === "undefined"
      ? false
      : await new Promise<boolean>((resolve) => {
          const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
          const channel = new BroadcastChannel(CHANNEL)
          const timer = setTimeout(() => {
            channel.close()
            resolve(false)
          }, ANSWER_MS)
          channel.onmessage = (e: MessageEvent<ChannelMessage>) => {
            if (e.data?.type === "taken" && e.data.id === id) {
              clearTimeout(timer)
              channel.close()
              resolve(true)
            }
          }
          channel.postMessage({
            type: "open",
            page,
            id,
          } satisfies ChannelMessage)
        })
  if (!taken) {
    window.open(
      `/workspace?${PERSONAL_AGENT_OPEN_PARAM}=${encodeURIComponent(page)}`,
      "_blank"
    )
  }
}

/** In a workspace: take the requests other windows make. */
export function listenPersonalAgentOpen(
  onOpen: (page: SettingsPage) => void
): () => void {
  const disposers: Array<() => void> = []
  let cancelled = false
  if (isDesktop()) {
    void getShellTransport()
      .subscribe<{ page?: string }>(PERSONAL_AGENT_OPEN_EVENT, (payload) => {
        if (isSettingsPage(payload?.page)) onOpen(payload.page)
      })
      .then((off) => {
        if (cancelled) off()
        else disposers.push(off)
      })
      .catch(() => {})
  } else if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(CHANNEL)
    channel.onmessage = (e: MessageEvent<ChannelMessage>) => {
      if (e.data?.type !== "open" || !isSettingsPage(e.data.page)) return
      channel.postMessage({
        type: "taken",
        id: e.data.id,
      } satisfies ChannelMessage)
      onOpen(e.data.page)
      window.focus()
    }
    disposers.push(() => channel.close())
  }
  return () => {
    cancelled = true
    for (const d of disposers) d()
  }
}
