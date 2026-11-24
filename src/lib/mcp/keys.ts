import type { McpInventory } from "./types"

/**
 * What a NEW server name may be: what `mcp_apply` accepts for a key it
 * creates and for a rename's target.
 *
 * Agents such as Claude Code build the names of a server's tools from its key
 * (`mcp__<key>__<tool>`), and a key with a dot, a space or a slash breaks that
 * — which is why the rule exists. It is for new names only: a key that is
 * already in a file and breaks it stays as it is, and stays editable.
 *
 * The rule and the reserved names come from the inventory; these are what the
 * backend sends, for the moments before one has been read.
 */
export const DEFAULT_KEY_PATTERN = "^[A-Za-z0-9_-]{1,64}$"
export const DEFAULT_RESERVED_KEYS: readonly string[] = ["codeg-mcp"]

export interface McpKeyRules {
  pattern: RegExp
  reserved: readonly string[]
}

const DEFAULT_RULES: McpKeyRules = {
  pattern: new RegExp(DEFAULT_KEY_PATTERN),
  reserved: DEFAULT_RESERVED_KEYS,
}

export function keyRulesOf(inventory: McpInventory | null): McpKeyRules {
  if (!inventory) return DEFAULT_RULES
  let pattern = DEFAULT_RULES.pattern
  if (inventory.key_pattern) {
    try {
      pattern = new RegExp(inventory.key_pattern)
    } catch {
      // A pattern this engine cannot compile: the backend still checks, and
      // the default is what it has always sent.
    }
  }
  const reserved =
    inventory.reserved_keys.length > 0
      ? inventory.reserved_keys
      : DEFAULT_RULES.reserved
  return { pattern, reserved }
}

/** Why `key` cannot be a new server's name, or `null` when it can. */
export type McpKeyProblem = "empty" | "reserved" | "invalid"

export function newKeyProblem(
  key: string,
  rules: McpKeyRules
): McpKeyProblem | null {
  if (key === "") return "empty"
  if (rules.reserved.includes(key)) return "reserved"
  if (!rules.pattern.test(key)) return "invalid"
  return null
}

export function isReservedKey(key: string, rules: McpKeyRules): boolean {
  return rules.reserved.includes(key)
}
