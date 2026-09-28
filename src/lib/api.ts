import {
  getActiveRemoteConnectionId,
  getShellTransport,
  getTransport,
  isDesktop,
  isRemoteDesktopMode,
  notifyRemoteDesktopUnauthorized,
} from "./transport"
import { getCodegToken } from "./transport/web-auth"
import { notifyWebUnauthorized } from "./transport/web-connection-store"
import { getCurrentEffectiveAppLocale } from "./i18n"
import {
  DEFAULT_FORGE_COMMENT_PAGE_SIZE,
  DEFAULT_FORGE_FILES_PAGE_SIZE,
  DEFAULT_FORGE_PAGE_SIZE,
} from "./forge-list-prefs"
import { TurnBusyError, isTurnInProgressRejection } from "./turn-busy"
import type { FolderThemeColor } from "./theme-presets"
import type { FollowUpIntent } from "./task-follow-up"
import type {
  LeakedTempReclaim,
  LeakedTempScan,
  AgentType,
  AgentDelegationDefaults,
  AgentOptionsSnapshot,
  Automation,
  AutomationRun,
  AutomationDraft,
  DeepSeekCatalogModel,
  DeepSeekModelCatalog,
  ForgeChangeDetail,
  ForgeChangedFileList,
  ForgeComment,
  ForgeCreateResult,
  ForgeCommentList,
  ForgeIdentity,
  ForgeIssueList,
  ForgeIssueRow,
  ForgeLabelList,
  ForgeMergeMethod,
  ForgeMergeOptions,
  ForgePanelSettings,
  ForgeRemote,
  ForgeSettingsStore,
  ForgeSort,
  ForgeStateAction,
  ForgeTab,
  ForgeTaskDraftInput,
  ForgeTaskLink,
  WorkTask,
  WorkTaskChangedFile,
  WorkTaskConfig,
  WorkTaskDraft,
  WorkTaskEvent,
  WorkTaskFolderSettings,
  WorkTaskTemplate,
  ConversationSummary,
  ConversationDetail,
  ConversationTurnsPage,
  DbConversationDetail,
  FolderInfo,
  AgentStats,
  SidebarData,
  ConnectionInfo,
  ConversationConnectionInfo,
  LiveSessionSnapshot,
  FeedbackItem,
  QuestionAnswer,
  PlanApprovalAnswer,
  AcpAgentInfo,
  AcpAgentStatus,
  AgentDiagnosticsReport,
  GrokStructuredConfig,
  CodexSandboxStructuredConfig,
  CursorStructuredConfig,
  CursorAuthStatus,
  CursorModelsResult,
  QoderAuthStatus,
  CodexModelInfo,
  AgentSkillScope,
  AgentSkillLayout,
  AgentSkillItem,
  AgentSkillsListResult,
  AgentSkillContent,
  ExpertListItem,
  ExpertInstallStatus,
  LinkOp,
  LinkOpResult,
  ScienceListItem,
  CustomSkillItem,
  CustomDeleteResult,
  CustomImportResult,
  FolderHistoryEntry,
  FolderDetail,
  FolderGroupDetail,
  SidebarLayoutEntry,
  FolderLinkDetail,
  FolderLinkPlan,
  FolderLinkRequestItem,
  CanvasMutation,
  CanvasNode,
  CanvasNodeKind,
  CanvasNodeMovePayload,
  CanvasSnapshot,
  CreateChatConversationResult,
  CreateChatDirResult,
  WorktreeResolution,
  GitWorktreeRemoval,
  DbConversationSummary,
  ImportResult,
  ImportSelectedResult,
  ScanResult,
  SelectedSessionKey,
  OpenedTab,
  OpenedTabsSnapshot,
  SaveTabsOutcome,
  GitBlobBase64,
  GitStatusEntry,
  GitBranchList,
  GitHeadInfo,
  GitPullResult,
  GitPushResult,
  GitPushInfo,
  GitMergeResult,
  GitRebaseResult,
  GitResetMode,
  GitConflictFileVersions,
  GitCommitResult,
  GitRemote,
  GitStashEntry,
  PreflightResult,
  FolderCommand,
  TerminalInfo,
  TerminalSnapshot,
  PromptInputBlock,
  FileTreeNode,
  WorkspaceFileEntry,
  DirectoryEntry,
  DirectoryItem,
  UploadAttachmentResult,
  FilePreviewContent,
  FileEditContent,
  FileSaveResult,
  WorkspaceSnapshotResponse,
  GitLogResult,
  GitLogFileChange,
  AvailableTerminalShells,
  SystemLanguageSettings,
  SystemProxySettings,
  CloseRequestPayload,
  CloseWindowBehavior,
  SystemCloseBehaviorSettingsView,
  SystemRenderingSettings,
  SystemAutostartSettings,
  SystemTerminalSettings,
  LogSettings,
  LogSettingsView,
  LogRecord,
  LogFileInfo,
  GitCredentials,
  GitDetectResult,
  PackageManagerInfo,
  HyperframesSkillAgent,
  GitSettings,
  GitHubAccountsSettings,
  GitHubTokenValidation,
  McpAppType,
  LocalMcpScan,
  LocalMcpServer,
  McpMarketplaceProvider,
  McpMarketplaceItem,
  McpMarketplaceServerDetail,
  ChatChannelInfo,
  ChannelStatusInfo,
  ChatChannelMessageLog,
  WebhookConfig,
  ModelProviderInfo,
  UpdateModelProviderResult,
  PluginCheckSummary,
  OpenCodeCatalogProvider,
  QuickMessage,
  OfficecliInfo,
  OfficecliSkill,
  SkillSyncReport,
  TokenUsageFacets,
  TokenUsageFilter,
  TokenUsageReport,
  TokenUsageSyncResult,
  TokenUsageSyncStatus,
} from "./types"

export async function listConversations(params?: {
  agent_type?: AgentType | null
  search?: string | null
  sort_by?: string | null
  folder_path?: string | null
}): Promise<ConversationSummary[]> {
  return getTransport().call("list_conversations", {
    agentType: params?.agent_type ?? null,
    search: params?.search ?? null,
    sortBy: params?.sort_by ?? null,
    folderPath: params?.folder_path ?? null,
  })
}

export async function getConversation(
  agentType: AgentType,
  conversationId: string
): Promise<ConversationDetail> {
  return getTransport().call("get_conversation", { agentType, conversationId })
}

export async function listFolders(): Promise<FolderInfo[]> {
  return getTransport().call("list_folders")
}

export async function getStats(): Promise<AgentStats> {
  return getTransport().call("get_stats")
}

export async function getSidebarData(): Promise<SidebarData> {
  return getTransport().call("get_sidebar_data")
}

// ACP commands

export async function acpConnect(
  agentType: AgentType,
  workingDir?: string,
  sessionId?: string,
  preferredModeId?: string | null,
  preferredConfigValues?: Record<string, string> | null
): Promise<string> {
  return getTransport().call("acp_connect", {
    agentType,
    workingDir: workingDir ?? null,
    sessionId: sessionId ?? null,
    preferredModeId: preferredModeId ?? null,
    preferredConfigValues: preferredConfigValues ?? null,
  })
}

/**
 * Drop inline image bytes from blocks whose bytes already live server-side.
 *
 * Web / remote-workspace mode uploads each composed image through
 * `/upload_attachment` and keeps the base64 ONLY for the local thumbnail /
 * optimistic bubble / queue-edit restore; the sent block carries an empty
 * payload plus the uploaded file's `file://` uri, and the backend re-inlines
 * the bytes right before dispatch (`acp::prompt_hydration`). Without this
 * strip, a couple of screenshots of base64 in the `/acp_prompt` JSON body
 * would blow axum's 2 MiB `DefaultBodyLimit` and 413 the send.
 *
 * `shouldStrip` is false on a local desktop workspace (Tauri IPC has no body
 * limit and there is no uploads dir to hydrate from), so those blocks pass
 * through byte-identical. Under `shouldStrip`, a `file://` uri on an image
 * block can only have come from an upload — every web/remote attach path
 * routes through `/upload_attachment` first — so uri presence is the marker.
 * Pure; exported for tests.
 */
export function stripUploadedImagePayloads(
  blocks: PromptInputBlock[],
  shouldStrip: boolean
): PromptInputBlock[] {
  if (!shouldStrip) return blocks
  return blocks.map((block) => {
    if (
      block.type === "image" &&
      block.data.length > 0 &&
      block.uri?.startsWith("file://")
    ) {
      return { ...block, data: "" }
    }
    if (
      block.type === "resource" &&
      typeof block.blob === "string" &&
      block.blob.length > 0 &&
      (block.mime_type?.startsWith("image/") ?? false) &&
      block.uri.startsWith("file://")
    ) {
      // The embedded-blob shape used for agents that reject native image
      // blocks (e.g. Grok). Same marker contract: empty blob + uploads uri.
      return { ...block, blob: "" }
    }
    return block
  })
}

export async function acpPrompt(
  connectionId: string,
  blocks: PromptInputBlock[],
  folderId: number | null = null,
  conversationId: number | null = null,
  clientMessageId: string | null = null
): Promise<void> {
  try {
    await getTransport().call("acp_prompt", {
      connectionId,
      // Strip in every mode where the prompt leaves through an HTTP body:
      // pure web (`!isDesktop`) and desktop-attached-to-remote-workspace.
      blocks: stripUploadedImagePayloads(
        blocks,
        !isDesktop() || getActiveRemoteConnectionId() !== null
      ),
      folderId,
      conversationId,
      clientMessageId,
    })
  } catch (e) {
    if (isTurnInProgressRejection(e)) throw new TurnBusyError()
    throw e
  }
}

export async function acpSetMode(
  connectionId: string,
  modeId: string
): Promise<void> {
  return getTransport().call("acp_set_mode", { connectionId, modeId })
}

export async function acpSetConfigOption(
  connectionId: string,
  configId: string,
  valueId: string
): Promise<void> {
  return getTransport().call("acp_set_config_option", {
    connectionId,
    configId,
    valueId,
  })
}

/** Pause or clear the session's active Codex goal (codex-acp #293). The backend
 *  sources the sessionId from the live session, so only the connection + action
 *  are needed here. */
export async function acpGoalControl(
  connectionId: string,
  action: "pause" | "clear"
): Promise<void> {
  return getTransport().call("acp_goal_control", { connectionId, action })
}

export async function acpCancel(connectionId: string): Promise<void> {
  return getTransport().call("acp_cancel", { connectionId })
}

export interface ForkResult {
  forkedSessionId: string
  originalSessionId: string
  siblingConversationId: number
}

export async function acpFork(
  connectionId: string,
  // Linkage for a conversation opened from history: its connection resumed via
  // session_id but the row isn't bound to the connection until the first prompt
  // fires, and forking from a rendered turn needs no prompt at all. Passing
  // these lets the backend adopt the row so the fork doesn't reject as
  // unlinked. Ignored once the connection is already linked (a
  // new-conversation-then-fork). See `ConnectionManager::fork_session`.
  conversationId?: number | null,
  folderId?: number | null,
  // "Fork from here": the rendered turn to fork at. The UI always passes one;
  // omitting it forks at the tail, which the backend also falls back to for a
  // turn the agent cannot name — its call, see `resolve_fork_point`.
  forkFromTurnId?: string | null
): Promise<ForkResult> {
  try {
    return await getTransport().call("acp_fork", {
      connectionId,
      conversationId: conversationId ?? null,
      folderId: folderId ?? null,
      forkFromTurnId: forkFromTurnId ?? null,
    })
  } catch (e) {
    // A fork is serialized with prompts on the backend: it returns
    // TurnInProgress while a turn is in flight. Surface it as TurnBusyError so
    // callers can treat it as transient (re-queue) rather than a fork failure.
    if (isTurnInProgressRejection(e)) throw new TurnBusyError()
    throw e
  }
}

/**
 * Stop one AIR async task (`_session/async_task/stop`).
 *
 * Resolves to the adapter's own verdict, NOT "the request went through": it
 * answers `false` for a task it declines to stop (unknown, already finished, or
 * a stop already in flight). The visible result — the task's terminal state and
 * the agent's acknowledgement — arrives on the session channel either way, so
 * callers use this only to avoid claiming they stopped something they didn't.
 */
export async function acpStopAsyncTask(
  connectionId: string,
  taskId: string
): Promise<boolean> {
  return getTransport().call("acp_stop_async_task", { connectionId, taskId })
}

export async function acpRespondPermission(
  connectionId: string,
  requestId: string,
  optionId: string
): Promise<void> {
  return getTransport().call("acp_respond_permission", {
    connectionId,
    requestId,
    optionId,
  })
}

/**
 * Submit the user's answer to a blocking `ask_user_question`. Resolves the
 * parked tool call on the backend (and clears the card on every client via the
 * `question_resolved` event). Idempotent: answering an already-resolved /
 * unknown `questionId` is a no-op success.
 */
export async function acpAnswerQuestion(
  connectionId: string,
  questionId: string,
  answer: QuestionAnswer
): Promise<void> {
  return getTransport().call("acp_answer_question", {
    connectionId,
    questionId,
    answer,
  })
}

/**
 * Submit the user's decision on a blocking Grok `exit_plan_mode` approval
 * (approve / request-changes / abandon). Resolves the parked ext request on the
 * backend (and clears the card on every client via the `plan_approval_resolved`
 * event). Idempotent: answering an already-resolved / unknown `approvalId` is a
 * no-op success.
 */
export async function acpAnswerPlanApproval(
  connectionId: string,
  approvalId: string,
  answer: PlanApprovalAnswer
): Promise<void> {
  return getTransport().call("acp_answer_plan_approval", {
    connectionId,
    approvalId,
    answer,
  })
}

export async function acpDisconnect(connectionId: string): Promise<void> {
  return getTransport().call("acp_disconnect", { connectionId })
}

export async function acpTouchConnection(
  connectionId: string
): Promise<boolean> {
  return getTransport().call("acp_touch_connection", { connectionId })
}

export async function acpListConnections(): Promise<ConnectionInfo[]> {
  return getTransport().call("acp_list_connections")
}

export async function acpGetSessionSnapshot(
  connectionId: string
): Promise<LiveSessionSnapshot | null> {
  return getTransport().call("acp_get_session_snapshot", { connectionId })
}

export async function acpGetSessionSnapshotByConversation(
  conversationId: number
): Promise<LiveSessionSnapshot | null> {
  return getTransport().call("acp_get_session_snapshot_by_conversation", {
    conversationId,
  })
}

export async function acpFindConnectionForConversation(
  conversationId: number,
  sessionId: string | undefined,
  agentType: AgentType
): Promise<ConversationConnectionInfo | null> {
  return getTransport().call("acp_find_connection_for_conversation", {
    conversationId,
    sessionId,
    agentType,
  })
}

export async function acpListAgents(): Promise<AcpAgentInfo[]> {
  return getTransport().call("acp_list_agents")
}

export async function acpGetAgentStatus(
  agentType: AgentType
): Promise<AcpAgentStatus> {
  return getTransport().call("acp_get_agent_status", { agentType })
}

// Run environment diagnostics for an agent (or a base env report when omitted).
export async function acpEnvDiagnostics(
  agentType?: AgentType
): Promise<AgentDiagnosticsReport> {
  return getTransport().call("acp_env_diagnostics", { agentType })
}

export async function acpClearBinaryCache(agentType: AgentType): Promise<void> {
  return getTransport().call("acp_clear_binary_cache", { agentType })
}

/** Read-only scan of the system temp dir for pre-isolation launch leftovers. */
export async function acpScanLeakedTemp(): Promise<LeakedTempScan> {
  return getTransport().call("acp_scan_leaked_temp", {})
}

/**
 * Delete leaked temp artifacts. The backend re-validates every path
 * immediately before deleting — this list is never trusted as-is.
 */
export async function acpReclaimLeakedTemp(
  paths: string[]
): Promise<LeakedTempReclaim> {
  return getTransport().call("acp_reclaim_leaked_temp", { paths })
}

export async function acpDownloadAgentBinary(
  agentType: AgentType,
  taskId: string,
  version?: string | null
): Promise<void> {
  return getTransport().call("acp_download_agent_binary", {
    agentType,
    version: version ?? null,
    taskId,
  })
}

export async function acpInstallUvTool(taskId: string): Promise<void> {
  // uv install downloads + extracts the toolchain from GitHub; allow well
  // beyond the default 60s web-call timeout so slow networks don't surface a
  // spurious timeout while the backend is still streaming progress.
  return getTransport().call(
    "acp_install_uv_tool",
    { taskId },
    { timeoutMs: 600_000 }
  )
}

export async function acpDetectAgentLocalVersion(
  agentType: AgentType
): Promise<string | null> {
  return getTransport().call("acp_detect_agent_local_version", { agentType })
}

export async function acpPrepareNpxAgent(
  agentType: AgentType,
  registryVersion: string | null | undefined,
  taskId: string,
  cleanFirst: boolean = false,
  version?: string | null
): Promise<string> {
  return getTransport().call("acp_prepare_npx_agent", {
    agentType,
    registryVersion: registryVersion ?? null,
    version: version ?? null,
    cleanFirst,
    taskId,
  })
}

export async function acpUninstallAgent(
  agentType: AgentType,
  taskId: string
): Promise<void> {
  return getTransport().call("acp_uninstall_agent", { agentType, taskId })
}

export async function acpUpdateAgentPreferences(
  agentType: AgentType,
  params: {
    enabled: boolean
    env: Record<string, string>
    config_json?: string | null
    opencode_auth_json?: string | null
    codex_auth_json?: string | null
    codex_config_toml?: string | null
  }
): Promise<number> {
  return getTransport().call("acp_update_agent_preferences", {
    agentType,
    enabled: params.enabled,
    env: params.env,
    configJson: params.config_json ?? null,
    opencodeAuthJson: params.opencode_auth_json ?? null,
    codexAuthJson: params.codex_auth_json ?? null,
    codexConfigToml: params.codex_config_toml ?? null,
  })
}

/** Returns the number of running sessions left on stale config by this save
 *  (for the settings-side "N sessions need restart" toast). */
export async function acpUpdateAgentEnv(
  agentType: AgentType,
  params: {
    enabled: boolean
    env: Record<string, string>
    modelProviderId?: number | null
  }
): Promise<number> {
  return getTransport().call("acp_update_agent_env", {
    agentType,
    enabled: params.enabled,
    env: params.env,
    modelProviderId: params.modelProviderId ?? null,
  })
}

/** Returns the number of running sessions left on stale config by this save
 *  (for the settings-side "N sessions need restart" toast). */
export async function acpUpdateAgentConfig(
  agentType: AgentType,
  params: {
    config_json?: string | null
    opencode_auth_json?: string | null
    codex_auth_json?: string | null
    codex_config_toml?: string | null
    /** Compact structured codex model list; backend regenerates the
     * `model_catalog_json` catalog files from it (config.toml keys are patched
     * into `codex_config_toml` text by the caller). */
    codex_model_catalog?: string | null
    /** Codex sandbox / approval controls; merged onto the on-disk config.toml
     * server-side. Governs the turns codex starts itself (/goal, /review,
     * /compact) — ordinary turns carry the composer preset's policy instead. */
    codex_sandbox?: CodexSandboxStructuredConfig | null
    grok_config_toml?: string | null
    /** Grok structured controls (mode / reasoning effort); merged onto the
     * on-disk config.toml server-side. */
    grok_structured?: GrokStructuredConfig | null
    /** Raw ~/.cursor/cli-config.json text (advanced editor; whole file). */
    cursor_cli_config_json?: string | null
    /** Cursor structured controls (sandbox / permission rules); merged onto
     * the on-disk cli-config.json server-side. */
    cursor_structured?: CursorStructuredConfig | null
  }
): Promise<number> {
  return getTransport().call("acp_update_agent_config", {
    agentType,
    configJson: params.config_json ?? null,
    opencodeAuthJson: params.opencode_auth_json ?? null,
    codexAuthJson: params.codex_auth_json ?? null,
    codexConfigToml: params.codex_config_toml ?? null,
    codexModelCatalog: params.codex_model_catalog ?? null,
    codexSandbox: params.codex_sandbox ?? null,
    grokConfigToml: params.grok_config_toml ?? null,
    grokStructured: params.grok_structured ?? null,
    cursorCliConfigJson: params.cursor_cli_config_json ?? null,
    cursorStructured: params.cursor_structured ?? null,
  })
}

/**
 * Probe `qoder status -o json` for the Qoder auth card. The optional live
 * personal access token lets the probe report on the credential that is on
 * screen rather than a stale saved one.
 */
export async function acpQoderAuthStatus(
  personalAccessToken?: string
): Promise<QoderAuthStatus> {
  return getTransport().call("acp_qoder_auth_status", { personalAccessToken })
}

/**
 * Probe `cursor-agent status --format json` for the Cursor auth card. The
 * optional live API key lets the probe test what's on screen; subscription
 * mode passes an empty string to force (and verify) the browser-login
 * credential.
 */
export async function acpCursorAuthStatus(
  apiKey?: string
): Promise<CursorAuthStatus> {
  return getTransport().call("acp_cursor_auth_status", { apiKey })
}

/** List models via `cursor-agent models` for the Cursor model picker. */
export async function acpCursorListModels(
  apiKey?: string
): Promise<CursorModelsResult> {
  return getTransport().call("acp_cursor_list_models", { apiKey })
}

/**
 * Persist a Hermes config update. Writes the active provider's API key to
 * ~/.hermes/.env and the model/provider/base_url to ~/.hermes/config.yaml.
 * When `rawConfigYaml` is given, config.yaml is written verbatim (advanced
 * mode), bypassing the structured merge.
 */
export async function acpUpdateHermesConfig(params: {
  provider: string
  apiKey?: string | null
  model?: string | null
  baseUrl?: string | null
  rawConfigYaml?: string | null
}): Promise<void> {
  return getTransport().call("acp_update_hermes_config", {
    provider: params.provider,
    apiKey: params.apiKey ?? null,
    model: params.model ?? null,
    baseUrl: params.baseUrl ?? null,
    rawConfigYaml: params.rawConfigYaml ?? null,
  })
}

/**
 * Persist a Kimi Code config update, keeping exactly one source authoritative.
 * `mode` "apikey" writes the codeg-managed ~/.kimi-code/config.toml provider/model
 * block AND seeds a synthetic gate token so the API key authenticates `kimi acp`
 * (its session gate only checks for a stored token); "login" clears the managed
 * block + removes our synthetic token so a real OAuth login governs; "raw" writes
 * a verbatim config.toml then seeds the gate token. Returns the number of running
 * Kimi sessions left on stale config.
 */
export async function acpUpdateKimiCodeConfig(params: {
  mode: "apikey" | "login" | "raw"
  interfaceType?: string | null
  authType?: string | null
  baseUrl?: string | null
  apiKey?: string | null
  model?: string | null
  maxContextSize?: number | null
  vertexProject?: string | null
  vertexLocation?: string | null
  rawConfigToml?: string | null
  /** Declares a thinking capability on the managed model, which is what makes
   * `kimi acp` advertise its Thinking picker in the composer at all. */
  reasoningEnabled?: boolean | null
  /** Declares `always_thinking` instead of `thinking` — no "Off" row. */
  alwaysThinking?: boolean | null
  /** The reasoning levels the composer offers; passed to the provider verbatim. */
  supportEfforts?: string[] | null
  defaultEffort?: string | null
}): Promise<number> {
  return getTransport().call("acp_update_kimi_code_config", {
    mode: params.mode,
    interfaceType: params.interfaceType ?? null,
    authType: params.authType ?? null,
    baseUrl: params.baseUrl ?? null,
    apiKey: params.apiKey ?? null,
    model: params.model ?? null,
    maxContextSize: params.maxContextSize ?? null,
    vertexProject: params.vertexProject ?? null,
    vertexLocation: params.vertexLocation ?? null,
    rawConfigToml: params.rawConfigToml ?? null,
    reasoningEnabled: params.reasoningEnabled ?? null,
    alwaysThinking: params.alwaysThinking ?? null,
    supportEfforts: params.supportEfforts ?? null,
    defaultEffort: params.defaultEffort ?? null,
  })
}

/**
 * List the models an API key + endpoint can access (GET `<baseUrl>/models`).
 * Validates the key and powers the Kimi settings model picker; throws with the
 * provider's error message on failure.
 */
export async function acpFetchKimiModels(params: {
  baseUrl: string
  apiKey: string
}): Promise<string[]> {
  return getTransport().call("acp_fetch_kimi_models", {
    baseUrl: params.baseUrl,
    apiKey: params.apiKey,
  })
}

/**
 * Apply a structured Pi config update. Merge-writes pi's native
 * `~/.pi/agent/settings.json` (`defaultProvider` / `defaultModel` /
 * `defaultThinkingLevel`) and, when an API key is supplied,
 * `~/.pi/agent/auth.json` (`{ "<provider>": { "type": "api_key", "key": ... } }`),
 * preserving every other key in both files.
 */
export async function acpUpdatePiConfig(params: {
  provider: string
  model: string
  thinkingLevel?: string
  apiKey?: string
  /** Custom/self-hosted provider endpoint. When set, `provider` is written to
   * `models.json` (with `customApi` as the wire protocol). Omit for built-ins. */
  customBaseUrl?: string
  customApi?: string
  /** Reasoning declaration for `model` inside the custom provider — pi refuses every
   * thinking level for a model that doesn't declare one. Omit to leave whatever the
   * entry already says untouched (built-in providers carry pi's own declaration). */
  modelReasoning?: {
    reasoning: boolean
    thinkingLevelMap: Record<string, string | null>
  }
}): Promise<void> {
  return getTransport().call("acp_update_pi_config", {
    provider: params.provider,
    model: params.model,
    thinkingLevel: params.thinkingLevel ?? null,
    apiKey: params.apiKey ?? null,
    customBaseUrl: params.customBaseUrl ?? null,
    customApi: params.customApi ?? null,
    modelReasoning: params.modelReasoning ?? null,
  })
}

/**
 * Read pi's current native config for the settings panel: the three
 * `settings.json` model keys plus the provider names present in `auth.json`
 * (sorted). Missing files surface as `null` / an empty list.
 */
export async function loadPiConfig(): Promise<{
  defaultProvider: string | null
  defaultModel: string | null
  defaultThinkingLevel: string | null
  authProviders: string[]
  /** Custom/self-hosted providers defined in `models.json`, sorted by id. Used
   * to rehydrate the custom-provider form and detect a custom `defaultProvider`. */
  customProviders: {
    id: string
    baseUrl: string
    api: string
    /** Models the provider defines, sorted by id. `reasoning: null` means the
     * entry never declared one — distinct from an explicit `false`. */
    models: {
      id: string
      reasoning: boolean | null
      thinkingLevelMap: Record<string, string | null>
    }[]
  }[]
}> {
  return getTransport().call("acp_load_pi_config", {})
}

/**
 * Read the DeepSeek Harness model catalog — `llm-deepseek.models` in
 * `$DSH_HOME/settings.yaml` — for the settings panel. A missing document is
 * "inheriting the agent's built-in list", not an error; an unreadable one
 * arrives as `error` so the panel can refuse to edit it.
 */
export async function loadDeepSeekModelCatalog(): Promise<DeepSeekModelCatalog> {
  return getTransport().call("acp_load_deepseek_model_catalog", {})
}

/**
 * Store the DeepSeek Harness model catalog, replacing `llm-deepseek.models`
 * and leaving every other key (and every comment) in the document alone.
 *
 * `null` — and an empty list — REMOVE the key, so the agent's built-in catalog
 * is inherited again. Invalid entries are rejected before anything is written.
 * The agent reads the document at launch, so a save reaches sessions started
 * after it, not the ones already running.
 */
export async function updateDeepSeekModelCatalog(
  models: DeepSeekCatalogModel[] | null
): Promise<void> {
  return getTransport().call("acp_update_deepseek_model_catalog", { models })
}

/**
 * Validate a user-supplied custom pi binary (BYO-pi): resolve it (path or
 * `PATH`) and best-effort read its `--version`. A not-found binary returns
 * `{ found: false, resolvedPath: null, version: null }` (not an error).
 */
export async function acpValidatePiCommand(command: string): Promise<{
  found: boolean
  resolvedPath: string | null
  version: string | null
}> {
  return getTransport().call("acp_validate_pi_command", { command })
}

/** One repo-shipped pi resource that only loads once the workspace is trusted. */
export type PiProjectResource = {
  path: string
  /** Display kind, e.g. `.pi/extensions`, `.agents/skills`. */
  kind: string
  /**
   * True when loading it means running repo-controlled code at pi startup
   * (`.pi/extensions` modules, `.pi/settings.json` project packages) rather than
   * just feeding pi repo-controlled text.
   */
  executesCode: boolean
}

export type PiProjectTrustState = {
  workspace: string
  resources: PiProjectResource[]
  /** `null` ⇒ nobody has decided, so pi leaves the resources unloaded. */
  decision: boolean | null
  /** Deciding directory — may be an ancestor of `workspace`. */
  decidedAt: string | null
  trustFile: string
  /**
   * Whether the user has confirmed this folder's grant in codeg. A trusted but
   * unacknowledged folder is one an older build auto-trusted without asking, so
   * the backend refuses to launch pi there until it is answered.
   */
  acknowledged: boolean
}

/**
 * What one settings.json sync did. Mirrors `AntigravitySyncReport` in
 * src-tauri/src/acp/connection.rs.
 *
 * `skipped` is the one that matters: the file was left as it was, so the
 * agent's auth is NOT what the panel now shows, and `reason` says why in the
 * same words the log uses.
 */
export type AntigravitySyncReport = {
  path: string
  status: "written" | "already_current" | "skipped"
  reason: string | null
}

/**
 * Write the saved Antigravity auth choice into the ACP server's settings.json
 * and report what happened.
 *
 * Call it right after saving the env row. The row is not what authenticates
 * Antigravity — `<GEMINI_HOME>/antigravity-acp/settings.json` is — and the file
 * can legitimately refuse to be rewritten (Hjson with comments, an `auth` key
 * that is not an object). Reporting "saved" without asking would be claiming
 * something that never happened: the launch would go on using the OLD
 * auth.type with the NEW method's credentials scrubbed out from under it.
 */
export async function acpSyncAntigravitySettings(): Promise<AntigravitySyncReport> {
  return getTransport().call("acp_sync_antigravity_settings", {})
}

/**
 * Step one of a browser-free Antigravity sign-in. Mirrors
 * `AntigravityLoginStart` in src-tauri/src/acp/antigravity_login.rs, as a union
 * on `alreadySignedIn` — the agent may hold a still-usable token, in which case
 * it authenticates on the spot and there is no link and nothing to complete.
 */
export type AntigravityLoginStart =
  | {
      alreadySignedIn: true
      handle: null
      authUrl: null
      redirectUri: null
      methodId: string
      expiresInSecs: number
    }
  | {
      alreadySignedIn: false
      /** Opaque id for this attempt; pass it back to finish/cancel. */
      handle: string
      /** The Google consent URL — open it in any browser, on any machine. */
      authUrl: string
      /**
       * Where the browser will be redirected and fail to connect. Shown so the
       * dead page reads as an expected step rather than a broken login.
       */
      redirectUri: string
      methodId: string
      /** Antigravity stops waiting after this many seconds. */
      expiresInSecs: number
    }

/** Step two's answer. Mirrors `AntigravityLoginOutcome` in the same file. */
export type AntigravityLoginOutcome = {
  signedIn: boolean
  /** The agent's own words when it refused; `null` on success. */
  message: string | null
  /**
   * Whether the same link still works. True only when codeg rejected the paste
   * itself — the agent never saw it, so the consent already given is still good
   * and only the paste needs fixing. False once the redirect went out: the
   * agent's listener answers exactly one request.
   */
  retryable: boolean
  /** Where the credential landed, when codeg can name the file. */
  credentialPath: string | null
}

/**
 * Begin signing in to Antigravity on a machine with no browser.
 *
 * Antigravity authenticates through a loopback browser flow the AGENT runs, so
 * on a headless server (codeg deployed on Linux, no desktop) the first session
 * opens a browser that does not exist and then blocks for five minutes. This
 * runs the same flow out of band and hands back the link, so the consent can
 * happen in whatever browser the user does have.
 */
export async function acpAntigravityLoginStart(
  methodId: string
): Promise<AntigravityLoginStart> {
  // The backend spawns the agent and waits for it: up to 60s for `initialize`
  // (CPython inside a PAR, unpacked on first run) plus 90s for the printed
  // link. The transport defaults — 60s on web, 30s through the remote-desktop
  // proxy — would abort with "Request timed out" while that child is still
  // starting, so the ceiling has to clear the backend's own with a margin.
  return getTransport().call(
    "acp_antigravity_login_start",
    { methodId },
    { timeoutMs: 180_000 }
  )
}

/**
 * Finish that sign-in with the address the browser was redirected to.
 *
 * That address points at `127.0.0.1` on the *server*, which the user's browser
 * cannot reach — codeg can, so it performs the redirect on their behalf. Only
 * the OAuth parameters are taken from the paste; the target itself comes from
 * the link codeg issued.
 */
export async function acpAntigravityLoginFinish(
  handle: string,
  redirect: string
): Promise<AntigravityLoginOutcome> {
  // 20s to deliver the redirect plus 180s for the agent's token exchange and
  // onboarding round-trips. Timing out under that would be the worst case
  // available: the attempt is already spent, so the sign-in cannot be retried,
  // and its result would be lost with it.
  return getTransport().call(
    "acp_antigravity_login_finish",
    { handle, redirect },
    { timeoutMs: 240_000 }
  )
}

/** Abandon a pending browser-free sign-in and stop its agent process. */
export async function acpAntigravityLoginCancel(handle: string): Promise<void> {
  return getTransport().call("acp_antigravity_login_cancel", { handle })
}

/**
 * Clear the credential Antigravity is holding, so the next sign-in can reach a
 * different Google account.
 *
 * Without it a signed-in Antigravity cannot switch accounts at all: the agent
 * refreshes its cached token silently, so `acpAntigravityLoginStart` answers
 * `alreadySignedIn` and never produces a consent link.
 *
 * Returns the settings.json sync report rather than a success flag. Signing out
 * removes `auth.type` from that file, so the backend writes the saved method
 * straight back — and a `skipped` report is the warning that it could not, and
 * that every later session will fail with "Authentication required" until the
 * user edits the file themselves.
 */
export async function acpAntigravitySignOut(): Promise<AntigravitySyncReport> {
  // The backend spawns the agent and puts two requests to it: up to 60s for
  // `initialize` (CPython inside a PAR, unpacked on first run) plus 60s for the
  // sign-out itself. The transport defaults — 60s on web, 30s through the
  // remote-desktop proxy — would abort while that child is still starting.
  return getTransport().call(
    "acp_antigravity_sign_out",
    {},
    { timeoutMs: 180_000 }
  )
}

/**
 * Which repo-shipped pi resources a workspace ships, and whether any trust
 * decision already covers it. Read-only.
 */
export async function acpPiProjectTrustState(
  workspace: string
): Promise<PiProjectTrustState> {
  return getTransport().call("acp_pi_project_trust_state", { workspace })
}

/**
 * Record (`true`/`false`) or clear (`null`) a project-trust decision in pi's
 * `trust.json`. The only path that writes trust — call it from an explicit user
 * action, never automatically: a `true` here lets the repo's `.pi/extensions`
 * execute at pi startup, is inherited by every subdirectory, and also applies to
 * the user's standalone `pi` CLI.
 */
export async function acpPiSetProjectTrust(
  workspace: string,
  trusted: boolean | null
): Promise<void> {
  return getTransport().call("acp_pi_set_project_trust", { workspace, trusted })
}

/** One decision recorded in pi's `trust.json`. */
export type PiTrustEntry = {
  path: string
  trusted: boolean
}

/**
 * Record that the user reviewed an existing grant and chose to keep it, which
 * clears the launch gate for that folder. Leaves pi's `trust.json` alone — the
 * grant itself isn't changing, only codeg's record that it was confirmed.
 */
export async function acpPiAcknowledgeProjectTrust(
  workspace: string
): Promise<void> {
  return getTransport().call("acp_pi_acknowledge_project_trust", { workspace })
}

/** Every decision in pi's `trust.json`, for review and revocation. */
export async function acpPiListTrustEntries(): Promise<PiTrustEntry[]> {
  return getTransport().call("acp_pi_list_trust_entries", {})
}

/**
 * Install the `pi` binary (`@earendil-works/pi-coding-agent`) globally via npm.
 * This is the prerequisite pi-acp spawns as `pi --mode rpc` — distinct from the
 * `pi-acp` adapter that `acpPrepareNpxAgent` installs. Progress streams on the
 * shared `app://agent-install` topic; pass `taskId` to `useAgentInstallStream`
 * (or `acpInstallStream`) to receive the log lines.
 */
export async function acpInstallPiBinary(taskId: string): Promise<void> {
  return getTransport().call(
    "acp_install_pi_binary",
    { taskId },
    { timeoutMs: 600_000 }
  )
}

/** Uninstall the global `pi` binary. Streams on `app://agent-install` too. */
export async function acpUninstallPiBinary(taskId: string): Promise<void> {
  return getTransport().call("acp_uninstall_pi_binary", { taskId })
}

/**
 * Launch Hermes's interactive setup in the OS terminal (desktop only). `kind`
 * picks the flow; the backend constructs the exact command from the registry
 * recipe (no arbitrary shell text crosses the boundary).
 */
export async function acpOpenHermesSetupTerminal(
  kind: "setup" | "model"
): Promise<void> {
  return getTransport().call("acp_open_hermes_setup_terminal", { kind })
}

/** Ensure ~/.hermes exists and reveal it in the system file manager (desktop). */
export async function acpRevealHermesHome(): Promise<void> {
  return getTransport().call("acp_reveal_hermes_home", {})
}

export async function acpReorderAgents(agentTypes: AgentType[]): Promise<void> {
  return getTransport().call("acp_reorder_agents", { agentTypes })
}

// ---------------------------------------------------------------------------
// Custom ACP agents — agents the user registers from ACP registry information
// instead of ones codeg ships hand-written support for.
// ---------------------------------------------------------------------------

/** One platform's binary release inside a custom agent's distribution spec. */
export interface CustomAgentBinarySpec {
  archive: string
  cmd?: string
  args?: string[]
  env?: Record<string, string>
  sha256?: string
}

export interface CustomAgentPackageSpec {
  package: string
  args?: string[]
  env?: Record<string, string>
  /** Console-script name the package installs; derived when omitted. */
  cmd?: string
  nodeRequired?: string
  uvRequired?: string
  python?: string
}

/**
 * A custom agent's launch spec — byte-for-byte the ACP registry's
 * `distribution` object, so a registry entry can be pasted verbatim.
 */
export interface CustomAgentSpec {
  npx?: CustomAgentPackageSpec
  uvx?: CustomAgentPackageSpec
  binary?: Record<string, CustomAgentBinarySpec>
}

export type CustomDistributionKind = "npx" | "uvx" | "binary"

export interface CustomAgentInfo {
  registryId: string
  /** `custom:<registryId>` — pass this wherever an `AgentType` is expected. */
  agentType: AgentType
  name: string
  description: string
  version: string
  distributionKind: string
  spec: CustomAgentSpec
  iconUrl: string | null
  /**
   * User declaration that the agent reads the shared `.agents/skills` store;
   * with `skillsDir`, gates the skills matrices.
   */
  skillsSharedStore: boolean
  /** The agent's own skills directory (absolute), when declared. */
  skillsDir: string | null
  /**
   * "registry" | "manual". Every whole-definition re-save must send it back,
   * or the definition's provenance would reset.
   */
  source: string
  /** Optional command that prints the locally installed version. */
  versionProbe: string | null
  /**
   * User declaration that the agent accepts MCP servers on the ACP wire —
   * for a custom agent, codeg's built-in codeg-mcp companion. Off means the
   * connection is made without it, for agents that fail `session/new` when
   * any server is sent.
   */
  supportsMcp: boolean
  /** False when the definition cannot launch here (e.g. no build for this OS). */
  launchable: boolean
  problem: string | null
}

/** One entry of the public ACP registry, annotated for the picker. */
export interface RegistryCatalogAgent {
  registryId: string
  name: string
  description: string
  version: string | null
  iconUrl: string | null
  website: string | null
  repository: string | null
  license: string | null
  distributionKinds: string[]
  /** codeg already ships hand-written support for this agent. */
  builtin: boolean
  /** Already registered as a custom agent. */
  installed: boolean
  supportedOnPlatform: boolean
  spec: CustomAgentSpec
}

export async function acpListCustomAgents(): Promise<CustomAgentInfo[]> {
  return getTransport().call("acp_list_custom_agents", {})
}

export async function acpSaveCustomAgent(params: {
  registryId: string
  name: string
  description?: string
  version?: string
  distributionKind: CustomDistributionKind
  spec: CustomAgentSpec
  iconUrl?: string | null
  skillsSharedStore?: boolean
  skillsDir?: string | null
  /**
   * "registry" | "manual". Omitted = the backend keeps the stored row's
   * provenance (or "manual" for a new row).
   */
  source?: string
  /** Optional version-probe command; full-replace like the skills fields. */
  versionProbe?: string | null
  /**
   * MCP declaration. Omitted = the backend keeps the stored row's value (or
   * on, for a new row) — the safe default here is what is already stored.
   */
  supportsMcp?: boolean
}): Promise<void> {
  return getTransport().call("acp_save_custom_agent", { params })
}

/**
 * Change ONE declaration on a stored custom-agent definition.
 *
 * `acp_save_custom_agent` is a full replace: a declaration the payload leaves
 * out is cleared, not kept — so a caller that edits one field has to send every
 * other field back. That makes the payload only as fresh as whatever the caller
 * is holding, and the settings page renders several independent cards over the
 * SAME definition, each loaded once on mount. Sending a card's own snapshot
 * therefore lets it revert a save another card made after it mounted (turn MCP
 * off in one card, flip a skills switch in the other, and MCP comes back on).
 *
 * So the definition is re-read here, immediately before the write, and the
 * patch is applied to THAT. Callers pass only what they are actually changing,
 * and a stale card cannot resurrect a value it never showed. The remaining
 * window is read-to-write, which is as narrow as this gets without a
 * compare-and-swap on the backend.
 */
export async function acpPatchCustomAgent(
  registryId: string,
  patch: Partial<
    Pick<
      CustomAgentInfo,
      "skillsSharedStore" | "skillsDir" | "supportsMcp" | "versionProbe"
    >
  >
): Promise<void> {
  const current = (await acpListCustomAgents()).find(
    (a) => a.registryId === registryId
  )
  if (!current) {
    // Deleted from another window while this card was open. Failing is right:
    // saving would re-create the definition the user just removed.
    throw new Error(`Custom agent ${registryId} no longer exists`)
  }
  return acpSaveCustomAgent({
    registryId: current.registryId,
    name: current.name,
    description: current.description,
    version: current.version,
    distributionKind: current.distributionKind as CustomDistributionKind,
    spec: current.spec,
    iconUrl: current.iconUrl,
    source: current.source,
    skillsSharedStore: current.skillsSharedStore,
    skillsDir: current.skillsDir,
    supportsMcp: current.supportsMcp,
    versionProbe: current.versionProbe,
    ...patch,
  })
}

export async function acpDeleteCustomAgent(
  registryId: string,
  deleteTranscripts: boolean
): Promise<void> {
  return getTransport().call("acp_delete_custom_agent", {
    registryId,
    deleteTranscripts,
  })
}

/** Fetch the public ACP registry (network). */
export async function acpFetchRegistryCatalog(): Promise<
  RegistryCatalogAgent[]
> {
  return getTransport().call("acp_fetch_registry_catalog", {})
}

export async function acpAddRegistryAgent(
  registryId: string,
  distributionKind?: CustomDistributionKind
): Promise<void> {
  return getTransport().call("acp_add_registry_agent", {
    registryId,
    distributionKind,
  })
}

/**
 * The platform key (`darwin-aarch64`, …) binary distributions are keyed by on
 * the machine that runs installs — the server in server mode, hence a backend
 * question rather than a userAgent sniff.
 */
export async function acpCurrentPlatform(): Promise<string> {
  return getTransport().call("acp_current_platform", {})
}

export async function codexRequestDeviceCode(): Promise<{
  userCode: string
  verificationUrl: string
  deviceAuthId: string
  interval: number
}> {
  return getTransport().call("codex_request_device_code", {})
}

export async function codexPollDeviceCode(params: {
  deviceAuthId: string
  userCode: string
}): Promise<{
  status: "pending" | "success" | "error"
  message?: string
  idToken?: string
  accessToken?: string
  refreshToken?: string
  accountId?: string
}> {
  return getTransport().call("codex_poll_device_code", {
    deviceAuthId: params.deviceAuthId,
    userCode: params.userCode,
  })
}

export async function acpPreflight(
  agentType: AgentType,
  forceRefresh?: boolean
): Promise<PreflightResult> {
  return getTransport().call("acp_preflight", {
    agentType,
    forceRefresh: forceRefresh ?? null,
  })
}

export async function opencodeListPlugins(): Promise<PluginCheckSummary> {
  return getTransport().call("opencode_list_plugins", {})
}

export async function opencodeProviderCatalog(
  forceRefresh?: boolean
): Promise<OpenCodeCatalogProvider[]> {
  return getTransport().call("opencode_provider_catalog", {
    forceRefresh: forceRefresh ?? null,
  })
}

/** The official codex model catalog (full ModelInfo entries), sourced at runtime
 *  from the codex codeg actually launches (cache + bundled fallback). Used for
 *  the official list, "quick-add official", and as the clone template for custom
 *  entries. Pass `forceRefresh` to bypass the cache and re-run codex. */
export async function codexBundledCatalog(
  forceRefresh?: boolean
): Promise<CodexModelInfo[]> {
  return getTransport().call("codex_bundled_catalog", {
    forceRefresh: forceRefresh ?? null,
  })
}

export async function opencodeInstallPlugins(
  taskId: string,
  names?: string[] | null
): Promise<void> {
  return getTransport().call("opencode_install_plugins", {
    names: names ?? null,
    taskId,
  })
}

export async function opencodeUninstallPlugin(
  name: string
): Promise<PluginCheckSummary> {
  return getTransport().call("opencode_uninstall_plugin", { name })
}

export async function acpListAgentSkills(params: {
  agentType: AgentType
  workspacePath?: string | null
}): Promise<AgentSkillsListResult> {
  return getTransport().call("acp_list_agent_skills", {
    agentType: params.agentType,
    workspacePath: params.workspacePath ?? null,
  })
}

export async function acpReadAgentSkill(params: {
  agentType: AgentType
  scope: AgentSkillScope
  skillId: string
  workspacePath?: string | null
}): Promise<AgentSkillContent> {
  return getTransport().call("acp_read_agent_skill", {
    agentType: params.agentType,
    scope: params.scope,
    skillId: params.skillId,
    workspacePath: params.workspacePath ?? null,
  })
}

export async function acpSaveAgentSkill(params: {
  agentType: AgentType
  scope: AgentSkillScope
  skillId: string
  content: string
  workspacePath?: string | null
  layout?: AgentSkillLayout | null
}): Promise<AgentSkillItem> {
  return getTransport().call("acp_save_agent_skill", {
    agentType: params.agentType,
    scope: params.scope,
    skillId: params.skillId,
    content: params.content,
    workspacePath: params.workspacePath ?? null,
    layout: params.layout ?? null,
  })
}

export async function acpDeleteAgentSkill(params: {
  agentType: AgentType
  scope: AgentSkillScope
  skillId: string
  workspacePath?: string | null
}): Promise<void> {
  return getTransport().call("acp_delete_agent_skill", {
    agentType: params.agentType,
    scope: params.scope,
    skillId: params.skillId,
    workspacePath: params.workspacePath ?? null,
  })
}

// ─── Experts (built-in expert skills) ───────────────────────────────────

export async function expertsList(): Promise<ExpertListItem[]> {
  return getTransport().call("experts_list")
}

export async function expertsGetInstallStatus(
  expertId: string
): Promise<ExpertInstallStatus[]> {
  return getTransport().call("experts_get_install_status", { expertId })
}

/** One round-trip snapshot of every (expert, agent) link state for the matrix. */
export async function expertsListAllInstallStatuses(): Promise<
  ExpertInstallStatus[]
> {
  return getTransport().call("experts_list_all_install_statuses")
}

/** Apply a batch of enable/disable ops; returns one result per op. */
export async function expertsApplyLinks(
  ops: LinkOp[]
): Promise<LinkOpResult[]> {
  return getTransport().call("experts_apply_links", { ops })
}

export async function expertsLinkToAgent(params: {
  expertId: string
  agentType: AgentType
}): Promise<ExpertInstallStatus> {
  return getTransport().call("experts_link_to_agent", {
    expertId: params.expertId,
    agentType: params.agentType,
  })
}

export async function expertsUnlinkFromAgent(params: {
  expertId: string
  agentType: AgentType
}): Promise<void> {
  return getTransport().call("experts_unlink_from_agent", {
    expertId: params.expertId,
    agentType: params.agentType,
  })
}

export async function expertsReadContent(expertId: string): Promise<string> {
  return getTransport().call("experts_read_content", { expertId })
}

export async function expertsOpenCentralDir(): Promise<string> {
  return getTransport().call("experts_open_central_dir")
}

// ─── Science (built-in scientific-research skills) ──────────────────────
// Link statuses reuse the Expert* DTOs (like office tools do): the
// `expertId` field carries the science skill id.

export async function scienceList(): Promise<ScienceListItem[]> {
  return getTransport().call("science_list")
}

export async function scienceGetInstallStatus(
  skillId: string
): Promise<ExpertInstallStatus[]> {
  return getTransport().call("science_get_install_status", { skillId })
}

/** One round-trip snapshot of every (science skill, agent) link state. */
export async function scienceListAllInstallStatuses(): Promise<
  ExpertInstallStatus[]
> {
  return getTransport().call("science_list_all_install_statuses")
}

/** Apply a batch of enable/disable ops; returns one result per op. */
export async function scienceApplyLinks(
  ops: LinkOp[]
): Promise<LinkOpResult[]> {
  return getTransport().call("science_apply_links", { ops })
}

export async function scienceLinkToAgent(params: {
  skillId: string
  agentType: AgentType
}): Promise<ExpertInstallStatus> {
  return getTransport().call("science_link_to_agent", {
    skillId: params.skillId,
    agentType: params.agentType,
  })
}

export async function scienceUnlinkFromAgent(params: {
  skillId: string
  agentType: AgentType
}): Promise<void> {
  return getTransport().call("science_unlink_from_agent", {
    skillId: params.skillId,
    agentType: params.agentType,
  })
}

export async function scienceReadContent(skillId: string): Promise<string> {
  return getTransport().call("science_read_content", { skillId })
}

export async function scienceOpenCentralDir(): Promise<string> {
  return getTransport().call("science_open_central_dir")
}

// ─── Custom (user-authored) skills ──────────────────────────────────────
// The fourth skill pack: user-created skills in the same central store, told
// apart from the built-in packs by exclusion. Link statuses reuse the Expert*
// DTOs (`expertId` carries the custom skill id).

export async function customList(): Promise<CustomSkillItem[]> {
  return getTransport().call("custom_list")
}

/** One round-trip snapshot of every (custom skill, agent) link state. */
export async function customListAllInstallStatuses(): Promise<
  ExpertInstallStatus[]
> {
  return getTransport().call("custom_list_all_install_statuses")
}

/** Apply a batch of enable/disable ops; returns one result per op. */
export async function customApplyLinks(ops: LinkOp[]): Promise<LinkOpResult[]> {
  return getTransport().call("custom_apply_links", { ops })
}

export async function customReadSkill(id: string): Promise<string> {
  return getTransport().call("custom_read_skill", { id })
}

export async function customCreateSkill(params: {
  id: string
  content: string
}): Promise<CustomSkillItem> {
  return getTransport().call("custom_create_skill", {
    id: params.id,
    content: params.content,
  })
}

export async function customSaveSkill(params: {
  id: string
  content: string
}): Promise<CustomSkillItem> {
  return getTransport().call("custom_save_skill", {
    id: params.id,
    content: params.content,
  })
}

export async function customDuplicateSkill(params: {
  sourceId: string
  newId: string
}): Promise<CustomSkillItem> {
  return getTransport().call("custom_duplicate_skill", {
    sourceId: params.sourceId,
    newId: params.newId,
  })
}

export async function customImportSkill(params: {
  sourcePath: string
  id?: string | null
}): Promise<CustomSkillItem> {
  return getTransport().call("custom_import_skill", {
    sourcePath: params.sourcePath,
    id: params.id ?? null,
  })
}

/**
 * Import an agent's own (global-scope) skills into the shared central store so
 * they can be re-enabled for any agent. Returns one result per id; skills
 * already in the store are reported as `skipped`, not errors.
 */
export async function customImportFromAgent(params: {
  agentType: AgentType
  ids: string[]
}): Promise<CustomImportResult[]> {
  return getTransport().call("custom_import_from_agent", {
    agentType: params.agentType,
    ids: params.ids,
  })
}

/** Batch-delete custom skills (cleans up their agent links first). */
export async function customDeleteSkills(
  ids: string[]
): Promise<CustomDeleteResult[]> {
  return getTransport().call("custom_delete_skills", { ids })
}

// ─── Office tools ───

export async function officecliDetect(): Promise<OfficecliInfo> {
  return getTransport().call("officecli_detect")
}

export async function officecliInstall(taskId: string): Promise<OfficecliInfo> {
  // The vendor installer downloads + extracts a multi-MB binary; allow well
  // beyond the default 60s web-call timeout so slow networks don't surface a
  // spurious timeout while progress is still streaming. Sits 30s ABOVE the
  // backend's own 600s deadline so the backend's structured timeout error wins
  // the race instead of a generic transport abort. `taskId` correlates the
  // `app://officecli-install` stream the settings page subscribes to.
  return getTransport().call(
    "officecli_install",
    { taskId },
    { timeoutMs: 630_000 }
  )
}

export async function officecliUninstall(): Promise<OfficecliInfo> {
  return getTransport().call("officecli_uninstall")
}

export async function officecliListSkills(): Promise<OfficecliSkill[]> {
  return getTransport().call("officecli_list_skills")
}

export async function officecliSyncSkills(): Promise<SkillSyncReport> {
  return getTransport().call("officecli_sync_skills")
}

export async function officecliSkillLinkToAgent(params: {
  skillId: string
  agentType: AgentType
}): Promise<ExpertInstallStatus> {
  return getTransport().call("officecli_skill_link_to_agent", params)
}

export async function officecliSkillUnlinkFromAgent(params: {
  skillId: string
  agentType: AgentType
}): Promise<void> {
  return getTransport().call("officecli_skill_unlink_from_agent", params)
}

export async function officecliSkillGetInstallStatus(
  skillId: string
): Promise<ExpertInstallStatus[]> {
  return getTransport().call("officecli_skill_get_install_status", { skillId })
}

/** One round-trip snapshot of every (skill, agent) link state for the matrix. */
export async function officecliSkillListAllInstallStatuses(): Promise<
  ExpertInstallStatus[]
> {
  return getTransport().call("officecli_skill_list_all_install_statuses")
}

/** Apply a batch of enable/disable ops; returns one result per op. */
export async function officecliSkillApplyLinks(
  ops: LinkOp[]
): Promise<LinkOpResult[]> {
  return getTransport().call("officecli_skill_apply_links", { ops })
}

export async function officecliSkillReadContent(
  skillId: string
): Promise<string> {
  return getTransport().call("officecli_skill_read_content", { skillId })
}

/**
 * Render an office file (.docx/.xlsx/.pptx) to self-contained HTML via the
 * OfficeCLI backend, for the in-app preview. `path` is relative to `rootPath`.
 */
export async function officecliRenderHtml(
  rootPath: string,
  path: string
): Promise<string> {
  return getTransport().call("officecli_render_html", { rootPath, path })
}

/**
 * Start (or share, by ref-count) a long-lived `officecli watch` preview server
 * for an office file and return its loopback `port` plus a per-watch `cap`
 * capability. `path` is relative to `rootPath`. Live refresh is driven by
 * officecli's own SSE channel, so the preview no longer re-reads (and locks)
 * the file the way the one-shot {@link officecliRenderHtml} did.
 *
 * `cap` is only used by web/server mode, where the iframe loads the preview
 * through the `/api/office-watch-proxy/{port}` reverse proxy and authenticates
 * with `?cap=` (the master token never enters the iframe). Desktop ignores it.
 */
export async function startOfficeWatch(
  rootPath: string,
  path: string
): Promise<{ port: number; cap: string }> {
  return getTransport().call("start_office_watch", { rootPath, path })
}

/** Release one reference to an office file's watch preview server. */
export async function stopOfficeWatch(
  rootPath: string,
  path: string
): Promise<void> {
  return getTransport().call("stop_office_watch", { rootPath, path })
}

export async function getSystemProxySettings(): Promise<SystemProxySettings> {
  return getTransport().call("get_system_proxy_settings")
}

export async function updateSystemProxySettings(
  settings: SystemProxySettings
): Promise<SystemProxySettings> {
  return getTransport().call("update_system_proxy_settings", { settings })
}

export async function getSystemLanguageSettings(): Promise<SystemLanguageSettings> {
  return getTransport().call("get_system_language_settings")
}

export async function updateSystemLanguageSettings(
  settings: SystemLanguageSettings
): Promise<SystemLanguageSettings> {
  return getTransport().call("update_system_language_settings", { settings })
}

export async function getSystemTerminalSettings(): Promise<SystemTerminalSettings> {
  return getTransport().call("get_system_terminal_settings")
}

export async function updateSystemTerminalSettings(
  settings: SystemTerminalSettings
): Promise<SystemTerminalSettings> {
  return getTransport().call("update_system_terminal_settings", { settings })
}

export async function getAvailableTerminalShells(): Promise<AvailableTerminalShells> {
  return getTransport().call("get_available_terminal_shells")
}

export async function probeTerminalShellPath(path: string): Promise<boolean> {
  return getTransport().call("probe_terminal_shell_path", { path })
}

export async function getSystemRenderingSettings(): Promise<SystemRenderingSettings> {
  return getTransport().call("get_system_rendering_settings")
}

export async function updateSystemRenderingSettings(
  settings: SystemRenderingSettings
): Promise<SystemRenderingSettings> {
  return getTransport().call("update_system_rendering_settings", { settings })
}

export async function getSystemAutostartSettings(): Promise<SystemAutostartSettings> {
  return getTransport().call("get_system_autostart_settings")
}

export async function updateSystemAutostartSettings(
  settings: SystemAutostartSettings
): Promise<SystemAutostartSettings> {
  return getTransport().call("update_system_autostart_settings", { settings })
}

// --- Close window behavior ---

/**
 * Emitted when a close press needs an answer. Addressed to `main`, but the
 * Tauri transport subscribes with `EventTarget::Any`, so every webview sharing
 * the root layout still receives it — `CloseRequestDialog` gates on the window
 * label rather than trusting the target.
 */
export const CLOSE_REQUEST_EVENT = "app://close-request"

export async function getSystemCloseBehaviorSettings(): Promise<SystemCloseBehaviorSettingsView> {
  return getTransport().call("get_system_close_behavior_settings")
}

export async function updateSystemCloseBehaviorSettings(
  behavior: CloseWindowBehavior
): Promise<SystemCloseBehaviorSettingsView> {
  return getTransport().call("update_system_close_behavior_settings", {
    behavior,
  })
}

/**
 * Answer an open close prompt. The backend holds a "a prompt is up" flag that
 * only this call clears, so every dismissal path — including Cancel and the
 * Esc key — has to reach it or the close button goes dead for the session.
 */
export async function resolveCloseRequest(
  action: "minimize" | "exit" | "cancel",
  remember: boolean
): Promise<void> {
  return getTransport().call("resolve_close_request", { action, remember })
}

export async function listenCloseRequest(
  handler: (payload: CloseRequestPayload) => void
): Promise<() => void> {
  return getTransport().subscribe<CloseRequestPayload>(
    CLOSE_REQUEST_EVENT,
    handler
  )
}

// --- Logging ---

/** Live-tail channel: one event per appended log record. */
export const LOG_APPENDED_EVENT = "logs://appended"
/** Cross-window broadcast announcing a log-level change. */
export const LOG_SETTINGS_CHANGED_EVENT = "log-settings://changed"

export async function getLogSettings(): Promise<LogSettingsView> {
  return getTransport().call("get_log_settings")
}

export async function setLogSettings(
  settings: LogSettings
): Promise<LogSettings> {
  return getTransport().call("set_log_settings", { settings })
}

export async function getRecentLogs(params: {
  limit: number
  minLevel?: string
  search?: string
}): Promise<LogRecord[]> {
  return getTransport().call("get_recent_logs", {
    limit: params.limit,
    minLevel: params.minLevel,
    search: params.search,
  })
}

export async function listLogFiles(): Promise<LogFileInfo[]> {
  return getTransport().call("list_log_files")
}

/** Ensure the logs dir exists and return its absolute path (desktop only). */
export async function openLogsDir(): Promise<string> {
  return getTransport().call("open_logs_dir")
}

/** Read a single on-disk log file (web download / paginate). Returns the
 * newest `maxBytes` when capped. */
export async function readLogFile(
  name: string,
  maxBytes?: number
): Promise<string> {
  return getTransport().call("read_log_file", { name, maxBytes })
}

export async function subscribeLogAppended(
  handler: (record: LogRecord) => void
): Promise<() => void> {
  return getTransport().subscribe<LogRecord>(LOG_APPENDED_EVENT, handler)
}

export async function subscribeLogSettingsChanged(
  handler: (settings: LogSettings) => void
): Promise<() => void> {
  return getTransport().subscribe<LogSettings>(
    LOG_SETTINGS_CHANGED_EVENT,
    handler
  )
}

// --- Version Control ---

export async function detectGit(): Promise<GitDetectResult> {
  return getTransport().call("detect_git")
}

export async function testGitPath(path: string): Promise<GitDetectResult> {
  return getTransport().call("test_git_path", { path })
}

export async function getGitSettings(): Promise<GitSettings> {
  return getTransport().call("get_git_settings")
}

export async function updateGitSettings(
  settings: GitSettings
): Promise<GitSettings> {
  return getTransport().call("update_git_settings", { settings })
}

export async function getGitHubAccounts(): Promise<GitHubAccountsSettings> {
  return getTransport().call("get_github_accounts")
}

export async function validateGitHubToken(
  serverUrl: string,
  token: string
): Promise<GitHubTokenValidation> {
  return getTransport().call("validate_github_token", { serverUrl, token })
}

/** Same answer shape as GitHub's, from `GET /api/v4/user` (+ the token's own
 *  scopes, which GitLab reports on a separate endpoint). */
export async function validateGitLabToken(
  serverUrl: string,
  token: string
): Promise<GitHubTokenValidation> {
  return getTransport().call("validate_gitlab_token", { serverUrl, token })
}

/** Same answer shape again, from Gitea's `GET /api/v1/user`. `scopes` always
 *  comes back empty: Gitea reports a token's scopes only on an endpoint that
 *  wants the account password and refuses the token being checked. */
export async function validateGiteaToken(
  serverUrl: string,
  token: string
): Promise<GitHubTokenValidation> {
  return getTransport().call("validate_gitea_token", { serverUrl, token })
}

export async function updateGitHubAccounts(
  settings: GitHubAccountsSettings
): Promise<GitHubAccountsSettings> {
  return getTransport().call("update_github_accounts", { settings })
}

export async function saveAccountToken(
  accountId: string,
  token: string
): Promise<void> {
  return getTransport().call("save_account_token", { accountId, token })
}

export async function getAccountToken(
  accountId: string
): Promise<string | null> {
  return getTransport().call("get_account_token", { accountId })
}

export async function deleteAccountToken(accountId: string): Promise<void> {
  return getTransport().call("delete_account_token", { accountId })
}

export async function mcpScanLocal(): Promise<LocalMcpScan> {
  return getTransport().call("mcp_scan_local")
}

export async function mcpListMarketplaces(): Promise<McpMarketplaceProvider[]> {
  return getTransport().call("mcp_list_marketplaces")
}

export async function mcpSearchMarketplace(params: {
  providerId: string
  query?: string | null
  limit?: number | null
}): Promise<McpMarketplaceItem[]> {
  return getTransport().call("mcp_search_marketplace", {
    providerId: params.providerId,
    query: params.query ?? null,
    limit: params.limit ?? null,
  })
}

export async function mcpGetMarketplaceServerDetail(params: {
  providerId: string
  serverId: string
}): Promise<McpMarketplaceServerDetail> {
  return getTransport().call("mcp_get_marketplace_server_detail", {
    providerId: params.providerId,
    serverId: params.serverId,
  })
}

export async function mcpInstallFromMarketplace(params: {
  providerId: string
  serverId: string
  apps: McpAppType[]
  specOverride?: Record<string, unknown> | null
  optionId?: string | null
  protocol?: string | null
  parameterValues?: Record<string, unknown> | null
}): Promise<LocalMcpServer> {
  return getTransport().call("mcp_install_from_marketplace", {
    providerId: params.providerId,
    serverId: params.serverId,
    apps: params.apps,
    specOverride: params.specOverride ?? null,
    optionId: params.optionId ?? null,
    protocol: params.protocol ?? null,
    parameterValues: params.parameterValues ?? null,
  })
}

export async function mcpUpsertLocalServer(params: {
  serverId: string
  spec: Record<string, unknown>
  apps: McpAppType[]
}): Promise<LocalMcpServer> {
  return getTransport().call("mcp_upsert_local_server", {
    serverId: params.serverId,
    spec: params.spec,
    apps: params.apps,
  })
}

export async function mcpSetServerApps(
  serverId: string,
  apps: McpAppType[]
): Promise<LocalMcpServer | null> {
  return getTransport().call("mcp_set_server_apps", { serverId, apps })
}

export async function mcpRemoveServer(
  serverId: string,
  apps?: McpAppType[] | null
): Promise<boolean> {
  return getTransport().call("mcp_remove_server", {
    serverId,
    apps: apps ?? null,
  })
}

// Folder history commands

export async function loadFolderHistory(): Promise<FolderHistoryEntry[]> {
  return getTransport().call("load_folder_history")
}

export async function getFolder(folderId: number): Promise<FolderDetail> {
  return getTransport().call("get_folder", { folderId })
}

export async function listAllConversations(params?: {
  folder_ids?: number[] | null
  agent_type?: AgentType | null
  search?: string | null
  sort_by?: string | null
  status?: string | null
  include_children?: boolean | null
}): Promise<DbConversationSummary[]> {
  return getTransport().call("list_all_conversations", {
    folderIds: params?.folder_ids ?? null,
    agentType: params?.agent_type ?? null,
    search: params?.search ?? null,
    sortBy: params?.sort_by ?? null,
    status: params?.status ?? null,
    includeChildren: params?.include_children ?? null,
  })
}

export async function listChildConversations(
  parentConversationId: number
): Promise<DbConversationSummary[]> {
  return getTransport().call("list_child_conversations", {
    parentConversationId,
  })
}

export async function listOpenedTabs(): Promise<OpenedTabsSnapshot> {
  return getTransport().call("list_opened_tabs")
}

export async function saveOpenedTabs(
  items: OpenedTab[],
  expectedVersion: number,
  origin: string
): Promise<SaveTabsOutcome> {
  return getTransport().call("save_opened_tabs", {
    items,
    expectedVersion,
    origin,
  })
}

export async function listOpenFolderDetails(): Promise<FolderDetail[]> {
  return getTransport().call("list_open_folder_details")
}

export async function listAllFolderDetails(): Promise<FolderDetail[]> {
  return getTransport().call("list_all_folder_details")
}

export async function openFolderById(folderId: number): Promise<FolderDetail> {
  return getTransport().call("open_folder_by_id", { folderId })
}

export async function removeFolderFromWorkspace(
  folderId: number
): Promise<void> {
  return getTransport().call("remove_folder_from_workspace", { folderId })
}

export async function listFolderGroups(): Promise<FolderGroupDetail[]> {
  return getTransport().call("list_folder_groups", {})
}

export async function createFolderGroup(
  name: string,
  color?: FolderThemeColor
): Promise<FolderGroupDetail> {
  return getTransport().call("create_folder_group", { name, color })
}

/** Patch a group's name and/or color. An omitted field is left alone, so the
 *  rename dialog and the color picker never clobber each other. */
export async function updateFolderGroup(
  groupId: number,
  patch: { name?: string; color?: FolderThemeColor }
): Promise<FolderGroupDetail> {
  return getTransport().call("update_folder_group", { groupId, ...patch })
}

/** Delete a group. Member folders are NOT removed from the workspace — they
 *  return to the top level. */
export async function deleteFolderGroup(groupId: number): Promise<void> {
  return getTransport().call("delete_folder_group", { groupId })
}

/** Persist the whole sidebar layout after a drag. See {@link SidebarLayoutEntry}. */
export async function applySidebarLayout(
  entries: SidebarLayoutEntry[]
): Promise<void> {
  return getTransport().call("apply_sidebar_layout", { entries })
}

/** Move one folder into (`groupId`) or out of (`null`) a group, appending it to
 *  the target container. The context-menu path, which has no drop position. */
export async function setFolderGroup(
  folderId: number,
  groupId: number | null
): Promise<void> {
  return getTransport().call("set_folder_group", { folderId, groupId })
}

export async function updateFolderColor(
  folderId: number,
  color: FolderThemeColor
): Promise<FolderDetail> {
  return getTransport().call("update_folder_color", { folderId, color })
}

export async function updateFolderAlias(
  folderId: number,
  alias: string | null
): Promise<FolderDetail> {
  return getTransport().call("update_folder_alias", { folderId, alias })
}

export async function updateFolderDefaultAgent(
  folderId: number,
  defaultAgentType: AgentType | null
): Promise<FolderDetail> {
  return getTransport().call("update_folder_default_agent", {
    folderId,
    defaultAgentType,
  })
}

export async function importLocalConversations(
  folderId: number
): Promise<ImportResult> {
  return getTransport().call("import_local_conversations", { folderId })
}

/** Walk every local agent's session store and reconcile against the DB for the
 *  import picker. Slow (filesystem-bound); per-agent progress arrives on the
 *  `import-scan://progress` side-channel while this call is in flight. */
export async function scanImportableSessions(): Promise<ScanResult> {
  return getTransport().call("scan_importable_sessions", {})
}

/** Batch-import the selected scanned sessions. The backend re-walks the local
 *  stores (disk is the source of truth), creates or reopens each target folder,
 *  and broadcasts `folder://changed` + one `conversations://bulk-changed` so
 *  every window's sidebar converges. Rejected while another import runs. */
export async function importSelectedSessions(
  selections: SelectedSessionKey[]
): Promise<ImportSelectedResult> {
  return getTransport().call("import_selected_sessions", { selections })
}

/**
 * Fetch a conversation's detail, optionally windowed:
 * - `{ tailTurns }` — last N turns, start aligned to a user-round boundary
 * - `{ fromIndex }` — exact slice `turns[fromIndex..]` (window refresh)
 * No window → legacy full response (also what an old server returns for any
 * request; the windowed fields are then absent).
 */
export async function getFolderConversation(
  conversationId: number,
  window?: { tailTurns?: number; fromIndex?: number }
): Promise<DbConversationDetail> {
  return getTransport().call("get_folder_conversation", {
    conversationId,
    ...(window?.tailTurns != null ? { tailTurns: window.tailTurns } : {}),
    ...(window?.fromIndex != null ? { fromIndex: window.fromIndex } : {}),
  })
}

/** Fetch one page of older history ending just before `beforeIndex`. */
export async function getFolderConversationTurns(
  conversationId: number,
  beforeIndex: number,
  limit: number
): Promise<ConversationTurnsPage> {
  return getTransport().call("get_folder_conversation_turns", {
    conversationId,
    beforeIndex,
    limit,
  })
}

export async function removeFolderFromHistory(path: string): Promise<void> {
  return getTransport().call("remove_folder_from_history", { path })
}

export async function createFolderDirectory(path: string): Promise<void> {
  return getTransport().call("create_folder_directory", { path })
}

export async function cloneRepository(
  url: string,
  targetDir: string,
  credentials?: GitCredentials | null
): Promise<void> {
  return getTransport().call("clone_repository", {
    url,
    targetDir,
    credentials: credentials ?? null,
  })
}

export async function getGitBranch(path: string): Promise<string | null> {
  return getTransport().call("get_git_branch", { path })
}

export async function getGitHead(path: string): Promise<GitHeadInfo> {
  return getTransport().call("get_git_head", { path })
}

export async function gitInit(path: string): Promise<void> {
  return getTransport().call("git_init", { path })
}

export async function gitPull(
  path: string,
  credentials?: GitCredentials | null
): Promise<GitPullResult> {
  return getTransport().call("git_pull", {
    path,
    credentials: credentials ?? null,
  })
}

export async function gitStartPullMerge(
  path: string,
  upstreamCommit?: string | null
): Promise<void> {
  return getTransport().call("git_start_pull_merge", { path, upstreamCommit })
}

export async function gitHasMergeHead(path: string): Promise<boolean> {
  return getTransport().call("git_has_merge_head", { path })
}

export async function gitFetch(
  path: string,
  credentials?: GitCredentials | null
): Promise<string> {
  return getTransport().call("git_fetch", {
    path,
    credentials: credentials ?? null,
  })
}

/**
 * Update a branch WITHOUT checking it out. The checked-out branch falls back to
 * a normal pull (so a conflict can still come back on `conflict`); any other
 * local branch is fast-forwarded from its upstream, and a remote branch
 * (`isRemote`, e.g. `origin/main`) only advances its remote-tracking ref.
 */
export async function gitUpdateBranch(
  path: string,
  branch: string,
  isRemote: boolean,
  credentials?: GitCredentials | null
): Promise<GitPullResult> {
  return getTransport().call("git_update_branch", {
    path,
    branch,
    isRemote,
    credentials: credentials ?? null,
  })
}

/** `branch` omitted (or null) reports on the checked-out branch. */
export async function gitPushInfo(
  path: string,
  branch?: string | null
): Promise<GitPushInfo> {
  return getTransport().call("git_push_info", {
    path,
    branch: branch ?? null,
  })
}

/**
 * Push a branch. `branch` omitted (or null) pushes the checked-out one; naming
 * one pushes it without checking it out (`git push <remote> <branch>`).
 */
export async function gitPush(
  path: string,
  remote?: string | null,
  credentials?: GitCredentials | null,
  folderId?: number | null,
  branch?: string | null
): Promise<GitPushResult> {
  return getTransport().call("git_push", {
    path,
    remote: remote ?? null,
    branch: branch ?? null,
    credentials: credentials ?? null,
    folderId: folderId ?? null,
  })
}

export async function gitNewBranch(
  path: string,
  branchName: string,
  startPoint?: string
): Promise<void> {
  return getTransport().call("git_new_branch", {
    path,
    branchName,
    startPoint: startPoint ?? null,
  })
}

export async function gitWorktreeAdd(
  path: string,
  branchName: string,
  worktreePath: string
): Promise<void> {
  return getTransport().call("git_worktree_add", {
    path,
    branchName,
    worktreePath,
  })
}

export async function gitCheckout(
  path: string,
  branchName: string
): Promise<void> {
  return getTransport().call("git_checkout", { path, branchName })
}

export async function gitListBranches(path: string): Promise<string[]> {
  return getTransport().call("git_list_branches", { path })
}

export async function gitListAllBranches(path: string): Promise<GitBranchList> {
  return getTransport().call("git_list_all_branches", { path })
}

export async function gitMerge(
  path: string,
  branchName: string
): Promise<GitMergeResult> {
  return getTransport().call("git_merge", { path, branchName })
}

export async function gitRebase(
  path: string,
  branchName: string
): Promise<GitRebaseResult> {
  return getTransport().call("git_rebase", { path, branchName })
}

export async function gitDeleteBranch(
  path: string,
  branchName: string,
  force: boolean = false
): Promise<string> {
  return getTransport().call("git_delete_branch", {
    path,
    branchName,
    force,
  })
}

/**
 * Remove the worktree that has `branchName` checked out — the only way such a
 * branch can be deleted, since git refuses `branch -d` while a worktree holds
 * the ref. `deleteBranch` also takes the branch and the worktree's workspace
 * folder (its sessions move to the repo folder); `force` discards uncommitted
 * work in the worktree and force-deletes an unmerged branch.
 *
 * `sourceFolderId` is the folder the caller acts from — it only supplies the
 * re-parent target when the worktree folder has no recorded root.
 */
export async function gitRemoveWorktree(
  path: string,
  branchName: string,
  sourceFolderId: number,
  deleteBranch: boolean,
  force: boolean = false
): Promise<GitWorktreeRemoval> {
  return getTransport().call("git_remove_worktree", {
    path,
    branchName,
    sourceFolderId,
    deleteBranch,
    force,
  })
}

export async function gitDeleteRemoteBranch(
  path: string,
  remote: string,
  branch: string,
  credentials?: GitCredentials | null
): Promise<void> {
  return getTransport().call("git_delete_remote_branch", {
    path,
    remote,
    branch,
    credentials: credentials ?? null,
  })
}

export async function gitListConflicts(path: string): Promise<string[]> {
  return getTransport().call("git_list_conflicts", { path })
}

export async function gitConflictFileVersions(
  path: string,
  file: string
): Promise<GitConflictFileVersions> {
  return getTransport().call("git_conflict_file_versions", { path, file })
}

export async function gitResolveConflict(
  path: string,
  file: string,
  content: string
): Promise<void> {
  return getTransport().call("git_resolve_conflict", { path, file, content })
}

export async function gitAbortOperation(
  path: string,
  operation: string
): Promise<void> {
  return getTransport().call("git_abort_operation", { path, operation })
}

export async function gitContinueOperation(
  path: string,
  operation: string
): Promise<void> {
  return getTransport().call("git_continue_operation", { path, operation })
}

/**
 * How many `openAppWindow` calls are still waiting on each window name. Two
 * clicks on the same action are handed the very same reserved window, so a
 * failure may only tear it down once nothing else is still racing for it.
 */
const appWindowReservations = new Map<string, number>()

function reserveAppWindow(name: string): void {
  appWindowReservations.set(name, (appWindowReservations.get(name) ?? 0) + 1)
}

/** Drops one reservation and reports how many remain for that name. */
function releaseAppWindow(name: string): number {
  const remaining = Math.max(0, (appWindowReservations.get(name) ?? 1) - 1)
  if (remaining > 0) appWindowReservations.set(name, remaining)
  else appWindowReservations.delete(name)
  return remaining
}

/**
 * True while a window still shows the blank placeholder we reserved — i.e. it
 * holds nothing worth keeping. Reading `location` on a cross-origin window
 * throws; such a window is not one of ours, so treat it as occupied.
 */
function isBlankAppWindow(win: Window): boolean {
  try {
    return win.location.href === "about:blank"
  } catch {
    return false
  }
}

/**
 * Open a same-origin app window (commit / push / settings / …) whose target
 * path is only known after a backend round trip.
 *
 * The window must be RESERVED inside the click's own call stack: in web mode
 * that round trip is a real HTTP request, far longer than any browser's
 * user-activation window, so calling `window.open(path)` after the await is
 * reliably swallowed by the popup blocker. (Issue #410 is the markdown-link
 * variant of the same bug, where the gap was only a microtask.)
 *
 * Reserving with an EMPTY url is what makes this safe to retrofit: an empty
 * url never navigates, so a name that already maps to an open window is simply
 * handed back — preserving today's reuse-by-name behaviour, which
 * `openPushWindow` relies on to retarget an already-open push window. And
 * because no window features are passed, a `null` return really does mean
 * "blocked" here, unlike the `noreferrer` popups in ai-elements/link-safety.tsx
 * (those return null even on success).
 */
async function openAppWindow(
  name: string,
  resolvePath: () => Promise<{ path: string }>
): Promise<void> {
  const win = window.open("", name)
  if (!win) {
    throw new Error(
      "Popup blocked by the browser. Allow popups for this site and try again."
    )
  }

  reserveAppWindow(name)
  try {
    const { path } = await resolvePath()
    win.location.href = path
  } catch (error) {
    // Tear the placeholder down only once nothing else is waiting on this name
    // AND nobody has navigated it meanwhile: a concurrent request for the same
    // window may still succeed, and it shares this exact window. Checking for
    // the blank placeholder (rather than remembering "I created it") is also
    // what keeps a window the user already had open — which always carries a
    // real document — from being closed by an unrelated failure.
    if (releaseAppWindow(name) === 0 && isBlankAppWindow(win)) win.close()
    throw error
  }
  releaseAppWindow(name)
}

export async function openMergeWindow(
  folderId: number,
  operation: string,
  upstreamCommit?: string | null
): Promise<void> {
  const locale = getCurrentEffectiveAppLocale()
  if (isDesktop()) {
    return getShellTransport().call("open_merge_window", {
      folderId,
      operation,
      upstreamCommit: upstreamCommit ?? null,
      locale,
      remoteConnectionId: getActiveRemoteConnectionId(),
    })
  }
  return openAppWindow(`merge-${folderId}`, () =>
    getTransport().call<{ path: string }>("open_merge_window", {
      folderId,
      operation,
      upstreamCommit: upstreamCommit ?? null,
      locale,
    })
  )
}

export async function openStashWindow(folderId: number): Promise<void> {
  const locale = getCurrentEffectiveAppLocale()
  if (isDesktop()) {
    return getShellTransport().call("open_stash_window", {
      folderId,
      locale,
      remoteConnectionId: getActiveRemoteConnectionId(),
    })
  }
  return openAppWindow(`stash-${folderId}`, () =>
    getTransport().call<{ path: string }>("open_stash_window", {
      folderId,
      locale,
    })
  )
}

/** `branch` preselects the push target; omitted means the checked-out branch. */
export async function openPushWindow(
  folderId: number,
  branch?: string | null
): Promise<void> {
  const locale = getCurrentEffectiveAppLocale()
  if (isDesktop()) {
    return getShellTransport().call("open_push_window", {
      folderId,
      locale,
      remoteConnectionId: getActiveRemoteConnectionId(),
      branch: branch ?? null,
    })
  }
  // Reusing the window NAME navigates an already-open push window to the new
  // URL, so the preselected branch applies there too (the desktop path gets the
  // same effect from the `push://retarget-branch` event).
  return openAppWindow(`push-${folderId}`, () =>
    getTransport().call<{ path: string }>("open_push_window", {
      folderId,
      locale,
      branch: branch ?? null,
    })
  )
}

export async function gitStashPush(
  path: string,
  message?: string,
  keepIndex?: boolean
): Promise<string> {
  return getTransport().call("git_stash_push", {
    path,
    message: message ?? null,
    keepIndex: keepIndex ?? false,
  })
}

export async function gitStashPop(
  path: string,
  stashRef?: string
): Promise<string> {
  return getTransport().call("git_stash_pop", {
    path,
    stashRef: stashRef ?? null,
  })
}

export async function gitStashList(path: string): Promise<GitStashEntry[]> {
  return getTransport().call("git_stash_list", { path })
}

export async function gitStashApply(
  path: string,
  stashRef: string
): Promise<string> {
  return getTransport().call("git_stash_apply", { path, stashRef })
}

export async function gitStashDrop(
  path: string,
  stashRef: string
): Promise<string> {
  return getTransport().call("git_stash_drop", { path, stashRef })
}

export async function gitStashClear(path: string): Promise<string> {
  return getTransport().call("git_stash_clear", { path })
}

export async function gitStashShow(
  path: string,
  stashRef: string
): Promise<GitStatusEntry[]> {
  return getTransport().call("git_stash_show", { path, stashRef })
}

export async function gitListRemotes(path: string): Promise<GitRemote[]> {
  return getTransport().call("git_list_remotes", { path })
}

export async function gitFetchRemote(
  path: string,
  name: string,
  credentials?: GitCredentials | null
): Promise<string> {
  return getTransport().call("git_fetch_remote", {
    path,
    name,
    credentials: credentials ?? null,
  })
}

export async function gitAddRemote(
  path: string,
  name: string,
  url: string
): Promise<void> {
  return getTransport().call("git_add_remote", { path, name, url })
}

export async function gitRemoveRemote(
  path: string,
  name: string
): Promise<void> {
  return getTransport().call("git_remove_remote", { path, name })
}

export async function gitSetRemoteUrl(
  path: string,
  name: string,
  url: string
): Promise<void> {
  return getTransport().call("git_set_remote_url", { path, name, url })
}

export async function gitStatus(
  path: string,
  showAllUntracked?: boolean
): Promise<GitStatusEntry[]> {
  return getTransport().call("git_status", {
    path,
    showAllUntracked: showAllUntracked ?? null,
  })
}

export async function gitDiff(path: string, file?: string): Promise<string> {
  return getTransport().call("git_diff", { path, file: file ?? null })
}

export async function gitDiffWithBranch(
  path: string,
  branch: string,
  file?: string
): Promise<string> {
  return getTransport().call("git_diff_with_branch", {
    path,
    branch,
    file: file ?? null,
  })
}

export async function gitShowDiff(
  path: string,
  commit: string,
  file?: string
): Promise<string> {
  return getTransport().call("git_show_diff", {
    path,
    commit,
    file: file ?? null,
  })
}

export async function gitShowFile(
  path: string,
  file: string,
  refName?: string
): Promise<string> {
  return getTransport().call("git_show_file", {
    path,
    file,
    refName: refName ?? null,
  })
}

export async function gitShowFileBase64(
  path: string,
  file: string,
  refName?: string,
  maxBytes?: number
): Promise<GitBlobBase64> {
  return getTransport().call("git_show_file_base64", {
    path,
    file,
    refName: refName ?? null,
    maxBytes: maxBytes ?? null,
  })
}

export async function gitIsTracked(
  path: string,
  file: string
): Promise<boolean> {
  return getTransport().call("git_is_tracked", { path, file })
}

export async function gitCommit(
  path: string,
  message: string,
  files: string[],
  folderId?: number | null
): Promise<GitCommitResult> {
  return getTransport().call("git_commit", {
    path,
    message,
    files,
    folderId: folderId ?? null,
  })
}

export async function gitRollbackFile(
  path: string,
  file: string
): Promise<void> {
  return getTransport().call("git_rollback_file", { path, file })
}

export async function gitAddFiles(
  path: string,
  files: string[]
): Promise<void> {
  return getTransport().call("git_add_files", { path, files })
}

// Window management commands

// ─── Workspace folder links (multi-folder workspace) ───

/** Links currently registered for `folderId`, with their live on-disk status. */
export async function listFolderLinks(
  folderId: number
): Promise<FolderLinkDetail[]> {
  return getTransport().call("list_folder_links", { folderId })
}

/**
 * Dry run: what names the picked directories would get and which ones would be
 * skipped. Resolved server-side against the real filesystem, so the dialog can
 * show the final names before anything is created.
 */
export async function previewFolderLinks(
  folderId: number,
  paths: string[]
): Promise<FolderLinkPlan[]> {
  return getTransport().call("preview_folder_links", { folderId, paths })
}

/**
 * Create the links. Entries that can't be linked are skipped rather than
 * failing the batch — the result is what actually landed.
 */
export async function createFolderLinks(
  folderId: number,
  items: FolderLinkRequestItem[],
  gitExclude = true
): Promise<FolderLinkDetail[]> {
  return getTransport().call("create_folder_links", {
    folderId,
    items,
    gitExclude,
  })
}

/** Rename a link (moves the symlink; the target is untouched). */
export async function renameFolderLink(
  linkId: number,
  newName: string
): Promise<FolderLinkDetail> {
  return getTransport().call("rename_folder_link", { linkId, newName })
}

/** Recreate the symlink for a link whose on-disk entry went missing. */
export async function repairFolderLink(
  linkId: number
): Promise<FolderLinkDetail> {
  return getTransport().call("repair_folder_link", { linkId })
}

/**
 * Drop a link. With `deleteLink` the symlink is removed from the workspace
 * root; the directory it pointed at is never touched.
 */
export async function removeFolderLink(
  linkId: number,
  deleteLink = true
): Promise<void> {
  return getTransport().call("remove_folder_link", { linkId, deleteLink })
}

// ─── Conversation canvas ───

/** Input for `canvasCreateNode`. Binding fields are kind-specific (validated
 *  server-side): folder → folderId, group → folderGroupId, agent → agentType,
 *  conversation → conversationId; custom starts empty; note uses content;
 *  file and terminal use path. */
export interface CreateCanvasNodeInput {
  kind: CanvasNodeKind
  folderId?: number
  folderGroupId?: number
  agentType?: string
  conversationId?: number
  title?: string
  content?: string
  /** file → the document's absolute path; terminal → its working directory.
   *  Required for those two kinds, rejected for the rest. */
  path?: string
  color?: string
  /** Pinned grid axes (regions only); omitted / 0 = auto. */
  gridColumns?: number
  gridRows?: number
  x: number
  y: number
  width: number
  height: number
}

/** Field-by-field patch: absent = untouched, empty string clears a nullable
 *  text field. `memberAdd` / `memberRemove` are atomic server-side list ops
 *  (custom regions only). */
export interface CanvasNodePatchInput {
  title?: string
  content?: string
  color?: string
  collapsed?: boolean
  /** Pinned grid axes; regions only (a non-region patch is rejected). 0 = auto. */
  gridColumns?: number
  gridRows?: number
  x?: number
  y?: number
  width?: number
  height?: number
  memberAdd?: number
  memberRemove?: number
}

/** Input for `canvasGroupIntoRegion` — every "collect these conversations"
 *  gesture: box-select → new region, a pinned card dragged into a custom
 *  region, and two cards dropped onto each other. */
export interface GroupIntoRegionInput {
  /** Existing custom region to merge into. Omit to create a new one from the
   *  geometry below (which is then ignored — the frame is already placed). */
  targetRegionId?: number
  title?: string
  color?: string
  /** Conversations to seed the region with; duplicates collapse server-side. */
  memberIds: number[]
  /** Pinned cards the selection swallowed, deleted in the same transaction.
   *  Ids that aren't pinned cards are ignored, not rejected. */
  consumeNodeIds: number[]
  gridColumns?: number
  gridRows?: number
  /** Where a NEW region goes — all four together, or none at all when merging
   *  into an existing frame. A half-specified frame is rejected rather than
   *  silently placed. */
  x?: number
  y?: number
  width?: number
  height?: number
}

/** What the gesture actually committed — the region plus the pins that were
 *  really deleted (raced ids dropped), mirroring the `grouped` event payload. */
export interface GroupIntoRegionResult {
  node: CanvasNode
  deletedIds: number[]
}

/** The full canvas node set plus the revision it was read at. */
export async function canvasListNodes(): Promise<CanvasSnapshot> {
  return getTransport().call("canvas_list_nodes", {})
}

export async function canvasCreateNode(
  input: CreateCanvasNodeInput
): Promise<CanvasMutation<CanvasNode>> {
  return getTransport().call("canvas_create_node", { input })
}

/** "Collect these conversations into a region": the region write, its member
 *  list and the deletion of the pinned cards it absorbed, as ONE transaction and
 *  ONE revision. Doing it as create + N × memberAdd + M × delete would spray a
 *  dozen events for one gesture and make every intermediate state observable. */
export async function canvasGroupIntoRegion(
  input: GroupIntoRegionInput
): Promise<CanvasMutation<GroupIntoRegionResult>> {
  return getTransport().call("canvas_group_into_region", { input })
}

export async function canvasUpdateNode(
  nodeId: number,
  patch: CanvasNodePatchInput
): Promise<CanvasMutation<CanvasNode>> {
  return getTransport().call("canvas_update_node", { nodeId, patch })
}

/** Batch position write (drag drop, auto-arrange): one revision bump, one
 *  event, however many nodes moved. The value echoes the moves as actually
 *  written — clamped, deleted-node ghosts dropped — apply THAT optimistically,
 *  not the request. */
export async function canvasMoveNodes(
  moves: CanvasNodeMovePayload[]
): Promise<CanvasMutation<CanvasNodeMovePayload[]>> {
  return getTransport().call("canvas_move_nodes", { moves })
}

/** Drag a member card out of a region onto open canvas. Custom regions MOVE
 *  the membership (stale retries reject as not_found); folder/agent regions
 *  COPY. One transaction, one event either way. */
export async function canvasDetachMember(
  regionId: number,
  conversationId: number,
  x: number,
  y: number
): Promise<CanvasMutation<CanvasNode>> {
  return getTransport().call("canvas_detach_member", {
    regionId,
    conversationId,
    x,
    y,
  })
}

export async function canvasDeleteNode(
  nodeId: number
): Promise<CanvasMutation<null>> {
  return getTransport().call("canvas_delete_node", { nodeId })
}

/** Delete a whole multi-selection in one transaction and one `pruned` event.
 *  The value is the ids ACTUALLY deleted (ghosts dropped) — apply that. */
export async function canvasDeleteNodes(
  nodeIds: number[]
): Promise<CanvasMutation<number[]>> {
  return getTransport().call("canvas_delete_nodes", { nodeIds })
}

export async function openFolder(path: string): Promise<FolderDetail> {
  return getTransport().call("open_folder", { path })
}

/** Open a file or directory in Visual Studio Code on the workspace host. */
export async function openInCode(path: string): Promise<void> {
  return getTransport().call("open_in_code", { path })
}

/**
 * Open a freshly created git worktree directory as a folder, recording the root
 * folder it descends from (`sourceFolderId` is the folder the worktree was
 * created from; the backend flattens to the root). Lets the worktree folder be
 * merged under its parent in the sidebar.
 */
export async function openWorktreeFolder(
  path: string,
  sourceFolderId: number
): Promise<FolderDetail> {
  return getTransport().call("open_worktree_folder", { path, sourceFolderId })
}

/**
 * Resolve where `branch` is checked out across the repo's worktrees. Returns the
 * canonical worktree path (or null if the branch isn't checked out anywhere) and
 * the registered folder id owning that path (or null for an external worktree).
 * Path matching is canonicalized on the host that runs git, so it is correct for
 * symlinked and remote-workspace paths the webview cannot resolve.
 */
export async function resolveWorktreeFolder(
  repoPath: string,
  branch: string
): Promise<WorktreeResolution> {
  return getTransport().call("resolve_worktree_folder", { repoPath, branch })
}

export async function openCommitWindow(folderId: number): Promise<void> {
  const locale = getCurrentEffectiveAppLocale()
  if (isDesktop()) {
    return getShellTransport().call("open_commit_window", {
      folderId,
      locale,
      remoteConnectionId: getActiveRemoteConnectionId(),
    })
  }
  return openAppWindow(`commit-${folderId}`, () =>
    getTransport().call<{ path: string }>("open_commit_window", {
      folderId,
      locale,
    })
  )
}

export type SettingsSection =
  | "general"
  | "appearance"
  | "agents"
  | "mcp"
  | "skills"
  | "experts"
  | "science"
  | "office-tools"
  | "collaboration"
  | "browser"
  | "version-control"
  | "shortcuts"
  | "system"

interface OpenSettingsWindowOptions {
  agentType?: AgentType | null
}

export async function openSettingsWindow(
  section?: SettingsSection,
  options?: OpenSettingsWindowOptions
): Promise<void> {
  const locale = getCurrentEffectiveAppLocale()
  if (isDesktop()) {
    return getShellTransport().call("open_settings_window", {
      section: section ?? null,
      agentType: options?.agentType ?? null,
      locale,
      remoteConnectionId: getActiveRemoteConnectionId(),
    })
  }
  // Web mode: open in new window
  return openAppWindow(`settings-${section ?? "general"}`, () =>
    getTransport().call<{ path: string }>("open_settings_window", {
      section: section ?? null,
      agentType: options?.agentType ?? null,
      locale,
    })
  )
}

export interface OpenImportSessionsWindowOptions {
  /** Folder path the picker should scroll to and preselect once the scan
   *  completes (the sidebar folder context-menu entry passes its own path). */
  focusPath?: string | null
}

export async function openImportSessionsWindow(
  options?: OpenImportSessionsWindowOptions
): Promise<void> {
  const focusPath = options?.focusPath ?? null
  if (isDesktop()) {
    return getShellTransport().call("open_import_sessions_window", {
      focusPath,
      locale: getCurrentEffectiveAppLocale(),
      remoteConnectionId: getActiveRemoteConnectionId(),
    })
  }
  return openAppWindow("import-sessions", () =>
    getTransport().call<{ path: string }>("open_import_sessions_window", {
      focusPath,
    })
  )
}

export async function openProjectBootWindow(source?: string): Promise<void> {
  if (isDesktop()) {
    return getShellTransport().call("open_project_boot_window", {
      source,
      locale: getCurrentEffectiveAppLocale(),
      remoteConnectionId: getActiveRemoteConnectionId(),
    })
  }
  if (typeof window !== "undefined") {
    window.open("/project-boot", "project-boot")
  }
}

// Cross-window handoff for the project launcher, which lives in its own
// window/tab and can't reach the workspace's React state directly. The
// backend upserts the folder and emits `folder://open-in-workspace` carrying
// the FolderDetail through the shared EventEmitter; the transport layer routes
// that to the right workspace window in every runtime (local Tauri bus, the
// server's WebSocket broadcaster for web, and the remote server's broadcaster
// for remote desktop), so only windows talking to this backend react. The
// workspace subscribes via WorkspaceOpenFolderListener.
export const FOLDER_OPEN_IN_WORKSPACE_EVENT = "folder://open-in-workspace"

export async function openFolderInWorkspace(
  path: string
): Promise<FolderDetail> {
  return getTransport().call("open_folder_in_workspace", { path })
}

export async function detectPackageManager(
  name: string
): Promise<PackageManagerInfo> {
  return getTransport().call("detect_package_manager", { name })
}

export async function createShadcnProject(params: {
  projectName: string
  template: string
  presetCode: string
  packageManager: string
  targetDir: string
}): Promise<string> {
  return getTransport().call("create_shadcn_project", {
    projectName: params.projectName,
    template: params.template,
    presetCode: params.presetCode,
    packageManager: params.packageManager,
    targetDir: params.targetDir,
  })
}

/**
 * Detect, per codeg-supported agent, whether the HyperFrames skills are already
 * installed globally. Cheap filesystem check, so no long timeout is needed.
 */
export async function detectHyperframesSkills(): Promise<
  HyperframesSkillAgent[]
> {
  return getTransport().call(
    "detect_hyperframes_skills",
    {},
    { timeoutMs: 30_000 }
  )
}

/**
 * Install the HyperFrames agent skills globally (symlinked) for the given
 * agents. Clones from GitHub, so allow a few minutes. Re-running is idempotent
 * (acts as an update for agents that already have the skills).
 */
export async function installHyperframesSkills(
  agents: string[]
): Promise<void> {
  await getTransport().call(
    "install_hyperframes_skills",
    { agents },
    { timeoutMs: 600_000 }
  )
}

export async function createHyperframesProject(params: {
  projectName: string
  example: string
  resolution: string
  packageManager: string
  targetDir: string
}): Promise<string> {
  return getTransport().call(
    "create_hyperframes_project",
    {
      projectName: params.projectName,
      example: params.example,
      resolution: params.resolution,
      packageManager: params.packageManager,
      targetDir: params.targetDir,
    },
    { timeoutMs: 600_000 }
  )
}

// Conversation CRUD commands

export async function createConversation(
  folderId: number,
  agentType: AgentType,
  title?: string
): Promise<number> {
  return getTransport().call("create_conversation", {
    folderId,
    agentType,
    title: title ?? null,
  })
}

/**
 * Create a folderless "chat mode" conversation. The backend lazily creates a
 * dated per-conversation scratch dir and a dedicated hidden chat folder
 * backing it, then the conversation. Returns the new conversation id plus that
 * folder so the caller can seed `allFolders` (cwd / active-folder) immediately.
 */
export async function createChatConversation(
  agentType: AgentType,
  title?: string,
  // Reuse a scratch dir already minted by `createChatDir` (eager connect) so the
  // ACP cwd never moves across the first send; omit to let the backend mint one.
  existingDir?: string
): Promise<CreateChatConversationResult> {
  return getTransport().call("create_chat_conversation", {
    agentType,
    title: title ?? null,
    existingDir: existingDir ?? null,
  })
}

/**
 * Eagerly create a chat-mode scratch directory (filesystem only — no DB rows)
 * and return its path, so a chat draft can connect ACP at a real cwd the instant
 * "no-folder mode" is selected, before any first prompt.
 */
export async function createChatDir(): Promise<CreateChatDirResult> {
  return getTransport().call("create_chat_dir", {})
}

export async function updateConversationStatus(
  conversationId: number,
  status: string
): Promise<void> {
  return getTransport().call("update_conversation_status", {
    conversationId,
    status,
  })
}

export async function updateConversationTitle(
  conversationId: number,
  title: string
): Promise<void> {
  return getTransport().call("update_conversation_title", {
    conversationId,
    title,
  })
}

export async function updateConversationPinned(
  conversationId: number,
  pinned: boolean
): Promise<void> {
  return getTransport().call("update_conversation_pinned", {
    conversationId,
    pinned,
  })
}

export async function deleteConversation(
  conversationId: number
): Promise<void> {
  return getTransport().call("delete_conversation", { conversationId })
}

// Folder command management

export async function listFolderCommands(
  folderId: number
): Promise<FolderCommand[]> {
  return getTransport().call("list_folder_commands", { folderId })
}

export async function createFolderCommand(
  folderId: number,
  name: string,
  command: string
): Promise<FolderCommand> {
  return getTransport().call("create_folder_command", {
    folderId,
    name,
    command,
  })
}

export async function updateFolderCommand(
  id: number,
  name?: string,
  command?: string,
  sortOrder?: number
): Promise<FolderCommand> {
  return getTransport().call("update_folder_command", {
    id,
    name: name ?? null,
    command: command ?? null,
    sortOrder: sortOrder ?? null,
  })
}

export async function deleteFolderCommand(id: number): Promise<void> {
  return getTransport().call("delete_folder_command", { id })
}

export async function reorderFolderCommands(
  folderId: number,
  ids: number[]
): Promise<void> {
  return getTransport().call("reorder_folder_commands", { folderId, ids })
}

export async function bootstrapFolderCommandsFromPackageJson(
  folderId: number,
  folderPath: string
): Promise<FolderCommand[]> {
  return getTransport().call("bootstrap_folder_commands_from_package_json", {
    folderId,
    folderPath,
  })
}

// Quick message management

export async function quickMessagesList(): Promise<QuickMessage[]> {
  return getTransport().call("quick_messages_list")
}

export async function quickMessagesCreate(params: {
  title: string
  content: string
}): Promise<QuickMessage> {
  return getTransport().call("quick_messages_create", {
    title: params.title,
    content: params.content,
  })
}

export async function quickMessagesUpdate(params: {
  id: number
  title?: string
  content?: string
}): Promise<QuickMessage> {
  return getTransport().call("quick_messages_update", {
    id: params.id,
    title: params.title ?? null,
    content: params.content ?? null,
  })
}

export async function quickMessagesDelete(id: number): Promise<void> {
  return getTransport().call("quick_messages_delete", { id })
}

export async function quickMessagesReorder(ids: number[]): Promise<void> {
  return getTransport().call("quick_messages_reorder", { ids })
}

// Token usage dashboard

export async function tokenUsageReport(
  filter: TokenUsageFilter
): Promise<TokenUsageReport> {
  return getTransport().call("token_usage_report", { filter })
}

export async function tokenUsageFacets(): Promise<TokenUsageFacets> {
  return getTransport().call("token_usage_facets")
}

export async function tokenUsageStatus(): Promise<TokenUsageSyncStatus> {
  return getTransport().call("token_usage_status")
}

/** `full` drops every stored fact and re-parses every transcript — the escape
 *  hatch for a session file the agent's own CLI grew behind codeg's back. */
export async function tokenUsageSync(
  mode: "incremental" | "full" = "incremental"
): Promise<TokenUsageSyncResult> {
  return getTransport().call("token_usage_sync", { mode })
}

// Automations

export async function automationList(): Promise<Automation[]> {
  return getTransport().call("automation_list")
}

export async function automationGet(id: number): Promise<Automation> {
  return getTransport().call("automation_get", { id })
}

export async function automationRuns(
  automationId: number,
  limit = 100
): Promise<AutomationRun[]> {
  return getTransport().call("automation_runs", { automationId, limit })
}

export async function automationCreate(
  draft: AutomationDraft
): Promise<Automation> {
  return getTransport().call("automation_create", { draft })
}

export async function automationUpdate(
  id: number,
  draft: AutomationDraft
): Promise<Automation> {
  return getTransport().call("automation_update", { id, draft })
}

export async function automationSetEnabled(
  id: number,
  enabled: boolean
): Promise<Automation> {
  return getTransport().call("automation_set_enabled", { id, enabled })
}

export async function automationDelete(id: number): Promise<void> {
  return getTransport().call("automation_delete", { id })
}

export async function automationMarkSeen(): Promise<void> {
  return getTransport().call("automation_mark_seen")
}

/** Authoritative "next run" preview — same evaluator as the scheduler. Returns
 *  an ISO timestamp, or null if the cron has no future occurrence. */
export async function automationComputeNextRun(
  cron: string,
  timezone: string
): Promise<string | null> {
  return getTransport().call("automation_compute_next_run", { cron, timezone })
}

/** Fire an automation immediately, bypassing its schedule. Returns the run id. */
export async function automationRunNow(automationId: number): Promise<number> {
  return getTransport().call("automation_run_now", { automationId })
}

/** Cancel an in-flight (or clear a wedged) run. */
export async function automationCancelRun(runId: number): Promise<void> {
  return getTransport().call("automation_cancel_run", { runId })
}

// Work tasks

export async function workTaskList(
  folderId?: number | null
): Promise<WorkTask[]> {
  return getTransport().call("work_task_list", { folderId: folderId ?? null })
}

export async function workTaskGet(id: number): Promise<WorkTask> {
  return getTransport().call("work_task_get", { id })
}

export async function workTaskEvents(
  taskId: number,
  limit = 500
): Promise<WorkTaskEvent[]> {
  return getTransport().call("work_task_events", { taskId, limit })
}

/**
 * Drop an uploaded image's base64 from a task's blocks in every mode where the
 * call leaves through an HTTP body, the same rule (and the same helper) a chat
 * send follows: the bytes already live in the uploads dir, and the engine's
 * dispatch re-inlines them from the uri (`acp::prompt_hydration`) when the task
 * eventually runs.
 */
function stripUploadedTaskBlocks(
  blocks: PromptInputBlock[] | null | undefined
): PromptInputBlock[] {
  if (!blocks || blocks.length === 0) return []
  return stripUploadedImagePayloads(
    blocks,
    !isDesktop() || getActiveRemoteConnectionId() !== null
  )
}

export async function workTaskCreate(draft: WorkTaskDraft): Promise<WorkTask> {
  return getTransport().call("work_task_create", {
    draft: { ...draft, config: stripUploadedTaskConfig(draft.config) },
  })
}

/** {@link stripUploadedTaskBlocks} over a whole task config. */
function stripUploadedTaskConfig(config: WorkTaskConfig): WorkTaskConfig {
  return {
    ...config,
    prompt_blocks: stripUploadedTaskBlocks(config.prompt_blocks),
  }
}

export async function workTaskUpdate(
  id: number,
  draft: WorkTaskDraft
): Promise<WorkTask> {
  return getTransport().call("work_task_update", {
    id,
    draft: { ...draft, config: stripUploadedTaskConfig(draft.config) },
  })
}

/** Persist the pending column's drag order (index → sort_order). */
export async function workTaskReorder(
  folderId: number,
  orderedIds: number[]
): Promise<void> {
  return getTransport().call("work_task_reorder", { folderId, orderedIds })
}

export async function workTaskDelete(
  id: number,
  deleteWorktree = false
): Promise<void> {
  return getTransport().call("work_task_delete", { id, deleteWorktree })
}

export async function workTaskStart(id: number): Promise<void> {
  return getTransport().call("work_task_start", { id })
}

/**
 * failed → queued. `note` (optional) reaches the retry prompt, and `blocks`
 * carries whatever the note box attached out of band (images, pasted bytes) —
 * stripped of uploaded payloads on the way out, exactly like a chat send.
 */
export async function workTaskRetry(
  id: number,
  note?: string | null,
  blocks?: PromptInputBlock[] | null,
  allowDuplicateSource?: boolean
): Promise<void> {
  return getTransport().call("work_task_retry", {
    id,
    note: note ?? null,
    blocks: stripUploadedTaskBlocks(blocks),
    allowDuplicateSource: allowDuplicateSource ?? false,
  })
}

/**
 * canceled → todo (back onto the board; started again explicitly). `note`
 * (optional) reaches the next run's prompt — a cancel usually had a reason.
 */
export async function workTaskRequeue(
  id: number,
  note?: string | null,
  blocks?: PromptInputBlock[] | null,
  allowDuplicateSource?: boolean
): Promise<void> {
  return getTransport().call("work_task_requeue", {
    id,
    note: note ?? null,
    blocks: stripUploadedTaskBlocks(blocks),
    allowDuplicateSource: allowDuplicateSource ?? false,
  })
}

/**
 * Plan when a to-do task starts (`scheduledAt` is an ISO instant; `null`
 * clears the plan). The engine claims it at that time exactly as if the start
 * button had been pressed — the folder's concurrency limit still applies.
 */
export async function workTaskSchedule(
  id: number,
  scheduledAt: string | null
): Promise<void> {
  return getTransport().call("work_task_schedule", { id, scheduledAt })
}

/**
 * Follow up on a reviewed task. `intent` picks the framing the agent receives
 * (see `lib/task-follow-up`); omitted means `revise`.
 */
export async function workTaskReturn(
  id: number,
  feedback: string,
  intent?: FollowUpIntent,
  blocks?: PromptInputBlock[] | null
): Promise<void> {
  return getTransport().call("work_task_return", {
    id,
    feedback,
    intent: intent ?? null,
    blocks: stripUploadedTaskBlocks(blocks),
  })
}

/**
 * Stop a task. `reason` (optional) is the user's own note about why — it lands
 * on the `canceled` entry of the progress timeline and is never replayed into
 * a later run's prompt (a requeue carries its own note for that).
 *
 * `deleteWorktree` takes the checkout along once the stop lands — best-effort,
 * so a removal that fails leaves a retryable `cleanup_state` on the card and
 * the task is canceled either way. It also deletes the work branch, which is
 * why the dialog leaves the box unchecked by default.
 */
export async function workTaskCancel(
  id: number,
  reason?: string | null,
  deleteWorktree = false
): Promise<void> {
  return getTransport().call("work_task_cancel", {
    id,
    reason: reason ?? null,
    deleteWorktree,
  })
}

/** Dispatch the agent-driven merge (`message: null` = the agent writes the
 *  commit message itself); the outcome rides `task://changed` events.
 *  Resolves `true` when the merge was QUEUED behind another landing of the same
 *  project instead of started — merges are serial per project, so a second
 *  acceptance takes a place in line rather than failing. */
export async function workTaskMerge(
  id: number,
  message: string | null,
  deleteWorktree: boolean,
  instructions: string | null = null
): Promise<boolean> {
  return getTransport().call("work_task_merge", {
    id,
    message,
    deleteWorktree,
    instructions,
  })
}

/** Accept a reviewed forge-sourced task by pushing it back: an issue's task
 *  publishes its branch and opens (or adopts) a pull request, a pull request's
 *  task pushes onto that pull request's own branch (where `title`/`draft` are
 *  ignored — nothing is created). Resolves with the pull request URL.
 *
 *  Unlike the merge dispatch this awaits the WHOLE operation — no agent runs,
 *  just a push and two REST calls — so a rejection is the real reason and the
 *  task is already back in review by the time it surfaces.
 *
 *  `deleteWorktree` takes the checkout along once the delivery lands — the
 *  same offer the merge and complete acceptances make. It rides on the
 *  delivery: a removal that fails leaves a retryable cleanup mark on the card
 *  and this call still resolves with the URL. */
export async function workTaskDeliverPr(
  id: number,
  prTitle: string | null,
  draft: boolean,
  deleteWorktree: boolean
): Promise<string> {
  return getTransport().call("work_task_deliver_pr", {
    id,
    prTitle,
    draft,
    deleteWorktree,
  })
}

/** Withdraw a merge waiting in the project's queue; the task stays in review. */
export async function workTaskMergeUnqueue(id: number): Promise<void> {
  return getTransport().call("work_task_merge_unqueue", { id })
}

/** Finish a reviewed task that has nothing to merge (review → done), taking
 *  its worktree with it when asked. Refused if the worktree changed after all. */
export async function workTaskComplete(
  id: number,
  deleteWorktree: boolean
): Promise<void> {
  return getTransport().call("work_task_complete", { id, deleteWorktree })
}

export async function workTaskArchive(
  id: number,
  archived: boolean
): Promise<void> {
  return getTransport().call("work_task_archive", { id, archived })
}

/** Remove the task's worktree + branch (also retries a failed cleanup). */
export async function workTaskCleanup(id: number): Promise<void> {
  return getTransport().call("work_task_cleanup", { id })
}

/** Unified diff of the worktree vs the task's recorded base. */
export async function workTaskDiff(
  id: number,
  file?: string | null
): Promise<string> {
  return getTransport().call("work_task_diff", { id, file: file ?? null })
}

export async function workTaskChangedFiles(
  id: number
): Promise<WorkTaskChangedFile[]> {
  return getTransport().call("work_task_changed_files", { id })
}

/** Effective settings after the folder → global → built-in fallback — what
 *  the engine will actually use for this folder. */
export async function workTaskSettingsEffective(
  folderId: number
): Promise<WorkTaskFolderSettings> {
  return getTransport().call("work_task_settings_effective", { folderId })
}

export async function workTaskSettingsGet(
  folderId: number
): Promise<WorkTaskFolderSettings> {
  return getTransport().call("work_task_settings_get", { folderId })
}

/** The folder's own settings row, or null when it follows the global
 *  defaults — how the settings dialog tells the two apart. */
export async function workTaskSettingsGetOwn(
  folderId: number
): Promise<WorkTaskFolderSettings | null> {
  return getTransport().call("work_task_settings_get_own", { folderId })
}

export async function workTaskSettingsSet(
  folderId: number,
  settings: WorkTaskFolderSettings
): Promise<void> {
  return getTransport().call("work_task_settings_set", { folderId, settings })
}

/** Drop the folder's own settings row — it reverts to the global defaults. */
export async function workTaskSettingsDelete(folderId: number): Promise<void> {
  return getTransport().call("work_task_settings_delete", { folderId })
}

export async function workTaskTemplateList(): Promise<WorkTaskTemplate[]> {
  return getTransport().call("work_task_template_list", {})
}

/** Upsert by exact name: an existing template of the same name is replaced. */
export async function workTaskTemplateSave(draft: {
  name: string
  title: string
  config: WorkTaskConfig
}): Promise<WorkTaskTemplate> {
  return getTransport().call("work_task_template_save", {
    draft: { ...draft, config: stripUploadedTaskConfig(draft.config) },
  })
}

export async function workTaskTemplateDelete(id: number): Promise<void> {
  return getTransport().call("work_task_template_delete", { id })
}

// Directory browser (for web/server mode)

export async function getHomeDirectory(): Promise<string> {
  return getTransport().call("get_home_directory")
}

export async function listDirectoryEntries(
  path: string
): Promise<DirectoryEntry[]> {
  return getTransport().call("list_directory_entries", { path })
}

export async function listDirectoryWithFiles(
  path: string
): Promise<DirectoryItem[]> {
  return getTransport().call("list_directory_with_files", { path })
}

// Hard ceiling for a single attachment, kept in lockstep with the server's
// `UPLOAD_MAX_BYTES` (`web/handlers/files.rs`, mirrored in
// `commands/remote_proxy.rs`). Sized to match the desktop drag-drop image
// limit (`DRAG_DROP_IMAGE_MAX_BYTES`) so the same screenshot attaches in
// every mode; oversize is rejected up front with a visible toast.
export const UPLOAD_MAX_BYTES = 20 * 1024 * 1024

// `btoa` only accepts a binary string, and `String.fromCharCode(...bytes)`
// hits the call-stack limit somewhere around a few hundred KB. Chunk the
// buffer so a 2 MB upload encodes without blowing the stack.
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let binary = ""
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize) as unknown as number[]
    binary += String.fromCharCode.apply(null, slice)
  }
  return btoa(binary)
}

// i18n_key values the Rust upload layer stamps via `with_i18n` and that
// the frontend branches on. MUST stay in lockstep with the Rust
// constants `UPLOAD_I18N_KEY_TOO_LARGE` / `UPLOAD_I18N_KEY_NOT_A_FILE`
// in `src-tauri/src/app_error.rs`. If either side renames the literal,
// the Rust unit test
// `commands::remote_proxy::tests::upload_i18n_keys_have_expected_values`
// fails — that's the CI tripwire keeping the two languages aligned.
export const UPLOAD_I18N_KEY_TOO_LARGE = "errors.upload.tooLarge"
export const UPLOAD_I18N_KEY_NOT_A_FILE = "errors.upload.notAFile"
export const UPLOAD_I18N_KEY_QUOTA_EXCEEDED = "errors.upload.quotaExceeded"

// Structured error thrown by the upload functions when an attachment
// would be empty (0 bytes). Callers should recognize it and silently
// skip — attaching a zero-byte ResourceLink would be a no-op for the
// agent and a confusing chip in the UI. Modeled as a real `Error`
// subclass so it carries a proper stack trace through async pipelines
// (a bare object literal would lose that), and so existing `instanceof
// Error` catch-rendering in the UI doesn't see an undefined `message`.
//
// The `code` field is preserved for the legacy duck-type check path —
// any callers still inspecting `.code === UPLOAD_ERROR_EMPTY` continue
// to work, but new code should rely on `isEmptyAttachmentError` or
// `instanceof EmptyAttachmentError`.
export const UPLOAD_ERROR_EMPTY = "attachment_empty"

export class EmptyAttachmentError extends Error {
  readonly code = UPLOAD_ERROR_EMPTY
  readonly fileName: string

  constructor(fileName: string) {
    super(`Empty file skipped: ${fileName}`)
    this.name = "EmptyAttachmentError"
    this.fileName = fileName
  }
}

export function isEmptyAttachmentError(err: unknown): boolean {
  if (err instanceof EmptyAttachmentError) return true
  // Tolerate the older bare-object shape so anything thrown through an
  // IPC boundary (which strips the class identity) still gets caught.
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === UPLOAD_ERROR_EMPTY
  )
}

// Upload a single attachment to the server.
//
// Web mode: streams the file via multipart/form-data to the same origin the
// page was served from. Desktop + remote workspace: routes through the Rust
// `remote_upload_attachment` command, because the webview's `fetch` can't
// hit a plain `http://` remote (mixed-content rules block secure-context
// requests). Returns the server-side absolute path so the caller can attach
// it as a `file://` ResourceLink — identical shape on both transports.
export async function uploadAttachment(
  file: File,
  sessionId?: string | null
): Promise<UploadAttachmentResult> {
  if (file.size === 0) {
    // Skip empty files at the entry — both the web and remote-desktop
    // transports would otherwise dutifully POST a zero-byte multipart part
    // (the server records it under `~/.codeg/uploads/<bucket>/...`), and
    // we'd attach a ResourceLink to an empty file. Throw the sentinel and
    // let the pool's catch block log + continue.
    throw new EmptyAttachmentError(file.name)
  }
  const remoteId = getActiveRemoteConnectionId()
  if (isDesktop() && remoteId !== null) {
    const buf = await file.arrayBuffer()
    // `getShellTransport()` resolves to the local Tauri transport even when
    // a `RemoteDesktopTransport` is configured — we deliberately want the
    // local IPC here, not the proxy, because `remote_upload_attachment`
    // lives on this desktop binary.
    return getShellTransport().call<UploadAttachmentResult>(
      "remote_upload_attachment",
      {
        connectionId: remoteId,
        fileName: file.name,
        mimeType: file.type || null,
        sessionId: sessionId ?? null,
        dataBase64: arrayBufferToBase64(buf),
      }
    )
  }

  const token = getCodegToken()
  const form = new FormData()
  form.append("file", file, file.name)
  if (sessionId) form.append("session_id", sessionId)

  const res = await fetch(`${window.location.origin}/api/upload_attachment`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  })
  if (res.status === 401) {
    notifyWebUnauthorized()
    throw new Error("Unauthorized")
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({
      code: "network_error",
      message: `HTTP ${res.status}`,
    }))
    throw err
  }
  return res.json()
}

// Upload a file picked from the desktop machine's filesystem to the remote
// codeg-server bound to the current window. The Tauri-native drag-drop event
// hands us OS paths (not `File` objects), so we read the bytes via Rust,
// then reuse the same `remote_upload_attachment` channel. Only callable from
// a window that has a remote workspace attached; non-remote callers should
// continue to use `appendResourceAttachments` with the local path directly.
export async function uploadLocalPathToRemote(
  path: string,
  sessionId?: string | null
): Promise<UploadAttachmentResult> {
  const remoteId = getActiveRemoteConnectionId()
  if (remoteId === null) {
    throw new Error(
      "uploadLocalPathToRemote requires an active remote workspace"
    )
  }
  const shell = getShellTransport()
  const file = await shell.call<{
    fileName: string
    mimeType: string | null
    size: number
    dataBase64: string
  }>("read_local_file_for_upload", { path })
  if (file.size === 0) {
    // Mirror the `uploadAttachment` empty-file guard. The Rust side
    // already read the bytes, so we've paid the cost — drop on the
    // floor here rather than send a zero-byte multipart upstream.
    throw new EmptyAttachmentError(file.fileName)
  }
  return shell.call<UploadAttachmentResult>("remote_upload_attachment", {
    connectionId: remoteId,
    fileName: file.fileName,
    mimeType: file.mimeType,
    sessionId: sessionId ?? null,
    dataBase64: file.dataBase64,
  })
}

// ─── Workspace file upload / download ───
//
// Issue #179: in server mode the user has no native file dialog, so the
// file-tree context menu offers explicit upload + download actions
// against these endpoints. The local desktop build (no remote) uses OS
// dialogs instead, so these helpers throw there. A remote-desktop
// window is a Tauri runtime but its file ops must target the remote
// host — it goes through the `remote_*_workspace_*` proxy commands.

export interface UploadWorkspaceFileResult {
  path: string
  name: string
  size: number
}

/**
 * Returns true when the current window can drive these helpers. Both
 * pure-web mode and remote-desktop mode qualify; only a local-desktop
 * Tauri window (no remote binding) is rejected, because it has its own
 * native file dialogs and these helpers would just be the wrong tool.
 */
export function isWorkspaceFileApiAvailable(): boolean {
  return !isDesktop() || isRemoteDesktopMode()
}

function assertWorkspaceFileApiAvailable(action: string): void {
  if (!isWorkspaceFileApiAvailable()) {
    throw new Error(
      `${action} is not available in local desktop mode; use the OS file dialogs instead.`
    )
  }
}

async function workspaceFileFetch(
  endpoint: string,
  body: BodyInit,
  isMultipart: boolean
): Promise<Response> {
  const token = getCodegToken()
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  }
  if (!isMultipart) {
    headers["Content-Type"] = "application/json"
  }
  const res = await fetch(`${window.location.origin}/api/${endpoint}`, {
    method: "POST",
    headers,
    body,
  })
  if (res.status === 401) {
    notifyWebUnauthorized()
    throw new Error("Unauthorized")
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({
      code: "network_error",
      message: `HTTP ${res.status}`,
    }))
    throw err
  }
  return res
}

export interface UploadWorkspaceFileArgs {
  rootPath: string
  targetPath: string
  file: File
  relativePath?: string | null
  signal?: AbortSignal
  /**
   * Byte-level progress callback fired on the request body as the
   * browser uploads it. `total` may equal 0 on streams where the size
   * is not pre-computable (rare for `File` objects but possible for
   * `Blob` slices) — callers should treat 0 as "unknown" rather than
   * "complete".
   */
  onProgress?: (loaded: number, total: number) => void
}

/**
 * Upload one workspace file. Two transports:
 *
 *   - **Web** — `XMLHttpRequest` direct to `/api/upload_workspace_file`,
 *     so we get byte-level upload progress and `AbortSignal` honoring.
 *   - **Remote desktop** — uses `uploadWorkspaceLocalPathsToRemote` with
 *     native file paths. Browser `File` objects are intentionally rejected
 *     there because Tauri IPC is not a streaming binary transport.
 *
 * Empty files are allowed: a workspace legitimately contains zero-byte
 * placeholders (`.gitkeep`, `__init__.py`). The chat-attachment uploader
 * still rejects them because feeding nothing to an LLM is meaningless,
 * but here we forward whatever the user picked.
 */
export async function uploadWorkspaceFile(
  args: UploadWorkspaceFileArgs
): Promise<UploadWorkspaceFileResult> {
  assertWorkspaceFileApiAvailable("uploadWorkspaceFile")

  if (isRemoteDesktopMode()) {
    throw new Error(
      "uploadWorkspaceFile requires browser File input; use uploadWorkspaceLocalPathsToRemote in remote desktop mode"
    )
  }

  return new Promise<UploadWorkspaceFileResult>((resolve, reject) => {
    const token = getCodegToken()
    const xhr = new XMLHttpRequest()
    xhr.open("POST", `${window.location.origin}/api/upload_workspace_file`)
    xhr.setRequestHeader("Authorization", `Bearer ${token}`)

    if (args.onProgress) {
      const onProgress = args.onProgress
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          onProgress(event.loaded, event.total)
        }
      }
    }

    xhr.onload = () => {
      if (xhr.status === 401) {
        notifyWebUnauthorized()
        reject(new Error("Unauthorized"))
        return
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        let err: unknown
        try {
          err = JSON.parse(xhr.responseText) as unknown
        } catch {
          err = {
            code: "network_error",
            message: `HTTP ${xhr.status}`,
          }
        }
        reject(err)
        return
      }
      try {
        resolve(JSON.parse(xhr.responseText) as UploadWorkspaceFileResult)
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    }
    xhr.onerror = () => reject(new Error("Network error during upload"))
    xhr.onabort = () => reject(new DOMException("Upload aborted", "AbortError"))

    // Wire the AbortSignal. The listener is removed on `loadend` so a
    // long-lived controller shared across many sequential uploads
    // doesn't leak listeners (the parent XHR will have been GC'd
    // anyway, but the listener kept a strong reference until then).
    if (args.signal) {
      if (args.signal.aborted) {
        xhr.abort()
        return
      }
      const signal = args.signal
      const onAbort = () => xhr.abort()
      signal.addEventListener("abort", onAbort, { once: true })
      xhr.addEventListener("loadend", () => {
        signal.removeEventListener("abort", onAbort)
      })
    }

    // Order matters: the backend reads text fields before the `file`
    // stream so it can resolve the destination before any bytes land.
    const form = new FormData()
    form.append("root_path", args.rootPath)
    form.append("target_path", args.targetPath)
    if (args.relativePath) {
      form.append("relative_path", args.relativePath)
    }
    form.append("file", args.file, args.file.name)
    xhr.send(form)
  })
}

export interface RemoteWorkspaceUploadPathEntry {
  localPath: string
  relativePath?: string | null
}

export interface RemoteWorkspaceUploadPathsResult {
  transferId: string
  files: UploadWorkspaceFileResult[]
  bytes: number
}

export async function uploadWorkspaceLocalPathsToRemote(args: {
  rootPath: string
  targetPath: string
  entries: RemoteWorkspaceUploadPathEntry[]
}): Promise<RemoteWorkspaceUploadPathsResult> {
  const connectionId = getActiveRemoteConnectionId()
  if (connectionId === null) {
    throw new Error(
      "uploadWorkspaceLocalPathsToRemote: no active remote connection"
    )
  }
  try {
    return await getShellTransport().call<RemoteWorkspaceUploadPathsResult>(
      "remote_upload_workspace_paths",
      {
        connectionId,
        rootPath: args.rootPath,
        targetPath: args.targetPath,
        entries: args.entries,
      }
    )
  } catch (err) {
    if (isRemoteAuthenticationFailed(err)) {
      notifyRemoteDesktopUnauthorized()
    }
    throw err
  }
}

export interface WorkspaceTransferProgress {
  transferId: string
  direction: "upload" | "download"
  loaded: number
  total: number | null
  state: "running" | "done" | "cancelled" | "error"
  path?: string | null
  error?: string | null
}

export async function listenWorkspaceTransferProgress(
  handler: (event: WorkspaceTransferProgress) => void
): Promise<() => void> {
  if (!isDesktop()) return () => {}
  const { listen } = await import("@tauri-apps/api/event")
  return listen<WorkspaceTransferProgress>(
    "workspace://transfer-progress",
    (event) => handler(event.payload)
  )
}

export async function cancelWorkspaceTransfer(
  transferId: string
): Promise<boolean> {
  return getShellTransport().call<boolean>("remote_cancel_workspace_transfer", {
    transferId,
  })
}

function isRemoteAuthenticationFailed(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "authentication_failed"
  )
}

export function isUploadAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError"
}

interface WorkspaceDownloadTicket {
  ticket: string
  url: string
  filename: string
  expiresAt: number
}

type WorkspaceDownloadKind = "file" | "dir"

function openBrowserDownloadUrl(url: string, filename: string): void {
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  anchor.rel = "noopener"
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

async function createWorkspaceDownloadTicket(args: {
  rootPath: string
  path: string
  kind: WorkspaceDownloadKind
}): Promise<WorkspaceDownloadTicket> {
  const res = await workspaceFileFetch(
    "workspace_download_ticket",
    JSON.stringify(args),
    false
  )
  return res.json()
}

/**
 * Sentinel return from a remote-desktop download path when the user
 * cancels the Tauri save dialog. Web mode never returns this — the
 * browser owns the download manager and there's no per-call cancel.
 */
export const WORKSPACE_DOWNLOAD_CANCELLED = "cancelled" as const

export type WorkspaceDownloadResult =
  | { status: "started" }
  | { status: "done"; savedPath?: string; bytes?: number; transferId?: string }
  | { status: typeof WORKSPACE_DOWNLOAD_CANCELLED }

export async function downloadWorkspaceFile(
  rootPath: string,
  path: string,
  fileName: string
): Promise<WorkspaceDownloadResult> {
  assertWorkspaceFileApiAvailable("downloadWorkspaceFile")

  if (isRemoteDesktopMode()) {
    return downloadWorkspaceViaRemoteProxy({
      endpoint: "remote_download_workspace_file",
      rootPath,
      path,
      suggestedName: fileName,
    })
  }

  const ticket = await createWorkspaceDownloadTicket({
    rootPath,
    path,
    kind: "file",
  })
  openBrowserDownloadUrl(ticket.url, ticket.filename || fileName)
  return { status: "started" }
}

export async function downloadWorkspaceDir(
  rootPath: string,
  path: string,
  dirName: string
): Promise<WorkspaceDownloadResult> {
  assertWorkspaceFileApiAvailable("downloadWorkspaceDir")

  if (isRemoteDesktopMode()) {
    return downloadWorkspaceViaRemoteProxy({
      endpoint: "remote_download_workspace_dir",
      rootPath,
      path,
      suggestedName: `${dirName}.zip`,
    })
  }

  const ticket = await createWorkspaceDownloadTicket({
    rootPath,
    path,
    kind: "dir",
  })
  openBrowserDownloadUrl(ticket.url, ticket.filename || `${dirName}.zip`)
  return { status: "started" }
}

async function downloadWorkspaceViaRemoteProxy(opts: {
  endpoint: "remote_download_workspace_file" | "remote_download_workspace_dir"
  rootPath: string
  path: string
  suggestedName: string
}): Promise<WorkspaceDownloadResult> {
  const connectionId = getActiveRemoteConnectionId()
  if (connectionId === null) {
    throw new Error(
      "downloadWorkspaceFile (remote): no active remote connection"
    )
  }
  const { save } = await import("@tauri-apps/plugin-dialog")
  const savePath = await save({ defaultPath: opts.suggestedName })
  if (!savePath) {
    return { status: WORKSPACE_DOWNLOAD_CANCELLED }
  }
  const { invoke } = await import("@tauri-apps/api/core")
  let result: { transferId: string; bytes: number }
  try {
    result = await invoke<{ transferId: string; bytes: number }>(
      opts.endpoint,
      {
        connectionId,
        rootPath: opts.rootPath,
        path: opts.path,
        savePath,
      }
    )
  } catch (err) {
    if (isRemoteAuthenticationFailed(err)) {
      notifyRemoteDesktopUnauthorized()
    }
    throw err
  }
  return {
    status: "done",
    savedPath: savePath,
    bytes: result.bytes,
    transferId: result.transferId,
  }
}

// File tree and git log commands

export async function getFileTree(
  path: string,
  maxDepth?: number
): Promise<FileTreeNode[]> {
  return getTransport().call("get_file_tree", {
    path,
    maxDepth: maxDepth ?? null,
  })
}

/**
 * Flat, gitignore-aware listing of every file/dir under `path`. Ignored
 * directories are pruned during the backend walk (no depth cap), so deeply
 * nested files are reachable while the payload stays small. Used by file search.
 */
export async function listWorkspaceFiles(
  path: string
): Promise<WorkspaceFileEntry[]> {
  return getTransport().call("list_workspace_files", { path })
}

export async function startWorkspaceStateStream(
  rootPath: string,
  wantsTreeGit = true
): Promise<WorkspaceSnapshotResponse> {
  return getTransport().call("start_workspace_state_stream", {
    rootPath,
    wantsTreeGit,
  })
}

export async function stopWorkspaceStateStream(
  rootPath: string,
  wantsTreeGit = true
): Promise<void> {
  return getTransport().call("stop_workspace_state_stream", {
    rootPath,
    wantsTreeGit,
  })
}

export async function getWorkspaceSnapshot(
  rootPath: string,
  sinceSeq?: number
): Promise<WorkspaceSnapshotResponse> {
  return getTransport().call("get_workspace_snapshot", {
    rootPath,
    sinceSeq: sinceSeq ?? null,
  })
}

export async function readFileBase64(
  path: string,
  maxBytes?: number
): Promise<string> {
  return getTransport().call("read_file_base64", {
    path,
    maxBytes: maxBytes ?? null,
  })
}

// Workspace-confined base64 read: `path` is relative to `rootPath` and is
// canonicalized server-side (resolving symlinks), so it can never read outside
// the workspace. Used by the HTML preview to inline local sub-resources safely.
export async function readWorkspaceFileBase64(
  rootPath: string,
  path: string,
  maxBytes?: number
): Promise<string> {
  return getTransport().call("read_workspace_file_base64", {
    rootPath,
    path,
    maxBytes: maxBytes ?? null,
  })
}

export async function readFilePreview(
  rootPath: string,
  path: string
): Promise<FilePreviewContent> {
  return getTransport().call("read_file_preview", { rootPath, path })
}

export async function readFileForEdit(
  rootPath: string,
  path: string
): Promise<FileEditContent> {
  return getTransport().call("read_file_for_edit", { rootPath, path })
}

export async function saveFileContent(
  rootPath: string,
  path: string,
  content: string,
  expectedEtag?: string | null
): Promise<FileSaveResult> {
  return getTransport().call("save_file_content", {
    rootPath,
    path,
    content,
    expectedEtag: expectedEtag ?? null,
  })
}

export async function saveFileCopy(
  rootPath: string,
  path: string,
  content: string
): Promise<FileSaveResult> {
  return getTransport().call("save_file_copy", {
    rootPath,
    path,
    content,
  })
}

export async function renameFileTreeEntry(
  rootPath: string,
  path: string,
  newName: string
): Promise<string> {
  return getTransport().call("rename_file_tree_entry", {
    rootPath,
    path,
    newName,
  })
}

/**
 * Move a file/directory into a different directory of the same workspace,
 * keeping its name. `sourcePath` and `destDir` are workspace-relative
 * (forward slashes); `destDir` is `""` for the workspace root. Resolves to the
 * moved entry's new workspace-relative path.
 */
export async function moveFileTreeEntry(
  rootPath: string,
  sourcePath: string,
  destDir: string
): Promise<string> {
  return getTransport().call("move_file_tree_entry", {
    rootPath,
    sourcePath,
    destDir,
  })
}

export async function deleteFileTreeEntry(
  rootPath: string,
  path: string
): Promise<void> {
  return getTransport().call("delete_file_tree_entry", { rootPath, path })
}

export async function createFileTreeEntry(
  rootPath: string,
  path: string,
  name: string,
  kind: "file" | "dir"
): Promise<string> {
  return getTransport().call("create_file_tree_entry", {
    rootPath,
    path,
    name,
    kind,
  })
}

export async function gitLog(
  path: string,
  limit?: number,
  branch?: string,
  remote?: string,
  skip?: number,
  author?: string,
  allBranches?: boolean,
  withFiles?: boolean
): Promise<GitLogResult> {
  return getTransport().call("git_log", {
    path,
    limit: limit ?? null,
    branch: branch ?? null,
    remote: remote ?? null,
    skip: skip ?? null,
    author: author ?? null,
    allBranches: allBranches ?? null,
    withFiles: withFiles ?? null,
  })
}

export async function gitCurrentUser(path: string): Promise<string | null> {
  return getTransport().call("git_current_user", { path })
}

export async function gitCommitFiles(
  path: string,
  commit: string
): Promise<GitLogFileChange[]> {
  return getTransport().call("git_commit_files", { path, commit })
}

// On-demand author search for the log filter — real repo authors matching
// `query` (case-insensitive, most-active first). Debounced client-side; no
// upfront full-repo scan.
export async function gitSearchAuthors(
  path: string,
  query: string,
  limit?: number
): Promise<string[]> {
  return getTransport().call("git_search_authors", {
    path,
    query,
    limit: limit ?? null,
  })
}

export async function gitCommitBranches(
  path: string,
  commit: string
): Promise<string[]> {
  return getTransport().call("git_commit_branches", { path, commit })
}

export async function gitReset(
  path: string,
  commit: string,
  mode: GitResetMode
): Promise<void> {
  return getTransport().call("git_reset", { path, commit, mode })
}

// Terminal commands

export async function terminalSpawn(
  workingDir: string,
  shell?: string,
  initialCommand?: string,
  terminalId?: string
): Promise<string> {
  return getTransport().call("terminal_spawn", {
    workingDir,
    shell: shell ?? null,
    initialCommand: initialCommand ?? null,
    terminalId: terminalId ?? null,
  })
}

export async function terminalWrite(
  terminalId: string,
  data: string
): Promise<void> {
  return getTransport().call("terminal_write", { terminalId, data })
}

export async function terminalResize(
  terminalId: string,
  cols: number,
  rows: number
): Promise<void> {
  return getTransport().call("terminal_resize", { terminalId, cols, rows })
}

/**
 * Recent output of an already-running terminal, for a viewer attaching to a
 * PTY it did not spawn (a canvas terminal card coming back from another
 * route). `alive: false` is the settled answer "nothing to attach to" — spawn
 * instead; it is never an error, so callers don't have to parse one.
 *
 * Subscribe to `terminal://output/<id>` BEFORE calling this, and drop the
 * events whose `seq` is at or below the returned `seq` — that overlap is
 * already in `data`. See `TerminalEvent.seq`.
 */
export async function terminalSnapshot(
  terminalId: string
): Promise<TerminalSnapshot> {
  return getTransport().call("terminal_snapshot", { terminalId })
}

export async function terminalKill(terminalId: string): Promise<void> {
  return getTransport().call("terminal_kill", { terminalId })
}

export async function terminalList(): Promise<TerminalInfo[]> {
  return getTransport().call("terminal_list")
}

// ── Web Server Management ──

export interface WebServerInfo {
  port: number
  token: string
  addresses: string[]
}

export async function startWebServer(params?: {
  port?: number
  host?: string
  token?: string | null
}): Promise<WebServerInfo> {
  return getTransport().call("start_web_server", {
    port: params?.port ?? null,
    host: params?.host ?? null,
    token: params?.token ?? null,
  })
}

export async function stopWebServer(): Promise<void> {
  return getTransport().call("stop_web_server")
}

export async function getWebServerStatus(): Promise<WebServerInfo | null> {
  return getTransport().call("get_web_server_status")
}

export interface WebServiceConfig {
  token: string | null
  port: number | null
  autoStart: boolean
}

export async function getWebServiceConfig(): Promise<WebServiceConfig> {
  return getTransport().call("get_web_service_config")
}

export async function updateWebServiceConfig(
  config: WebServiceConfig
): Promise<WebServiceConfig> {
  return getTransport().call("update_web_service_config", { config })
}

export type WebServicePortState = "free" | "occupied" | "unknown"

export interface WebServicePortProbe {
  port: number
  state: WebServicePortState
}

export async function probeWebServicePort(
  port?: number
): Promise<WebServicePortProbe> {
  return getTransport().call("probe_web_service_port", {
    port: port ?? null,
  })
}

// ─── Chat Channels ───

export async function listChatChannels(): Promise<ChatChannelInfo[]> {
  return getTransport().call("list_chat_channels")
}

export async function createChatChannel(params: {
  name: string
  channelType: string
  configJson: string
  enabled: boolean
  dailyReportEnabled: boolean
  dailyReportTime?: string | null
}): Promise<ChatChannelInfo> {
  return getTransport().call("create_chat_channel", {
    name: params.name,
    channelType: params.channelType,
    configJson: params.configJson,
    enabled: params.enabled,
    dailyReportEnabled: params.dailyReportEnabled,
    dailyReportTime: params.dailyReportTime ?? null,
  })
}

export async function updateChatChannel(params: {
  id: number
  name?: string | null
  enabled?: boolean | null
  configJson?: string | null
  eventFilterJson?: string | null
  dailyReportEnabled?: boolean | null
  dailyReportTime?: string | null
}): Promise<ChatChannelInfo> {
  return getTransport().call("update_chat_channel", {
    id: params.id,
    name: params.name ?? null,
    enabled: params.enabled ?? null,
    configJson: params.configJson ?? null,
    eventFilterJson: params.eventFilterJson ?? null,
    dailyReportEnabled: params.dailyReportEnabled ?? null,
    dailyReportTime: params.dailyReportTime ?? null,
  })
}

export async function deleteChatChannel(id: number): Promise<void> {
  return getTransport().call("delete_chat_channel", { id })
}

export async function saveChatChannelToken(
  channelId: number,
  token: string
): Promise<void> {
  return getTransport().call("save_chat_channel_token", { channelId, token })
}

export async function getChatChannelHasToken(
  channelId: number
): Promise<boolean> {
  return getTransport().call("get_chat_channel_has_token", { channelId })
}

export async function deleteChatChannelToken(channelId: number): Promise<void> {
  return getTransport().call("delete_chat_channel_token", { channelId })
}

export async function connectChatChannel(id: number): Promise<void> {
  return getTransport().call("connect_chat_channel", { id })
}

export async function disconnectChatChannel(id: number): Promise<void> {
  return getTransport().call("disconnect_chat_channel", { id })
}

export async function testChatChannel(id: number): Promise<void> {
  return getTransport().call("test_chat_channel", { id })
}

export async function getChatChannelStatus(): Promise<ChannelStatusInfo[]> {
  return getTransport().call("get_chat_channel_status")
}

export async function listChatChannelMessages(params: {
  channelId: number
  limit?: number
  offset?: number
}): Promise<ChatChannelMessageLog[]> {
  return getTransport().call("list_chat_channel_messages", {
    channelId: params.channelId,
    limit: params.limit ?? null,
    offset: params.offset ?? null,
  })
}

export async function getChatCommandPrefix(): Promise<string> {
  return getTransport().call("get_chat_command_prefix")
}

export async function setChatCommandPrefix(prefix: string): Promise<void> {
  return getTransport().call("set_chat_command_prefix", { prefix })
}

export async function getChatEventFilter(): Promise<string[] | null> {
  return getTransport().call("get_chat_event_filter")
}

export async function setChatEventFilter(
  filter: string[] | null
): Promise<void> {
  return getTransport().call("set_chat_event_filter", { filter })
}

export async function getChatEventWebhooks(): Promise<WebhookConfig[]> {
  return getTransport().call("get_chat_event_webhooks")
}

export async function setChatEventWebhooks(
  webhooks: WebhookConfig[]
): Promise<void> {
  return getTransport().call("set_chat_event_webhooks", { webhooks })
}

export async function getChatMessageLanguage(): Promise<string> {
  return getTransport().call("get_chat_message_language")
}

export async function setChatMessageLanguage(language: string): Promise<void> {
  return getTransport().call("set_chat_message_language", { language })
}

// ─── WeChat QR Code Auth ───

export async function weixinGetQrcode(): Promise<{
  qrcode_id: string
  qrcode_img_content: string
}> {
  return getTransport().call("weixin_get_qrcode")
}

export async function weixinCheckQrcode(
  channelId: number,
  qrcode: string
): Promise<{
  status: string
}> {
  return getTransport().call("weixin_check_qrcode", { channelId, qrcode })
}

// ---------------------------------------------------------------------------
// Model Providers
// ---------------------------------------------------------------------------

export async function listModelProviders(): Promise<ModelProviderInfo[]> {
  return getTransport().call("list_model_providers")
}

export async function createModelProvider(params: {
  name: string
  apiUrl: string
  apiKey: string
  agentType: string
  model?: string | null
}): Promise<ModelProviderInfo> {
  return getTransport().call("create_model_provider", {
    name: params.name,
    apiUrl: params.apiUrl,
    apiKey: params.apiKey,
    agentType: params.agentType,
    model: params.model ?? null,
  })
}

export async function updateModelProvider(params: {
  id: number
  name?: string | null
  apiUrl?: string | null
  apiKey?: string | null
  agentType?: string | null
  model?: string | null
}): Promise<UpdateModelProviderResult> {
  return getTransport().call("update_model_provider", {
    id: params.id,
    name: params.name ?? null,
    apiUrl: params.apiUrl ?? null,
    apiKey: params.apiKey ?? null,
    agentType: params.agentType ?? null,
    model: params.model ?? null,
  })
}

export async function deleteModelProvider(id: number): Promise<void> {
  return getTransport().call("delete_model_provider", { id })
}

// ─── Delegation settings ───────────────────────────────────────────────

export interface DelegationSettings {
  enabled: boolean
  depth_limit: number
  /** Per-parent byte budget (in MB) for the broker's in-memory cache of
   * completed sub-agent result text. `0` = unlimited. */
  completed_cache_max_mb: number
  /** Optional per-agent overrides applied when codeg-mcp spawns a subagent.
   * Keyed by `agent_type`. Missing entries mean "use agent defaults." */
  agent_defaults?: Partial<Record<AgentType, AgentDelegationDefaults>>
}

export async function getDelegationSettings(): Promise<DelegationSettings> {
  return getTransport().call("get_delegation_settings")
}

export async function setDelegationSettings(
  settings: DelegationSettings
): Promise<DelegationSettings> {
  return getTransport().call("set_delegation_settings", { settings })
}

// ─── codeg-mcp service status ──────────────────────────────────────────

/** Headline verdict from Rust `CodegMcpServiceState`. Ordered by which problem
 * to solve first: only `stopped` is repairable from this process. */
export type CodegMcpServiceState =
  | "stopped"
  | "unavailable"
  | "disabled"
  | "running"

/** One toggleable companion tool group, named by its `--features` slug. */
export interface CodegMcpToolGroup {
  key: string
  enabled: boolean
  /** The group this one lives inside, when it lives inside one
   * (`browser_eval` inside `browser`). Sent by the backend so the two
   * surfaces that render this list cannot disagree about which switch gates
   * which. Absent for a group proper. */
  requires?: string | null
}

/** Mirror of Rust `CodegMcpServiceStatus`. */
export interface CodegMcpServiceStatus {
  state: CodegMcpServiceState
  /** Whether the broker socket answered a liveness ping just now. */
  listening: boolean
  socket_path: string
  /** Resolved `codeg-mcp` path; `null` when the lookup came up empty. */
  binary_path: string | null
  tool_groups: CodegMcpToolGroup[]
  companion_count: number
  session_count: number
  active_delegations: number
  depth_limit: number
  /** Unix millis of the bind that produced the current accept loop. */
  started_at: number | null
  last_error: string | null
  /** False in runtimes that never bound a socket — hide the start button
   * rather than offer one that can only fail. */
  can_start: boolean
}

export async function getCodegMcpServiceStatus(): Promise<CodegMcpServiceStatus> {
  return getTransport().call("get_codeg_mcp_service_status")
}

/** Bind the broker socket if it isn't already answering. Idempotent. */
export async function startCodegMcpService(): Promise<void> {
  return getTransport().call("start_codeg_mcp_service")
}

/** Flip one tool group by the slug the status report uses. The backend
 * dispatches to that feature's own settings writer, so this is the same write
 * the settings window performs — sibling fields and change events included. */
export async function setCodegMcpToolGroup(
  key: string,
  enabled: boolean
): Promise<void> {
  return getTransport().call("set_codeg_mcp_tool_group", { key, enabled })
}

// ─── Live feedback settings + submit ───────────────────────────────────

/** Mirror of Rust `FeedbackSettings`. */
export interface FeedbackSettings {
  enabled: boolean
}

export async function getFeedbackSettings(): Promise<FeedbackSettings> {
  return getTransport().call("get_feedback_settings")
}

export async function setFeedbackSettings(
  settings: FeedbackSettings
): Promise<FeedbackSettings> {
  return getTransport().call("set_feedback_settings", { settings })
}

/**
 * Submit a live-feedback note to a running connection (the `check_user_feedback`
 * steering path). Returns the stored note (it also arrives via the
 * `feedback_submitted` event). Rejects when no turn is in flight — callers
 * detect that with `isNoActiveTurnRejection` and fall back to a normal prompt.
 *
 * `blocks` (optional) is the full prompt-block draft when the note carries
 * image attachments; `text` stays the recorded/display form. Blocks ride the
 * native `_session/steering` wire only — the backend rejects them on the pull
 * path (same `NoActiveTurn` fallback) so an attachment is never silently
 * dropped. Uploaded payloads are stripped to their `file://` markers in every
 * HTTP-body mode, exactly like `acpPrompt`; the backend re-hydrates them.
 */
export async function submitSessionFeedback(
  connectionId: string,
  text: string,
  blocks?: PromptInputBlock[] | null
): Promise<FeedbackItem> {
  return getTransport().call("submit_session_feedback", {
    connectionId,
    text,
    blocks:
      blocks && blocks.length > 0
        ? stripUploadedImagePayloads(
            blocks,
            !isDesktop() || getActiveRemoteConnectionId() !== null
          )
        : null,
  })
}

// ─── Ask-user-question settings ────────────────────────────────────────────

/** Mirror of Rust `QuestionSettings` (default ON). */
export interface QuestionSettings {
  enabled: boolean
}

export async function getQuestionSettings(): Promise<QuestionSettings> {
  return getTransport().call("get_question_settings")
}

export async function setQuestionSettings(
  settings: QuestionSettings
): Promise<QuestionSettings> {
  return getTransport().call("set_question_settings", { settings })
}

// ─── Get-session-info settings ─────────────────────────────────────────────

/** Mirror of Rust `SessionInfoSettings` (default ON). */
export interface SessionInfoSettings {
  enabled: boolean
}

export async function getSessionInfoSettings(): Promise<SessionInfoSettings> {
  return getTransport().call("get_session_info_settings")
}

export async function setSessionInfoSettings(
  settings: SessionInfoSettings
): Promise<SessionInfoSettings> {
  return getTransport().call("set_session_info_settings", { settings })
}

// ─── Built-in browser tools settings ───────────────────────────────────────

/** Mirror of Rust `BrowserToolsSettings` (default OFF). Whether agents get
 *  `browser_list_tabs` / `browser_snapshot` at all; which individual page they
 *  may read is a separate, per-tab decision made from the tab's own toolbar. */
export interface BrowserToolsSettings {
  enabled: boolean
  /** Whether `browser_eval` exists: an agent running its own code on a shared
   *  page. Off by default and separate from `enabled`, because everything else
   *  in the group is a named act a person sharing a tab can picture and this
   *  is not one of them. Never in force with `enabled` off — the backend drops
   *  it, so a stale `true` cannot outlive the switch above it. Even on, every
   *  individual snippet is shown to the person and approved on its own. */
  eval: boolean
}

export async function getBrowserToolsSettings(): Promise<BrowserToolsSettings> {
  return getTransport().call("get_browser_tools_settings")
}

export async function setBrowserToolsSettings(
  settings: BrowserToolsSettings
): Promise<BrowserToolsSettings> {
  return getTransport().call("set_browser_tools_settings", { settings })
}

// ─── Create-from-chat (chat authoring) settings ────────────────────────────

/** Mirror of Rust `ChatAuthoringSettings`. Both default OFF — these tools write
 * app state (and a scheduled automation goes on to spawn agents), so they are
 * opt-in rather than on like the read-only lookups. */
export interface ChatAuthoringSettings {
  automations_enabled: boolean
  work_tasks_enabled: boolean
}

export async function getChatAuthoringSettings(): Promise<ChatAuthoringSettings> {
  return getTransport().call("get_chat_authoring_settings")
}

export async function setChatAuthoringSettings(
  settings: ChatAuthoringSettings
): Promise<ChatAuthoringSettings> {
  return getTransport().call("set_chat_authoring_settings", { settings })
}

/** Live probe — opens a transient ACP connection to `agent_type`, reads what
 * it advertises (modes / config_options), and tears down. Used by the
 * delegation-settings UI so the option set on screen matches exactly what
 * codeg-mcp will receive when a subagent is spawned for delegation.
 *
 * Does NOT touch chat-side `selectorsCache` or `localStorage` preferences. */
export async function describeAgentOptions(
  agentType: AgentType,
  workingDir?: string | null
): Promise<AgentOptionsSnapshot> {
  // The backend probe has its own 60s timeout (`ConnectionManager::
  // probe_agent_options`) plus 500ms grace + poll/serialization
  // overhead. The default transport timeout of 60s would race with
  // that and surface "Request timed out" before the backend can
  // return `ProbeTimedOut`. 70s gives the backend a clean margin to
  // produce its structured error.
  return getTransport().call(
    "acp_describe_agent_options",
    {
      agentType,
      workingDir: workingDir ?? null,
    },
    { timeoutMs: 70_000 }
  )
}

// ───────────────────────────────────────────────────────────────────────────
// Backup & restore
// ───────────────────────────────────────────────────────────────────────────

export interface BackupManifestEntry {
  path: string
  size: number
  sha256: string
}

/** How badly one third-party SQLite store degraded during backup. */
export type SqliteDegradation =
  | "recoveredOnCopy"
  | "bareFileOnly"
  | "notArchived"

export interface DegradedSqlite {
  agent: string
  archivePath: string
  level: SqliteDegradation
}

export interface BackupManifest {
  formatVersion: number
  kind: string
  createdAt: string
  appVersion: string
  latestMigration: string
  runtime: string
  includesExternalTranscripts: boolean
  includesSecrets: boolean
  /** Which codeg-owned sections this archive claims to manage. */
  managedSections?: string[] | null
  /** Stores that could not be snapshotted cleanly. */
  degradedSqlite?: DegradedSqlite[]
  entries: BackupManifestEntry[]
}

export type BackupPhase =
  | "snapshotting"
  | "archiving"
  | "encrypting"
  | "decrypting"
  | "extracting"
  | "verifying"
  | "swapping"
  | "done"
  | "cancelled"
  | "error"

export interface BackupProgress {
  opId: string
  phase: BackupPhase
  processedBytes: number
  totalBytes: number | null
  currentPath?: string | null
  error?: string | null
}

export interface BackupPreview {
  encrypted: boolean
  needsPassphrase: boolean
  manifest?: BackupManifest | null
  compatible: boolean
  rejectReason?: string | null
}

/** Why an archive entry was refused outright (the live file was untouched). */
export type ExternalRefusalReason = "legacyUnprovableSqlitePair"

export interface RefusedExternal {
  archivePath: string
  targetPath: string
  reason: ExternalRefusalReason
}

export type ExternalDowngradeReason = "agentsRunning"

export interface ExternalDowngrade {
  reason: ExternalDowngradeReason
  agents: string[]
  path: string
}

export interface StagedRestore {
  stagingDir: string
  manifest: BackupManifest
  restoredExternalPath?: string | null
  skippedConflicts: string[]
  refusedExternal?: RefusedExternal[]
  /** Set when the requested external mode could not be honored. */
  externalDowngraded?: ExternalDowngrade | null
}

/** A pre-restore safety snapshot the user can inspect or roll back to. */
export interface SafetySnapshot {
  id: string
  path: string
  createdAt?: string | null
  sizeBytes: number
  rollbackSupported: boolean
}

/** Where (if anywhere) external agent transcripts are restored. */
export type ExternalRestoreMode =
  | { mode: "skip" }
  | { mode: "side_location" }
  | { mode: "original_locations"; on_conflict: "overwrite" | "skip_existing" }

export interface BackupExportOptions {
  includeExternalTranscripts: boolean
  passphrase?: string | null
}

/**
 * Subscribe to backup/restore progress. Works in both runtimes: the backend
 * emits through the unified event bridge (Tauri webview + WS broadcaster).
 */
export async function listenBackupProgress(
  handler: (event: BackupProgress) => void
): Promise<() => void> {
  return getTransport().subscribe<BackupProgress>("backup://progress", handler)
}

export async function cancelBackup(opId: string): Promise<boolean> {
  return getTransport().call<boolean>("backup_cancel", { opId })
}

/** Desktop export: native save dialog → write the archive to the chosen path. */
export async function exportBackupDesktop(
  opts: BackupExportOptions
): Promise<BackupManifest | null> {
  const { save } = await import("@tauri-apps/plugin-dialog")
  const encrypted = !!opts.passphrase
  const ext = encrypted ? "codegbak" : "codeg.zip"
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")
  const destPath = await save({
    defaultPath: `codeg-backup-${stamp}.${ext}`,
    filters: [{ name: "Codeg backup", extensions: [ext] }],
  })
  if (!destPath) return null
  return getTransport().call<BackupManifest>("backup_create", {
    options: {
      includeExternalTranscripts: opts.includeExternalTranscripts,
      passphrase: opts.passphrase ?? null,
    },
    destPath,
  })
}

// Backup create/inspect/stage can legitimately run far longer than the
// default 60s web transport timeout (large archives, encrypted decrypt,
// extract+verify). Use a very generous client bound so the UI doesn't abort
// while the backend is still working (and possibly committing a restore).
const BACKUP_LONG_CALL_TIMEOUT_MS = 60 * 60_000

export interface BackupTicketResult {
  url: string
  filename: string
  /** Stores that could not be snapshotted cleanly. The desktop path reads
   *  these off the returned manifest; the web path has no manifest, so the
   *  ticket carries them. */
  degradedSqlite: DegradedSqlite[]
}

/** Web export: build server-side, then trigger a browser download via ticket. */
export async function exportBackupWeb(
  opts: BackupExportOptions
): Promise<BackupTicketResult> {
  const ticket = await getTransport().call<BackupTicketResult>(
    "backup_create_ticket",
    {
      includeExternalTranscripts: opts.includeExternalTranscripts,
      passphrase: opts.passphrase ?? null,
    },
    { timeoutMs: BACKUP_LONG_CALL_TIMEOUT_MS }
  )
  const a = document.createElement("a")
  a.href = `${window.location.origin}${ticket.url}`
  a.download = ticket.filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  return ticket
}

/** Web restore step 1: upload the archive once; returns an opaque upload id. */
export async function uploadBackupWeb(
  file: File,
  onProgress?: (loaded: number, total: number) => void
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const token = getCodegToken()
    const xhr = new XMLHttpRequest()
    xhr.open("POST", `${window.location.origin}/api/backup_upload`)
    xhr.setRequestHeader("Authorization", `Bearer ${token}`)
    if (onProgress) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress(event.loaded, event.total)
      }
    }
    xhr.onload = () => {
      if (xhr.status === 401) {
        notifyWebUnauthorized()
        reject(new Error("Unauthorized"))
        return
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        let err: unknown
        try {
          err = JSON.parse(xhr.responseText) as unknown
        } catch {
          err = { code: "network_error", message: `HTTP ${xhr.status}` }
        }
        reject(err)
        return
      }
      try {
        const res = JSON.parse(xhr.responseText) as { uploadId: string }
        resolve(res.uploadId)
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    }
    xhr.onerror = () => reject(new Error("Network error during upload"))
    const form = new FormData()
    form.append("file", file, file.name)
    xhr.send(form)
  })
}

/**
 * A decrypted archive parked under the data dir, reused by the conflict scan
 * and by staging. `sourceId` is absent when the archive is encrypted and no
 * usable passphrase was given — prompt and prepare again.
 */
export interface PreparedBackupSource {
  sourceId?: string | null
  preview: BackupPreview
}

/** Restore step 1 (desktop: by path) — decrypt once, preview, get a handle. */
export async function prepareBackupSourceDesktop(
  srcPath: string,
  passphrase?: string | null
): Promise<PreparedBackupSource> {
  return getTransport().call<PreparedBackupSource>(
    "backup_prepare_source",
    { srcPath, passphrase: passphrase ?? null },
    { timeoutMs: BACKUP_LONG_CALL_TIMEOUT_MS }
  )
}

/** Restore step 1 (web: by upload id). */
export async function prepareBackupSourceWeb(
  uploadId: string,
  passphrase?: string | null
): Promise<PreparedBackupSource> {
  return getTransport().call<PreparedBackupSource>(
    "backup_prepare_source",
    { uploadId, passphrase: passphrase ?? null },
    { timeoutMs: BACKUP_LONG_CALL_TIMEOUT_MS }
  )
}

/**
 * Drop a prepared source. Safe to call on an already-released handle, and safe
 * to skip — an abandoned source is reaped on idle and at startup — but calling
 * it removes the decrypted archive immediately.
 */
export async function releaseBackupSource(sourceId: string): Promise<boolean> {
  return getTransport().call<boolean>("backup_release_source", { sourceId })
}

/** Stage a restore (desktop). Applied on next app start. */
export async function stageRestoreDesktop(args: {
  sourceId: string
  externalMode?: ExternalRestoreMode | null
}): Promise<StagedRestore> {
  return getTransport().call<StagedRestore>(
    "backup_restore_stage",
    {
      sourceId: args.sourceId,
      externalMode: args.externalMode ?? null,
    },
    { timeoutMs: BACKUP_LONG_CALL_TIMEOUT_MS }
  )
}

export interface StageRestoreWebResult {
  needsRestart: boolean
  restartDelayMs: number
  staged: StagedRestore
}

/** Stage a restore (web). Applied on next server start. */
export async function stageRestoreWeb(args: {
  sourceId: string
  externalMode?: ExternalRestoreMode | null
}): Promise<StageRestoreWebResult> {
  return getTransport().call<StageRestoreWebResult>(
    "backup_restore_stage",
    {
      sourceId: args.sourceId,
      externalMode: args.externalMode ?? null,
    },
    { timeoutMs: BACKUP_LONG_CALL_TIMEOUT_MS }
  )
}

export interface ExternalConflict {
  agent: string
  archivePath: string
  targetPath: string
  targetSize?: number | null
}

/** Scan a backup for external transcripts whose live target already exists. */
export async function scanExternalConflicts(
  sourceId: string
): Promise<ExternalConflict[]> {
  return getTransport().call<ExternalConflict[]>(
    "backup_scan_external_conflicts",
    { sourceId },
    { timeoutMs: BACKUP_LONG_CALL_TIMEOUT_MS }
  )
}

/**
 * Agents connected right now. Advisory only — the actual guarantee is a lock
 * the backend takes before it writes, which downgrades to the side location
 * rather than failing.
 */
export async function backupActiveAgents(): Promise<string[]> {
  return getTransport().call<string[]>("backup_active_agents", {})
}

/** Pre-restore safety snapshots still on disk, newest first. */
export async function listSafetySnapshots(): Promise<SafetySnapshot[]> {
  return getTransport().call<SafetySnapshot[]>(
    "backup_list_safety_snapshots",
    {}
  )
}

/** Stage a rollback to a safety snapshot; applied on the next start. */
export async function rollbackToSnapshot(snapshotId: string): Promise<unknown> {
  return getTransport().call("backup_rollback", { snapshotId })
}

/**
 * Discard a staged restore that was never applied. The escape hatch when the
 * restart after staging never happened and every retry hits `alreadyPending`.
 */
export async function discardPendingRestore(): Promise<boolean> {
  return getTransport().call<boolean>("backup_discard_pending", {})
}

// ── Forge workbench (Issues/PR) ────────────────────────────────────────────

/** The folder's `origin` remote parsed into forge coordinates, if any. */
export async function folderForgeRemote(
  folderId: number
): Promise<ForgeRemote | null> {
  return getTransport().call("folder_forge_remote", { folderId })
}

/** Everything the client gets to decide about a list request. The REPOSITORY
 *  is deliberately absent: the backend derives it from the folder's own remote,
 *  so there is nothing here to claim (see `commands/forge.rs`). */
export interface ForgeListQuery {
  tab: ForgeTab
  state?: "open" | "closed" | "all"
  assignedMe?: boolean
  /** Label names, ANDed by both forges. */
  labels?: string[]
  /** Free text over title and description. Treated as TEXT, not query syntax. */
  search?: string | null
  sort?: ForgeSort
  /** 1-based. Both forges paginate by offset; the backend clamps. */
  page?: number
  perPage?: number
  accountId?: string | null
}

export async function forgeListIssues(
  folderId: number,
  query: ForgeListQuery
): Promise<ForgeIssueList> {
  return getTransport().call("forge_list_issues", {
    folderId,
    query: {
      tab: query.tab,
      state: query.state ?? "open",
      assignedMe: query.assignedMe ?? false,
      labels: query.labels ?? [],
      search: query.search ?? null,
      sort: query.sort ?? "newest",
      page: query.page ?? 1,
      perPage: query.perPage ?? DEFAULT_FORGE_PAGE_SIZE,
      accountId: query.accountId ?? null,
    },
  })
}

/** Everything a COUNT may be narrowed by. No page and no order: neither can
 *  change the number, which is what lets the switcher survive a page turn
 *  without spending a request. */
export interface ForgeCountFilters {
  state?: "open" | "closed" | "all"
  assignedMe?: boolean
  labels?: string[]
  search?: string | null
  accountId?: string | null
}

/** One tab's count — a badge on the workbench's switcher — or null when the
 *  forge declines to count, the probe fails, or GitHub calls the search
 *  incomplete.
 *
 *  Ask only for the tab you are NOT showing. The visible tab's count already
 *  came back inside its own list response, and re-asking would make every
 *  filter change cost three search calls against a quota of thirty a MINUTE. */
export async function forgeTabCount(
  folderId: number,
  tab: ForgeTab,
  filters: ForgeCountFilters = {}
): Promise<number | null> {
  return getTransport().call("forge_tab_count", {
    folderId,
    tab,
    filters: {
      state: filters.state ?? "open",
      assignedMe: filters.assignedMe ?? false,
      labels: filters.labels ?? [],
      search: filters.search ?? null,
      accountId: filters.accountId ?? null,
    },
  })
}

/** The repository's labels, for the workbench's label filter. Its own call
 *  (and its own cache in the page): labels change far more slowly than the
 *  list, and on GitHub this runs on the core quota rather than search's
 *  30-per-minute one. */
export async function forgeListLabels(
  folderId: number,
  accountId?: string | null
): Promise<ForgeLabelList> {
  return getTransport().call("forge_list_labels", {
    folderId,
    accountId: accountId ?? null,
  })
}

/** Which item's discussion, and which page of it. As with `ForgeListQuery`,
 *  the repository is deliberately absent — the backend derives it from the
 *  folder's own remote. */
export interface ForgeCommentQuery {
  /** "issue" | "pr". Picks the COLLECTION on GitLab; GitHub serves both from
   *  its issue-comments endpoint. */
  kind: "issue" | "pr"
  /** The item's own number (`iid` on GitLab). */
  number: number
  /** 1-based; the backend clamps. */
  page?: number
  perPage?: number
  accountId?: string | null
}

/** One page of a work item's comments, oldest first.
 *
 *  Its own call rather than part of the list: a thread is one request per ITEM,
 *  and a list page holds thirty of them whose reader opens at most one. On
 *  GitHub it runs on the core quota (5000/hour) rather than search's
 *  30-per-minute one, so opening panel after panel cannot starve the list. */
export async function forgeListComments(
  folderId: number,
  query: ForgeCommentQuery
): Promise<ForgeCommentList> {
  return getTransport().call("forge_list_comments", {
    folderId,
    filters: {
      kind: query.kind,
      number: query.number,
      page: query.page ?? 1,
      perPage: query.perPage ?? DEFAULT_FORGE_COMMENT_PAGE_SIZE,
      accountId: query.accountId ?? null,
    },
  })
}

/**
 * Post one comment, and get back the comment as the FORGE stored it.
 *
 * The result is what the thread appends — not the text that was sent. They
 * differ in every field that matters: the id (the React key, and the handle
 * that de-duplicates it when the next page arrives), the author as the forge
 * resolved it from the token, the timestamp and the permalink.
 *
 * Never retried: a retried POST posts twice, and a thread other people read is
 * the wrong place to be approximately once.
 */
export async function forgeCreateComment(
  folderId: number,
  draft: {
    kind: "issue" | "pr"
    number: number
    body: string
    accountId?: string | null
  }
): Promise<ForgeComment> {
  return getTransport().call("forge_create_comment", {
    folderId,
    draft: {
      kind: draft.kind,
      number: draft.number,
      body: draft.body,
      accountId: draft.accountId ?? null,
    },
  })
}

/**
 * Close or reopen one item, and get back the row the forge now serves.
 *
 * The returned row is the point: flipping `state` locally would be a guess.
 * The item may have been closed in the browser a moment ago, a lock may have
 * refused the write, and on GitHub a pull request merged in between comes back
 * `merged` rather than `closed`.
 */
export async function forgeSetItemState(
  folderId: number,
  request: {
    kind: "issue" | "pr"
    number: number
    action: ForgeStateAction
    accountId?: string | null
  }
): Promise<ForgeIssueRow> {
  return getTransport().call("forge_set_item_state", {
    folderId,
    request: {
      kind: request.kind,
      number: request.number,
      action: request.action,
      accountId: request.accountId ?? null,
    },
  })
}

/** Open a new issue on the folder's repository. As everywhere else on this
 *  surface, the repository is derived from the folder's own remote — there is
 *  no field here to point this account's token at somewhere else. */
export async function forgeCreateIssue(
  folderId: number,
  draft: {
    title: string
    body?: string | null
    labels?: string[]
    accountId?: string | null
  }
): Promise<ForgeIssueRow> {
  return getTransport().call("forge_create_issue", {
    folderId,
    draft: {
      title: draft.title,
      body: draft.body ?? null,
      labels: draft.labels ?? [],
      accountId: draft.accountId ?? null,
    },
  })
}

/** One proposed change's branches, size, mergeability and CI. Asked only when
 *  the panel opens on a PULL REQUEST — a list page holds thirty rows whose
 *  reader opens at most one, so folding this into every row would spend its
 *  requests on rows nobody looks at. */
export async function forgeChangeDetail(
  folderId: number,
  number: number,
  accountId?: string | null
): Promise<ForgeChangeDetail> {
  return getTransport().call("forge_change_detail", {
    folderId,
    query: { number, accountId: accountId ?? null },
  })
}

/** One page of the files a proposed change touches. Paths and counters only —
 *  reading the diff itself is what the task worktree and the app's diff view
 *  are for. */
export async function forgeChangeFiles(
  folderId: number,
  query: {
    number: number
    page?: number
    perPage?: number
    accountId?: string | null
  }
): Promise<ForgeChangedFileList> {
  return getTransport().call("forge_change_files", {
    folderId,
    query: {
      number: query.number,
      page: query.page ?? 1,
      perPage: query.perPage ?? DEFAULT_FORGE_FILES_PAGE_SIZE,
      accountId: query.accountId ?? null,
    },
  })
}

/** Who a comment on this folder's repository would be posted as.
 *
 *  The panel cannot work this out: which stored account serves a folder is
 *  decided in the backend, from the origin remote's HOST and an optional
 *  pinned account, so reading "the default account" out of the settings list
 *  would name the wrong person on every folder that is not on it.
 *
 *  Local — it reads stored settings and sends nothing to the forge. */
export async function forgeIdentity(
  folderId: number,
  accountId?: string | null
): Promise<ForgeIdentity> {
  return getTransport().call("forge_identity", {
    folderId,
    accountId: accountId ?? null,
  })
}

/** Which merge methods the folder's repository permits.
 *
 *  A REPOSITORY fact, not a change's — which is why it is not a field on
 *  `forgeChangeDetail`: folding it in would spend a request on every change
 *  opened merely to read it. Asked once, when the panel is about to draw the
 *  merge button. */
export async function forgeMergeOptions(
  folderId: number,
  accountId?: string | null
): Promise<ForgeMergeOptions> {
  return getTransport().call("forge_merge_options", {
    folderId,
    accountId: accountId ?? null,
  })
}

/** Land one proposed change, and get back the row the forge now serves.
 *
 *  The returned row is the point, as it is for `forgeSetItemState`: GitHub has
 *  no merged STATE (a merged pull request reports `closed`, and only
 *  `merged_at` tells them apart), so a local guess would paint a change that
 *  just landed as one somebody abandoned.
 *
 *  `null` means IT MERGED AND THE ROW COULD NOT BE READ BACK — GitHub's merge
 *  response does not contain the pull request, so the row costs a second
 *  request that can fail on its own. It is emphatically not a failure: the
 *  change is on the base branch, and reporting one would invite somebody to run
 *  an irreversible operation twice.
 *
 *  `headSha` is the commit the caller was looking at. Both forges refuse with a
 *  409 when the branch has moved since, which is the point of sending it: the
 *  panel decided with a diff, a file list and a set of checks that all describe
 *  ONE commit. */
export async function forgeMergeChange(
  folderId: number,
  request: {
    number: number
    method: ForgeMergeMethod
    headSha?: string | null
    accountId?: string | null
  }
): Promise<ForgeIssueRow | null> {
  return getTransport().call("forge_merge_change", {
    folderId,
    request: {
      number: request.number,
      method: request.method,
      headSha: request.headSha ?? null,
      accountId: request.accountId ?? null,
    },
  })
}

/** Trigger a work task from an issue. Duplicate / folder-mismatch come back
 *  as discriminated outcomes for the dialog to act on, not as errors. */
export async function workTaskCreateFromForge(
  draft: ForgeTaskDraftInput
): Promise<ForgeCreateResult> {
  return getTransport().call("work_task_create_from_forge", { draft })
}

/** Latest task per source key (any state) — drives the row chips. */
export async function workTaskLookupBySource(
  sourceKeys: string[]
): Promise<ForgeTaskLink[]> {
  return getTransport().call("work_task_lookup_by_source", { sourceKeys })
}

/** The repository panel's preferences, every scope at once. Read once per page
 *  mount (and again after the settings dialog saves) rather than per trigger:
 *  the trigger dialog opens from a row click and must not wait on a round trip
 *  to draw. */
export async function forgeSettingsGet(): Promise<ForgeSettingsStore> {
  return getTransport().call("forge_settings_get", {})
}

/**
 * Save ONE scope and get back every scope as stored — trimmed, with blank
 * instructions dropped.
 *
 * `folderId = null` writes the global row. `settings = null` drops a folder's
 * own row so it follows the global one again, which is how "use global
 * defaults" saves (the global row itself cannot be dropped — there is nothing
 * behind it).
 */
export async function forgeSettingsSet(
  folderId: number | null,
  settings: ForgePanelSettings | null
): Promise<ForgeSettingsStore> {
  return getTransport().call("forge_settings_set", { folderId, settings })
}
