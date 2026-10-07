import type { KnownInvocations } from "@/lib/invocation-token"
import type { AgentSkillItem, AvailableCommandInfo } from "@/lib/types"

import type { ReferenceAttrs } from "./types"

/**
 * Builders that turn a runtime command / skill into the inline `reference`
 * badge the composer embeds (refType `skill`). They carry no `uri`, so on send
 * `referenceToMarkdown` serializes them to their literal invocation token
 * `${prefix}${id}` — `/command`, `$skill` — exactly the text the agent CLI
 * executes. `meta.invocationPrefix` drives that prefix; `meta.scope === "expert"`
 * (set elsewhere) is kept for the editor's leading-badge replace logic.
 */

export type InvocationPrefix = "/" | "$"

/**
 * The literal token an advertised command executes as. Codex (via codex-acp)
 * advertises its skills as commands NAMED `$<skill>` — for those the `$` IS the
 * invocation prefix (`$deploy`), not part of the name, so no `/` is prepended.
 * Every other command runs as `/<name>`. Menus render this token so the row
 * matches exactly what will be sent.
 */
export function commandInvocationToken(name: string): string {
  return name.startsWith("$") ? name : `/${name}`
}

/** A `/`-triggered ACP slash command → command badge (`/name` — except a
 *  Codex skill-as-command named `$skill`, whose `$` moves into the prefix so it
 *  serializes to `$skill`, the token Codex actually executes). */
export function commandToReference(cmd: AvailableCommandInfo): ReferenceAttrs {
  const isCodexSkill = cmd.name.startsWith("$")
  const id = isCodexSkill ? cmd.name.slice(1) : cmd.name
  return {
    refType: "skill",
    id,
    label: id,
    uri: null,
    meta: { invocationPrefix: isCodexSkill ? "$" : "/" },
  }
}

/** A `/`- or `$`-triggered agent skill → skill badge (`${prefix}${id}`). */
export function skillToReference(
  skill: AgentSkillItem,
  prefix: InvocationPrefix
): ReferenceAttrs {
  return {
    refType: "skill",
    id: skill.id,
    label: skill.name || skill.id,
    uri: null,
    meta: { invocationPrefix: prefix, scope: skill.scope },
  }
}

/**
 * The {@link KnownInvocations} of a composer: exactly the tokens its own
 * `/`·`$` menu can offer, written the way they are sent — so whatever the menu
 * would insert as a badge is also what typed or pasted text is allowed to become
 * one, and nothing else is.
 *
 * `skills` are the on-disk skills behind the `$` menu (Codex only; every other
 * agent advertises its skills through `commands` already) and are keyed with the
 * prefix that agent triggers them by.
 */
export function buildKnownInvocations(
  commands: readonly AvailableCommandInfo[] | null | undefined,
  skills?: readonly AgentSkillItem[] | null,
  skillPrefix: InvocationPrefix = "/"
): KnownInvocations {
  const tokens = new Set<string>()
  for (const cmd of commands ?? []) {
    if (cmd.name) tokens.add(commandInvocationToken(cmd.name))
  }
  for (const skill of skills ?? []) {
    if (skill.id) tokens.add(`${skillPrefix}${skill.id}`)
  }
  return tokens
}
