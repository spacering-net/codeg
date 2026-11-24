"use client"

/**
 * What a window does with `personal-agent://notify` (1.13): the backend has
 * already decided whether, how urgently and how to tell the owner; a window
 * only puts it in front of them.
 *
 * - `posted`: the desktop backend posted the OS notification itself.
 * - `toast`: a codeg window has the focus. The window that has it shows the
 *   news in page — when it is a workspace (it has the toasts); a focused
 *   window without them posts the OS notification instead, unless the owner
 *   wants this news on the page only (`in_page`): then nothing else.
 * - `system`: no codeg window has the focus (codeg-server in a browser, or a
 *   desktop window on a remote server). A window that has it after all
 *   shows it in page; otherwise exactly one window or tab posts it, as this
 *   device's notification settings say (the master switch, "hide
 *   contents"): the id is claimed across tabs, and a browser notification
 *   carries it as its `tag`, so two that race still show one.
 *
 * Following the news — a toast's [Open], a click on a browser notification
 * — is a window event the workspace takes (`listenPersonalAgentFollow`): it
 * opens the assistant on its card, or the conversation.
 */

import { toast } from "sonner"

import { getDesktopNotificationPrefs } from "@/lib/desktop-notification-prefs"
import {
  deliverSystemNotification,
  getNotificationPermission,
} from "@/lib/notification"
import { avatarPngDataUrl } from "@/lib/personal-agent-avatar-png"
import { getShellTransport, isDesktop } from "@/lib/transport"
import type { PersonalAgentNotify, PersonalAgentNotifyLink } from "@/lib/types"
import { requestWindowAttention } from "@/lib/window-attention"

/** The window event a followed notification raises. */
export const PERSONAL_AGENT_FOLLOW_EVENT = "codeg:personal-agent-follow"
/** The desktop's event an assistant picked in the menu bar raises. */
export const TRAY_FOLLOW_EVENT = "workspace://follow-personal-agent"

const CLAIM_PREFIX = "codeg:pa-notify:"
/** A claim is read back this long after it is written: the last writer of
 *  two that raced holds it. */
const CLAIM_SETTLE_MS = 60
/** Claims older than this are cleared. */
const CLAIM_TTL_MS = 10 * 60_000
/** Ids this window has taken already (a repeated event). */
const HANDLED_MAX = 200

const handled = new Set<string>()
const windowToken = `${Date.now().toString(36)}-${Math.random()
  .toString(36)
  .slice(2)}`

/** Follow a notification's link: the workspace opens what it points at. */
export function followPersonalAgentLink(link: PersonalAgentNotifyLink): void {
  window.dispatchEvent(
    new CustomEvent<PersonalAgentNotifyLink>(PERSONAL_AGENT_FOLLOW_EVENT, {
      detail: link,
    })
  )
}

/** Take the links followed in this window. */
export function listenPersonalAgentFollow(
  onLink: (link: PersonalAgentNotifyLink) => void
): () => void {
  const handler = (e: Event) => {
    const link = (e as CustomEvent<PersonalAgentNotifyLink>).detail
    if (link && typeof link === "object") onLink(link)
  }
  window.addEventListener(PERSONAL_AGENT_FOLLOW_EVENT, handler)
  // The desktop's menu bar opens an assistant the same way (10.10).
  let cancelled = false
  let off: (() => void) | null = null
  if (isDesktop()) {
    void getShellTransport()
      .subscribe<PersonalAgentNotifyLink>(TRAY_FOLLOW_EVENT, (link) => {
        if (link && typeof link === "object" && link.kind === "bot") {
          onLink(link)
        }
      })
      .then((unlisten) => {
        if (cancelled) unlisten()
        else off = unlisten
      })
      .catch(() => {})
  }
  return () => {
    cancelled = true
    off?.()
    window.removeEventListener(PERSONAL_AGENT_FOLLOW_EVENT, handler)
  }
}

function pruneClaims(now: number) {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i)
      if (!key?.startsWith(CLAIM_PREFIX)) continue
      const at = Number(localStorage.getItem(key)?.split("@")[1])
      if (!Number.isFinite(at) || now - at > CLAIM_TTL_MS) {
        localStorage.removeItem(key)
      }
    }
  } catch {
    // no storage: nothing to clear
  }
}

/** Whether this window is the one to post `id`. One already claimed is
 *  another's; of two that claim at once, the last writer keeps it. */
export async function claimNotification(id: string): Promise<boolean> {
  const key = CLAIM_PREFIX + id
  const now = Date.now()
  const mine = `${windowToken}@${now}`
  try {
    pruneClaims(now)
    if (localStorage.getItem(key) != null) return false
    localStorage.setItem(key, mine)
  } catch {
    // No storage to share: this window posts it.
    return true
  }
  await new Promise((r) => setTimeout(r, CLAIM_SETTLE_MS))
  try {
    return localStorage.getItem(key) === mine
  } catch {
    return true
  }
}

function focusedHere(): boolean {
  if (typeof document === "undefined") return false
  return document.visibilityState !== "hidden" && document.hasFocus()
}

/** Whether this window shows toasts: a workspace. */
function hasToasts(): boolean {
  if (typeof window === "undefined") return false
  const path = window.location.pathname.replace(/\/+$/, "")
  return path === "/workspace" || path.startsWith("/workspace/")
}

export interface NotifyWords {
  /** The toast's button that follows the link. */
  open: string
}

function showToast(n: PersonalAgentNotify, words: NotifyWords) {
  const link = n.link
  toast(n.title, {
    id: `pa-notify-${n.id}`,
    description: n.body,
    classNames: { description: "whitespace-pre-line line-clamp-4" },
    duration: n.level === "urgent" ? 12_000 : 6_000,
    action: link
      ? { label: words.open, onClick: () => followPersonalAgentLink(link) }
      : undefined,
  })
}

/** Post the OS notification here. False when this device's settings or the
 *  browser say no. */
async function postHere(n: PersonalAgentNotify): Promise<boolean> {
  const prefs = getDesktopNotificationPrefs()
  if (!prefs.enabled) return false
  const body = prefs.hideBody ? n.hidden_body : n.body
  if (isDesktop()) {
    if (!(await claimNotification(n.id))) return false
    try {
      await deliverSystemNotification(n.title, body)
    } catch {
      return false
    }
    if (n.attention) void requestWindowAttention("permission_request")
    return true
  }
  if (getNotificationPermission() !== "granted") return false
  const Ctor = (window as { Notification?: typeof Notification }).Notification
  if (typeof Ctor !== "function") return false
  if (!(await claimNotification(n.id))) return false
  const icon = (await avatarPngDataUrl(n.avatar).catch(() => null)) ?? undefined
  try {
    const note = new Ctor(n.title, { body, tag: n.id, icon })
    const link = n.link
    note.onclick = () => {
      try {
        window.focus()
      } catch {
        // a browser that will not raise the tab
      }
      note.close()
      if (link) followPersonalAgentLink(link)
    }
    return true
  } catch {
    return false
  }
}

/** What this window did with one notification. */
export type NotifyOutcome = "ignored" | "toast" | "posted" | "dropped"

export async function handlePersonalAgentNotify(
  n: PersonalAgentNotify,
  words: NotifyWords
): Promise<NotifyOutcome> {
  if (n.mode === "posted") return "ignored"
  if (handled.has(n.id)) return "ignored"
  handled.add(n.id)
  if (handled.size > HANDLED_MAX) {
    const first = handled.values().next().value
    if (first !== undefined) handled.delete(first)
  }
  const focused = focusedHere()
  if (focused && hasToasts()) {
    showToast(n, words)
    return "toast"
  }
  // On the page only: never an OS notification.
  if (n.in_page) return "ignored"
  // In page is for the window that has the focus; a focused window that
  // cannot show it posts it instead.
  if (n.mode === "toast" && !focused) return "ignored"
  return (await postHere(n)) ? "posted" : "dropped"
}

/** Test seam. */
export function __resetPersonalAgentNotifyForTests(): void {
  handled.clear()
}
