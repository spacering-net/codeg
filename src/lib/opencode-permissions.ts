/**
 * Pure model for OpenCode's `permission` config block.
 *
 * Shape comes from the official schema (`https://opencode.ai/config.json`,
 * `$defs/PermissionConfig`), semantics from the docs
 * (https://opencode.ai/docs/permissions/):
 *
 *   "permission": "allow"                     // one action for everything
 *   "permission": { "*": "ask", "bash": "allow" }
 *   "permission": { "bash": { "*": "ask", "git *": "allow" } }
 *
 * An action is `allow` (run without approval) / `ask` (prompt) / `deny`
 * (block).
 *
 * ## Why key order is load-bearing
 *
 * OpenCode flattens the whole block into ONE list of rules and resolves a call
 * with `findLast` (`packages/opencode/src/permission/index.ts`):
 *
 *     for (const [key, value] of Object.entries(permission)) {
 *       if (typeof value === "string") { ruleset.push({permission: key, action: value, pattern: "*"}) ... }
 *       ruleset.push(...Object.entries(value).map(([pattern, action]) => ({permission: key, pattern, action})))
 *     }
 *     rulesets.flat().findLast((rule) =>
 *       Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern))
 *
 * The tool name is matched with the same wildcard matcher as the pattern, so a
 * top-level `"*"` matches EVERY tool — and because the last match wins, a `"*"`
 * written after `"bash"` silently overrides it. `{"bash":"deny","*":"allow"}`
 * allows bash. Every writer here therefore re-emits `"*"` first, in its scope,
 * and {@link readOpenCodePermissions} reports `orderingUnsafe` for a document
 * that arrived the other way round so the UI never shows a rule that is not the
 * one actually in force.
 *
 * `"*"` inside a scope is that scope's base action: at the top level it is the
 * global default, inside a key it is the key's default before its patterns.
 * This module treats "base action" and `"*"` as the same thing so the UI has a
 * single mental model.
 *
 * ## Agents
 *
 * Per-agent blocks (`agent.<name>.permission`) are appended AFTER the global
 * rules, so they win the same `findLast`. Anything claiming "nothing will
 * prompt" has to account for them — see {@link applyOpenCodeAutoAccept}.
 *
 * Every function is pure: it parses the given JSON text, mutates a clone and
 * returns new JSON text, leaving all unrelated keys untouched. Invalid JSON is
 * returned unchanged — the caller's raw-JSON editor owns that error.
 */

export type OpenCodePermissionAction = "allow" | "ask" | "deny"

export const OPENCODE_PERMISSION_ACTIONS: readonly OpenCodePermissionAction[] =
  ["allow", "ask", "deny"] as const

/** The wildcard pattern that carries a scope's base action. */
export const OPENCODE_PERMISSION_WILDCARD = "*"

export interface OpenCodePermissionKeyMeta {
  key: string
  /**
   * Whether the schema types this key as `PermissionRuleConfig` (action *or*
   * pattern object) rather than a bare `PermissionActionConfig`. Only these
   * get a fine-grained rule editor.
   *
   * NOTE: the prose docs describe `webfetch`/`websearch` as matched by URL and
   * query, but the published schema types both as action-only — so codeg keeps
   * them action-only rather than emit config the `$schema` would reject. The
   * raw-JSON editor remains available for anyone who wants to try patterns.
   */
  fineGrained: boolean
  /** What OpenCode does when the key is unset (docs → "Defaults"). */
  defaultAction: OpenCodePermissionAction
  /** Example pattern for the rule editor's placeholder. */
  patternExample?: string
}

/**
 * Known permission keys, ordered by how much a user is likely to care.
 * `additionalProperties` in the schema means other keys (MCP tools, etc.) are
 * legal too — those are surfaced separately as "custom" entries.
 */
export const OPENCODE_PERMISSION_KEYS: readonly OpenCodePermissionKeyMeta[] = [
  {
    key: "bash",
    fineGrained: true,
    defaultAction: "allow",
    patternExample: "git *",
  },
  {
    key: "edit",
    fineGrained: true,
    defaultAction: "allow",
    patternExample: "src/**/*.ts",
  },
  {
    key: "read",
    fineGrained: true,
    defaultAction: "allow",
    patternExample: "*.env",
  },
  {
    key: "external_directory",
    fineGrained: true,
    defaultAction: "ask",
    patternExample: "~/projects/**",
  },
  {
    key: "task",
    fineGrained: true,
    defaultAction: "allow",
    patternExample: "general",
  },
  {
    key: "skill",
    fineGrained: true,
    defaultAction: "allow",
    patternExample: "my-skill",
  },
  {
    key: "glob",
    fineGrained: true,
    defaultAction: "allow",
    patternExample: "src/**",
  },
  {
    key: "grep",
    fineGrained: true,
    defaultAction: "allow",
    patternExample: "TODO.*",
  },
  {
    key: "list",
    fineGrained: true,
    defaultAction: "allow",
    patternExample: "src/**",
  },
  // Upstream types `lsp` as a `PermissionRuleConfig` (see `InputObject` in
  // `config/v1/permission.ts`), i.e. it takes per-operation patterns like the
  // keys above — `lsp_diagnostics`, `lsp_goto_definition`, … — not just a bare
  // action.
  {
    key: "lsp",
    fineGrained: true,
    defaultAction: "allow",
    patternExample: "lsp_diagnostics",
  },
  { key: "webfetch", fineGrained: false, defaultAction: "allow" },
  { key: "websearch", fineGrained: false, defaultAction: "allow" },
  { key: "todowrite", fineGrained: false, defaultAction: "allow" },
  { key: "question", fineGrained: false, defaultAction: "allow" },
  { key: "doom_loop", fineGrained: false, defaultAction: "ask" },
]

const KNOWN_KEYS = new Set(OPENCODE_PERMISSION_KEYS.map((meta) => meta.key))

export interface OpenCodePermissionRule {
  pattern: string
  action: OpenCodePermissionAction
}

export interface OpenCodePermissionEntry {
  key: string
  /** Base action: the bare string form, or the scope's `"*"`. null = unset. */
  action: OpenCodePermissionAction | null
  /** Pattern rules other than `"*"`, in file order (last match wins). */
  rules: OpenCodePermissionRule[]
  /** True for a key that is not in {@link OPENCODE_PERMISSION_KEYS}. */
  custom: boolean
}

export interface OpenCodePermissionView {
  /** How `permission` is written on disk right now. */
  shape: "unset" | "action" | "object"
  /** Effective global default: the bare action, or the object's `"*"`. */
  globalAction: OpenCodePermissionAction | null
  /**
   * True when nothing can prompt or block: the global default is `allow` and no
   * key or rule narrows it to `ask` / `deny`.
   */
  autoAcceptAll: boolean
  /** Every known key (unset ones carry `action: null`) then custom keys. */
  entries: OpenCodePermissionEntry[]
  /**
   * A key somewhere in the block is shadowed by a later, more general one — the
   * plain `"*"` written last, or a glob like `"mymcp_*"` after `"mymcp_run"`.
   * Those rows are displayed but not in force, so the UI must say so.
   */
  orderingUnsafe: boolean
  /**
   * True when {@link normalizeOpenCodePermissionOrder} would clear
   * `orderingUnsafe`. False for shadowing between two globs, which has no one
   * obviously-correct order — that has to be fixed in the raw JSON.
   */
  orderingFixable: boolean
  /**
   * Names of `agent.<name>` / `mode.<name>` blocks that can still prompt or
   * block. Agent rules are applied after the global ones, so these outrank
   * everything modelled in `entries`.
   */
  agentOverrides: string[]
  /**
   * A top-level `tools` map contains a `false`. OpenCode folds the deprecated
   * map into `permission`, so it denies a tool that this editor shows as
   * unset — worth saying out loud, since nothing here edits it.
   */
  legacyToolsDeny: boolean
  /**
   * `permission` exists but is not a valid action string or object (e.g. an
   * array, or an object holding a non-action value). The UI should stay
   * read-only and point at the raw-JSON editor.
   */
  invalid: boolean
}

function isAction(value: unknown): value is OpenCodePermissionAction {
  return value === "allow" || value === "ask" || value === "deny"
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/** Parse a config document; returns null when the text is not a JSON object. */
function parseConfig(configText: string): Record<string, unknown> | null {
  const trimmed = configText.trim()
  if (!trimmed) return {}
  try {
    return asRecord(JSON.parse(trimmed))
  } catch {
    return null
  }
}

/** Serialize back, collapsing an empty document to "" (= no file). */
function serializeConfig(config: Record<string, unknown>): string {
  return Object.keys(config).length === 0 ? "" : JSON.stringify(config, null, 2)
}

/**
 * Whether the visual editor can write at all: every writer here refuses to
 * touch a document it cannot parse, so the UI must fall back to the raw-JSON
 * editor instead of silently swallowing clicks.
 */
export function isOpenCodeConfigEditable(configText: string): boolean {
  return parseConfig(configText) !== null
}

function emptyEntries(): OpenCodePermissionEntry[] {
  return OPENCODE_PERMISSION_KEYS.map((meta) => ({
    key: meta.key,
    action: null,
    rules: [],
    custom: false,
  }))
}

/**
 * The alternatives a single OpenCode glob really stands for. `Wildcard.match`
 * rewrites a trailing `" .*"` into `"( .*)?"`, so `"git *"` matches plain
 * `"git"` as well as `"git "` + anything.
 *
 * Runs of `*` are then collapsed. Every `*` becomes `.*`, so `**` and `*` are
 * the same language, but a run costs the containment search dearly: each extra
 * `*` multiplies the live sets it has to keep apart. A doubled-star build
 * path against its single-star twin goes from thousands of states to none.
 *
 * Order matters — the trailing rule is decided on the ORIGINAL text, because
 * OpenCode applies it to the escaped pattern: `"git **"` becomes `"git .*.*"`,
 * which does not end in `" .*"` and so does not match a bare `"git"`.
 * Collapsing first would invent that match.
 */
function globVariants(pattern: string): string[] {
  const variants = pattern.endsWith(" *")
    ? [pattern, pattern.slice(0, -2)]
    : [pattern]
  return variants.map((variant) => variant.replace(/\*+/g, "*"))
}

/**
 * Ceilings for the containment search. The state cap only fends off absurd
 * input; the enqueue budget is the real bound, since the live-set powerset is
 * exponential in theory. Both bail out returning false — no warning — which is
 * the quiet direction.
 *
 * The budget is charged before a successor is allocated, so it bounds work and
 * memory rather than just counting what was already built. Real permission
 * patterns need well under 50 enqueues — the longest in OpenCode's own docs,
 * `packages/web/src/content/docs/*.mdx`, settles in 40 — so this leaves two
 * orders of magnitude of headroom while keeping the pathological case (a run
 * of a dozen `?` against `**`) to single-digit milliseconds.
 */
const GLOB_STATE_LIMIT = 512
const GLOB_VISIT_LIMIT = 20000

/**
 * Does every string glob `a` matches also match glob `b`?
 *
 * A containment question, not a text match. Asking whether `b` matches `a`'s
 * literal *text* is only exact when `a` has no metacharacters of its own:
 * `"git ?"` and `"git *"` each match the other's text, yet only `"git *"`
 * covers the other's language. Both halves of an OpenCode rule — the tool name
 * and the pattern — are globs, so both need the real answer. A token-by-token
 * walk is not enough either, because two `*`s can trade responsibility for the
 * same characters: `"*?"` covers `"a*"`, and no left-to-right pairing sees it.
 *
 * So: run `b` as an NFA determinized on the fly while `a` generates. State is
 * `a`'s position plus the set of `b` positions still live. `a`'s literals emit
 * themselves; its `?` and `*` emit every representative character — each
 * literal appearing anywhere in `b`, plus one that appears nowhere, which
 * stands for all the rest. Wherever `a` can stop, `b` must be able to accept;
 * the first place it cannot is a string in `a` but not in `b`. Both patterns
 * are expanded through {@link globVariants} first, so the trailing-`" *"` rule
 * is honoured on both sides — the side that bites is `a`: `" *"` matches the
 * empty string and `"?*"` does not.
 *
 * The live set is a sorted array rather than a bitmask so that pattern length
 * is not capped at a machine word: `"packages/web/src/content/docs/*.mdx"`
 * alone needs 36 states, and giving up on it would quietly switch the check off
 * for exactly the patterns the docs use as examples. Everything is indexed by
 * UTF-16 code unit, the alphabet the matcher's own regex works in.
 *
 * Exact for this dialect. Checked against the real matcher over every pair of
 * globs up to length 4 on a 3-letter alphabet, deciding containment by direct
 * comparison of the strings up to length 6 each one matches: 609,961 pairs, no
 * disagreement in either direction. Case-sensitive, deliberately: OpenCode
 * folds case only on Windows, and this runs in a webview that need not be on
 * the agent's machine, so it stays quiet rather than warn wrongly.
 */
function globCovers(a: string, b: string): boolean {
  const coveredVariants = globVariants(a.replace(/\\/g, "/"))
  const coverVariants = globVariants(b.replace(/\\/g, "/"))
  // Same pattern, same language - worth checking up front, because a
  // fixed-length `?` run after a `*` is exactly the shape whose subset
  // construction blows up. A doubled-star build path collapses onto its
  // single-star twin, and the search would otherwise spend 6,341 states
  // proving that a pattern covers itself.
  if (
    coveredVariants.length === coverVariants.length &&
    coveredVariants.every((variant, i) => variant === coverVariants[i])
  ) {
    return true
  }

  // One flat NFA over `b`'s variants: `tokens[state]` is the character at that
  // position, or null for a variant's accepting state.
  const tokens: Array<string | null> = []
  const starts: number[] = []
  for (const variant of coverVariants) {
    starts.push(tokens.length)
    for (let i = 0; i < variant.length; i++) tokens.push(variant[i])
    tokens.push(null)
  }
  if (tokens.length > GLOB_STATE_LIMIT) return false

  const alphabet = new Set<string>()
  for (const token of tokens) {
    if (token !== null && token !== "*" && token !== "?") alphabet.add(token)
  }
  // Plus one character `b` never mentions, standing in for all the rest.
  let fresh = " "
  while (alphabet.has(fresh)) {
    fresh = String.fromCharCode(fresh.charCodeAt(0) + 1)
  }

  /** Follow `*`-as-empty edges out of every live state. */
  const close = (live: Iterable<number>): number[] => {
    const out = new Set(live)
    const stack = [...out]
    while (stack.length > 0) {
      const state = stack.pop()!
      if (tokens[state] !== "*") continue
      if (out.has(state + 1)) continue
      out.add(state + 1)
      stack.push(state + 1)
    }
    return [...out].sort((x, y) => x - y)
  }

  const step = (live: number[], char: string): number[] => {
    const next = new Set<number>()
    for (const state of live) {
      const token = tokens[state]
      if (token === "*") next.add(state)
      else if (token === "?" || token === char) next.add(state + 1)
    }
    return close(next)
  }

  /**
   * Characters worth branching on from here. Only a literal that some live
   * state is actually waiting for can change the outcome; every other character
   * is consumable by exactly the same `*` and `?` states, so one stand-in
   * covers the lot. That keeps the fan-out at a path glob's handful of live
   * literals instead of every literal in the pattern.
   */
  const branches = (live: number[]): string[] => {
    const chars = new Set<string>()
    for (const state of live) {
      const token = tokens[state]
      if (token !== null && token !== "*" && token !== "?") chars.add(token)
    }
    chars.add(fresh)
    return [...chars]
  }

  const accepts = (live: number[]): boolean =>
    live.some((state) => tokens[state] === null)

  const start = close(starts)
  // Shared across `a`'s variants so total work stays bounded; the visited set
  // and queue are per-variant, since each variant is its own search.
  let budget = GLOB_VISIT_LIMIT

  for (const covered of coveredVariants) {
    const seen = new Set<string>()
    const pending: Array<[number, number[]]> = []

    /** Queue a state unless already known. False once the budget is out. */
    const enqueue = (index: number, live: number[]): boolean => {
      const key = `${index}:${live.join(",")}`
      if (seen.has(key)) return true
      if (--budget < 0) return false
      seen.add(key)
      pending.push([index, live])
      return true
    }

    if (!enqueue(0, start)) return false
    while (pending.length > 0) {
      const [index, live] = pending.pop()!

      if (index === covered.length) {
        // `a` can stop here, so `b` has to be able to.
        if (!accepts(live)) return false
        continue
      }
      const token = covered[index]
      if (token === "*") {
        if (!enqueue(index + 1, live)) return false
        for (const char of branches(live)) {
          if (!enqueue(index, step(live, char))) return false
        }
      } else if (token === "?") {
        for (const char of branches(live)) {
          if (!enqueue(index + 1, step(live, char))) return false
        }
      } else if (!enqueue(index + 1, step(live, token))) {
        return false
      }
    }
  }
  return true
}

/**
 * True when some key in this scope is shadowed by a later one that covers it.
 *
 * OpenCode flattens the block and resolves with `findLast`, so of two keys that
 * can match the same call the later one wins. If a later key covers an earlier
 * key's whole language, that earlier rule is dead: `{"bash":"deny","*":"allow"}`
 * allows bash, `{"mymcp_run":"deny","mymcp_*":"allow"}` allows `mymcp_run`, and
 * `{"git ?":"ask","git *":"allow"}` never asks. The documented arrangement —
 * specific written after general — is not flagged, because a specific pattern
 * does not cover the general one.
 */
function scopeOrderingUnsafe(scope: Record<string, unknown>): boolean {
  const keys = Object.keys(scope)
  // The matcher folds `\` to `/` before doing anything else, so two keys the
  // JSON kept apart can still be the same pattern.
  const normalized = keys.map((key) => key.replace(/\\/g, "/"))
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      // A wildcard-free key matches exactly itself, so the only earlier key it
      // can cover is one that normalizes to the same thing. Skipping the rest
      // keeps the pairwise sweep cheap on the ordinary all-literal config.
      if (!/[*?]/.test(normalized[j]) && normalized[j] !== normalized[i]) {
        continue
      }
      if (globCovers(keys[i], keys[j])) return true
    }
  }
  return false
}

/** Any `tools` entry set to `false` — the legacy way of writing a deny. */
function legacyToolsDeny(value: unknown): boolean {
  const tools = asRecord(value)
  if (!tools) return false
  return Object.values(tools).some((enabled) => enabled === false)
}

/** True when a `permission` value carries any `ask` / `deny`. */
function permissionNarrows(value: unknown): boolean {
  if (isAction(value)) return value !== "allow"
  const record = asRecord(value)
  if (!record) return false
  return Object.values(record).some((entry) => {
    if (isAction(entry)) return entry !== "allow"
    const rules = asRecord(entry)
    if (!rules) return false
    return Object.values(rules).some(
      (action) => isAction(action) && action !== "allow"
    )
  })
}

/**
 * Agent blocks that can still prompt or block, from any of the three sources
 * OpenCode folds into an agent's ruleset: `agent.<name>.permission`,
 * the deprecated `agent.<name>.tools` (`false` → deny, converted in
 * `packages/core/src/v1/config/agent.ts`), and the deprecated `mode.<name>`,
 * which `config.ts` merges into `agent.<name>` before any of that runs.
 *
 * A block that only grants `allow` cannot stop a call, so it does not count.
 */
function findAgentOverrides(config: Record<string, unknown>): string[] {
  const names = new Set<string>()
  for (const scopeKey of ["agent", "mode"]) {
    const scope = asRecord(config[scopeKey])
    if (!scope) continue
    for (const [name, rawAgent] of Object.entries(scope)) {
      const agent = asRecord(rawAgent)
      if (!agent) continue
      if (permissionNarrows(agent.permission) || legacyToolsDeny(agent.tools)) {
        names.add(name)
      }
    }
  }
  return [...names]
}

/** Read the `permission` block into a flat, UI-friendly view. */
export function readOpenCodePermissions(
  configText: string
): OpenCodePermissionView {
  const config = parseConfig(configText)
  const raw = config?.permission
  const agentOverrides = config ? findAgentOverrides(config) : []
  const rootToolsDeny = config ? legacyToolsDeny(config.tools) : false
  const clean = {
    orderingUnsafe: false,
    orderingFixable: false,
    agentOverrides,
    legacyToolsDeny: rootToolsDeny,
  }
  const unblocked = agentOverrides.length === 0 && !rootToolsDeny

  if (!config || raw === undefined || raw === null) {
    return {
      shape: "unset",
      globalAction: null,
      autoAcceptAll: false,
      entries: emptyEntries(),
      ...clean,
      invalid: false,
    }
  }

  if (isAction(raw)) {
    return {
      shape: "action",
      globalAction: raw,
      autoAcceptAll: raw === "allow" && unblocked,
      entries: emptyEntries(),
      ...clean,
      invalid: false,
    }
  }

  const record = asRecord(raw)
  if (!record) {
    return {
      shape: "object",
      globalAction: null,
      autoAcceptAll: false,
      entries: emptyEntries(),
      ...clean,
      invalid: true,
    }
  }

  let invalid = false
  let orderingUnsafe = scopeOrderingUnsafe(record)
  let globalAction: OpenCodePermissionAction | null = null
  const parsed = new Map<string, OpenCodePermissionEntry>()

  for (const [key, value] of Object.entries(record)) {
    if (key === OPENCODE_PERMISSION_WILDCARD) {
      if (isAction(value)) globalAction = value
      else invalid = true
      continue
    }

    if (isAction(value)) {
      parsed.set(key, {
        key,
        action: value,
        rules: [],
        custom: !KNOWN_KEYS.has(key),
      })
      continue
    }

    const ruleRecord = asRecord(value)
    if (!ruleRecord) {
      invalid = true
      continue
    }
    if (scopeOrderingUnsafe(ruleRecord)) orderingUnsafe = true

    let base: OpenCodePermissionAction | null = null
    const rules: OpenCodePermissionRule[] = []
    for (const [pattern, action] of Object.entries(ruleRecord)) {
      if (!isAction(action)) {
        invalid = true
        continue
      }
      if (pattern === OPENCODE_PERMISSION_WILDCARD) base = action
      else rules.push({ pattern, action })
    }
    parsed.set(key, {
      key,
      action: base,
      rules,
      custom: !KNOWN_KEYS.has(key),
    })
  }

  const entries: OpenCodePermissionEntry[] = OPENCODE_PERMISSION_KEYS.map(
    (meta) =>
      parsed.get(meta.key) ?? {
        key: meta.key,
        action: null,
        rules: [],
        custom: false,
      }
  )
  for (const entry of parsed.values()) {
    if (entry.custom) entries.push(entry)
  }

  const narrowed = entries.some(
    (entry) =>
      entry.action === "ask" ||
      entry.action === "deny" ||
      entry.rules.some((rule) => rule.action !== "allow")
  )

  return {
    shape: "object",
    globalAction,
    autoAcceptAll:
      globalAction === "allow" &&
      !narrowed &&
      !invalid &&
      !orderingUnsafe &&
      unblocked,
    entries,
    orderingUnsafe,
    // Reordering only helps when moving the wildcards to the front is enough;
    // two overlapping globs have no single obviously-correct order.
    orderingFixable:
      orderingUnsafe && !scopeOrderingUnsafeAfterNormalize(record),
    agentOverrides,
    legacyToolsDeny: rootToolsDeny,
    invalid,
  }
}

/** Whether shadowing would survive moving every `"*"` to the front. */
function scopeOrderingUnsafeAfterNormalize(
  record: Record<string, unknown>
): boolean {
  const top = withWildcardFirst(record)
  if (scopeOrderingUnsafe(top)) return true
  return Object.values(top).some((value) => {
    const rules = asRecord(value)
    return rules ? scopeOrderingUnsafe(withWildcardFirst(rules)) : false
  })
}

/**
 * Re-emit a scope with `"*"` first. Everything else keeps its relative order,
 * which is what decides precedence among the specific rules.
 */
function withWildcardFirst(
  scope: Record<string, unknown>
): Record<string, unknown> {
  if (!(OPENCODE_PERMISSION_WILDCARD in scope)) return scope
  const ordered: Record<string, unknown> = {
    [OPENCODE_PERMISSION_WILDCARD]: scope[OPENCODE_PERMISSION_WILDCARD],
  }
  for (const [key, value] of Object.entries(scope)) {
    if (key !== OPENCODE_PERMISSION_WILDCARD) ordered[key] = value
  }
  return ordered
}

/**
 * Rewrite `permission` through a mutator over the object form.
 *
 * A bare-action `permission` is first widened to `{ "*": <action> }` — the same
 * thing semantically — so per-key edits never silently drop the global default.
 * The result always leads with `"*"`: appending it instead would make it
 * override every key written before it (see the module header). When the
 * mutator leaves the object empty the key is removed entirely, and an emptied
 * document serializes to "".
 */
function patchPermissionObject(
  configText: string,
  mutate: (permission: Record<string, unknown>) => void
): string {
  const config = parseConfig(configText)
  if (!config) return configText
  const clone = JSON.parse(JSON.stringify(config)) as Record<string, unknown>

  const raw = clone.permission
  const rawRecord = asRecord(raw)
  const permission: Record<string, unknown> = isAction(raw)
    ? { [OPENCODE_PERMISSION_WILDCARD]: raw }
    : { ...(rawRecord ?? {}) }

  mutate(permission)

  if (Object.keys(permission).length === 0) delete clone.permission
  else clone.permission = withWildcardFirst(permission)

  return serializeConfig(clone)
}

/**
 * Move every `"*"` — the block's own and each key's — back to the front of its
 * scope, so the rules the UI shows are the rules OpenCode will apply. Offered
 * as an explicit repair for a document codeg did not write; no value changes.
 */
export function normalizeOpenCodePermissionOrder(configText: string): string {
  return patchPermissionObject(configText, (permission) => {
    for (const [key, value] of Object.entries(permission)) {
      const rules = asRecord(value)
      if (rules) permission[key] = withWildcardFirst(rules)
    }
  })
}

/**
 * Rebuild one key's value from a base action plus ordered pattern rules.
 * Rules are emitted after `"*"` so the wildcard stays the fallback and the
 * specific patterns keep last-match-wins priority, matching the docs' advice.
 * Blank and duplicate patterns are dropped (a later duplicate wins, mirroring
 * what JSON parsing would do anyway).
 */
function buildKeyValue(
  action: OpenCodePermissionAction | null,
  rules: OpenCodePermissionRule[]
): OpenCodePermissionAction | Record<string, string> | null {
  const cleaned: OpenCodePermissionRule[] = []
  const seen = new Set<string>()
  for (const rule of rules) {
    const pattern = rule.pattern.trim()
    if (!pattern || pattern === OPENCODE_PERMISSION_WILDCARD) continue
    if (seen.has(pattern)) {
      const index = cleaned.findIndex((item) => item.pattern === pattern)
      if (index >= 0) cleaned.splice(index, 1)
    }
    seen.add(pattern)
    cleaned.push({ pattern, action: rule.action })
  }

  if (cleaned.length === 0) return action
  const value: Record<string, string> = {}
  if (action) value[OPENCODE_PERMISSION_WILDCARD] = action
  for (const rule of cleaned) value[rule.pattern] = rule.action
  return value
}

/** Set (or clear, with `null`) the global default — `permission["*"]`. */
export function setOpenCodeGlobalPermission(
  configText: string,
  action: OpenCodePermissionAction | null
): string {
  return patchPermissionObject(configText, (permission) => {
    if (action) permission[OPENCODE_PERMISSION_WILDCARD] = action
    else delete permission[OPENCODE_PERMISSION_WILDCARD]
  })
}

/**
 * Set (or clear) one key's base action, keeping its existing pattern rules.
 * Clearing a key that still has rules leaves the rules in place — only the
 * key's own `"*"` goes away.
 */
export function setOpenCodeKeyPermission(
  configText: string,
  key: string,
  action: OpenCodePermissionAction | null
): string {
  if (!key || key === OPENCODE_PERMISSION_WILDCARD) return configText
  return patchPermissionObject(configText, (permission) => {
    const current = permission[key]
    const rules: OpenCodePermissionRule[] = []
    const record = asRecord(current)
    if (record) {
      for (const [pattern, value] of Object.entries(record)) {
        if (pattern === OPENCODE_PERMISSION_WILDCARD) continue
        if (isAction(value)) rules.push({ pattern, action: value })
      }
    }
    const next = buildKeyValue(action, rules)
    if (next === null) delete permission[key]
    else permission[key] = next
  })
}

/** Replace one key's pattern rules, keeping its base action. */
export function setOpenCodeKeyRules(
  configText: string,
  key: string,
  rules: OpenCodePermissionRule[]
): string {
  if (!key || key === OPENCODE_PERMISSION_WILDCARD) return configText
  return patchPermissionObject(configText, (permission) => {
    const current = permission[key]
    let action: OpenCodePermissionAction | null = null
    if (isAction(current)) {
      action = current
    } else {
      const record = asRecord(current)
      const base = record?.[OPENCODE_PERMISSION_WILDCARD]
      if (isAction(base)) action = base
    }
    const next = buildKeyValue(action, rules)
    if (next === null) delete permission[key]
    else permission[key] = next
  })
}

/**
 * Auto-accept everything: replace the block with `{ "*": "allow" }` and clear
 * every other source of a deny.
 *
 * Per-key overrides and pattern rules go, because one leftover
 * `"bash": { "rm *": "deny" }` would still stop a run. So do the per-agent
 * sources, which OpenCode applies *after* the global rules and which therefore
 * win outright: `agent.<name>.permission`, the deprecated
 * `agent.<name>.tools` (`false` → deny), and the deprecated `mode.<name>`,
 * which config loading folds into `agent.<name>`. The legacy top-level `tools`
 * map goes too, for the same reason.
 *
 * Everything else in an agent block — model, prompt, mode — is preserved, and
 * a block emptied by this is KEPT: OpenCode registers a custom agent from the
 * mere presence of `agent.<name>`, so deleting the entry would delete the agent.
 */
export function applyOpenCodeAutoAccept(configText: string): string {
  const config = parseConfig(configText)
  if (!config) return configText
  const clone = JSON.parse(JSON.stringify(config)) as Record<string, unknown>
  clone.permission = { [OPENCODE_PERMISSION_WILDCARD]: "allow" }
  delete clone.tools

  for (const scopeKey of ["agent", "mode"]) {
    const scope = asRecord(clone[scopeKey])
    if (!scope) continue
    for (const rawAgent of Object.values(scope)) {
      const agent = asRecord(rawAgent)
      if (!agent) continue
      delete agent.permission
      delete agent.tools
    }
  }

  return serializeConfig(clone)
}

/** Drop the whole `permission` block, restoring OpenCode's own defaults. */
export function clearOpenCodePermissions(configText: string): string {
  const config = parseConfig(configText)
  if (!config) return configText
  if (config.permission === undefined) return configText
  const clone = JSON.parse(JSON.stringify(config)) as Record<string, unknown>
  delete clone.permission
  return serializeConfig(clone)
}

/**
 * What a key actually resolves to when the user hasn't set it: the global
 * default when one is configured, otherwise OpenCode's own per-key default.
 */
export function effectiveOpenCodeDefault(
  key: string,
  globalAction: OpenCodePermissionAction | null
): OpenCodePermissionAction {
  if (globalAction) return globalAction
  const meta = OPENCODE_PERMISSION_KEYS.find((item) => item.key === key)
  return meta?.defaultAction ?? "allow"
}
