/**
 * Client-side mirror of the backend's `forge::source_key` normalizer — the
 * workbench builds candidate keys for its visible rows and batch-looks them up
 * against the keys the trigger command stored. The two sides MUST normalize
 * identically (lowercase host + repo, `.git` and surrounding slashes stripped)
 * or a chip simply never matches its task; any rule change lands in both
 * places (`src-tauri/src/forge/mod.rs`).
 */
import type { ForgeProviderId } from "@/lib/types"

export function buildForgeSourceKey(args: {
  provider: ForgeProviderId
  serverHost: string
  ownerRepo: string
  kind: "issue" | "pr"
  number: number
}): string {
  const host = args.serverHost.trim().toLowerCase()
  const repo = normalizeForgeRepo(args.ownerRepo)
  return `${args.provider}:${host}:${repo}:${args.kind}:${args.number}`
}

/** Lowercased `owner/repo`, `.git` suffix and surrounding slashes stripped. */
export function normalizeForgeRepo(input: string): string {
  return input
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "")
    .toLowerCase()
}
