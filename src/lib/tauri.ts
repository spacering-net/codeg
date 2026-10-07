import { invoke } from "@tauri-apps/api/core"
import { getCurrentEffectiveAppLocale } from "./i18n"
import type {
  AgentType,
  ConversationSummary,
  ConversationDetail,
  DbConversationDetail,
  FolderInfo,
  AgentStats,
  SidebarData,
  ConnectionInfo,
  AcpAgentInfo,
  AcpAgentStatus,
  AgentSkillScope,
  AgentSkillLayout,
  AgentSkillItem,
  AgentSkillsListResult,
  AgentSkillContent,
  FolderHistoryEntry,
  FolderDetail,
  FolderGroupDetail,
  SidebarLayoutEntry,
  FolderLinkDetail,
  FolderLinkPlan,
  FolderLinkRequestItem,
  DbConversationSummary,
  ImportResult,
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
  PromptInputBlock,
  FileTreeNode,
  DirectoryEntry,
  FilePreviewContent,
  FileEditContent,
  FileSaveResult,
  WorkspaceSnapshotResponse,
  GitLogResult,
  AvailableTerminalShells,
  AppLocale,
  SystemLanguageSettings,
  SystemProxySettings,
  SystemRenderingSettings,
  SystemAutostartSettings,
  SystemTerminalSettings,
  GitCredentials,
  GitDetectResult,
  GitSettings,
  GitHubAccountsSettings,
  GitHubTokenValidation,
  McpAppType,
  LocalMcpScan,
  LocalMcpServer,
  McpMarketplaceProvider,
  McpMarketplaceItem,
  McpMarketplaceServerDetail,
} from "./types"

export async function listConversations(params?: {
  agent_type?: AgentType | null
  search?: string | null
  sort_by?: string | null
  folder_path?: string | null
}): Promise<ConversationSummary[]> {
  return invoke("list_conversations", {
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
  return invoke("get_conversation", { agentType, conversationId })
}

export async function listFolders(): Promise<FolderInfo[]> {
  return invoke("list_folders")
}

export async function getStats(): Promise<AgentStats> {
  return invoke("get_stats")
}

export async function getSidebarData(): Promise<SidebarData> {
  return invoke("get_sidebar_data")
}

// ACP commands

export async function acpConnect(
  agentType: AgentType,
  workingDir?: string,
  sessionId?: string
): Promise<string> {
  return invoke("acp_connect", {
    agentType,
    workingDir: workingDir ?? null,
    sessionId: sessionId ?? null,
  })
}

export async function acpPrompt(
  connectionId: string,
  blocks: PromptInputBlock[]
): Promise<void> {
  return invoke("acp_prompt", { connectionId, blocks })
}

export async function acpSetMode(
  connectionId: string,
  modeId: string
): Promise<void> {
  return invoke("acp_set_mode", { connectionId, modeId })
}

export async function acpSetConfigOption(
  connectionId: string,
  configId: string,
  valueId: string
): Promise<void> {
  return invoke("acp_set_config_option", { connectionId, configId, valueId })
}

export async function acpCancel(connectionId: string): Promise<void> {
  return invoke("acp_cancel", { connectionId })
}

export interface ForkResult {
  forkedSessionId: string
  originalSessionId: string
  siblingConversationId: number
}

export async function acpFork(connectionId: string): Promise<ForkResult> {
  return invoke("acp_fork", { connectionId })
}

export async function acpRespondPermission(
  connectionId: string,
  requestId: string,
  optionId: string
): Promise<void> {
  return invoke("acp_respond_permission", {
    connectionId,
    requestId,
    optionId,
  })
}

export async function acpDisconnect(connectionId: string): Promise<void> {
  return invoke("acp_disconnect", { connectionId })
}

export async function acpListConnections(): Promise<ConnectionInfo[]> {
  return invoke("acp_list_connections")
}

export async function acpListAgents(): Promise<AcpAgentInfo[]> {
  return invoke("acp_list_agents")
}

export async function acpGetAgentStatus(
  agentType: AgentType
): Promise<AcpAgentStatus> {
  return invoke("acp_get_agent_status", { agentType })
}

export async function acpClearBinaryCache(agentType: AgentType): Promise<void> {
  return invoke("acp_clear_binary_cache", { agentType })
}

export async function acpDownloadAgentBinary(
  agentType: AgentType,
  taskId: string,
  version?: string | null
): Promise<void> {
  return invoke("acp_download_agent_binary", {
    agentType,
    version: version ?? null,
    taskId,
  })
}

export async function acpInstallUvTool(taskId: string): Promise<void> {
  return invoke("acp_install_uv_tool", { taskId })
}

export async function acpDetectAgentLocalVersion(
  agentType: AgentType
): Promise<string | null> {
  return invoke("acp_detect_agent_local_version", { agentType })
}

export async function acpPrepareNpxAgent(
  agentType: AgentType,
  registryVersion: string | null | undefined,
  taskId: string,
  cleanFirst: boolean = false,
  version?: string | null
): Promise<string> {
  return invoke("acp_prepare_npx_agent", {
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
  return invoke("acp_uninstall_agent", { agentType, taskId })
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
): Promise<void> {
  return invoke("acp_update_agent_preferences", {
    agentType,
    enabled: params.enabled,
    env: params.env,
    configJson: params.config_json ?? null,
    opencodeAuthJson: params.opencode_auth_json ?? null,
    codexAuthJson: params.codex_auth_json ?? null,
    codexConfigToml: params.codex_config_toml ?? null,
  })
}

export async function acpReorderAgents(agentTypes: AgentType[]): Promise<void> {
  return invoke("acp_reorder_agents", { agentTypes })
}

export async function acpPreflight(
  agentType: AgentType,
  forceRefresh?: boolean
): Promise<PreflightResult> {
  return invoke("acp_preflight", {
    agentType,
    forceRefresh: forceRefresh ?? null,
  })
}

export async function acpListAgentSkills(params: {
  agentType: AgentType
  workspacePath?: string | null
}): Promise<AgentSkillsListResult> {
  return invoke("acp_list_agent_skills", {
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
  return invoke("acp_read_agent_skill", {
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
  return invoke("acp_save_agent_skill", {
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
  return invoke("acp_delete_agent_skill", {
    agentType: params.agentType,
    scope: params.scope,
    skillId: params.skillId,
    workspacePath: params.workspacePath ?? null,
  })
}

export async function getSystemProxySettings(): Promise<SystemProxySettings> {
  return invoke("get_system_proxy_settings")
}

export async function updateSystemProxySettings(
  settings: SystemProxySettings
): Promise<SystemProxySettings> {
  return invoke("update_system_proxy_settings", { settings })
}

export async function getSystemLanguageSettings(): Promise<SystemLanguageSettings> {
  return invoke("get_system_language_settings")
}

export async function updateSystemLanguageSettings(
  settings: SystemLanguageSettings
): Promise<SystemLanguageSettings> {
  return invoke("update_system_language_settings", { settings })
}

export async function setTrayLocale(locale: AppLocale): Promise<void> {
  return invoke("set_tray_locale", { locale })
}

export async function getSystemTerminalSettings(): Promise<SystemTerminalSettings> {
  return invoke("get_system_terminal_settings")
}

export async function updateSystemTerminalSettings(
  settings: SystemTerminalSettings
): Promise<SystemTerminalSettings> {
  return invoke("update_system_terminal_settings", { settings })
}

export async function getAvailableTerminalShells(): Promise<AvailableTerminalShells> {
  return invoke("get_available_terminal_shells")
}

export async function probeTerminalShellPath(path: string): Promise<boolean> {
  return invoke("probe_terminal_shell_path", { path })
}

export async function getSystemRenderingSettings(): Promise<SystemRenderingSettings> {
  return invoke("get_system_rendering_settings")
}

export async function updateSystemRenderingSettings(
  settings: SystemRenderingSettings
): Promise<SystemRenderingSettings> {
  return invoke("update_system_rendering_settings", { settings })
}

export async function getSystemAutostartSettings(): Promise<SystemAutostartSettings> {
  return invoke("get_system_autostart_settings")
}

export async function updateSystemAutostartSettings(
  settings: SystemAutostartSettings
): Promise<SystemAutostartSettings> {
  return invoke("update_system_autostart_settings", { settings })
}

// --- Version Control ---

export async function detectGit(): Promise<GitDetectResult> {
  return invoke("detect_git")
}

export async function testGitPath(path: string): Promise<GitDetectResult> {
  return invoke("test_git_path", { path })
}

export async function getGitSettings(): Promise<GitSettings> {
  return invoke("get_git_settings")
}

export async function updateGitSettings(
  settings: GitSettings
): Promise<GitSettings> {
  return invoke("update_git_settings", { settings })
}

export async function getGitHubAccounts(): Promise<GitHubAccountsSettings> {
  return invoke("get_github_accounts")
}

export async function validateGitHubToken(
  serverUrl: string,
  token: string
): Promise<GitHubTokenValidation> {
  return invoke("validate_github_token", { serverUrl, token })
}

export async function updateGitHubAccounts(
  settings: GitHubAccountsSettings
): Promise<GitHubAccountsSettings> {
  return invoke("update_github_accounts", { settings })
}

export async function saveAccountToken(
  accountId: string,
  token: string
): Promise<void> {
  return invoke("save_account_token", { accountId, token })
}

export async function getAccountToken(
  accountId: string
): Promise<string | null> {
  return invoke("get_account_token", { accountId })
}

export async function deleteAccountToken(accountId: string): Promise<void> {
  return invoke("delete_account_token", { accountId })
}

export async function mcpScanLocal(): Promise<LocalMcpScan> {
  return invoke("mcp_scan_local")
}

export async function mcpListMarketplaces(): Promise<McpMarketplaceProvider[]> {
  return invoke("mcp_list_marketplaces")
}

export async function mcpSearchMarketplace(params: {
  providerId: string
  query?: string | null
  limit?: number | null
}): Promise<McpMarketplaceItem[]> {
  return invoke("mcp_search_marketplace", {
    providerId: params.providerId,
    query: params.query ?? null,
    limit: params.limit ?? null,
  })
}

export async function mcpGetMarketplaceServerDetail(params: {
  providerId: string
  serverId: string
}): Promise<McpMarketplaceServerDetail> {
  return invoke("mcp_get_marketplace_server_detail", {
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
  return invoke("mcp_install_from_marketplace", {
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
  return invoke("mcp_upsert_local_server", {
    serverId: params.serverId,
    spec: params.spec,
    apps: params.apps,
  })
}

export async function mcpSetServerApps(
  serverId: string,
  apps: McpAppType[]
): Promise<LocalMcpServer | null> {
  return invoke("mcp_set_server_apps", { serverId, apps })
}

export async function mcpRemoveServer(
  serverId: string,
  apps?: McpAppType[] | null
): Promise<boolean> {
  return invoke("mcp_remove_server", {
    serverId,
    apps: apps ?? null,
  })
}

// Appearance / window chrome

export async function updateTrafficLightPosition(zoom: number): Promise<void> {
  return invoke("update_traffic_light_position", { zoom: zoom as number })
}

export async function updateAppearanceMode(mode: string): Promise<void> {
  return invoke("update_appearance_mode", { mode })
}

// Folder history commands

export async function loadFolderHistory(): Promise<FolderHistoryEntry[]> {
  return invoke("load_folder_history")
}

export async function getFolder(folderId: number): Promise<FolderDetail> {
  return invoke("get_folder", { folderId })
}

export async function listAllConversations(params?: {
  folder_ids?: number[] | null
  agent_type?: AgentType | null
  search?: string | null
  sort_by?: string | null
  status?: string | null
  include_children?: boolean | null
}): Promise<DbConversationSummary[]> {
  return invoke("list_all_conversations", {
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
  return invoke("list_child_conversations", {
    parentConversationId,
  })
}

export async function listOpenedTabs(): Promise<OpenedTabsSnapshot> {
  return invoke("list_opened_tabs")
}

export async function saveOpenedTabs(
  items: OpenedTab[],
  expectedVersion: number,
  origin: string
): Promise<SaveTabsOutcome> {
  return invoke("save_opened_tabs", { items, expectedVersion, origin })
}

export async function listOpenFolderDetails(): Promise<FolderDetail[]> {
  return invoke("list_open_folder_details")
}

export async function openFolderById(folderId: number): Promise<FolderDetail> {
  return invoke("open_folder_by_id", { folderId })
}

export async function removeFolderFromWorkspace(
  folderId: number
): Promise<void> {
  return invoke("remove_folder_from_workspace", { folderId })
}

export async function listFolderGroups(): Promise<FolderGroupDetail[]> {
  return invoke("list_folder_groups", {})
}

export async function createFolderGroup(
  name: string,
  color?: string
): Promise<FolderGroupDetail> {
  return invoke("create_folder_group", { name, color })
}

export async function updateFolderGroup(
  groupId: number,
  patch: { name?: string; color?: string }
): Promise<FolderGroupDetail> {
  return invoke("update_folder_group", { groupId, ...patch })
}

export async function deleteFolderGroup(groupId: number): Promise<void> {
  return invoke("delete_folder_group", { groupId })
}

export async function applySidebarLayout(
  entries: SidebarLayoutEntry[]
): Promise<void> {
  return invoke("apply_sidebar_layout", { entries })
}

export async function setFolderGroup(
  folderId: number,
  groupId: number | null
): Promise<void> {
  return invoke("set_folder_group", { folderId, groupId })
}

export async function importLocalConversations(
  folderId: number
): Promise<ImportResult> {
  return invoke("import_local_conversations", { folderId })
}

export async function getFolderConversation(
  conversationId: number,
  window?: { tailTurns?: number; fromIndex?: number }
): Promise<DbConversationDetail> {
  return invoke("get_folder_conversation", {
    conversationId,
    ...(window?.tailTurns != null ? { tailTurns: window.tailTurns } : {}),
    ...(window?.fromIndex != null ? { fromIndex: window.fromIndex } : {}),
  })
}

export async function removeFolderFromHistory(path: string): Promise<void> {
  return invoke("remove_folder_from_history", { path })
}

export async function createFolderDirectory(path: string): Promise<void> {
  return invoke("create_folder_directory", { path })
}

export async function cloneRepository(
  url: string,
  targetDir: string,
  credentials?: GitCredentials | null
): Promise<void> {
  return invoke("clone_repository", {
    url,
    targetDir,
    credentials: credentials ?? null,
  })
}

export async function getGitBranch(path: string): Promise<string | null> {
  return invoke("get_git_branch", { path })
}

export async function getGitHead(path: string): Promise<GitHeadInfo> {
  return invoke("get_git_head", { path })
}

export async function gitInit(path: string): Promise<void> {
  return invoke("git_init", { path })
}

export async function gitPull(
  path: string,
  credentials?: GitCredentials | null
): Promise<GitPullResult> {
  return invoke("git_pull", { path, credentials: credentials ?? null })
}

export async function gitStartPullMerge(
  path: string,
  upstreamCommit?: string | null
): Promise<void> {
  return invoke("git_start_pull_merge", { path, upstreamCommit })
}

export async function gitHasMergeHead(path: string): Promise<boolean> {
  return invoke("git_has_merge_head", { path })
}

export async function gitFetch(
  path: string,
  credentials?: GitCredentials | null
): Promise<string> {
  return invoke("git_fetch", { path, credentials: credentials ?? null })
}

export async function gitPushInfo(path: string): Promise<GitPushInfo> {
  return invoke("git_push_info", { path })
}

export async function gitPush(
  path: string,
  remote?: string | null,
  credentials?: GitCredentials | null
): Promise<GitPushResult> {
  return invoke("git_push", {
    path,
    remote: remote ?? null,
    credentials: credentials ?? null,
  })
}

export async function gitNewBranch(
  path: string,
  branchName: string,
  startPoint?: string
): Promise<void> {
  return invoke("git_new_branch", {
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
  return invoke("git_worktree_add", { path, branchName, worktreePath })
}

export async function gitCheckout(
  path: string,
  branchName: string
): Promise<void> {
  return invoke("git_checkout", { path, branchName })
}

export async function gitListBranches(path: string): Promise<string[]> {
  return invoke("git_list_branches", { path })
}

export async function gitListAllBranches(path: string): Promise<GitBranchList> {
  return invoke("git_list_all_branches", { path })
}

export async function gitMerge(
  path: string,
  branchName: string
): Promise<GitMergeResult> {
  return invoke("git_merge", { path, branchName })
}

export async function gitRebase(
  path: string,
  branchName: string
): Promise<GitRebaseResult> {
  return invoke("git_rebase", { path, branchName })
}

export async function gitListConflicts(path: string): Promise<string[]> {
  return invoke("git_list_conflicts", { path })
}

export async function gitConflictFileVersions(
  path: string,
  file: string
): Promise<GitConflictFileVersions> {
  return invoke("git_conflict_file_versions", { path, file })
}

export async function gitResolveConflict(
  path: string,
  file: string,
  content: string
): Promise<void> {
  return invoke("git_resolve_conflict", { path, file, content })
}

export async function gitAbortOperation(
  path: string,
  operation: string
): Promise<void> {
  return invoke("git_abort_operation", { path, operation })
}

export async function gitContinueOperation(
  path: string,
  operation: string
): Promise<void> {
  return invoke("git_continue_operation", { path, operation })
}

export async function openMergeWindow(
  folderId: number,
  operation: string,
  upstreamCommit?: string | null
): Promise<void> {
  return invoke("open_merge_window", {
    folderId,
    operation,
    upstreamCommit: upstreamCommit ?? null,
    locale: getCurrentEffectiveAppLocale(),
  })
}

export async function openStashWindow(folderId: number): Promise<void> {
  return invoke("open_stash_window", {
    folderId,
    locale: getCurrentEffectiveAppLocale(),
  })
}

export async function openPushWindow(folderId: number): Promise<void> {
  return invoke("open_push_window", {
    folderId,
    locale: getCurrentEffectiveAppLocale(),
  })
}

export async function gitStashPush(
  path: string,
  message?: string,
  keepIndex?: boolean
): Promise<string> {
  return invoke("git_stash_push", {
    path,
    message: message ?? null,
    keepIndex: keepIndex ?? false,
  })
}

export async function gitStashPop(
  path: string,
  stashRef?: string
): Promise<string> {
  return invoke("git_stash_pop", { path, stashRef: stashRef ?? null })
}

export async function gitStashList(path: string): Promise<GitStashEntry[]> {
  return invoke("git_stash_list", { path })
}

export async function gitStashApply(
  path: string,
  stashRef: string
): Promise<string> {
  return invoke("git_stash_apply", { path, stashRef })
}

export async function gitStashDrop(
  path: string,
  stashRef: string
): Promise<string> {
  return invoke("git_stash_drop", { path, stashRef })
}

export async function gitStashClear(path: string): Promise<string> {
  return invoke("git_stash_clear", { path })
}

export async function gitStashShow(
  path: string,
  stashRef: string
): Promise<GitStatusEntry[]> {
  return invoke("git_stash_show", { path, stashRef })
}

export async function gitListRemotes(path: string): Promise<GitRemote[]> {
  return invoke("git_list_remotes", { path })
}

export async function gitFetchRemote(
  path: string,
  name: string,
  credentials?: GitCredentials | null
): Promise<string> {
  return invoke("git_fetch_remote", {
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
  return invoke("git_add_remote", { path, name, url })
}

export async function gitRemoveRemote(
  path: string,
  name: string
): Promise<void> {
  return invoke("git_remove_remote", { path, name })
}

export async function gitSetRemoteUrl(
  path: string,
  name: string,
  url: string
): Promise<void> {
  return invoke("git_set_remote_url", { path, name, url })
}

export async function gitStatus(
  path: string,
  showAllUntracked?: boolean
): Promise<GitStatusEntry[]> {
  return invoke("git_status", {
    path,
    showAllUntracked: showAllUntracked ?? null,
  })
}

export async function gitDiff(path: string, file?: string): Promise<string> {
  return invoke("git_diff", { path, file: file ?? null })
}

export async function gitDiffWithBranch(
  path: string,
  branch: string,
  file?: string
): Promise<string> {
  return invoke("git_diff_with_branch", {
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
  return invoke("git_show_diff", { path, commit, file: file ?? null })
}

export async function gitShowFile(
  path: string,
  file: string,
  refName?: string
): Promise<string> {
  return invoke("git_show_file", {
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
  return invoke("git_show_file_base64", {
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
  return invoke("git_is_tracked", { path, file })
}

export async function gitCommit(
  path: string,
  message: string,
  files: string[]
): Promise<GitCommitResult> {
  return invoke("git_commit", { path, message, files })
}

export async function gitRollbackFile(
  path: string,
  file: string
): Promise<void> {
  return invoke("git_rollback_file", { path, file })
}

export async function gitAddFiles(
  path: string,
  files: string[]
): Promise<void> {
  return invoke("git_add_files", { path, files })
}

// Window management commands

// ─── Workspace folder links (multi-folder workspace) ───

export async function listFolderLinks(
  folderId: number
): Promise<FolderLinkDetail[]> {
  return invoke("list_folder_links", { folderId })
}

export async function previewFolderLinks(
  folderId: number,
  paths: string[]
): Promise<FolderLinkPlan[]> {
  return invoke("preview_folder_links", { folderId, paths })
}

export async function createFolderLinks(
  folderId: number,
  items: FolderLinkRequestItem[],
  gitExclude = true
): Promise<FolderLinkDetail[]> {
  return invoke("create_folder_links", { folderId, items, gitExclude })
}

export async function renameFolderLink(
  linkId: number,
  newName: string
): Promise<FolderLinkDetail> {
  return invoke("rename_folder_link", { linkId, newName })
}

export async function repairFolderLink(
  linkId: number
): Promise<FolderLinkDetail> {
  return invoke("repair_folder_link", { linkId })
}

export async function removeFolderLink(
  linkId: number,
  deleteLink = true
): Promise<void> {
  return invoke("remove_folder_link", { linkId, deleteLink })
}

export async function openFolder(path: string): Promise<FolderDetail> {
  return invoke("open_folder", { path })
}

export async function openCommitWindow(folderId: number): Promise<void> {
  return invoke("open_commit_window", {
    folderId,
    locale: getCurrentEffectiveAppLocale(),
  })
}

export type SettingsSection =
  | "general"
  | "appearance"
  | "agents"
  | "mcp"
  | "skills"
  | "shortcuts"
  | "system"

interface OpenSettingsWindowOptions {
  agentType?: AgentType | null
}

export async function openSettingsWindow(
  section?: SettingsSection,
  options?: OpenSettingsWindowOptions
): Promise<void> {
  return invoke("open_settings_window", {
    section: section ?? null,
    agentType: options?.agentType ?? null,
    locale: getCurrentEffectiveAppLocale(),
  })
}

// Conversation CRUD commands

export async function createConversation(
  folderId: number,
  agentType: AgentType,
  title?: string
): Promise<number> {
  return invoke("create_conversation", {
    folderId,
    agentType,
    title: title ?? null,
  })
}

export async function updateConversationStatus(
  conversationId: number,
  status: string
): Promise<void> {
  return invoke("update_conversation_status", { conversationId, status })
}

export async function updateConversationTitle(
  conversationId: number,
  title: string
): Promise<void> {
  return invoke("update_conversation_title", { conversationId, title })
}

export async function deleteConversation(
  conversationId: number
): Promise<void> {
  return invoke("delete_conversation", { conversationId })
}

// Folder command management

export async function listFolderCommands(
  folderId: number
): Promise<FolderCommand[]> {
  return invoke("list_folder_commands", { folderId })
}

export async function createFolderCommand(
  folderId: number,
  name: string,
  command: string
): Promise<FolderCommand> {
  return invoke("create_folder_command", { folderId, name, command })
}

export async function updateFolderCommand(
  id: number,
  name?: string,
  command?: string,
  sortOrder?: number
): Promise<FolderCommand> {
  return invoke("update_folder_command", {
    id,
    name: name ?? null,
    command: command ?? null,
    sortOrder: sortOrder ?? null,
  })
}

export async function deleteFolderCommand(id: number): Promise<void> {
  return invoke("delete_folder_command", { id })
}

export async function reorderFolderCommands(
  folderId: number,
  ids: number[]
): Promise<void> {
  return invoke("reorder_folder_commands", { folderId, ids })
}

export async function bootstrapFolderCommandsFromPackageJson(
  folderId: number,
  folderPath: string
): Promise<FolderCommand[]> {
  return invoke("bootstrap_folder_commands_from_package_json", {
    folderId,
    folderPath,
  })
}

// Directory browser

export async function getHomeDirectory(): Promise<string> {
  return invoke("get_home_directory")
}

export async function listDirectoryEntries(
  path: string
): Promise<DirectoryEntry[]> {
  return invoke("list_directory_entries", { path })
}

// File tree and git log commands

export async function getFileTree(
  path: string,
  maxDepth?: number
): Promise<FileTreeNode[]> {
  return invoke("get_file_tree", { path, maxDepth: maxDepth ?? null })
}

export async function startWorkspaceStateStream(
  rootPath: string
): Promise<WorkspaceSnapshotResponse> {
  return invoke("start_workspace_state_stream", { rootPath })
}

export async function stopWorkspaceStateStream(
  rootPath: string
): Promise<void> {
  return invoke("stop_workspace_state_stream", { rootPath })
}

export async function getWorkspaceSnapshot(
  rootPath: string,
  sinceSeq?: number
): Promise<WorkspaceSnapshotResponse> {
  return invoke("get_workspace_snapshot", {
    rootPath,
    sinceSeq: sinceSeq ?? null,
  })
}

export async function readFileBase64(
  path: string,
  maxBytes?: number
): Promise<string> {
  return invoke("read_file_base64", { path, maxBytes: maxBytes ?? null })
}

export async function readFilePreview(
  rootPath: string,
  path: string
): Promise<FilePreviewContent> {
  return invoke("read_file_preview", { rootPath, path })
}

export async function readFileForEdit(
  rootPath: string,
  path: string
): Promise<FileEditContent> {
  return invoke("read_file_for_edit", { rootPath, path })
}

export async function saveFileContent(
  rootPath: string,
  path: string,
  content: string,
  expectedEtag?: string | null
): Promise<FileSaveResult> {
  return invoke("save_file_content", {
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
  return invoke("save_file_copy", {
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
  return invoke("rename_file_tree_entry", { rootPath, path, newName })
}

export async function deleteFileTreeEntry(
  rootPath: string,
  path: string
): Promise<void> {
  return invoke("delete_file_tree_entry", { rootPath, path })
}

export async function createFileTreeEntry(
  rootPath: string,
  path: string,
  name: string,
  kind: "file" | "dir"
): Promise<string> {
  return invoke("create_file_tree_entry", { rootPath, path, name, kind })
}

export async function gitLog(
  path: string,
  limit?: number,
  branch?: string,
  remote?: string
): Promise<GitLogResult> {
  return invoke("git_log", {
    path,
    limit: limit ?? null,
    branch: branch ?? null,
    remote: remote ?? null,
  })
}

export async function gitCommitBranches(
  path: string,
  commit: string
): Promise<string[]> {
  return invoke("git_commit_branches", { path, commit })
}

export async function gitReset(
  path: string,
  commit: string,
  mode: GitResetMode
): Promise<void> {
  return invoke("git_reset", { path, commit, mode })
}

// Terminal commands

export async function terminalSpawn(
  workingDir: string,
  shell?: string,
  initialCommand?: string,
  terminalId?: string
): Promise<string> {
  return invoke("terminal_spawn", {
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
  return invoke("terminal_write", { terminalId, data })
}

export async function terminalResize(
  terminalId: string,
  cols: number,
  rows: number
): Promise<void> {
  return invoke("terminal_resize", { terminalId, cols, rows })
}

export async function terminalKill(terminalId: string): Promise<void> {
  return invoke("terminal_kill", { terminalId })
}

export async function terminalList(): Promise<TerminalInfo[]> {
  return invoke("terminal_list")
}
