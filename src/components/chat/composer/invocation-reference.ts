import type { KnownInvocations } from "@/lib/invocation-token"
import type {
  AgentSkillItem,
  AgentType,
  AvailableCommandInfo,
} from "@/lib/types"

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
 * The trigger under which the composer menus list an agent's skills read from
 * disk (`useAgentSkills`), or `null` when the agent advertises its skills as
 * commands itself, so they already reach the `/` menu through
 * `availableCommands`.
 *
 * - Codex: `$`, its own skill-mention syntax. Its `$` menu is the disk list.
 * - Antigravity: `/`, beside its commands. Its ACP server advertises only its
 *   built-ins (`/plan`, `/logout`, `/usage`) and never a skill, although it
 *   loads every skill in its skill directories and names each one to the
 *   model. A `/<skill>` the user sends reaches the model as written, next to
 *   that list.
 */
export function diskSkillTrigger(
  agentType: AgentType | null | undefined
): InvocationPrefix | null {
  if (agentType === "codex") return "$"
  if (agentType === "antigravity") return "/"
  return null
}

/**
 * The disk skills a menu offers under `trigger`. Under `/` they share the menu
 * with the agent's own commands, and a skill whose `/<id>` is also a command is
 * left out: sending that token runs the command, so the skill row could not do
 * what it says. Antigravity, for one, intercepts `/plan`, `/logout` and
 * `/usage` before its model sees them.
 */
export function skillsForMenu(
  skills: readonly AgentSkillItem[],
  commands: readonly Pick<AvailableCommandInfo, "name">[],
  trigger: InvocationPrefix
): readonly AgentSkillItem[] {
  if (trigger !== "/" || commands.length === 0) return skills
  const commandTokens = new Set(
    commands.map((cmd) => commandInvocationToken(cmd.name))
  )
  return skills.filter((skill) => !commandTokens.has(`/${skill.id}`))
}

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

/**
 * What the agent says goes after a command (codex `/review-branch` → `branch
 * name`, claude `/mcp` → `[reconnect|enable|disable [<server>|all]]`), or
 * `null` when it advertises nothing to type there. Menus show it beside the
 * token; selecting the command still inserts the token alone.
 */
export function commandInputHint(cmd: AvailableCommandInfo): string | null {
  return cmd.input_hint?.trim() || null
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
 * `skills` are the on-disk skills the menu lists for an agent that does not
 * advertise them itself (see {@link diskSkillTrigger}), keyed with the prefix
 * that agent triggers them by.
 */
export function buildKnownInvocations(
  commands: readonly Pick<AvailableCommandInfo, "name">[] | null | undefined,
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
