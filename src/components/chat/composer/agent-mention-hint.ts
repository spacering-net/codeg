import { getDelegationSettings } from "@/lib/api"

import type { AcpAgentInfo, PromptInputBlock } from "@/lib/types"

/**
 * An `@<agent>` mention delegates work to another agent only when BOTH gates
 * are open: multi-agent delegation is enabled in settings (the tool is
 * injected per connection), and the target agent itself is enabled. When a
 * gate is closed the host model silently answers the mention itself — to the
 * sender `@` just looks broken (upstream issue #545). These helpers let the
 * send path surface that as a hint at the exact moment it becomes true.
 */

/**
 * Agent mentions serialize as `[@label](codeg://agent/<agent_type>)` (see
 * `reference-text.ts`), so we anchor on the routing URI — free-standing
 * `@label` prose the user typed must not trigger the hint. Clean URIs stay
 * unescaped in the destination; ids containing spaces/parens (rare custom
 * agents) end up in the `<…>` form whose captures we don't attempt to parse.
 */
const AGENT_MENTION_URI = /codeg:\/\/agent\/([^)\s\\]+)/g

export function extractMentionedAgentTypes(text: string): string[] {
  const found = new Set<string>()
  for (const match of text.matchAll(AGENT_MENTION_URI)) {
    if (match[1]) found.add(match[1])
  }
  return [...found]
}

/** Scan the SEND wire blocks — agent mentions live in the prose text block. */
export function mentionedAgentTypesFromBlocks(
  blocks: PromptInputBlock[]
): string[] {
  const prose = blocks
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n")
  return extractMentionedAgentTypes(prose)
}

export interface BlockedAgentMentions {
  /** Multi-agent delegation is off — no mention can delegate. */
  delegationOff: boolean
  /** Delegation is on, but these mentioned agents are disabled in settings. */
  disabledAgents: Array<{ type: string; label: string }>
}

/**
 * Best-effort classification of the mentions in a sent draft.
 *
 * `agents` is the caller's already-subscribed registry snapshot
 * (`useAcpAgents`) rather than a fetch of our own: `acp_list_agents` probes npm
 * prefixes and shells out for binary versions, and the app deliberately
 * coalesces it behind ONE ref-counted store that reloads on window focus,
 * `app://acp-agents-updated` and transport reconnect. Reading that store keeps
 * this free AND fresh — a private TTL cache would re-nag with stale gates for
 * the whole TTL right after the user flipped the toggle the hint sent them to.
 * An empty/cold list simply reports nothing disabled, which is the fail-safe
 * direction (a missed hint, never a false one).
 *
 * The delegation toggle IS read per call: it is a handful of `app_metadata`
 * reads, it has no change event to invalidate against, and this runs
 * fire-and-forget off the send path. Throws only if that lookup fails —
 * callers are expected to swallow that (a missing hint must never break the
 * send).
 */
export async function findBlockedAgentMentions(
  mentionedTypes: string[],
  agents: AcpAgentInfo[]
): Promise<BlockedAgentMentions> {
  if (mentionedTypes.length === 0) {
    return { delegationOff: false, disabledAgents: [] }
  }
  const settings = await getDelegationSettings()
  if (!settings.enabled) {
    return { delegationOff: true, disabledAgents: [] }
  }
  /** `agent_type → display name` for every agent disabled in Agents 管理. */
  const disabled = new Map<string, string>()
  for (const agent of agents) {
    if (!agent.enabled) {
      disabled.set(agent.agent_type, agent.name || agent.agent_type)
    }
  }
  return {
    delegationOff: false,
    disabledAgents: mentionedTypes
      .filter((type) => disabled.has(type))
      .map((type) => ({ type, label: disabled.get(type) ?? type })),
  }
}
