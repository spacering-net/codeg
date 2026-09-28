// Site rules of the built-in browser: "always open this host in the built-in
// browser / in the system browser / never". The matching here decides which
// rule applies to a URL; the same algorithm runs in Rust
// (`src-tauri/src/browser/policy.rs`), which enforces `block` on every
// navigation a tab attempts, so both sides must stay identical.

import type { LinkTarget } from "./browser-prefs"

export type HostRuleAction = LinkTarget | "block"

export const HOST_RULE_ACTIONS: readonly HostRuleAction[] = [
  "builtin",
  "system",
  "block",
]

export interface HostRule {
  /** Hostname, `*.suffix`, or `*`; an optional `:port` pins the port. */
  pattern: string
  action: HostRuleAction
}

/** Longest a hostname can be (RFC 1035), plus a port. */
const MAX_PATTERN_LEN = 253 + 6

type HostMatcher =
  | { kind: "any" }
  | { kind: "suffix"; suffix: string }
  | { kind: "exact"; host: string }

export interface ParsedHostRulePattern {
  host: HostMatcher
  port: number | null
}

function validHostname(host: string): boolean {
  return (
    host.length > 0 &&
    !host.startsWith(".") &&
    !host.endsWith(".") &&
    !host.includes("..") &&
    /^[a-z0-9._-]+$/.test(host)
  )
}

/**
 * An IPv6 literal (without brackets) in the canonical form the URL parser
 * produces (`::1`, never `0:0:0:0:0:0:0:1`), or `null` when it is not one.
 * The URL parser is the one canonicalizer both sides agree with.
 */
function canonicalIpv6(host: string): string | null {
  if (!host.includes(":") || !/^[0-9a-f:.]+$/.test(host)) return null
  try {
    return new URL(`http://[${host}]/`).hostname.replace(/^\[|\]$/g, "")
  } catch {
    return null
  }
}

/** ASCII-only lower-casing, like the Rust side: a non-ASCII letter is not
 *  part of a pattern, and Unicode folding (`K` → `k`) must not make one. */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (c) => c.toLowerCase())
}

/** Trimming of exactly the characters the Rust side trims
 *  (`char::is_ascii_whitespace`: space, tab, line feed, form feed, carriage
 *  return — and NOT vertical tab). `String.prototype.trim` and `str::trim`
 *  disagree on U+0085, U+00A0 and more; a pattern the two sides parse
 *  differently is a rule one of them silently ignores. */
function asciiTrim(text: string): string {
  return text.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "")
}

/**
 * Parse a pattern; `null` for anything that is not one. Case-insensitive,
 * surrounding whitespace ignored. Same grammar as the Rust side.
 */
export function parseHostRulePattern(
  pattern: string
): ParsedHostRulePattern | null {
  const trimmed = asciiLower(asciiTrim(pattern))
  if (!trimmed || trimmed.length > MAX_PATTERN_LEN) return null
  let host: string
  let portText: string | null = null
  const bracketed = trimmed.startsWith("[")
  if (bracketed) {
    // `[::1]:3000` — an IPv6 literal keeps its brackets; the port follows.
    const close = trimmed.indexOf("]")
    if (close === -1) return null
    host = trimmed.slice(1, close)
    const tail = trimmed.slice(close + 1)
    if (tail.startsWith(":")) portText = tail.slice(1)
    else if (tail.length > 0) return null
  } else {
    const colon = trimmed.lastIndexOf(":")
    if (colon !== -1) {
      const digits = trimmed.slice(colon + 1)
      if (!/^\d+$/.test(digits)) return null
      host = trimmed.slice(0, colon)
      portText = digits
    } else {
      host = trimmed
    }
  }
  let port: number | null = null
  if (portText !== null) {
    port = Number(portText)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  }
  let matcher: HostMatcher
  if (bracketed) {
    // Brackets mean an IPv6 literal and nothing else — not a wildcard, not
    // a name.
    const canonical = canonicalIpv6(host)
    if (!canonical) return null
    matcher = { kind: "exact", host: canonical }
  } else if (host === "*") {
    matcher = { kind: "any" }
  } else if (host.startsWith("*.")) {
    const suffix = host.slice(2)
    if (!validHostname(suffix)) return null
    matcher = { kind: "suffix", suffix: `.${suffix}` }
  } else if (validHostname(host)) {
    matcher = { kind: "exact", host }
  } else {
    return null
  }
  return { host: matcher, port }
}

/** Why a typed pattern is not accepted, or `null` when it is. */
export function validateHostRulePattern(
  pattern: string
): "empty" | "invalid" | null {
  if (!asciiTrim(pattern)) return "empty"
  return parseHostRulePattern(pattern) ? null : "invalid"
}

/** The form a pattern is stored in: (ASCII) trimmed and lower-cased. */
export function normalizeHostRulePattern(pattern: string): string {
  return asciiLower(asciiTrim(pattern))
}

/**
 * The URL's host as a rule sees it: lower-case, without IPv6 brackets and
 * without a trailing dot — `example.com.` names the same server as
 * `example.com`, and a block on one must hold for the other. Same as the
 * Rust side's `rule_hostname`.
 */
export function ruleHostname(parsed: URL): string | null {
  const host = parsed.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "")
    .toLowerCase()
  return host.length > 0 ? host : null
}

function effectivePort(parsed: URL): number | null {
  if (parsed.port) return Number(parsed.port)
  if (parsed.protocol === "https:") return 443
  if (parsed.protocol === "http:") return 80
  return null
}

function matches(
  rule: ParsedHostRulePattern,
  hostname: string,
  port: number | null
): boolean {
  const host = rule.host
  const hostOk =
    host.kind === "any"
      ? true
      : host.kind === "suffix"
        ? hostname.endsWith(host.suffix) && hostname.length > host.suffix.length
        : hostname === host.host
  return hostOk && (rule.port === null || rule.port === port)
}

type Score = [number, number, number, number]

/** Among equally specific rules the more restrictive one wins — two
 *  spellings of one host may both be in the table, and a block must not
 *  depend on which was listed first. */
const RESTRICTIVENESS: Record<HostRuleAction, number> = {
  block: 2,
  system: 1,
  builtin: 0,
}

/**
 * Higher wins: an exact host over a wildcard, a longer wildcard suffix over
 * a shorter one, `*` last; a pinned port breaks a tie; then the action.
 */
function score(rule: ParsedHostRulePattern, action: HostRuleAction): Score {
  const host = rule.host
  const [kind, len] =
    host.kind === "exact"
      ? [2, host.host.length]
      : host.kind === "suffix"
        ? [1, host.suffix.length]
        : [0, 0]
  return [kind, len, rule.port === null ? 0 : 1, RESTRICTIVENESS[action]]
}

function higher(a: Score, b: Score): boolean {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i]
  }
  return false
}

/**
 * The rule that applies to `parsed`: the most specific matching pattern;
 * among equally specific ones the most restrictive action, and among those
 * the first listed. Unparsable patterns never match.
 */
export function matchHostRule(
  rules: readonly HostRule[] | undefined,
  parsed: URL
): HostRule | null {
  if (!rules || rules.length === 0) return null
  const hostname = ruleHostname(parsed)
  if (!hostname) return null
  const port = effectivePort(parsed)
  let best: { rule: HostRule; score: Score } | null = null
  for (const rule of rules) {
    const pattern = parseHostRulePattern(rule.pattern)
    if (!pattern || !matches(pattern, hostname, port)) continue
    const candidate = score(pattern, rule.action)
    if (!best || higher(candidate, best.score)) {
      best = { rule, score: candidate }
    }
  }
  return best?.rule ?? null
}

/**
 * What a pattern matches, as a key: two patterns with the same key are the
 * same rule however they are spelled (`[::1]` / `[0:0:0:0:0:0:0:1]`, case,
 * whitespace). `null` for anything that is not a pattern.
 */
export function hostRulePatternKey(pattern: string): string | null {
  const parsed = parseHostRulePattern(pattern)
  if (!parsed) return null
  const host =
    parsed.host.kind === "any"
      ? "*"
      : parsed.host.kind === "suffix"
        ? `*${parsed.host.suffix}`
        : parsed.host.host
  return `${host}:${parsed.port ?? ""}`
}

/** Whether a value read from storage or the wire is a rule. */
export function isHostRule(value: unknown): value is HostRule {
  if (!value || typeof value !== "object") return false
  const candidate = value as { pattern?: unknown; action?: unknown }
  return (
    typeof candidate.pattern === "string" &&
    candidate.pattern.trim().length > 0 &&
    candidate.pattern.length <= MAX_PATTERN_LEN &&
    typeof candidate.action === "string" &&
    (HOST_RULE_ACTIONS as readonly string[]).includes(candidate.action)
  )
}
