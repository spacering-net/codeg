import type { AgentType } from "@/lib/types"
import type { ExtraSlotLoginResult } from "@/lib/api"
import { getTransport, getActiveRemoteConnectionId } from "@/lib/transport"

export interface AgentAccount {
  id: string
  agentType: AgentType
  name: string
  homeDir: string
  removed: boolean
}

export interface AgentAccountCapability {
  agentType: AgentType
  supported: boolean
  reason: string | null
  loginKind: "terminal" | "browser" | null
  configSubdir?: string | null
  canSwitchConversation?: boolean
  isolatesToolSettings?: boolean
  authMethods?: AccountAuthMethod[]
  canCheckAuth?: boolean
}

export type AccountAuthMethod = "sign_in" | "api_key" | "native"
export interface AccountAuthStatus {
  state: "signed_in" | "signed_out" | "unavailable"
  method: AccountAuthMethod | null
}

export interface AgentAccountsResult {
  accounts: AgentAccount[]
  capabilities: AgentAccountCapability[]
}

export function listAgentAccounts(
  agentType: AgentType
): Promise<AgentAccountsResult> {
  return getTransport().call("acp_list_agent_accounts", { agentType })
}

export function createAgentAccount(
  agentType: AgentType,
  name: string,
  homeDir?: string
): Promise<AgentAccount> {
  return getTransport().call("acp_create_agent_account", {
    agentType,
    name,
    homeDir: homeDir?.trim() || null,
  })
}

export function renameAgentAccount(
  accountId: string,
  name: string
): Promise<void> {
  return getTransport().call("acp_rename_agent_account", { accountId, name })
}

export function removeAgentAccount(accountId: string): Promise<void> {
  return getTransport().call("acp_remove_agent_account", { accountId })
}

export function loginAgentAccount(
  accountId: string,
  method?: AccountAuthMethod
): Promise<ExtraSlotLoginResult> {
  return getTransport().call("acp_login_agent_account", { accountId, method })
}

export function setAgentAccountApiKey(
  accountId: string,
  apiKey: string
): Promise<void> {
  return getTransport().call("acp_set_agent_account_api_key", {
    accountId,
    apiKey,
  })
}

export function checkAgentAccountAuth(
  accountId: string
): Promise<AccountAuthStatus> {
  return getTransport().call("acp_check_agent_account_auth", { accountId })
}

export function switchConversationAccount(request: {
  conversationId: number
  sourceAccountId: string | null
  targetAccountId: string | null
  preferredModeId?: string
  preferredConfigValues?: Record<string, string>
}): Promise<{
  conversationId: number
  agentAccountId: string | null
  connectionId: string
  externalId: string
}> {
  return getTransport().call(
    "acp_switch_conversation_account",
    { request },
    { timeoutMs: 120_000 }
  )
}

/** One copy of a conversation row's account binding. */
export interface AccountBindingSnapshot {
  accountId: string | null
  /** The row's `updated_at` when this copy was read. */
  updatedAt: string
}

/**
 * The account a conversation tab's connection must use, or `undefined` while
 * it is not known yet. A draft uses the account picked in its welcome view. A
 * persisted conversation uses its saved binding: first the one this view set
 * itself (creating the conversation or switching its account), then the newer
 * of the two copies it can read — the workspace conversation list and the
 * fetched detail. `null` is a known Default binding.
 *
 * The detail alone is not enough: a tab that started as a draft keeps a
 * virtual runtime key for its whole life, so its detail is never fetched. Nor
 * is the list alone: a list refresh can land a copy older than the detail.
 * The account only changes in a write that also moves `updated_at`, so the
 * later copy holds the current binding; a tie keeps the detail.
 */
export function resolveConversationAccount(sources: {
  persisted: boolean
  draft: string | null
  local?: string | null
  listed?: AccountBindingSnapshot
  detail?: AccountBindingSnapshot
}): string | null | undefined {
  if (!sources.persisted) return sources.draft
  if (sources.local !== undefined) return sources.local
  const { listed, detail } = sources
  if (listed && detail) {
    return Date.parse(listed.updatedAt) > Date.parse(detail.updatedAt)
      ? listed.accountId
      : detail.accountId
  }
  return (listed ?? detail)?.accountId
}

export function agentAccountKey(
  agentType: string,
  accountId?: string | null
): string {
  return accountId ? `${agentType}:account:${accountId}` : agentType
}

function selectionKey(agentType: AgentType) {
  return `codeg:agent-account:${getActiveRemoteConnectionId() ?? "local"}:${agentType}`
}

export function readSelectedAccount(agentType: AgentType): string | null {
  if (typeof window === "undefined") return null
  try {
    return localStorage.getItem(selectionKey(agentType)) || null
  } catch {
    return null
  }
}

export function saveSelectedAccount(agentType: AgentType, id: string | null) {
  try {
    if (id) localStorage.setItem(selectionKey(agentType), id)
    else localStorage.removeItem(selectionKey(agentType))
  } catch {
    /* A blocked preference store must not prevent account selection. */
  }
}
