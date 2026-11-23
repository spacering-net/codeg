import type { FlatFileEntry } from "@/hooks/use-file-tree"
import { formatConversationTitle } from "@/lib/conversation-title"
import { buildFileUri } from "@/lib/reference-link"
import {
  type AcpAgentInfo,
  type DbConversationSummary,
  type GitLogEntry,
  type RosterEntry,
} from "@/lib/types"
import { getAgentLabel } from "@/lib/custom-agents"

import type { SuggestionItem } from "./types"

function joinPath(root: string, relative: string): string {
  const left = root.replace(/[/\\]+$/, "")
  const right = relative.replace(/^[/\\]+/, "")
  return left ? `${left}/${right}` : right
}

/** Workspace file → file reference (uri built from the workspace root). */
export function fileToSuggestion(
  entry: FlatFileEntry,
  workspaceRoot: string
): SuggestionItem {
  return {
    reference: {
      refType: "file",
      id: entry.relativePath,
      label: entry.name,
      uri: buildFileUri(joinPath(workspaceRoot, entry.relativePath)),
      meta: { fileKind: entry.kind },
    },
    detail: entry.relativePath,
    keywords: entry.relativePath,
  }
}

/**
 * ACP agent → agent reference. Carries a `codeg://agent/<agent_type>` uri as a
 * routing anchor: it serializes inline as `[@label](codeg://agent/…)` and
 * renders as a badge in the transcript. The readable link IS the routing
 * anchor: the backend derives the delegation reminder from it at send time, so
 * nothing has to travel out-of-band alongside the prompt.
 */
export function agentToSuggestion(agent: AcpAgentInfo): SuggestionItem {
  return {
    reference: {
      refType: "agent",
      id: agent.agent_type,
      label: agent.name || getAgentLabel(agent.agent_type),
      uri: `codeg://agent/${agent.agent_type}`,
      meta: { agentType: agent.agent_type, available: agent.available },
    },
    detail: agent.description || null,
    keywords: agent.agent_type,
  }
}

/**
 * Personal assistant → assistant reference, routed like an agent: it
 * serializes inline as `[@name](codeg://bot/<uid>)`, from which the backend
 * derives the delegation reminder at send time. The second line is its
 * persona's head (`detail`, as the roster reads it), or the agent its work
 * runs on when it has none written; that agent's name and slug are
 * searchable too.
 */
export function assistantToSuggestion(
  entry: RosterEntry & { uid: string },
  detail?: string | null
): SuggestionItem {
  const agentType = entry.work_agent_type ?? null
  const agentLabel = agentType ? getAgentLabel(agentType) : ""
  return {
    reference: {
      refType: "assistant",
      id: entry.uid,
      label: entry.name,
      uri: `codeg://bot/${entry.uid}`,
      meta: { botUid: entry.uid },
    },
    detail: detail || agentLabel || null,
    keywords: agentType ? `${agentLabel} ${agentType}` : "",
  }
}

/**
 * Conversation → session reference. The serialization uri encodes codeg's
 * internal numeric conversation id as `codeg://session/<conversation_id>` — the
 * stable key the `get_session_info` MCP tool resolves directly (it then reads the
 * row's bound `external_id` + `agent_type` server-side). The `@`-panel option row
 * still shows the owning agent's icon via `meta.agentType`; the inline session
 * badge shows a neutral conversation glyph, not the agent icon.
 */
export function sessionToSuggestion(
  conversation: DbConversationSummary
): SuggestionItem {
  // Fold any inline reference badges in the title (`[name](file://…)`, …) down
  // to their bracket text, so the panel row and the inserted session badge read
  // like the sidebar's title (`README.md fix`, not raw `[README.md](…)`) rather
  // than leaking serialized Markdown. The numeric `#id` fallback also covers a
  // whitespace-only title (folding can't turn blank into non-blank).
  const label =
    formatConversationTitle(conversation.title).trim() || `#${conversation.id}`
  const uri = `codeg://session/${conversation.id}`
  return {
    reference: {
      refType: "session",
      id: String(conversation.id),
      label,
      uri,
      meta: {
        agentType: conversation.agent_type,
        status: conversation.status,
        branch: conversation.git_branch,
      },
    },
    detail: conversation.git_branch || conversation.status,
    keywords: `${label} ${conversation.agent_type}`,
  }
}

/**
 * Git commit → commit reference (`codeg://commit/<repoKey>@<fullHash>`).
 * `repoKey` identifies the repository (e.g. its path) and is URI-encoded.
 */
export function commitToSuggestion(
  entry: GitLogEntry,
  repoKey: string
): SuggestionItem {
  return {
    reference: {
      refType: "commit",
      id: entry.full_hash,
      label: entry.hash,
      uri: `codeg://commit/${encodeURIComponent(repoKey)}@${entry.full_hash}`,
      meta: {
        shortHash: entry.hash,
        message: entry.message,
        author: entry.author,
        pushed: entry.pushed,
      },
    },
    detail: entry.message,
    keywords: `${entry.hash} ${entry.message} ${entry.author}`,
  }
}

// Skills, commands and experts are no longer surfaced in the `@` panel — they
// are inserted via the `/` and `$` triggers, which build their reference attrs
// directly (see composer/invocation-reference.ts).
