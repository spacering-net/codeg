"use client"

import { Monitor, MonitorCloud, Server, type LucideIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { useRemoteConnection } from "@/contexts/remote-connection-context"
import { isDesktop } from "@/lib/platform"
import { cn } from "@/lib/utils"

/**
 * The machine whose configuration the Harness page reads and writes.
 *
 * Every MCP, skill and skill-pack command goes through the window's transport,
 * so the answer is whatever that transport talks to:
 *
 * - `local` — the desktop app's own backend: this computer.
 * - `remote` — a desktop window bound to a remote codeg server: that host,
 *   under the name the user gave the connection.
 * - `web` — a browser: the server the page was served from. Whether that is
 *   also the machine in front of the user cannot be told from here (a server
 *   on localhost and a port-forwarded one look the same), so it is named by
 *   its address and nothing is claimed about where it runs.
 */
export type HarnessHost =
  | { kind: "local" }
  | { kind: "remote"; name: string; address: string }
  | { kind: "web"; name: string; address: string }

export function useHarnessHost(): HarnessHost {
  // Non-null only in a remote workspace window, and only once the connection
  // has loaded — the gate renders nothing of the workspace before that.
  const remote = useRemoteConnection()?.connection ?? null
  if (remote) {
    return {
      kind: "remote",
      name: remote.name.trim() || remote.base_url,
      address: remote.base_url,
    }
  }
  if (isDesktop()) return { kind: "local" }
  // The page only ever renders in a browser (a workbench route is entered by
  // a client-side switch), but a prerender must not throw for it either.
  if (typeof window === "undefined") {
    return { kind: "web", name: "", address: "" }
  }
  return {
    kind: "web",
    name: window.location.host,
    address: window.location.origin,
  }
}

const HOST_ICONS: Record<HarnessHost["kind"], LucideIcon> = {
  // The same glyphs the quick-actions menu gives the local and the remote
  // workspace, so a host reads the same wherever it is named.
  local: Monitor,
  remote: MonitorCloud,
  web: Server,
}

/**
 * Says which machine a section's changes land on — at the head of the MCP,
 * Skills and Skill-packs sections, which all edit files on the workspace's
 * host. "Local" was only ever true in the local desktop window: from a remote
 * workspace window or a browser, the same screens edit another machine.
 *
 * The host's name is isolated (`<bdi>`) because it is an address or a
 * user-chosen label, not prose: in a right-to-left sentence a bare
 * `10.0.0.5:3080` would otherwise be reordered around its punctuation.
 *
 * `foldHint` is for the head of a section on a phone, where the sentence
 * after the chip would take a line or two of its own: it goes into the chip's
 * tooltip, and stays in the text a screen reader reads, after the name. The
 * chip itself — which machine — is always on show.
 */
export function HarnessHostLabel({
  className,
  foldHint = false,
}: {
  className?: string
  foldHint?: boolean
}) {
  const t = useTranslations("Harness.host")
  const host = useHarnessHost()
  const Icon = HOST_ICONS[host.kind]
  const name = host.kind === "local" ? t("local") : host.name
  const hint = t(`${host.kind}Hint`)
  const address =
    host.kind === "local"
      ? null
      : host.kind === "remote"
        ? `${host.name}\n${host.address}`
        : host.address
  const title = foldHint
    ? address
      ? `${address}\n${hint}`
      : hint
    : (address ?? undefined)

  return (
    <p
      data-harness-host={host.kind}
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground",
        className
      )}
    >
      <span className="sr-only">{t("label")}</span>
      <span
        title={title}
        className="inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-full bg-muted/70 px-2 py-0.5 font-medium text-foreground ws-msg-chip"
      >
        <Icon
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground"
        />
        <bdi className="truncate">{name}</bdi>
      </span>
      <span className={cn("min-w-0", foldHint && "sr-only")}>{hint}</span>
    </p>
  )
}
