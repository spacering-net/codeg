/**
 * Bundled tailnet join plan for phone reach.
 *
 * Goal: the phone talks to desktop Codeg with the existing URL + token.
 * A userspace tsnet sidecar can join a tailnet (auth URL or auth key)
 * without installing the standalone Tailscale app on the computer.
 * Funnel HTTPS then means the phone also does not need the Tailscale app.
 */

export type TailnetAuth =
  | { kind: "auth-key"; value: string }
  | { kind: "auth-url"; value: string }

export type TailnetJoinPlan = {
  hostname: string
  target: string
  auth: TailnetAuth
  sidecarArgs: string[]
}

export class TailnetJoinError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TailnetJoinError"
  }
}

export function joinPlan(input: {
  hostname?: string
  target: string
  authKey?: string
  authUrl?: string
}): TailnetJoinPlan {
  const target = input.target.trim()
  if (!target) {
    throw new TailnetJoinError("target is required (desktop web service)")
  }
  const hostname = (input.hostname ?? "codeg").trim() || "codeg"
  const key = input.authKey?.trim() ?? ""
  const url = input.authUrl?.trim() ?? ""
  if (key && url) {
    throw new TailnetJoinError(
      "use either an auth key or an auth URL, not both"
    )
  }
  if (!key && !url) {
    throw new TailnetJoinError("auth key or auth URL is required")
  }
  const auth: TailnetAuth = key
    ? { kind: "auth-key", value: key }
    : { kind: "auth-url", value: url }
  const sidecarArgs = [
    "--hostname",
    hostname,
    "--target",
    target,
    auth.kind === "auth-key" ? "--authkey" : "--login-server",
    auth.value,
  ]
  return { hostname, target, auth, sidecarArgs }
}

export function sidecarCommand(plan: TailnetJoinPlan): string {
  return ["codeg-tsnet", ...plan.sidecarArgs].join(" ")
}
