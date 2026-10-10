"use client"

import { useCallback, useMemo, useSyncExternalStore } from "react"

import { buildKnownInvocations } from "@/components/chat/composer/invocation-reference"
import { useAgentSkills } from "@/hooks/use-agent-skills"
import {
  getLastAdvertisedCommands,
  subscribeLastAdvertisedCommands,
} from "@/lib/advertised-commands-store"
import type { KnownInvocations } from "@/lib/invocation-token"
import type { AgentType, AvailableCommandInfo } from "@/lib/types"

const nothingRemembered = () => null

/**
 * The invocations a transcript's user bubbles may badge: what the composer's
 * `/`·`$` menu offers the same agent, so a sent message badges the tokens its
 * composer could have inserted and nothing else. That is the commands the
 * connection advertises, plus, for Codex, the on-disk skills behind its `$`
 * menu, read from the same folder as the composer's scan (one shared entry).
 * Every other agent advertises its skills as commands already.
 *
 * Until the connection has advertised (there is none yet, it is still coming
 * up, or it is between a disconnect and a reconnect), the commands are the
 * ones this agent last advertised in this folder (`advertised-commands-store`),
 * so a badge the reader is looking at neither starts out as text nor drops to
 * text in the meantime. The connection's own list, even an empty one, always
 * wins over that record.
 *
 * The reference changes only when one of those lists does, never per render: a
 * new value re-renders every user message on screen.
 */
export function useTranscriptKnownInvocations(
  agentType: AgentType,
  availableCommands: readonly AvailableCommandInfo[] | null | undefined,
  workspacePath: string | null
): KnownInvocations {
  const isCodex = agentType === "codex"
  const skills = useAgentSkills(isCodex ? "codex" : null, workspacePath)
  // Looked up only while the live list is unknown, so a newer record for this
  // folder cannot re-render a transcript that already has the connection's.
  const advertised = availableCommands != null
  const getRemembered = useCallback(
    () =>
      advertised ? null : getLastAdvertisedCommands(agentType, workspacePath),
    [advertised, agentType, workspacePath]
  )
  const remembered = useSyncExternalStore(
    subscribeLastAdvertisedCommands,
    getRemembered,
    nothingRemembered
  )
  const commands = availableCommands ?? remembered
  return useMemo(
    () => buildKnownInvocations(commands, skills, isCodex ? "$" : "/"),
    [commands, skills, isCodex]
  )
}
