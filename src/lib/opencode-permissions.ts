/**
 * Pure model for OpenCode 2's `permissions` config: an ordered list of rules.
 *
 *   "permissions": [
 *     { "action": "shell", "resource": "*", "effect": "ask" },
 *     { "action": "shell", "resource": "git status *", "effect": "allow" },
 *     { "action": "shell", "resource": "git push *", "effect": "deny" }
 *   ]
 *
 * `action` names a tool's permission (`shell`, `edit`, `read`, …, `*` for all),
 * `resource` is what it acts on (a command, a path, a URL, a skill id, …), and
 * `effect` is `allow` / `ask` / `deny`. Both are whole-value wildcards. A call
 * is decided by the LAST matching rule (`core/src/permission.ts`:
 * `rulesets.flat().findLast(…)`), and with no match at all OpenCode asks —
 * though every agent starts from a base policy that allows everything except
 * reading `.env` files, so in practice an unset action is allowed.
 *
 * ## The editor's model, and why order is load-bearing
 *
 * The UI shows a global default (the `*`/`*` rule), then per action a base
 * effect (its `*` resource) and pattern rules. That is exactly what the list
 * means when it is written grouped: the global rules first, then each action's
 * rules together, its base before its patterns. Every writer here emits that
 * order. A list that arrived otherwise — an action's rules split up, a base
 * after its patterns, the global rule last, or a later rule covering an
 * earlier one — has rules that are written but not in force, so
 * {@link readOpenCodePermissions} reports `orderingUnsafe` and the UI says so.
 *
 * ## OpenCode 1.x's `permission`
 *
 * OpenCode 2 still loads 1.x's `permission` object (and the older `tools`
 * map), converting it in memory into rules placed before the 2.x ones, with
 * three actions renamed: `bash` → `shell`, `task` → `subagent`, and
 * `write`/`patch`/`apply_patch` → `edit` (`core/src/config/normalize.ts`,
 * `v1/config/migrate.ts`). This module reads such a document through the same
 * conversion, and the first edit writes the result as `permissions` and drops
 * the 1.x keys, so the file says one thing.
 *
 * ## Agents
 *
 * `agents.<id>.permissions` are appended after the global rules, so they win
 * the same `findLast`. Anything claiming "nothing will prompt" has to account
 * for them — see {@link applyOpenCodeAutoAccept}.
 *
 * Every writer goes through `patchJsoncText`, so comments and formatting
 * outside `permissions` survive; a document that does not parse is returned
 * unchanged — the caller's raw editor owns that error.
 */

import { parseJsoncObject, patchJsoncText, type JsonObject } from "./jsonc-edit"

export type OpenCodePermissionAction = "allow" | "ask" | "deny"

export const OPENCODE_PERMISSION_ACTIONS: readonly OpenCodePermissionAction[] =
  ["allow", "ask", "deny"] as const

/** The wildcard: as an action it is every tool, as a resource every target. */
export const OPENCODE_PERMISSION_WILDCARD = "*"

export interface OpenCodePermissionKeyMeta {
  key: string
  /** Whether rules for specific resources are worth offering. Every action
   *  accepts them; the action-only ones are checked against `*` alone. */
  fineGrained: boolean
  /** What OpenCode does when nothing configures the action: every agent's
   *  base policy allows all actions. */
  defaultAction: OpenCodePermissionAction
  /** Example resource for the rule editor's placeholder. */
  patternExample?: string
}

/**
 * OpenCode 2's built-in permission actions (docs: "Actions"), ordered by how
 * much a user is likely to care. MCP tools (`<server>_<tool>`) and plugin
 * actions are surfaced as custom entries.
 */
export const OPENCODE_PERMISSION_KEYS: readonly OpenCodePermissionKeyMeta[] = [
  {
    key: "shell",
    fineGrained: true,
    defaultAction: "allow",
    patternExample: "git *",
  },
  {
    key: "edit",
    fineGrained: true,
    defaultAction: "allow",
    patternExample: "src/*.ts",
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
    defaultAction: "allow",
    patternExample: "~/projects/*",
  },
  {
    key: "subagent",
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
    key: "webfetch",
    fineGrained: true,
    defaultAction: "allow",
    patternExample: "https://docs.example.com/*",
  },
  {
    key: "websearch",
    fineGrained: true,
    defaultAction: "allow",
    patternExample: "*",
  },
  {
    key: "glob",
    fineGrained: true,
    defaultAction: "allow",
    patternExample: "src/*",
  },
  {
    key: "grep",
    fineGrained: true,
    defaultAction: "allow",
    patternExample: "TODO.*",
  },
  // Code Mode: denying it removes `execute` and the MCP tools reached only
  // through it, while nested tools keep enforcing their own rules.
  { key: "execute", fineGrained: false, defaultAction: "allow" },
  { key: "question", fineGrained: false, defaultAction: "allow" },
  // Only present with `experimental.todo`.
  { key: "todowrite", fineGrained: false, defaultAction: "allow" },
]

const KNOWN_KEYS = new Set(OPENCODE_PERMISSION_KEYS.map((meta) => meta.key))

export interface OpenCodePermissionRule {
  pattern: string
  action: OpenCodePermissionAction
}

export interface OpenCodePermissionEntry {
  key: string
  /** Base effect: the action's `*` rule. null = unset. */
  action: OpenCodePermissionAction | null
  /** Rules for specific resources, in list order (last match wins). */
  rules: OpenCodePermissionRule[]
  /** True for an action that is not in {@link OPENCODE_PERMISSION_KEYS}
   *  (an MCP tool, a plugin's action, or `*` rules for specific resources). */
  custom: boolean
}

export interface OpenCodePermissionView {
  /** Whether the document configures permissions at all. */
  shape: "unset" | "rules"
  /** The rules come (partly) from 1.x's `permission` / `tools`, which the
   *  next edit rewrites as `permissions`. */
  legacy: boolean
  /** The global default: the `*`/`*` rule's effect. */
  globalAction: OpenCodePermissionAction | null
  /**
   * True when nothing can prompt or block: the global default is `allow` and no
   * rule or agent narrows it to `ask` / `deny`.
   */
  autoAcceptAll: boolean
  /** Every known action (unset ones carry `action: null`) then custom ones. */
  entries: OpenCodePermissionEntry[]
  /**
   * Some rule is written but not in force: the list is not in the grouped
   * order the editor shows, or a later rule covers an earlier one. The rows
   * shown are the grouped reading, so the UI must say so.
   */
  orderingUnsafe: boolean
  /** True when {@link normalizeOpenCodePermissionOrder} would clear
   *  `orderingUnsafe`. False when two overlapping globs remain, which has no
   *  one obviously-correct order — that has to be fixed in the raw editor. */
  orderingFixable: boolean
  /** Agents whose own rules can still prompt or block. They are applied after
   *  the global ones, so they outrank everything modelled in `entries`. */
  agentOverrides: string[]
  /** The rules cannot be read (not a list of `{action, resource, effect}`).
   *  The UI stays read-only and points at the raw editor. */
  invalid: boolean
}

interface Rule {
  action: string
  resource: string
  effect: OpenCodePermissionAction
}

function isAction(value: unknown): value is OpenCodePermissionAction {
  return value === "allow" || value === "ask" || value === "deny"
}

function asRecord(value: unknown): JsonObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as JsonObject
}

/**
 * Whether the visual editor can write at all: every writer here refuses to
 * touch a document it cannot parse, so the UI must fall back to the raw editor
 * instead of silently swallowing clicks.
 */
export function isOpenCodeConfigEditable(configText: string): boolean {
  return parseJsoncObject(configText).value !== null
}

/** 1.x's action names, as OpenCode 2 renames them (`v1/config/migrate.ts`). */
function normalizeLegacyAction(action: string): string {
  if (action === "write" || action === "patch" || action === "apply_patch")
    return "edit"
  if (action === "task") return "subagent"
  if (action === "bash") return "shell"
  return action
}

/** 1.x's `tools` and `permission`, converted the way OpenCode 2 converts them
 *  (`core/src/config/normalize.ts`: `migrateTools`, `migratePermissions`).
 *  `null` when either is malformed. */
function legacyRules(config: JsonObject): Rule[] | null {
  const rules: Rule[] = []
  if (config.tools !== undefined) {
    const tools = asRecord(config.tools)
    if (!tools) return null
    for (const [action, enabled] of Object.entries(tools)) {
      if (typeof enabled !== "boolean") return null
      rules.push({
        action: normalizeLegacyAction(action),
        resource: "*",
        effect: enabled ? "allow" : "deny",
      })
    }
  }
  const permission = config.permission
  if (permission === undefined || permission === null) return rules
  if (isAction(permission)) {
    rules.push({ action: "*", resource: "*", effect: permission })
    return rules
  }
  const record = asRecord(permission)
  if (!record) return null
  for (const [action, value] of Object.entries(record)) {
    if (isAction(value)) {
      rules.push({
        action: normalizeLegacyAction(action),
        resource: "*",
        effect: value,
      })
      continue
    }
    const patterns = asRecord(value)
    if (!patterns) return null
    for (const [resource, effect] of Object.entries(patterns)) {
      if (!isAction(effect)) return null
      rules.push({ action: normalizeLegacyAction(action), resource, effect })
    }
  }
  return rules
}

/** `permissions` as rules; `null` when it is not a well-formed rule list. */
function nativeRules(value: unknown): Rule[] | null {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) return null
  const rules: Rule[] = []
  for (const raw of value) {
    const rule = asRecord(raw)
    if (
      !rule ||
      typeof rule.action !== "string" ||
      typeof rule.resource !== "string" ||
      !isAction(rule.effect)
    )
      return null
    rules.push({
      action: rule.action,
      resource: rule.resource,
      effect: rule.effect,
    })
  }
  return rules
}

/** Every rule the document contributes, in OpenCode's order: 1.x's first. */
function documentRules(config: JsonObject): Rule[] | null {
  const legacy = legacyRules(config)
  const native = nativeRules(config.permissions)
  if (!legacy || !native) return null
  return [...legacy, ...native]
}

function hasLegacyPermissions(config: JsonObject): boolean {
  return (
    config.tools !== undefined ||
    (config.permission !== undefined && config.permission !== null)
  )
}

interface Group {
  key: string
  base: OpenCodePermissionAction | null
  rules: OpenCodePermissionRule[]
}

/** The editor's reading of a rule list: the global group first, then each
 *  action's rules in order of first appearance, a later duplicate resource
 *  replacing an earlier one. */
function regroup(rules: Rule[]): Group[] {
  const groups = new Map<string, Group>()
  for (const rule of rules) {
    let group = groups.get(rule.action)
    if (!group) {
      group = { key: rule.action, base: null, rules: [] }
      groups.set(rule.action, group)
    }
    if (rule.resource === OPENCODE_PERMISSION_WILDCARD) {
      group.base = rule.effect
      continue
    }
    const existing = group.rules.findIndex((r) => r.pattern === rule.resource)
    if (existing >= 0) group.rules.splice(existing, 1)
    group.rules.push({ pattern: rule.resource, action: rule.effect })
  }
  const ordered = [...groups.values()]
  const global = ordered.findIndex(
    (g) => g.key === OPENCODE_PERMISSION_WILDCARD
  )
  if (global > 0) ordered.unshift(...ordered.splice(global, 1))
  return ordered
}

/** The rule list a grouped model stands for. */
function serialize(groups: Group[]): Rule[] {
  const rules: Rule[] = []
  for (const group of groups) {
    if (group.base)
      rules.push({ action: group.key, resource: "*", effect: group.base })
    for (const rule of group.rules)
      rules.push({
        action: group.key,
        resource: rule.pattern,
        effect: rule.action,
      })
  }
  return rules
}

function sameRules(a: Rule[], b: Rule[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (rule, i) =>
        rule.action === b[i].action &&
        rule.resource === b[i].resource &&
        rule.effect === b[i].effect
    )
  )
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
 * True when a rule in the grouped list is dead because a later one covers it:
 * an action group covered by a later group's action glob (`{"mymcp_run"}`
 * then `{"mymcp_*"}`), or a resource rule covered by a later one in its group
 * (`"git ?"` then `"git *"`). The documented arrangement — specific after
 * general — is not flagged, because a specific glob does not cover a general
 * one. The global group comes first, so it never shadows.
 */
function groupsShadowed(groups: Group[]): boolean {
  const keys = groups
    .map((group) => group.key)
    .filter((key) => key !== OPENCODE_PERMISSION_WILDCARD)
  if (listShadowed(keys)) return true
  return groups.some((group) =>
    listShadowed(group.rules.map((rule) => rule.pattern))
  )
}

/** Whether a later glob in `items` covers an earlier one. */
function listShadowed(items: string[]): boolean {
  // The matcher folds `\` to `/` before anything else, so two items the
  // JSON kept apart can still be the same pattern.
  const normalized = items.map((item) => item.replace(/\\/g, "/"))
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      // A wildcard-free item matches exactly itself, so the only earlier item
      // it can cover is one that normalizes to the same thing. Skipping the
      // rest keeps the pairwise sweep cheap on an all-literal list.
      if (!/[*?]/.test(normalized[j]) && normalized[j] !== normalized[i]) {
        continue
      }
      if (globCovers(items[i], items[j])) return true
    }
  }
  return false
}

/** Whether an `agents.<id>.permissions` list (or 1.x agent block) can still
 *  prompt or block. A block that only allows cannot stop a call. */
function rulesNarrow(rules: Rule[] | null): boolean {
  return (rules ?? []).some((rule) => rule.effect !== "allow")
}

/** Agents whose own rules can still prompt or block: OpenCode 2's
 *  `agents.<id>.permissions`, and 1.x's `agent.<name>` / `mode.<name>`
 *  `permission` and `tools`, which it converts the same way. */
function findAgentOverrides(config: JsonObject): string[] {
  const names = new Set<string>()
  const native = asRecord(config.agents)
  for (const [name, raw] of Object.entries(native ?? {})) {
    const agent = asRecord(raw)
    if (agent && rulesNarrow(nativeRules(agent.permissions))) names.add(name)
  }
  for (const scopeKey of ["agent", "mode"]) {
    const scope = asRecord(config[scopeKey])
    for (const [name, raw] of Object.entries(scope ?? {})) {
      const agent = asRecord(raw)
      if (!agent) continue
      const legacy = legacyRules({
        permission: agent.permission,
        tools: agent.tools,
      })
      if (rulesNarrow(legacy)) names.add(name)
    }
  }
  return [...names]
}

function entriesOf(groups: Group[]): OpenCodePermissionEntry[] {
  const byKey = new Map(groups.map((group) => [group.key, group]))
  const entries: OpenCodePermissionEntry[] = OPENCODE_PERMISSION_KEYS.map(
    (meta) => {
      const group = byKey.get(meta.key)
      return {
        key: meta.key,
        action: group?.base ?? null,
        rules: group?.rules ?? [],
        custom: false,
      }
    }
  )
  for (const group of groups) {
    if (KNOWN_KEYS.has(group.key)) continue
    if (group.key === OPENCODE_PERMISSION_WILDCARD) {
      // The global default is shown on its own; `*` rules for specific
      // resources are listed like a custom action's so they stay visible.
      if (group.rules.length > 0)
        entries.push({
          key: group.key,
          action: null,
          rules: group.rules,
          custom: true,
        })
      continue
    }
    entries.push({
      key: group.key,
      action: group.base,
      rules: group.rules,
      custom: true,
    })
  }
  return entries
}

/** Read the document's permissions into a flat, UI-friendly view. */
export function readOpenCodePermissions(
  configText: string
): OpenCodePermissionView {
  const config = parseJsoncObject(configText).value
  const empty: OpenCodePermissionView = {
    shape: "unset",
    legacy: false,
    globalAction: null,
    autoAcceptAll: false,
    entries: entriesOf([]),
    orderingUnsafe: false,
    orderingFixable: false,
    agentOverrides: [],
    invalid: false,
  }
  if (!config) return empty
  const agentOverrides = findAgentOverrides(config)
  const legacy = hasLegacyPermissions(config)
  const rules = documentRules(config)
  if (!rules) {
    return { ...empty, shape: "rules", legacy, agentOverrides, invalid: true }
  }
  if (rules.length === 0 && config.permissions === undefined && !legacy) {
    return { ...empty, agentOverrides }
  }

  const groups = regroup(rules)
  const grouped = sameRules(serialize(groups), rules)
  const shadowed = groupsShadowed(groups)
  const orderingUnsafe = !grouped || shadowed
  const globalAction =
    groups.find((g) => g.key === OPENCODE_PERMISSION_WILDCARD)?.base ?? null
  const entries = entriesOf(groups)
  const narrowed = rules.some((rule) => rule.effect !== "allow")

  return {
    shape: "rules",
    legacy,
    globalAction,
    autoAcceptAll:
      globalAction === "allow" &&
      !narrowed &&
      !orderingUnsafe &&
      agentOverrides.length === 0,
    entries,
    orderingUnsafe,
    orderingFixable: orderingUnsafe && !shadowed,
    agentOverrides,
    invalid: false,
  }
}

/**
 * Rewrite the document's rules through a mutator over the grouped model, as
 * OpenCode 2's `permissions`, dropping 1.x's `permission` and `tools` (whose
 * rules the model already holds). An emptied model removes the key.
 *
 * Rules written in another order than the grouped one are left alone unless
 * `reorder` is set: writing them back grouped would change what rules the
 * edit never touched decide, so only the explicit repair may do that.
 */
function patchPermissions(
  configText: string,
  mutate: (groups: Group[]) => void,
  reorder = false
): string {
  const parsed = parseJsoncObject(configText).value
  if (!parsed) return configText
  const rules = documentRules(parsed)
  if (!rules) return configText
  if (!reorder && !sameRules(serialize(regroup(rules)), rules))
    return configText
  return patchJsoncText(configText, (config) => {
    const groups = regroup(rules)
    mutate(groups)
    const next = serialize(groups.filter((g) => g.base || g.rules.length > 0))
    delete config.permission
    delete config.tools
    if (next.length > 0) config.permissions = next
    else delete config.permissions
  })
}

function groupFor(groups: Group[], key: string): Group {
  let group = groups.find((g) => g.key === key)
  if (!group) {
    group = { key, base: null, rules: [] }
    if (key === OPENCODE_PERMISSION_WILDCARD) groups.unshift(group)
    else groups.push(group)
  }
  return group
}

/**
 * Write the rules in the grouped order the editor shows, so the rules shown
 * are the rules OpenCode applies. Offered as an explicit repair for a list
 * codeg did not write.
 */
export function normalizeOpenCodePermissionOrder(configText: string): string {
  return patchPermissions(configText, () => {}, true)
}

/** Set (or clear, with `null`) the global default — the `*`/`*` rule. */
export function setOpenCodeGlobalPermission(
  configText: string,
  action: OpenCodePermissionAction | null
): string {
  return patchPermissions(configText, (groups) => {
    groupFor(groups, OPENCODE_PERMISSION_WILDCARD).base = action
  })
}

/** Set (or clear) one action's base effect, keeping its resource rules. */
export function setOpenCodeKeyPermission(
  configText: string,
  key: string,
  action: OpenCodePermissionAction | null
): string {
  if (!key || key === OPENCODE_PERMISSION_WILDCARD) return configText
  return patchPermissions(configText, (groups) => {
    groupFor(groups, key).base = action
  })
}

/**
 * Replace one action's resource rules, keeping its base effect. Blank
 * resources, and `*` (the base), are dropped; a later duplicate wins, as it
 * would in OpenCode.
 */
export function setOpenCodeKeyRules(
  configText: string,
  key: string,
  rules: OpenCodePermissionRule[]
): string {
  if (!key) return configText
  const cleaned: OpenCodePermissionRule[] = []
  for (const rule of rules) {
    const pattern = rule.pattern.trim()
    if (!pattern || pattern === OPENCODE_PERMISSION_WILDCARD) continue
    const existing = cleaned.findIndex((item) => item.pattern === pattern)
    if (existing >= 0) cleaned.splice(existing, 1)
    cleaned.push({ pattern, action: rule.action })
  }
  return patchPermissions(configText, (groups) => {
    groupFor(groups, key).rules = cleaned
  })
}

/**
 * Auto-accept everything: one `*`/`*` allow rule, and every other source of
 * an ask or deny cleared — 1.x's `permission` and `tools`, and each agent's
 * own rules, which OpenCode applies after the global ones and which would
 * therefore win (`agents.<id>.permissions`, and 1.x's `agent.<name>` /
 * `mode.<name>` `permission` and `tools`).
 *
 * Everything else in an agent block is preserved, and a block emptied by this
 * is KEPT: the mere presence of `agents.<id>` defines a custom agent.
 * `policies` are not permissions and are left alone: a `tool.use` deny there
 * still blocks, by design.
 */
export function applyOpenCodeAutoAccept(configText: string): string {
  try {
    return patchJsoncText(configText, (config) => {
      config.permissions = [{ action: "*", resource: "*", effect: "allow" }]
      delete config.permission
      delete config.tools
      const agents = asRecord(config.agents)
      for (const raw of Object.values(agents ?? {})) {
        const agent = asRecord(raw)
        if (agent) delete agent.permissions
      }
      for (const scopeKey of ["agent", "mode"]) {
        const scope = asRecord(config[scopeKey])
        for (const raw of Object.values(scope ?? {})) {
          const agent = asRecord(raw)
          if (!agent) continue
          delete agent.permission
          delete agent.tools
        }
      }
    })
  } catch {
    return configText
  }
}

/** Drop every permission rule the document sets, restoring OpenCode's own
 *  defaults. */
export function clearOpenCodePermissions(configText: string): string {
  const config = parseJsoncObject(configText).value
  if (
    !config ||
    (config.permissions === undefined && !hasLegacyPermissions(config))
  )
    return configText
  return patchJsoncText(configText, (draft) => {
    delete draft.permissions
    delete draft.permission
    delete draft.tools
  })
}

/**
 * What an action resolves to when the user hasn't set it: the global default
 * when one is configured, otherwise OpenCode's own (its base policy allows).
 */
export function effectiveOpenCodeDefault(
  key: string,
  globalAction: OpenCodePermissionAction | null
): OpenCodePermissionAction {
  if (globalAction) return globalAction
  const meta = OPENCODE_PERMISSION_KEYS.find((item) => item.key === key)
  return meta?.defaultAction ?? "allow"
}
