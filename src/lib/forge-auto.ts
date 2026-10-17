import { getWebServerStatus } from "@/lib/api"
import { isLocalDesktop } from "@/lib/platform"
import { getServerBaseUrl } from "@/lib/transport"
import type { ForgeAutoSettings, ForgePanelSettings } from "@/lib/types"

/** The route forges deliver webhooks to — mirrors the public route in
 *  `web/router.rs`. Unauthenticated by necessity; the delivery's signature is
 *  what codeg checks. */
export const FORGE_WEBHOOK_PATH = "/api/forge_webhook"

/** Mirrors `ForgeAutoSettings::default()` in `forge/settings.rs`: off, and
 *  on the cautious side of every choice once switched on. */
export const DEFAULT_FORGE_AUTO_SETTINGS: ForgeAutoSettings = {
  schedule: false,
  interval_minutes: 15,
  webhook: false,
  webhook_secret: null,
  issues: true,
  pull_requests: false,
  issue_scenario: null,
  pr_scenario: null,
  include_labels: [],
  exclude_labels: [],
  include_authors: [],
  exclude_authors: [],
  skip_drafts: true,
  auto_start: true,
  writeback: false,
  include_existing: false,
  enabled_at: null,
}

/** The scan intervals offered, in minutes. A stored value outside this list
 *  (written by an API client, or a future build) is still shown — see
 *  `scanIntervalOptions`. */
export const SCAN_INTERVAL_PRESETS = [
  1, 5, 15, 30, 60, 180, 360, 720, 1440,
] as const

/** A scope's auto-processing block, with the defaults filled in under it — a
 *  blob from a build that predates auto-processing has none at all, and a
 *  partial one keeps its own values. */
export function autoSettingsOf(
  settings: ForgePanelSettings | null | undefined
): ForgeAutoSettings {
  return { ...DEFAULT_FORGE_AUTO_SETTINGS, ...(settings?.auto ?? {}) }
}

/** Mirrors `ForgeAutoSettings::is_active`: a trigger is on AND there is a kind
 *  to pick up. */
export function isAutoActive(auto: ForgeAutoSettings): boolean {
  return (auto.schedule || auto.webhook) && (auto.issues || auto.pull_requests)
}

/** The interval select's options: the presets, plus the current value when it
 *  is not one of them, so a select never shows nothing. */
export function scanIntervalOptions(current: number): number[] {
  const options: number[] = [...SCAN_INTERVAL_PRESETS]
  if (!options.includes(current)) options.push(current)
  return options.sort((a, b) => a - b)
}

/** Whether two auto blocks would save to the same thing. `enabled_at` is
 *  server-stamped, so it never makes a form dirty. Pattern lists compare in
 *  order — reordering a chip is an edit like any other. */
export function sameAutoSettings(
  a: ForgeAutoSettings,
  b: ForgeAutoSettings
): boolean {
  const strip = (v: ForgeAutoSettings) => ({ ...v, enabled_at: null })
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b))
}

/** 32 random bytes as hex — the same shape the backend mints when a webhook is
 *  switched on with no secret. */
export function generateWebhookSecret(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

/**
 * Where a forge should deliver this codeg's webhooks — as far as this window
 * can tell.
 *
 * A browser (or a desktop window on a remote server) is already talking to the
 * server that receives them, so its own base URL is the answer. The local
 * desktop app serves HTTP only while its web service is running, and then on
 * the addresses that service reports; while it is off there is nowhere to
 * deliver to, which is an empty list rather than a guess.
 *
 * Whichever it is, the address has to be reachable FROM THE FORGE — a LAN
 * address works for a self-hosted forge on the same network, not for
 * github.com. That is for the dialog to say; this only names the URLs.
 */
export async function forgeWebhookUrls(): Promise<string[]> {
  if (isLocalDesktop()) {
    const status = await getWebServerStatus().catch(() => null)
    if (status == null) return []
    return status.addresses.map(
      (address) => `${address.replace(/\/+$/, "")}${FORGE_WEBHOOK_PATH}`
    )
  }
  const base = getServerBaseUrl()
  return base ? [`${base}${FORGE_WEBHOOK_PATH}`] : []
}
