export type PluginJsonValue =
  | null
  | boolean
  | number
  | string
  | PluginJsonValue[]
  | { [key: string]: PluginJsonValue }

export interface WorkspaceLifecycleInput {
  folderId: number
  path: string
  name: string
  parentId: number | null
}

export interface WorktreeLifecycleInput {
  folderId: number | null
  repositoryPath: string
  path: string
  branch: string | null
  origin: "workspace" | "automation" | "task" | "cli"
}

interface SessionLifecycleInput<Detail> {
  folderId: number
  conversationId: number | null
  connectionId: string
  agentType: string
  detail: Detail
}

export interface AgentClosedInput {
  folderId: number | null
  conversationId: number | null
  connectionId: string
  agentType: string
  sessionId: string
  outcome: "closed" | "error"
}

export interface AgentArchivedInput {
  folderId: number
  conversationId: number
  agentType: string
  sessionId: string | null
}

export interface AgentOpenBeforeInput {
  agentType: string
  workingDirectory: string | null
  sessionId: string | null
  env: Record<string, string>
}

export interface AgentCreateBeforeInput {
  agentType: string
  folderId: number | null
  kind: "regular" | "chat" | "delegate"
  parentConversationId: number | null
  title: string | null
}

export interface AgentCreatedInput extends AgentCreateBeforeInput {
  conversationId: number
  folderId: number
}

export interface SessionToolCompletedInput {
  folderId: number | null
  conversationId: number
  connectionId: string
  agentType: string
  detail: {
    toolCallId: string
    kind: "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "other"
    status: "completed" | "failed"
    outputKind: "text" | "error" | "structured" | "none"
    outputPreview: string | null
    previewTruncated: boolean
  }
}

interface SessionBeforeInput {
  conversationId: number | null
  folderId: number | null
  agentType: string
}

export interface SessionPromptBeforeInput extends SessionBeforeInput {
  prompt: string
}

export type SessionPromptBeforeResult =
  | { prompt: string; reject?: never }
  | { reject: string; prompt?: never }
  | null
  | undefined

export interface SessionPermissionBeforeInput extends SessionBeforeInput {
  requestId: string
  title: string
  toolKind?: string
  rawInputPreview?: string
  options: Array<{
    optionId: string
    name: string
    kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | "unknown"
  }>
}

export type SessionPermissionBeforeResult =
  | { action: "select"; optionId: string }
  | { action: "cancel"; optionId?: never }
  | null
  | undefined

export interface PluginLifecycleInputs {
  "workspace.open.before": { path: string }
  "workspace.open.after": { folderId: number; path: string }
  "workspace.close.after": { folderId: number }
  "workspace.create.before": { path: string }
  "workspace.create.after": WorkspaceLifecycleInput
  "workspace.archive.after": WorkspaceLifecycleInput
  "worktree.create.before": WorktreeLifecycleInput
  "worktree.create.after": WorktreeLifecycleInput
  "worktree.archive.after": WorktreeLifecycleInput
  "session.prompt.before": SessionPromptBeforeInput
  "session.permission.before": SessionPermissionBeforeInput
  "session.started": SessionLifecycleInput<{ sessionId: string }>
  "session.turn.started": SessionLifecycleInput<null>
  "session.turn.completed": SessionLifecycleInput<{ stopReason: string }>
  "session.tool.completed": SessionToolCompletedInput
  "session.permission.requested": SessionLifecycleInput<{
    requestId: string
    queued: number
  }>
  "session.permission.resolved": SessionLifecycleInput<{
    requestId: string
    optionId: string | null
    origin:
      | { kind: "user" }
      | { kind: "chat_channel" }
      | { kind: "cli_policy"; run_id: string }
      | { kind: "host_plugin"; plugin_id: string }
      | { kind: "assistant"; bot_id: number }
      | { kind: "assistant_page" }
      | null
  }>
  "agent.close.after": AgentClosedInput
  "agent.archive.after": AgentArchivedInput
  "agent.open.before": AgentOpenBeforeInput
  "agent.create.before": AgentCreateBeforeInput
  "agent.create.after": AgentCreatedInput
}

export type PluginLifecycleEvent = keyof PluginLifecycleInputs

export type PluginLifecycleResult<Event extends PluginLifecycleEvent> =
  Event extends "session.prompt.before"
    ? SessionPromptBeforeResult
    : Event extends "session.permission.before"
      ? SessionPermissionBeforeResult
      : Event extends "agent.open.before"
        ? { env: Record<string, string> } | null
        : Event extends "agent.create.before"
          ? { title: string } | null
          : Event extends `${string}.before`
            ? { path: string } | null
            : PluginJsonValue

/** A handler routed by the private method name declared in the manifest. */
export type PluginLifecycleHandler<Event extends PluginLifecycleEvent> = (
  input: PluginLifecycleInputs[Event],
  settings: PluginJsonValue
) => PluginLifecycleResult<Event> | Promise<PluginLifecycleResult<Event>>
