/** The fifteen agents codeg ships hand-written support for. */
export type BuiltinAgentType =
  | "claude_code"
  | "codex"
  | "open_code"
  | "gemini"
  | "open_claw"
  | "cline"
  | "hermes"
  | "code_buddy"
  | "kimi_code"
  | "pi"
  | "grok"
  | "cursor"
  | "deepseek"
  | "qoder"
  | "antigravity"

/**
 * Which agent backs a conversation.
 *
 * Open-ended on purpose: besides the built-ins, a user can register any ACP
 * agent, which arrives as `custom:<registry-id>` (mirrors Rust's
 * `AgentType::Custom`). The `(string & {})` arm keeps editor autocomplete for
 * the built-ins while accepting those ids.
 *
 * Never index a `Record` with this directly — use `getAgentLabel` /
 * `getAgentColor`, which fall back for custom agents.
 */
export type AgentType = BuiltinAgentType | (string & {})

/** Wire prefix marking a custom (user-registered) ACP agent. */
export const CUSTOM_AGENT_PREFIX = "custom:"

/** True for a user-registered ACP agent. */
export function isCustomAgentType(agentType: AgentType): boolean {
  return agentType.startsWith(CUSTOM_AGENT_PREFIX)
}

/** The registry id behind `custom:<id>`, or `null` for a built-in. */
export function customAgentId(agentType: AgentType): string | null {
  return isCustomAgentType(agentType)
    ? agentType.slice(CUSTOM_AGENT_PREFIX.length)
    : null
}

export type AppErrorCode =
  | "invalid_input"
  | "configuration_missing"
  | "configuration_invalid"
  | "not_found"
  | "not_a_git_repository"
  | "already_exists"
  | "permission_denied"
  | "dependency_missing"
  | "network_error"
  | "authentication_failed"
  | "database_error"
  | "io_error"
  | "external_command_failed"
  | "window_operation_failed"
  | "task_execution_failed"
  | (string & {})

export interface AppCommandError {
  code: AppErrorCode
  message: string
  detail?: string | null
  /** Optional dotted i18n key used to render a localized message. */
  i18n_key?: string | null
  /** Optional named parameters substituted into the localized template. */
  i18n_params?: Record<string, string> | null
}

export interface RemoteWorkspaceHeader {
  name: string
  value: string
}

export interface RemoteWorkspaceConnection {
  id: number
  name: string
  base_url: string
  token: string
  headers: RemoteWorkspaceHeader[]
  sort_order: number
  created_at: string
  updated_at: string
}

export interface RemoteWorkspaceConnectionInput {
  name: string
  baseUrl: string
  token: string
  headers: RemoteWorkspaceHeader[]
}

export interface ConversationSummary {
  id: string
  agent_type: AgentType
  folder_path: string | null
  folder_name: string | null
  title: string | null
  started_at: string
  ended_at: string | null
  message_count: number
  model: string | null
  git_branch: string | null
}

export type MessageRole = "user" | "assistant" | "system" | "tool"

export interface AgentToolCall {
  tool_name: string
  input_preview?: string | null
  output_preview?: string | null
  is_error: boolean
}

export interface AgentExecutionStats {
  agent_type?: string | null
  status?: string | null
  total_duration_ms?: number | null
  total_tokens?: number | null
  total_tool_use_count?: number | null
  read_count?: number | null
  search_count?: number | null
  bash_count?: number | null
  edit_file_count?: number | null
  lines_added?: number | null
  lines_removed?: number | null
  other_tool_count?: number | null
  tool_calls?: AgentToolCall[]
  /** The child's own session id, when the sub-agent ran as a standalone session
   *  on disk instead of as chunks folded into the parent (Grok: every
   *  `spawn_subagent` child). Drives the Agent card's "open the sub-agent's
   *  session" action — `getConversation` resolves it even though the session is
   *  hidden from the sidebar. Absent for every other agent. */
  child_session_id?: string | null
}

/**
 * One entry of a live subagent transcript (LIVE-only — never persisted, never
 * emitted by the Rust parsers). Entries arrive pre-merged: the reducer/backend
 * split blocks only at kind/attribution boundaries, so consecutive same-kind
 * chunks of one subagent are a single growing entry.
 */
export interface AgentTranscriptEntry {
  type: "text" | "thinking"
  text: string
}

/**
 * Image payload shared across `ContentBlock::Image` /
 * `ContentBlock::ImageGeneration` / ACP wire `ToolCallImageInfo`. Mirror of
 * Rust `models::message::ImageData`.
 */
export interface ImageData {
  data: string
  mime_type: string
  uri?: string | null
}

export type ContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image"
      data: string
      mime_type: string
      uri?: string | null
    }
  | {
      /**
       * codex-acp v0.14+ image generation. Distinct from `image` because
       * codex-acp positions image generation as a first-class
       * `ToolCall(title="Image generation")` carrying revised_prompt + image.
       * Rendered with the dedicated `<GeneratedImagesBlock>` component, not
       * mixed with regular tool-call cards.
       *
       * Singular `image` (not array): codex-acp emits exactly one image per
       * `ToolCall`. Multi-image turns produce N separate ToolCalls. `null`
       * during the in-flight placeholder window between
       * `ImageGenerationBegin` and `ImageGenerationEnd`.
       *
       * `status` mirrors the underlying ToolCallStatus during live streaming
       * so the renderer can distinguish in-flight vs. failed when no image
       * arrives. Absent on Rust-emitted blocks (JSONL replay only emits
       * blocks with a present image, so absence is treated as success).
       */
      type: "image_generation"
      revised_prompt?: string | null
      image?: ImageData | null
      status?: ToolCallStatus | null
      /** Real tool/page name when this card is not Codex image generation. */
      label?: string | null
    }
  | {
      type: "tool_use"
      tool_use_id: string | null
      tool_name: string
      input_preview: string | null
      /**
       * ACP tool-call status when known. Live and promoted turns forward it
       * from `ToolCallInfo.status` in `buildStreamingTurnsFromLiveMessage`;
       * DB-persisted rows omit it (`undefined`). Lets the render layer tell a
       * still-unsettled orphan (interrupted/retried arg-less call promoted into
       * `localTurns`) from a completed no-op. See `dropEmptyInFlightToolCalls`.
       */
      status?: string | null
      /**
       * ACP extensibility metadata for this tool call. Opaque pass-through
       * — both the live snapshot (`ToolCallState.meta`) and the persisted
       * message-row variant carry the same shape. Delegation writes
       * `meta["codeg.delegation"] = { status, child_connection_id,
       * child_conversation_id, error_code? }` here.
       */
      meta?: Record<string, unknown> | null
    }
  | {
      type: "tool_result"
      tool_use_id: string | null
      output_preview: string | null
      is_error: boolean
      agent_stats?: AgentExecutionStats | null
      /**
       * Images returned in a tool result (e.g. Claude Code's `Read` of a
       * PNG/JPEG, or a multi-page PDF read returning one image per page).
       * Mirror of Rust `ContentBlock::ToolResult.images`. The adapter renders
       * these in-position as `generated-image` cards so the historical (JSONL
       * replay) path matches the live ACP stream — which surfaces the same
       * bytes via `ToolCallInfo.images` and an `image_generation` block.
       * Absent/empty for the common text-only tool result.
       */
      images?: ImageData[] | null
      /**
       * Frontend-only, LIVE-stream data (same doctrine as the `plan` block:
       * never persisted, never emitted by the Rust JSONL parsers). The
       * in-flight transcript of a Claude native subagent — text/thinking
       * chunks attributed to this Agent tool call via
       * `_meta.claudeCode.parentToolUseId` (claude-agent-acp ≥0.63) —
       * rendered inside the live Agent capsule. Detached at settle:
       * history shows the parsed `agent_stats` shape only.
       */
      agent_transcript?: AgentTranscriptEntry[] | null
    }
  | { type: "thinking"; text: string }
  /**
   * Frontend-only, LIVE-stream synthetic block. It is NEVER persisted and
   * NEVER emitted by the Rust JSONL parsers — the persisted plan path is a
   * `TodoWrite` tool_use block. It exists purely so a live plan can survive
   * `buildStreamingTurnsFromLiveMessage` → `adaptContentBlock` without being
   * down-converted into a `thinking`/reasoning block. Mirrors the reducer's
   * `LiveContentBlock` plan variant in `acp-connections-context.tsx` (NOT the
   * `kind`-tagged snapshot type lower in this file). Because it is live-only,
   * persistence/export switches over `ContentBlock` never receive it.
   */
  | { type: "plan"; entries: PlanEntryInfo[] }

export type TurnRole = "user" | "assistant" | "system"

export interface TurnUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
}

export interface SessionStats {
  total_usage: TurnUsage | null
  total_tokens?: number | null
  total_duration_ms: number
  context_window_used_tokens?: number | null
  context_window_max_tokens?: number | null
  context_window_usage_percent?: number | null
}

export interface MessageTurn {
  id: string
  role: TurnRole
  blocks: ContentBlock[]
  timestamp: string
  usage?: TurnUsage | null
  duration_ms?: number | null
  model?: string | null
  /** Wall-clock completion time (ISO). Each Rust parser sets this to its
   * own end-marker (e.g. OpenCode's `time.completed`, or just the event-log
   * `timestamp` for agents that log post-generation). Notably this is NOT
   * `timestamp + duration_ms` — those two fields encode unrelated spans in
   * most parsers. */
  completed_at?: string | null
}

export interface ConversationDetail {
  summary: ConversationSummary
  turns: MessageTurn[]
  session_stats?: SessionStats | null
  /**
   * Byte length of the source transcript this parse consumed (Claude only;
   * absent elsewhere). Retires background-overlay turns whose
   * `background_activity` watermark it has caught up to — see
   * `BackgroundOverlayEntry` in the conversation runtime store.
   */
  transcript_watermark?: number | null
}

export interface FolderInfo {
  path: string
  name: string
  agent_types: AgentType[]
  conversation_count: number
}

export interface AgentConversationCount {
  agent_type: AgentType
  conversation_count: number
}

export interface AgentStats {
  total_conversations: number
  total_messages: number
  by_agent: AgentConversationCount[]
}

export interface SidebarData {
  folders: FolderInfo[]
  stats: AgentStats
}

export interface FolderHistoryEntry {
  id: number
  path: string
  name: string
  last_opened_at: string
}

export interface FolderDetail {
  id: number
  name: string
  path: string
  git_branch: string | null
  default_agent_type: AgentType | null
  last_opened_at: string
  sort_order: number
  color: string
  /**
   * Root folder this one was created under (worktree folders only); null for
   * top-level folders. Flattened — a worktree of a worktree still points at the
   * original root. Drives the sidebar merge and worktree-branch detection.
   */
  parent_id: number | null
  /**
   * Folder classification. `chat` folders back folderless chat-mode
   * conversations: kept in `allFolders` so cwd / active-folder resolve, but
   * hidden from user-facing folder lists; their conversations route to the
   * sidebar "Chat" group and folder-bound chrome is hidden while one is active.
   */
  kind: FolderKind
  /**
   * User-supplied display alias, or null when unset. When present, the sidebar
   * folder header and conversation header render `alias [name]`
   * (see `formatFolderLabelWithAlias`). Display-only — never used for the
   * folder's real `path`/`id`.
   */
  alias: string | null
}

/**
 * Result of `createChatConversation`: the new conversation id plus the hidden
 * chat folder backing it, so the caller can drop the folder straight into
 * `allFolders` (resolving cwd / active-folder) without a refetch.
 */
export interface CreateChatConversationResult {
  conversationId: number
  folderId: number
  folder: FolderDetail
}

/**
 * Result of `createChatDir`: a freshly created chat-mode scratch directory
 * (filesystem only — no DB rows). Used to connect ACP at a real cwd the instant
 * "no-folder mode" is selected; the conversation is still created lazily on the
 * first send, reusing this path.
 */
export interface CreateChatDirResult {
  path: string
}

export interface OpenedTab {
  id: number
  folder_id: number
  conversation_id: number | null
  agent_type: AgentType
  position: number
  is_active: boolean
  is_pinned: boolean
}

export interface DbConversationSummary {
  id: number
  folder_id: number
  title: string | null
  /** True once the user renamed this conversation by hand; the backend then
   *  stops auto-deriving its title from the session file. */
  title_locked: boolean
  agent_type: AgentType
  status: string
  /** Mirrors `conversation.kind` — drives sidebar visibility and grouping. */
  kind: ConversationKind
  model: string | null
  git_branch: string | null
  external_id: string | null
  message_count: number
  /** Number of direct, non-deleted delegation children (computed by the backend
   *  `fill_child_counts` aggregate). `child_count > 0` means this conversation is
   *  expandable into its sub-session subtree — drives the sidebar chevron. */
  child_count: number
  created_at: string
  updated_at: string
  /** When the user pinned this conversation (ISO string), or null if not pinned.
   *  Drives the sidebar's "Pinned" section (sorted by this descending); a pinned
   *  conversation is shown there instead of in its folder group. */
  pinned_at: string | null
  parent_id?: number | null
  parent_tool_use_id?: string | null
  delegation_call_id?: string | null
  /** Set when the conversation was re-parented out of a removed worktree: the
   *  worktree path it originally ran in. Drives the "source worktree removed"
   *  badge. */
  origin_cwd?: string | null
}

/** Payload for the global `conversation://changed` side-channel that keeps
 *  every client's sidebar list/status in sync across desktop + browsers.
 *  Mirrors the Rust `ConversationChange` enum (serde `tag = "kind"`). */
export type ConversationChange =
  | { kind: "upsert"; summary: DbConversationSummary }
  | { kind: "deleted"; id: number }
  | { kind: "status"; id: number; status: string }

export const CONVERSATION_CHANGED_EVENT = "conversation://changed"

/** Payload for the global `folder://changed` side-channel. A folder created or
 *  updated headlessly — e.g. the automation engine minting a per-run worktree —
 *  reaches every client's workspace list so a conversation produced inside it can
 *  be grouped/rendered in the sidebar. `deleted` is its mirror image: a folder
 *  row that is gone for good (a work task's worktree, once removed from disk) is
 *  dropped from the list without waiting for a full refetch. Mirrors the Rust
 *  `FolderChange` enum (serde `tag = "kind"`). Distinct from
 *  `folder://open-in-workspace`, whose listener also opens + focuses a tab. */
export type FolderChange =
  | { kind: "upsert"; folder: FolderDetail }
  | { kind: "deleted"; id: number }

export const FOLDER_CHANGED_EVENT = "folder://changed"

/** Payload for `folder://links-changed`: a workspace folder's set of linked
 *  directories was created, renamed, repaired, or removed. Carries only the id
 *  — listeners re-fetch, so a dropped event self-heals on the next change.
 *  Mirrors the Rust `FolderLinksChanged`. */
export interface FolderLinksChanged {
  folder_id: number
}

export const FOLDER_LINKS_CHANGED_EVENT = "folder://links-changed"

/** Global side-channel announcing a live-feedback enable/disable (payload is
 *  `FeedbackSettings`). The settings UI runs in a separate window, so the
 *  conversation feedback bar converges on this backend broadcast rather than a
 *  frontend-only cache. Mirrors the Rust `FEEDBACK_SETTINGS_CHANGED_EVENT`. */
export const FEEDBACK_SETTINGS_CHANGED_EVENT = "feedback-settings://changed"

/** Payload for the global `tabs://changed` side-channel that keeps every
 *  client's open-tab set in sync across desktop + browsers. Mirrors the Rust
 *  `TabsChanged` struct. The full conversation-bound tab set is sent as a
 *  snapshot (idempotent apply); `is_active` marks the focused tab, which is
 *  mirrored across clients. `origin` is echoed so the originator ignores its
 *  own broadcast; the sentinel `"server"` marks cascade changes every client
 *  applies. */
export interface TabsChanged {
  version: number
  origin: string
  tabs: OpenedTab[]
}

export const TABS_CHANGED_EVENT = "tabs://changed"

/** Response of `list_opened_tabs`: the persisted set + current workspace tab
 *  version (clients seed their compare-and-set / echo logic from it). */
export interface OpenedTabsSnapshot {
  items: OpenedTab[]
  version: number
}

/** Response of the `save_opened_tabs` compare-and-set. When `accepted` is false
 *  the save was stale (another client won) and `tabs` is the current truth to
 *  reconcile against. */
export interface SaveTabsOutcome {
  accepted: boolean
  version: number
  tabs: OpenedTab[]
}

export interface ImportResult {
  imported: number
  updated: number
  skipped: number
}

/** Mirrors Rust `ScanSessionStatus` — how one locally-discovered session
 *  reconciles against the DB by `(external_id, agent_type)`. `deleted` means
 *  only soft-deleted rows exist; import never resurrects those. */
export type ScanSessionStatus = "new" | "imported" | "deleted"

/** Mirrors Rust `ScanSession`: one locally-discovered agent session in the
 *  import-picker scan. */
export interface ScanSession {
  external_id: string
  agent_type: AgentType
  title: string | null
  started_at: string
  ended_at: string | null
  message_count: number
  model: string | null
  git_branch: string | null
  status: ScanSessionStatus
}

/** Mirrors Rust `ScanFolder`: sessions sharing a normalize-matched cwd, plus
 *  how that path reconciles against the folder table. `exists_in_codeg: false`
 *  with a `folder_id` means the row is soft-deleted and import will reopen it. */
export interface ScanFolder {
  path: string
  name: string
  exists_in_codeg: boolean
  folder_id: number | null
  agent_types: AgentType[]
  sessions: ScanSession[]
}

/** Mirrors Rust `ScanResult` — response of `scan_importable_sessions`. */
export interface ScanResult {
  folders: ScanFolder[]
  /** Sessions with no cwd in their transcript — not importable, count only. */
  no_folder_count: number
  total_sessions: number
  importable_count: number
}

/** Mirrors Rust `SelectedSessionKey` (camelCase over the wire): identifies one
 *  scanned session for `import_selected_sessions`. */
export interface SelectedSessionKey {
  agentType: AgentType
  externalId: string
}

/** Mirrors Rust `ImportFolderOutcome`: per-folder tally of one batch import. */
export interface ImportFolderOutcome {
  path: string
  folder_id: number
  created: boolean
  imported: number
  updated: number
  skipped: number
}

/** Mirrors Rust `ImportSelectedResult` — response of
 *  `import_selected_sessions`. */
export interface ImportSelectedResult {
  imported: number
  updated: number
  skipped: number
  not_found: number
  failed: number
  created_folders: number
  folders: ImportFolderOutcome[]
  errors: string[]
}

/** Mirrors Rust `ImportScanProgress` — payload of the per-agent
 *  `import-scan://progress` broadcast while `scan_importable_sessions` walks
 *  the local session stores. */
export interface ImportScanProgress {
  agent_type: AgentType
  done: number
  total: number
  session_count: number
}

export const IMPORT_SCAN_PROGRESS_EVENT = "import-scan://progress"

/** Payload of the one-shot `conversations://bulk-changed` nudge a batch import
 *  broadcasts on completion. Clients respond with a single full conversation
 *  refetch (covers inserted rows and refreshed titles alike) instead of
 *  applying thousands of per-row upserts. */
export interface ConversationsBulkChanged {
  imported: number
  updated: number
  folder_ids: number[]
}

export const CONVERSATIONS_BULK_CHANGED_EVENT = "conversations://bulk-changed"

export interface DbConversationDetail {
  summary: DbConversationSummary
  turns: MessageTurn[]
  session_stats?: SessionStats | null
  /** See `ConversationDetail.transcript_watermark` (threaded through the DB
   *  fetch path from the same parser detail). */
  transcript_watermark?: number | null
  /**
   * Id of the persisted user turn the backend identified as the in-flight prompt
   * (present only while a turn is running on this conversation's connection). The
   * timeline uses it to locate — and, while the live reply is in hand, hide — the
   * partial assistant turn some agents (OpenCode, Gemini) persist after the prompt
   * mid-stream, which would otherwise double-render against the live reply.
   */
  in_flight_user_turn_id?: string | null
  /**
   * Turn-window metadata, present only when the request asked for a window
   * (`tailTurns`/`fromIndex`); their absence marks a legacy full response
   * (old server) and disables windowed merging. `turns` then holds
   * `full[turns_offset..]` while every other field still describes the full
   * transcript. See `src/lib/turn-window.ts` for the derivation helpers.
   */
  turns_offset?: number | null
  turns_total?: number | null
  /** Assistant turns in `full[0..turns_offset)` (baseline globalization). */
  assistant_turns_before_offset?: number | null
  /**
   * Structural fingerprint of `full[0..turns_offset)` as a fixed-width 16-hex
   * string (a raw u64 JSON number would be rounded past 2^53-1). Compared on
   * window refreshes to detect prefix rewrites (compaction), and used as the
   * seed for client-side chain extension.
   */
  prefix_hash?: string | null
  /**
   * Max timestamp across `full[0..turns_offset)`; absent when the window
   * covers the whole transcript. A background overlay turn may only be
   * retired by the watermark rule when its timestamp is STRICTLY greater
   * than this bound (its persisted twin is then provably inside the window).
   */
  uncovered_prefix_max_ts?: string | null
}

/** One page of older history for reverse infinite scroll:
 *  `full[turns_offset .. turns_offset + turns.length)`. */
export interface ConversationTurnsPage {
  turns: MessageTurn[]
  turns_offset: number
  turns_total: number
  assistant_turns_before_offset: number
  /** H(0..turns_offset) — adopted as the window fingerprint after a prepend. */
  prefix_hash: string
  /** H(0..min(beforeIndex, total)) — must equal the client's current window
   *  fingerprint for the page to legally join the loaded window. */
  prefix_hash_before_index: string
  uncovered_prefix_max_ts?: string | null
}

export type ConversationStatus =
  | "in_progress"
  | "pending_review"
  | "completed"
  | "cancelled"

/** Mirrors Rust `ConversationKind` (src-tauri/src/db/entities/conversation.rs).
 *  `loop` rows belong to the Loop Engineering workbench and never appear in
 *  the sidebar list; `delegate` rows nest under their parent's tool-call view. */
export type ConversationKind = "regular" | "chat" | "loop" | "delegate"

/** Mirrors Rust `FolderKind` (src-tauri/src/db/entities/folder.rs).
 *  `loop_worktree` is reserved for M2+ — add it here when the variant lands. */
export type FolderKind = "regular" | "chat"

export const STATUS_ORDER: ConversationStatus[] = [
  "in_progress",
  "pending_review",
  "completed",
  "cancelled",
]

export const STATUS_LABELS: Record<ConversationStatus, string> = {
  in_progress: "In Progress",
  pending_review: "Review",
  completed: "Completed",
  cancelled: "Cancelled",
}

export const STATUS_COLORS: Record<ConversationStatus, string> = {
  in_progress: "bg-yellow-400",
  pending_review: "bg-blue-500",
  completed: "bg-green-500",
  cancelled: "bg-red-500",
}

export const AGENT_DISPLAY_ORDER: BuiltinAgentType[] = [
  "codex",
  "claude_code",
  "open_code",
  "gemini",
  "open_claw",
  "cline",
  "hermes",
  "code_buddy",
  "kimi_code",
  "pi",
  "grok",
  "cursor",
  "deepseek",
  "qoder",
  "antigravity",
]

const AGENT_DISPLAY_ORDER_INDEX = new Map<AgentType, number>(
  AGENT_DISPLAY_ORDER.map((agent, index) => [agent, index])
)

/**
 * Sort built-ins into their curated order. Custom agents have no pinned
 * position, so they fall to the end and tie-break alphabetically among
 * themselves — a stable order that does not shuffle as agents are added.
 */
export function compareAgentType(a: AgentType, b: AgentType): number {
  const aIndex = AGENT_DISPLAY_ORDER_INDEX.get(a) ?? Number.MAX_SAFE_INTEGER
  const bIndex = AGENT_DISPLAY_ORDER_INDEX.get(b) ?? Number.MAX_SAFE_INTEGER
  if (aIndex !== bIndex) return aIndex - bIndex
  return a.localeCompare(b)
}

export const ALL_AGENT_TYPES: BuiltinAgentType[] = [
  "claude_code",
  "codex",
  "open_code",
  "gemini",
  "open_claw",
  "cline",
  "hermes",
  "code_buddy",
  "kimi_code",
  "pi",
  "grok",
  "cursor",
  "deepseek",
  "qoder",
  "antigravity",
]

export const MODEL_PROVIDER_AGENT_TYPES: BuiltinAgentType[] = [
  "claude_code",
  "codex",
  "gemini",
]

/**
 * How a Hermes provider's credentials are supplied:
 * - `apiKey`: codeg writes the key to `~/.hermes/.env`.
 * - `oauth`: set through the terminal `--setup` flow (no API-key field).
 * - `aws`: resolved from the AWS SDK credential chain (no API-key field).
 */
export type HermesProviderKind = "apiKey" | "oauth" | "aws"

/**
 * Curated Hermes providers the settings panel edits via structured fields.
 * Mirrors the backend `HERMES_PROVIDERS` table (commands/acp.rs), whose ids and
 * `.env` key vars come from Hermes' own `hermes_cli/auth.py` PROVIDER_REGISTRY.
 * The provider choice drives the linkage between the API key (~/.hermes/.env)
 * and the general config (~/.hermes/config.yaml `model.provider`/`base_url`).
 */
export interface HermesProviderOption {
  /** Canonical `model.provider` id written to config.yaml. */
  id: string
  /** Brand display name shown in the provider dropdown (not localized). */
  label: string
  /** Whether the provider takes a user-supplied base URL (OpenAI-compatible). */
  needsBaseUrl: boolean
  kind: HermesProviderKind
}

export const HERMES_PROVIDERS: HermesProviderOption[] = [
  // API-key providers — codeg writes the key var to ~/.hermes/.env.
  {
    id: "openrouter",
    label: "OpenRouter",
    needsBaseUrl: false,
    kind: "apiKey",
  },
  {
    id: "openai-api",
    label: "OpenAI / Compatible",
    needsBaseUrl: true,
    kind: "apiKey",
  },
  // Hermes' built-in `custom` provider: a user-supplied OpenAI-compatible
  // endpoint. Unlike `openai-api` (key in ~/.hermes/.env), `custom` stores its
  // key + endpoint INLINE in config.yaml (`model.api_key`/`model.base_url`);
  // the backend routes them there. Shows both API Key + API URL fields.
  {
    id: "custom",
    label: "Custom (OpenAI-compatible)",
    needsBaseUrl: true,
    kind: "apiKey",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    needsBaseUrl: false,
    kind: "apiKey",
  },
  {
    id: "gemini",
    label: "Google AI Studio",
    needsBaseUrl: false,
    kind: "apiKey",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    needsBaseUrl: false,
    kind: "apiKey",
  },
  {
    id: "xai",
    label: "xAI Grok",
    needsBaseUrl: false,
    kind: "apiKey",
  },
  {
    id: "zai",
    label: "Z.AI / GLM",
    needsBaseUrl: false,
    kind: "apiKey",
  },
  {
    id: "minimax",
    label: "MiniMax",
    needsBaseUrl: false,
    kind: "apiKey",
  },
  {
    id: "minimax-cn",
    label: "MiniMax (China)",
    needsBaseUrl: false,
    kind: "apiKey",
  },
  {
    id: "kimi-coding",
    label: "Kimi / Moonshot",
    needsBaseUrl: false,
    kind: "apiKey",
  },
  {
    id: "kimi-coding-cn",
    label: "Kimi / Moonshot (China)",
    needsBaseUrl: false,
    kind: "apiKey",
  },
  {
    id: "nvidia",
    label: "NVIDIA NIM",
    needsBaseUrl: false,
    kind: "apiKey",
  },
  {
    id: "alibaba",
    label: "Qwen (DashScope)",
    needsBaseUrl: false,
    kind: "apiKey",
  },
  {
    id: "alibaba-coding-plan",
    label: "Alibaba Coding Plan",
    needsBaseUrl: false,
    kind: "apiKey",
  },
  {
    id: "copilot",
    label: "GitHub Copilot",
    needsBaseUrl: false,
    kind: "apiKey",
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    needsBaseUrl: true,
    kind: "apiKey",
  },
  {
    id: "azure-foundry",
    label: "Azure Foundry",
    needsBaseUrl: true,
    kind: "apiKey",
  },
  {
    id: "stepfun",
    label: "StepFun",
    needsBaseUrl: false,
    kind: "apiKey",
  },
  {
    id: "arcee",
    label: "Arcee AI",
    needsBaseUrl: false,
    kind: "apiKey",
  },
  {
    id: "gmi",
    label: "GMI Cloud",
    needsBaseUrl: false,
    kind: "apiKey",
  },
  {
    id: "huggingface",
    label: "Hugging Face",
    needsBaseUrl: false,
    kind: "apiKey",
  },
  {
    id: "kilocode",
    label: "Kilo Code",
    needsBaseUrl: false,
    kind: "apiKey",
  },
  {
    id: "opencode-zen",
    label: "OpenCode Zen",
    needsBaseUrl: false,
    kind: "apiKey",
  },
  {
    id: "opencode-go",
    label: "OpenCode Go",
    needsBaseUrl: false,
    kind: "apiKey",
  },
  {
    id: "xiaomi",
    label: "Xiaomi MiMo",
    needsBaseUrl: false,
    kind: "apiKey",
  },
  {
    id: "tencent-tokenhub",
    label: "Tencent TokenHub",
    needsBaseUrl: false,
    kind: "apiKey",
  },
  {
    id: "ollama-cloud",
    label: "Ollama Cloud",
    needsBaseUrl: false,
    kind: "apiKey",
  },
  {
    id: "novita",
    label: "Novita AI",
    needsBaseUrl: false,
    kind: "apiKey",
  },
  // New in Hermes 0.20.0.
  {
    id: "ai-gateway",
    label: "Vercel AI Gateway",
    needsBaseUrl: false,
    kind: "apiKey",
  },
  // OAuth / external providers — credentials set via the terminal `--setup` flow.
  {
    id: "nous",
    label: "Nous Portal",
    needsBaseUrl: false,
    kind: "oauth",
  },
  {
    id: "openai-codex",
    label: "OpenAI Codex",
    needsBaseUrl: false,
    kind: "oauth",
  },
  {
    id: "minimax-oauth",
    label: "MiniMax",
    needsBaseUrl: false,
    kind: "oauth",
  },
  {
    id: "xai-oauth",
    label: "xAI Grok",
    needsBaseUrl: false,
    kind: "oauth",
  },
  {
    id: "qwen-oauth",
    label: "Qwen",
    needsBaseUrl: false,
    kind: "oauth",
  },
  {
    id: "google-gemini-cli",
    label: "Gemini CLI",
    needsBaseUrl: false,
    kind: "oauth",
  },
  {
    id: "copilot-acp",
    label: "GitHub Copilot ACP",
    needsBaseUrl: false,
    kind: "oauth",
  },
  // AWS Bedrock — credentials from the AWS SDK chain.
  {
    id: "bedrock",
    label: "AWS Bedrock",
    needsBaseUrl: false,
    kind: "aws",
  },
  // Google Vertex AI (Hermes 0.20.0) — service-account JSON / application-
  // default credentials, configured via the terminal `--setup` flow like the
  // other no-key providers, hence `oauth` (no API-key or base-URL field).
  {
    id: "vertex",
    label: "Google Vertex AI",
    needsBaseUrl: false,
    kind: "oauth",
  },
]

/**
 * Normalized Hermes config projection returned in `AcpAgentInfo.config_json`
 * for `agent_type === "hermes"` (parsed from ~/.hermes/.env + config.yaml).
 */
export interface HermesLocalConfig {
  provider?: string
  model?: string
  baseUrl?: string
  apiKey?: string
  hermesHome?: string
  setupCommand?: string
  modelCommand?: string
}

export const AGENT_LABELS: Record<BuiltinAgentType, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
  open_code: "OpenCode",
  gemini: "Gemini CLI",
  open_claw: "OpenClaw",
  cline: "Cline",
  hermes: "Hermes Agent",
  code_buddy: "CodeBuddy",
  kimi_code: "Kimi Code",
  pi: "Pi",
  grok: "Grok",
  cursor: "Cursor",
  deepseek: "DeepSeek Harness",
  qoder: "Qoder",
  antigravity: "Google Antigravity",
}

export const AGENT_COLORS: Record<BuiltinAgentType, string> = {
  claude_code: "bg-[#D97757]",
  codex: "bg-[#7A9DFF]",
  open_code: "bg-black",
  gemini: "bg-[#3186FF]",
  open_claw: "bg-emerald-600",
  cline: "bg-purple-500",
  hermes: "bg-amber-500",
  code_buddy: "bg-[#0052D9]",
  kimi_code: "bg-[#1783FF]",
  pi: "bg-[#0D9488]",
  grok: "bg-neutral-900",
  cursor: "bg-zinc-800",
  deepseek: "bg-[#4D6BFE]",
  qoder: "bg-[#6C4CF1]",
  antigravity: "bg-[#1A73E8]",
}

// ACP connection status (matches Rust ConnectionStatus)
export type ConnectionStatus =
  | "connecting"
  | "connected"
  | "prompting"
  | "disconnected"
  | "error"

export interface PromptCapabilitiesInfo {
  image: boolean
  audio: boolean
  embedded_context: boolean
}

export type PromptInputBlock =
  | { type: "text"; text: string }
  | {
      type: "image"
      data: string
      mime_type: string
      uri?: string | null
    }
  | {
      type: "resource"
      uri: string
      mime_type?: string | null
      text?: string | null
      blob?: string | null
    }
  | {
      type: "resource_link"
      uri: string
      name: string
      mime_type?: string | null
      description?: string | null
    }

export interface PromptDraft {
  blocks: PromptInputBlock[]
  displayText: string
}

// Permission option info from agent
export interface PermissionOptionInfo {
  option_id: string
  name: string
  kind: string
  /**
   * The option's ACP `_meta`, forwarded verbatim from the wire. codex-acp
   * ≥1.1.8 and claude-agent-acp ≥0.64.1 hang
   * `permission: {version: 1, changes: [...]}` here — see
   * `parsePermissionOptionChanges` in `lib/permission-request.ts`. Absent for
   * agents that send no option metadata.
   */
  meta?: Record<string, unknown> | null
}

// --- ask_user_question (mirror of Rust `crate::acp::question`) ---

/** One selectable choice in an `ask_user_question` (mirror of `QuestionOption`). */
export interface QuestionOption {
  label: string
  description: string
}

/** A single multiple-choice question (mirror of Rust `QuestionSpec`). `id` is
 *  the backend-minted correlation key the answer is submitted against. Empty
 *  `options` means free-text: the card renders only its "Other" input (codex
 *  elicitation / MCP-server forms ask open questions this way). `is_secret`
 *  masks that input (absent on the wire for non-secret sources). */
export interface QuestionSpec {
  id: string
  question: string
  header: string
  multi_select: boolean
  options: QuestionOption[]
  is_secret?: boolean
}

/** Awaiting-answer question set on the session (mirror of `PendingQuestionState`). */
export interface PendingQuestionState {
  question_id: string
  questions: QuestionSpec[]
  created_at: string
}

/** One question's answer submitted to `acp_answer_question`. `labels` carries
 *  the selected option labels plus any free-text "Other" the user typed. */
export interface QuestionAnswerItem {
  questionId: string
  labels: string[]
}

/** The full submission to `acp_answer_question`. `declined` is set when the
 *  user dismissed the card without choosing. */
export interface QuestionAnswer {
  answers: QuestionAnswerItem[]
  declined: boolean
}

// --- plan approval (mirror of Rust `crate::acp::plan_approval`) ---

/** Awaiting-decision Grok `exit_plan_mode` approval on the session (mirror of
 *  Rust `PendingPlanApprovalState`). The agent is blocked until the user acts. */
export interface PendingPlanApprovalState {
  approval_id: string
  tool_call_id: string
  plan_markdown: string
  created_at: string
}

/** Which action the user took on the plan-approval card (mirror of Rust
 *  `PlanApprovalDecision`). */
export type PlanApprovalDecision = "approve" | "request_changes" | "abandon"

/** The user's decision submitted to `acp_answer_plan_approval` (mirror of Rust
 *  `PlanApprovalAnswer`). `feedback` carries the freeform revision notes for a
 *  `request_changes` decision. */
export interface PlanApprovalAnswer {
  decision: PlanApprovalDecision
  feedback?: string | null
}

export interface SessionModeInfo {
  id: string
  name: string
  description?: string | null
}

export interface SessionModeStateInfo {
  current_mode_id: string
  available_modes: SessionModeInfo[]
}

export interface SessionConfigSelectOptionInfo {
  value: string
  name: string
  description?: string | null
}

export interface SessionConfigSelectGroupInfo {
  group: string
  name: string
  options: SessionConfigSelectOptionInfo[]
}

export interface SessionConfigSelectInfo {
  current_value: string
  options: SessionConfigSelectOptionInfo[]
  groups: SessionConfigSelectGroupInfo[]
}

/** An on/off toggle config option (ACP's unstable boolean config kind). Cline
 *  3.0.50+ ships one as `auto_approve` ("Auto-approve tools"). */
export interface SessionConfigBooleanInfo {
  current_value: boolean
}

export type SessionConfigKindInfo =
  | ({ type: "select" } & SessionConfigSelectInfo)
  | ({ type: "boolean" } & SessionConfigBooleanInfo)

export interface SessionConfigOptionInfo {
  id: string
  name: string
  description?: string | null
  category?: string | null
  kind: SessionConfigKindInfo
}

export interface AgentOptionsSnapshot {
  modes: SessionModeStateInfo | null
  config_options: SessionConfigOptionInfo[]
  /** Slash commands captured during the same transient probe as modes/config
   *  (empty when the agent advertises none in the probe window). */
  available_commands: AvailableCommandInfo[]
  /** What the agent accepts in a prompt, from the same probe. Lets a composer
   *  with no live session (the to-do task boxes) encode an attached image the
   *  way this agent takes it. Null when the agent advertised none. */
  prompt_capabilities?: PromptCapabilitiesInfo | null
}

export interface AgentDelegationDefaults {
  mode_id?: string | null
  config_values: Record<string, string>
}

// ─── Automations ───────────────────────────────────────────────────────────
// Mirrors src-tauri/src/models/automation.rs. Wire form is snake_case (serde
// default), matching AgentDelegationDefaults.

export type AutomationTriggerKind = "schedule" | "manual"
export type AutomationIsolation = "worktree_per_run" | "shared_in_root"
export type AutomationRunStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "skipped"

/** Display-only cache so the editor can render a value the live agent no longer
 *  offers (marked unavailable) instead of silently dropping it. */
export interface AutomationLabelSnapshot {
  agent_label?: string
  mode_label?: string
  config_labels?: Record<string, string>
  folder_label?: string
  branch_label?: string
}

/** What firing the automation does. Optional in stored configs — absent means
 *  the legacy `launch_session`. */
export type AutomationAction = "launch_session" | "enqueue_task"

/** The captured composer snapshot stored in `automation.config`. `mode_id` +
 *  `config_values` are exactly AgentDelegationDefaults; the model rides inside
 *  `config_values["model"]`, never as its own field. */
export interface AutomationConfig {
  action?: AutomationAction
  prompt_blocks: PromptInputBlock[]
  display_text: string
  mode_id?: string | null
  config_values: Record<string, string>
  label_snapshot?: AutomationLabelSnapshot | null
}

export interface Automation {
  id: number
  name: string
  enabled: boolean
  trigger_kind: AutomationTriggerKind
  cron: string | null
  timezone: string
  next_run_at: string | null
  agent_type: AgentType
  root_folder_id: number | null
  isolation: AutomationIsolation
  branch: string | null
  is_remote_branch: boolean
  // Serialized from an opaque JSON column; the backend falls back to `null`
  // when a stored blob fails to parse, so readers must guard against it.
  config: AutomationConfig | null
  last_run_at: string | null
  last_run_status: string | null
  last_run_conversation_id: number | null
  unseen_failures: number
  created_at: string
  updated_at: string
}

export interface AutomationRun {
  id: number
  automation_id: number
  status: AutomationRunStatus
  trigger: string
  scheduled_for: string | null
  started_at: string | null
  ended_at: string | null
  conversation_id: number | null
  worktree_folder_id: number | null
  stop_reason: string | null
  error: string | null
  summary: string | null
  created_at: string
}

/** Full create/update payload — the editor saves the whole automation wholesale. */
export interface AutomationDraft {
  name: string
  enabled: boolean
  trigger_kind: AutomationTriggerKind
  cron: string | null
  timezone: string
  agent_type: AgentType
  root_folder_id: number | null
  isolation: AutomationIsolation
  branch: string | null
  is_remote_branch: boolean
  config: AutomationConfig
}

// ─── Work tasks ────────────────────────────────────────────────────────────
// Mirrors src-tauri/src/models/work_task.rs. Wire form is snake_case like
// Automations. (Named WorkTask* because `Task` is taken by task-context.tsx.)

export type WorkTaskStatus =
  | "todo"
  | "queued"
  /** Out of the queue, setting up: worktree, init command, agent spawn. */
  | "preparing"
  | "running"
  | "awaiting_input"
  | "review"
  | "merging"
  | "done"
  | "failed"
  | "canceled"

/** The captured composer snapshot stored in `work_task.config`. Optional
 *  agent/mode/config fields are per-task overrides; empty = inherit the
 *  folder's task settings at launch. */
export interface WorkTaskConfig {
  prompt_blocks: PromptInputBlock[]
  display_text: string
  agent_type?: AgentType | null
  mode_id?: string | null
  config_values: Record<string, string>
  label_snapshot?: AutomationLabelSnapshot | null
}

export interface WorkTask {
  id: number
  folder_id: number
  title: string
  // Serialized from an opaque JSON column; guard against a null parse fallback.
  config: WorkTaskConfig | null
  status: WorkTaskStatus
  /** agent_error | setup_error | verdict_blocked | interrupted */
  failure_reason: string | null
  last_error: string | null
  run_seq: number
  sort_order: number
  worktree_folder_id: number | null
  /** A worktree is recorded but unusable — its folder row was removed or its
   *  directory is gone from disk. Merge cannot run; review offers "complete"
   *  instead. Absent = false (stamped by the list/get commands). */
  worktree_missing?: boolean
  /** The agent that runs — or ran — this task, resolved by the list/get
   *  commands the way the engine resolves it at launch (the conversation that
   *  actually ran, else the task's override, else the folder's task settings,
   *  else the folder default). Absent/null = nothing configured anywhere. */
  agent_type?: AgentType | null
  conversation_id: number | null
  /** Live ACP connection of the current generation; stale after a settle —
   *  gate on status before attaching. */
  connection_id: string | null
  base_branch: string | null
  base_sha: string | null
  work_branch: string | null
  /** null = nothing pending; "failed" = worktree cleanup failed (retryable). */
  cleanup_state: string | null
  verdict: string | null
  result_summary: string | null
  files_changed: number | null
  additions: number | null
  deletions: number | null
  merge_commit: string | null
  /** How a done task ended: 'merged' | 'delivered_pr' |
   *  'accepted_without_merge'. Absent on live tasks and on rows finished
   *  before the column existed. */
  completion_kind?: string | null
  /** Acceptance red/green light of the current review, if a preflight
   *  command ran. */
  preflight: WorkTaskPreflight | null
  /** The merge this reviewed task is waiting to run — the user clicked merge
   *  while another task of the same project was landing. Absent/null = not
   *  queued; the rank comes from ordering the folder's queued tasks by
   *  `queued_at`. */
  merge_queued?: WorkTaskQueuedMerge | null
  archived_at: string | null
  /** Planned start of a to-do task (ISO); null = no plan. Consumed the moment
   *  the task is claimed, by the scheduler or by hand. */
  scheduled_at: string | null
  /** Forge provenance ('forge_issue' | 'forge_pr'); absent = not forge-sourced. */
  source_kind?: string | null
  /** Canonical source key ({provider}:{host}:{owner_repo}:{kind}:{number}). */
  source_key?: string | null
  /** Source snapshot (url, title, numbers …); shape mirrors ForgeSourceMeta. */
  source_meta?: ForgeSourceMeta | null
  /** Latest agent_progress milestone — present on live (running/awaiting/merging) rows only. */
  latest_progress?: string | null
  created_at: string
  updated_at: string
  started_at: string | null
  settled_at: string | null
  finished_at: string | null
}

/** Provenance snapshot of a forge-triggered task (mirrors Rust ForgeSourceMeta). */
export interface ForgeSourceMeta {
  provider: ForgeProviderId
  server_host: string
  api_base: string
  account_id: string
  owner_repo: string
  number: number
  /** Canonical html URL, server-derived. */
  url: string
  /** Issue/PR title at trigger time. */
  title: string
  /** PR-only fields (absent on issues; filled by trigger-time hydration in M8). */
  base_ref?: string | null
  head_ref?: string | null
  head_sha?: string | null
  head_repo?: string | null
  /** URL of the PR created by the delivery acceptance path (P1). */
  result_pr?: string | null
  /** The trigger dialog's write-back answer, frozen at trigger time. Absent on
   *  rows minted before the choice lived here — those stay silent. */
  writeback?: boolean | null
}

export type ForgeTab = "issues" | "prs"

/** Normalized across both forges. `merged` only reaches a pull request row —
 *  GitHub reports merged ones as plain `closed`, so the backend derives it. */
export type ForgeItemState = "open" | "closed" | "merged"

/** How the workbench list is ordered (mirrors Rust ForgeSort). Four NAMED
 *  orders rather than a field/direction pair: the two forges spell their sort
 *  fields differently and accept different sets, so this is the intersection. */
export type ForgeSort =
  | "newest"
  | "oldest"
  | "recently_updated"
  | "least_recently_updated"

/** One label as the forge paints it (mirrors Rust ForgeLabel). */
export interface ForgeLabel {
  name: string
  /** `#rrggbb`, normalized from GitHub's bare digits and GitLab's hashed ones —
   *  or null when the forge sent something that is not hex (GitLab accepts CSS
   *  colour names on write). Null draws the neutral chip. */
  color: string | null
}

/** The repository's label vocabulary (mirrors Rust ForgeLabelList). */
export interface ForgeLabelList {
  labels: ForgeLabel[]
  /** The repository has more labels than one page holds — said out loud so a
   *  filter list that stops at 100 does not read as complete. */
  truncated: boolean
}

/** One row of the forge workbench list (mirrors Rust ForgeIssueRow). */
export interface ForgeIssueRow {
  number: number
  title: string
  /** Capped body from the list payload — the trigger snapshot's source. */
  body: string | null
  state: string
  /** Draft / work-in-progress pull request. Always false for issues. */
  draft: boolean
  labels: ForgeLabel[]
  author: string | null
  /** The author's picture, `http(s)` only — under the same rule (and from the
   *  same sanitizer) as `ForgeComment.author_avatar`. Rides along with the list
   *  row on both forges, so the panel's author avatar costs no request. */
  author_avatar: string | null
  updated_at: string | null
  html_url: string
  is_pr: boolean
  /** Human comments (GitHub `comments` / GitLab `user_notes_count`) — system
   *  timeline events are excluded by both, which is what makes it mean
   *  "there is a discussion here". */
  comments: number
}

/** One page of the workbench list (mirrors Rust ForgeIssueList). */
export interface ForgeIssueList {
  rows: ForgeIssueRow[]
  /** 1-based page actually served (already clamped by the backend). */
  page: number
  per_page: number
  /** Matching items, or null when the forge declines to count — GitLab omits
   *  its totals past 10k rows, and its locally-filtered closed-MR query would
   *  report a count that includes rows the user cannot see. Null means the UI
   *  must fall back to previous/next instead of page numbers. */
  total_count: number | null
  /** How many of those matches the forge will actually PAGE through, when that
   *  is fewer than `total_count`. GitHub Search serves only the first 1000
   *  results and answers 422 past them, so page NUMBERS come from this and the
   *  "N results" summary from `total_count`. Null means every match is
   *  reachable (always so on GitLab). */
  reachable_count: number | null
  has_next: boolean
  /** GitHub search timed out; this page is partial. */
  incomplete: boolean
}

/** Who a write against a folder goes out as (mirrors Rust ForgeIdentity).
 *
 *  Resolved by the backend from the origin remote's host and an optional
 *  pinned account — the panel has no way to work it out, and the default
 *  account would be the wrong answer on any folder that is not on it.
 *  Deliberately carries no token: it is derived from the value that holds one. */
export interface ForgeIdentity {
  username: string
  /** `http(s)` only, like every other avatar the panel renders. */
  avatar_url: string | null
}

/** One human comment on a work item (mirrors Rust ForgeComment).
 *
 *  "Human" is the selection rule the backend applies: GitHub's review comments
 *  live on another endpoint and GitLab's system events ("changed the
 *  milestone") are filtered out, so this thread is exactly the set
 *  `ForgeIssueRow.comments` counts. */
export interface ForgeComment {
  /** The forge's own id, stringified — a React key and the de-duplication
   *  handle across pages, never a number to do arithmetic with. */
  id: string
  author: string | null
  /** `http(s)` only; null when the forge sent nothing usable. */
  author_avatar: string | null
  body: string
  created_at: string | null
  /** Present only when the comment was EDITED — both forges stamp an
   *  `updated_at` on creation, and the backend drops the ones that merely
   *  repeat `created_at`. */
  updated_at: string | null
  html_url: string | null
}

/** One page of an item's discussion (mirrors Rust ForgeCommentList). No total:
 *  neither forge counts this collection cheaply, and the count the panel shows
 *  is `ForgeIssueRow.comments`, which the list already paid for. */
export interface ForgeCommentList {
  comments: ForgeComment[]
  page: number
  per_page: number
  /** Whether the FORGE has another page. Not "the page came back full": GitLab
   *  drops system notes after paginating, so a page can hold no comments at
   *  all and still have a discussion behind it. */
  has_next: boolean
}

/** What the panel's state button does to an item (mirrors Rust
 *  ForgeStateAction). Two VERBS rather than a target state — that is what
 *  GitLab's API takes and what a button means. Merging is deliberately absent:
 *  it is a different operation with its own preconditions, not a state. It has
 *  its own door — see `ForgeMergeMethod`. */
export type ForgeStateAction = "close" | "reopen"

/** How a change is joined to its base branch (mirrors Rust ForgeMergeMethod).
 *
 *  One vocabulary, two very different offers behind it. GitHub takes the method
 *  per merge and lets a repository forbid any of the three. GitLab takes no
 *  method at all — the PROJECT picks between a merge commit, a rebase-merge and
 *  a fast-forward — and the only thing a caller chooses is whether to squash,
 *  so `rebase` never reaches it. Which is why the menu is built from
 *  `ForgeMergeOptions` rather than from this union. */
export type ForgeMergeMethod = "merge" | "squash" | "rebase"

/** What `merge` actually DOES to the history (mirrors Rust
 *  ForgeMergeStrategy).
 *
 *  The method and the result are the same question on GitHub — `merge` writes a
 *  merge commit, full stop. On GitLab they are not: the project's own setting
 *  picks between a merge commit, a rebase-then-merge and a fast-forward, and
 *  the API offers no override. This is what stops the menu promising a merge
 *  commit to a fast-forward-only project. */
export type ForgeMergeStrategy =
  | "merge_commit"
  | "rebase_merge"
  | "fast_forward"

/** The merge methods one repository permits (mirrors Rust ForgeMergeOptions).
 *
 *  Asked for separately from `ForgeChangeDetail` and only when the panel is
 *  about to draw the button: it is a REPOSITORY fact, and folding it into the
 *  detail would spend a request on every change opened merely to read it. */
export interface ForgeMergeOptions {
  /** In the order to offer them. EMPTY means the forge would not say — a token
   *  that reads the change but not the repository's settings gets this — and
   *  the panel then offers `merge` alone rather than entries that can only
   *  fail. */
  methods: ForgeMergeMethod[]
  /** Which one starts selected. Always a member of `methods` when that is
   *  non-empty. */
  default_method: ForgeMergeMethod
  /** What `merge` will do here — see `ForgeMergeStrategy`. */
  merge_strategy: ForgeMergeStrategy
}

/** How a check ended up, in ONE vocabulary (mirrors Rust ForgeCheckState).
 *
 *  GitHub crosses `status` with `conclusion` and keeps a second legacy
 *  commit-status vocabulary; GitLab has its own eleven job statuses. All three
 *  are folded by the backend, so this switches on five values instead of
 *  eighteen. `neutral` is deliberately not `success`: a skipped required check
 *  is not a pass. */
export type ForgeCheckState =
  | "queued"
  | "running"
  | "success"
  | "failure"
  | "neutral"

/** One CI check on a change's head commit (mirrors Rust ForgeCheck). */
export interface ForgeCheck {
  id: string
  name: string
  state: ForgeCheckState
  /** One-line detail — GitHub's status description, GitLab's stage. */
  summary: string | null
  /** `http(s)` only; null when the forge sent nothing usable. */
  url: string | null
  /** A failure here does not block the change (GitLab's `allow_failure`;
   *  always false on GitHub, which has no per-check equivalent). */
  allow_failure: boolean
}

/** A change's checks, and how much of the answer arrived (mirrors Rust
 *  ForgeCheckList).
 *
 *  `available: false` is NOT "no checks ran" — it means the forge would not
 *  say (a token without `checks:read`, CI disabled). An empty list under
 *  `available: true` means nothing is configured. Collapsing the two prints
 *  "no checks" over a repository whose pipeline is red.
 *
 *  `partial` is the same distinction one level down: GitHub keeps its checks
 *  in TWO collections behind TWO fine-grained permissions, so a token granted
 *  only one of them gets a 403 from one endpoint and an empty list from the
 *  other. That half answer must not be drawn as a complete one. */
export interface ForgeCheckList {
  checks: ForgeCheck[]
  available: boolean
  /** Some checks could not be read; this list may be missing entries. Always
   *  false when `available` is false — there is no partial answer to qualify. */
  partial: boolean
}

/** What a proposed change is, beyond what its list row says (mirrors Rust
 *  ForgeChangeDetail).
 *
 *  Every counter is nullable because the two forges answer different halves:
 *  GitHub's pull object carries additions/deletions/changed_files/commits,
 *  GitLab's merge request carries none of them. A zero would claim the change
 *  touches nothing, so absent stays absent. */
export interface ForgeChangeDetail {
  number: number
  /** Where it would land. */
  base_ref: string
  /** What would land. */
  head_ref: string
  /** `owner/repo` of the head, present ONLY when it is a fork. */
  head_repo: string | null
  head_sha: string | null
  draft: boolean
  state: string
  /** Tri-state on BOTH forges: null is "the server has not worked it out yet"
   *  (GitHub computes it asynchronously, GitLab says `unchecked`), which is a
   *  different answer from false. */
  mergeable: boolean | null
  /** The forge's own word for the situation, for a tooltip — the two
   *  vocabularies do not line up and a translation would read as a diagnosis. */
  merge_state: string | null
  additions: number | null
  deletions: number | null
  changed_files: number | null
  commits: number | null
  checks: ForgeCheckList
}

/** How a file was touched (mirrors Rust ForgeFileStatus). */
export type ForgeFileStatus = "added" | "removed" | "modified" | "renamed"

/** One file a change touches (mirrors Rust ForgeChangedFile). */
export interface ForgeChangedFile {
  /** Path AFTER the change (the old one for a deletion). */
  path: string
  /** Where a rename came from; null otherwise. */
  previous_path: string | null
  status: ForgeFileStatus
  /** Null when the forge does not count — a binary file has no line counts on
   *  either forge. */
  additions: number | null
  deletions: number | null
  binary: boolean
  /** The file's own unified diff, as the forge shipped it with the page — it
   *  costs no extra request, the backend simply stopped discarding it.
   *
   *  Null means there is nothing to open onto, for either of two reasons: the
   *  content is binary, or the forge WITHHELD the diff (GitHub omits it past
   *  its own size limit while still reporting the line counts). Neither is an
   *  empty diff, which is why the row offers no reveal rather than a reveal
   *  onto nothing. */
  patch: string | null
}

/** One page of a change's file list (mirrors Rust ForgeChangedFileList). */
export interface ForgeChangedFileList {
  files: ForgeChangedFile[]
  page: number
  per_page: number
  /** From the forge's own pagination signal, never from the row count. */
  has_next: boolean
}

/** A folder's `origin` remote parsed into forge coordinates. */
export interface ForgeRemote {
  server_host: string
  owner_repo: string
  remote_url: string
  /** Which forge this host is — decided by the backend from the configured
   *  accounts and the hostname, never chosen here. */
  provider: ForgeProviderId
}

/** Latest task (any state) for a source key — the row chip's data. */
export interface ForgeTaskLink {
  source_key: string
  task_id: number
  status: WorkTaskStatus
  verdict: string | null
  updated_at: string
}

/** How the trigger dialog asks the work item to be handled. A template NAME
 *  the server resolves into its own instruction text — prompt text never
 *  crosses the wire. `fix`/`plan_first` are issue scenarios,
 *  `review_fix`/`review_only` are PR/MR scenarios.
 *
 *  Both issue templates confirm the reported problem is real before acting on
 *  it, which is why there is no "investigate only" entry: the server refuses
 *  that retired name rather than mapping it onto one of these. */
export type ForgeScenarioId =
  | "fix"
  | "plan_first"
  | "review_fix"
  | "review_only"

/** Trigger payload (client supplies coordinates + display snapshot only —
 *  the server derives everything trusted). */
export interface ForgeTaskDraftInput {
  folder_id: number
  source: {
    kind: "issue" | "pr"
    provider: ForgeProviderId
    server_host: string
    account_id?: string | null
    owner_repo: string
    number: number
  }
  snapshot: {
    title: string
    body?: string | null
    labels?: string[]
    author?: string | null
  }
  /** Absent/null = the kind's default (`fix` for issues, `review_fix` for
   *  proposed changes). */
  scenario?: ForgeScenarioId | null
  instruction?: string | null
  /** Comment the outcome back on this item once the task finishes — the
   *  trigger dialog's own box, recorded on the task and frozen at trigger
   *  time. Always sent explicitly by the dialog; ABSENT is read server-side as
   *  "silent", not as the dialog's default, because a request without it came
   *  from a client that never showed the question. */
  writeback?: boolean | null
  agent_type?: string | null
  force?: boolean
}

/** One scope's repository-panel preferences — mirrors
 *  `forge::settings::ForgePanelSettings`.
 *
 *  What lives here is the dimension this page adds on top of a folder's
 *  task-settings stage prompts: how you like an ISSUE handled, and what you
 *  always want said for a review as opposed to a fix. */
export interface ForgePanelSettings {
  /** Scenario the trigger dialog preselects for an issue; null = the built-in
   *  default. Consumed by the DIALOG — the request it then sends always names
   *  a scenario outright. */
  default_issue_scenario?: ForgeScenarioId | null
  /** Same, for a pull/merge request. */
  default_pr_scenario?: ForgeScenarioId | null
  /** What the trigger dialog's write-back switch starts as. Only the starting
   *  position: the switch is on screen every time, and what it says when the
   *  user presses Create is what the task records. */
  writeback_default: boolean
  /** Standing instructions appended after a scenario's built-in wording,
   *  keyed by scenario id plus the reserved `all` (every scenario). */
  scenario_prompts: Record<string, string>
}

/** Every scope of the panel's preferences — mirrors
 *  `forge::settings::ForgeSettingsStore`.
 *
 *  Scoped the same way task settings are: a global row plus optional per-folder
 *  overrides, and an override wins WHOLESALE rather than merging field by
 *  field. Sent as one value because the settings dialog shows one folder while
 *  saying whether that folder is following the global row, which takes both. */
export interface ForgeSettingsStore {
  global: ForgePanelSettings
  /** Keyed by folder id (JSON has no integer keys, so they arrive as strings).
   *  A folder with no entry follows `global` — absence IS the answer, so there
   *  is no separate "follows global" flag to keep in sync. */
  folders: Record<string, ForgePanelSettings>
}

/** Reserved `scenario_prompts` key applied to every scenario. */
export const FORGE_SCENARIO_PROMPT_ALL = "all"

/** Discriminated trigger outcome — duplicate/mismatch are answers, not errors. */
export type ForgeCreateResult =
  | { outcome: "created"; task: WorkTask }
  | { outcome: "duplicate"; existing: WorkTask }
  | { outcome: "folder_mismatch"; folder_remote: ForgeRemote | null }

/** A merge parked on a reviewed task while its project lands another one. */
export interface WorkTaskQueuedMerge {
  /** The commit message the user typed; null = the agent writes it. */
  message: string | null
  delete_worktree: boolean
  /** Extra directions for the merge agent, kept so a merge that waited its turn
   *  lands under what the user asked for when they queued it. */
  instructions?: string | null
  /** Place in line (ISO instant) — the order the engine's pump dispatches in. */
  queued_at: string
}

/** Result of the folder's preflight command for one review generation. */
export interface WorkTaskPreflight {
  status: "running" | "passed" | "failed"
  /** Display name of the folder command that ran. */
  command: string
  exit_code?: number | null
  /** Trailing combined output — present when the light is red. */
  output_tail?: string | null
}

/** One append-only timeline entry ("how the task advanced"). */
export interface WorkTaskEvent {
  id: number
  task_id: number
  kind: string
  actor: string
  payload: Record<string, unknown> | null
  created_at: string
}

export interface WorkTaskDraft {
  folder_id: number
  title: string
  config: WorkTaskConfig
}

/** A saved task blueprint (global; the folder is picked at creation time).
 *  Saving under an existing name replaces that template. */
export interface WorkTaskTemplate {
  id: number
  name: string
  title: string
  // Serialized from an opaque JSON column; guard against a null parse fallback.
  config: WorkTaskConfig | null
  created_at: string
  updated_at: string
}

/** Per-folder task defaults (work_task_settings.config). */
export interface WorkTaskFolderSettings {
  default_agent_type?: AgentType | null
  mode_id?: string | null
  config_values: Record<string, string>
  label_snapshot?: AutomationLabelSnapshot | null
  auto_process: boolean
  /** 0 = unlimited. */
  max_concurrent: number
  merge_strategy: "squash" | "merge"
  /** Land reviewed tasks automatically: when a task settles into review and is
   *  actually mergeable, the engine dispatches the same merge the button would
   *  (agent-written commit message, worktree per `delete_worktree_default`). */
  auto_merge: boolean
  delete_worktree_default: boolean
  /** Directory new task worktrees are created IN — each task still gets its
   *  own `<repo>-task-<id>` directory under it. Null/blank keeps them next to
   *  the project folder; `~` expands and a relative path resolves against the
   *  project folder. */
  worktree_root?: string | null
  /** folder_command id run in the worktree when a task settles into review
   *  (the acceptance red/green light); null = no preflight. */
  preflight_command_id?: number | null
  /** Free-form preflight shell line; wins over `preflight_command_id`. */
  preflight_command?: string | null
  /** Shell line run inside a freshly created worktree before the agent
   *  starts (deps install, env seeding). */
  init_command?: string | null
  /** Extra instructions appended after the built-in prompt of a launch stage.
   *  Keys are the engine's stage ids (`work` | `retry` | `return` | `merge`)
   *  plus the reserved `all`, which applies to every stage. */
  stage_prompts?: Record<string, string> | null
}

/** Changed file of a task worktree vs its recorded base. */
export interface WorkTaskChangedFile {
  file: string
  additions: number
  deletions: number
}

// --- Token usage dashboard (mirror of src-tauri/src/models/token_usage.rs) ---

export type TokenUsageBucket = "day" | "week" | "month"

export interface TokenUsageFilter {
  /** Inclusive lower bound, ISO-8601. Omit for "since the first recorded turn". */
  start?: string | null
  /** Exclusive upper bound, ISO-8601. Omit for "up to now". */
  end?: string | null
  /** Selected folders; each is expanded server-side to its worktree children. */
  folderIds?: number[] | null
  /** `conversation.agent_type` wire names. */
  agentTypes?: string[] | null
  models?: string[] | null
  bucket: TokenUsageBucket
  /** `-new Date().getTimezoneOffset()` — all buckets are local-time buckets. */
  tzOffsetMinutes: number
  /** Also compute the equally-long window before `start`, for delta chips. */
  comparePrevious?: boolean
}

export interface TokenUsageTotals {
  input_tokens: number
  output_tokens: number
  cache_creation_tokens: number
  cache_read_tokens: number
  total_tokens: number
  turn_count: number
  conversation_count: number
  /** Summed generation time of the counted turns, not time spent in the app. */
  duration_ms: number
  active_days: number
}

export interface TokenUsagePoint {
  /** `YYYY-MM-DD` (day/week) or `YYYY-MM` (month), in the viewer's local time. */
  bucket_key: string
  start: string
  end: string
  input_tokens: number
  output_tokens: number
  cache_creation_tokens: number
  cache_read_tokens: number
  total_tokens: number
  turn_count: number
  conversation_count: number
}

export interface TokenUsageBreakdownItem {
  /** Folder id as a string, agent wire name, or model name. */
  key: string
  label: string
  input_tokens: number
  output_tokens: number
  cache_creation_tokens: number
  cache_read_tokens: number
  total_tokens: number
  turn_count: number
  conversation_count: number
}

export interface TokenUsageHeatCell {
  /** 0 = Monday … 6 = Sunday, local time. */
  weekday: number
  /** 0–23, local time. */
  hour: number
  total_tokens: number
  turn_count: number
}

export interface TokenUsageConversationItem {
  conversation_id: number
  title: string | null
  agent_type: string
  folder_label: string | null
  total_tokens: number
  output_tokens: number
  turn_count: number
  /** Summed recorded generation time of the counted turns. */
  duration_ms: number
  last_activity_at: string
}

export interface TokenUsageStreak {
  longest_days: number
  current_days: number
  current_ends_on: string | null
}

export interface TokenUsageReport {
  range_start: string | null
  range_end: string | null
  bucket: TokenUsageBucket
  totals: TokenUsageTotals
  previous_totals: TokenUsageTotals | null
  series: TokenUsagePoint[]
  by_folder: TokenUsageBreakdownItem[]
  by_agent: TokenUsageBreakdownItem[]
  by_model: TokenUsageBreakdownItem[]
  heatmap: TokenUsageHeatCell[]
  top_conversations: TokenUsageConversationItem[]
  streak: TokenUsageStreak
  first_activity_at: string | null
  last_activity_at: string | null
  /** The scan hit its row cap — the numbers cover only the most recent slice. */
  truncated: boolean
}

export interface TokenUsageFolderFacet {
  folder_id: number
  /** Compact display name: the alias when set, else the folder name. The filter
   *  list renders `alias [ name ]` from `name` + `alias` instead. */
  label: string
  /** The folder's real (on-disk) directory name, alias or not. */
  name: string
  /** User-set display alias, or null when unset. */
  alias: string | null
  path: string
  parent_id: number | null
}

export interface TokenUsageFacets {
  folders: TokenUsageFolderFacet[]
  agents: string[]
  models: string[]
  data_start: string | null
  data_end: string | null
}

export interface TokenUsageSyncStatus {
  total_conversations: number
  synced_conversations: number
  stale_conversations: number
  fact_rows: number
  last_synced_at: string | null
  running: boolean
}

export interface TokenUsageSyncResult {
  scanned: number
  synced: number
  skipped: number
  /** Real faults — retried next pass. The only counter that warrants a toast. */
  failed: number
  /** Transcripts that are gone for good: facts kept, stamp settled, never
   *  retried. Deliberately silent — the reader cannot act on it. */
  lost: number
  turns_written: number
  tokens_written: number
  pruned_conversations: number
}

/** Payload of the `token-usage-sync://progress` event. */
export interface TokenUsageSyncProgress {
  done: number
  total: number
  current_title: string | null
  /** Present only on the final tick. */
  result: TokenUsageSyncResult | null
}

export interface PlanEntryInfo {
  content: string
  priority: string
  status: string
}

export interface AvailableCommandInfo {
  name: string
  description: string
  input_hint?: string | null
}

export interface SessionUsageUpdateInfo {
  used: number
  size: number
}

/**
 * Wire-level image attached to a tool call (e.g. codex image generation).
 * Mirrors Rust's `ToolCallImageInfo`. Reused by snapshot endpoints and
 * live `tool_call(_update)` events.
 */
export interface ToolCallImageWire {
  data: string
  mime_type: string
  uri?: string | null
}

// ACP events pushed from Rust backend (discriminated by "type" field)
/**
 * One background task settled by a `<task-notification>` transcript record
 * (mirror of Rust `BackgroundSettledInfo`). `task_id` is the launch ack's
 * `agentId` (async sub-agent) or `backgroundTaskId` (background shell);
 * `status` is the notification's `<status>` verbatim (`"completed"` on
 * success). The same id may settle more than once (a resumed sub-agent
 * notifies again).
 *
 * `tool_use_id`/`result` come from the same notification's `<tool-use-id>`/
 * `<result>` tags. The `background_activity` handler uses them to flip the
 * launch card in-memory (rewriting its `[[codeg-background-task]]` marker via
 * `resolveBackgroundTask`) instead of a `refetchDetail` — which double-rendered
 * the #870-held turn and raced the transcript's last write. `tool_use_id` is
 * the launching tool call's id (`toolu_…`), NOT `task_id`; absent for a
 * background shell (no marker card to flip).
 */
export interface BackgroundSettledInfo {
  task_id: string
  status: string
  summary?: string | null
  tool_use_id?: string | null
  result?: string | null
}

export type AcpEvent =
  /**
   * `parent_tool_use_id` = subagent attribution (claude-agent-acp ≥0.63 with
   * the `subagent-transcript` capability): chunks of a live subagent carry the
   * launching Agent tool call's id and route into its capsule, never the main
   * thread. Absent/null = main-thread content (every other agent, and Claude
   * main-thread chunks).
   */
  | { type: "content_delta"; text: string; parent_tool_use_id?: string | null }
  | { type: "thinking"; text: string; parent_tool_use_id?: string | null }
  | {
      type: "claude_sdk_message"
      session_id: string
      message: unknown
    }
  | {
      type: "tool_call"
      tool_call_id: string
      title: string
      kind: string
      status: string
      content: string | null
      raw_input: string | null
      raw_output: string | null
      locations?: unknown
      meta?: unknown
      /** Present iff agent attached images (e.g. codex-acp v0.14+ image gen). */
      images?: ToolCallImageWire[]
    }
  | {
      type: "tool_call_update"
      tool_call_id: string
      title: string | null
      status: string | null
      content: string | null
      raw_input: string | null
      raw_output: string | null
      raw_output_append?: boolean
      locations?: unknown
      meta?: unknown
      /**
       * Wire-level partial update: present means "replace prior images with
       * this vec", absent means "preserve prior images". Mirrors the
       * `Option<Vec<...>>` semantics on the Rust side.
       */
      images?: ToolCallImageWire[]
    }
  | {
      type: "permission_request"
      request_id: string
      tool_call: unknown
      options: PermissionOptionInfo[]
      /**
       * How many FURTHER permission requests are queued behind this card. Only
       * one card shows at a time, so this is what tells the user "the agent is
       * waiting on me three more times" instead of leaving the rest looking
       * like a hang. Optional: absent on pre-#442 persisted envelopes.
       */
      queued?: number
    }
  | {
      type: "permission_resolved"
      request_id: string
    }
  | {
      /**
       * Depth-only update: a new request queued up behind the visible card,
       * which publishes no `permission_request` of its own. Without this the
       * card's `queued` count would go stale.
       */
      type: "permission_queue_depth"
      depth: number
    }
  | {
      type: "turn_complete"
      session_id: string
      stop_reason: string
    }
  | {
      // Synthetic notification-only event (chat-channel "user message" push).
      // The frontend reducer has no case for it — it is consumed backend-side.
      type: "user_prompt_sent"
      text_preview: string
    }
  | {
      type: "session_started"
      session_id: string
    }
  | {
      type: "conversation_linked"
      conversation_id: number
      folder_id: number
    }
  | {
      // Agent published a live ACP session title. The backend writes the
      // conversation row and broadcasts `conversation://changed`; the
      // frontend does not apply this event itself.
      type: "native_session_title"
      title: string
    }
  | {
      type: "conversation_status_changed"
      conversation_id: number
      status: ConversationStatus
    }
  | {
      type: "session_modes"
      modes: SessionModeStateInfo
    }
  | {
      type: "session_config_options"
      config_options: SessionConfigOptionInfo[]
    }
  | {
      // The agent settled a `session/set_config_option` somewhere other than
      // where the pick asked. Correlated backend-side (see the Rust
      // `ConfigOptionRejected`) because only that side can tell a request's
      // answer from an unsolicited option update. `requested` / `actual` are
      // display labels, already resolved against the option's value list.
      type: "config_option_rejected"
      config_id: string
      option_name: string
      requested: string
      actual: string
    }
  | {
      type: "selectors_ready"
    }
  | {
      type: "prompt_capabilities"
      prompt_capabilities: PromptCapabilitiesInfo
    }
  | {
      type: "fork_supported"
      supported: boolean
    }
  | {
      type: "mode_changed"
      mode_id: string
    }
  | {
      type: "plan_update"
      entries: PlanEntryInfo[]
    }
  | {
      type: "status_changed"
      status: ConnectionStatus
    }
  | {
      type: "error"
      message: string
      agent_type: string
      /** Stable backend error identifier for localization (e.g. "initialize_timeout"). */
      code: string | null
      /**
       * Diagnostic evidence for errors the backend *inferred* rather than
       * received — the `turn_failed_empty*` family, where the agent reported
       * success and the wire carried no error. Agent stderr tail plus a
       * summary of updates the backend could not parse.
       *
       * Already redacted and length-bounded by the backend. Render it in the
       * alert detail only: it must not reach the OS notification or the
       * connection-status tooltip.
       */
      details?: string | null
    }
  | {
      // codex-acp #289: a retryable turn error that keeps the turn alive (codex
      // auto-retries). NOT a turn failure — rendered as a transient retry
      // indicator that reuses the Claude API-retry banner and clears at the
      // next turn boundary. `error_status` is the HTTP status when codex's
      // `codexErrorInfo` carried one. With AIR advertised, codex 1.2+ replaces
      // this channel with severity-"warning" `session_failure` records, so it
      // now serves only legacy paths.
      //
      // pi shares this channel (#525): pi-acp announces `auto_retry_start` as
      // ordinary prose, so the backend classifies it out of the transcript and
      // routes it here. pi sends an EMPTY `message` — it forwards no error text,
      // only the counters below — and the banner renders its own localized line
      // in that case. All three counters are absent for codex, which reports
      // none of them.
      type: "turn_retrying"
      message: string
      error_status?: number
      attempt?: number
      max_retries?: number
      retry_delay_ms?: number
    }
  | {
      // JetBrains AIR typed session failure upsert
      // (`_meta.jetbrains.air.sessionFailure`, claude-agent-acp 0.67+/
      // codex-acp 1.2+; published because codeg advertises the client
      // capability). Wire carries UPSERTS ONLY — the reducer applies the same
      // monotonic id+revision merge as the backend snapshot store, and infers
      // resolution (warnings settle at turn boundaries; errors stay active).
      type: "session_failure"
      record: SessionFailureRecord
    }
  | {
      type: "session_load_failed"
      session_id: string
      message: string
      /** Stable backend identifier — currently `"resource_not_found"`. */
      code: string
    }
  | {
      type: "available_commands"
      commands: AvailableCommandInfo[]
    }
  | {
      type: "usage_update"
      used: number
      size: number
    }
  /**
   * Out-of-turn activity surfaced from the agent's own session transcript by
   * the backend watcher (Claude only): async sub-agent / background-shell
   * `<task-notification>` completions, the agent's continued work after them,
   * and cron//loop autonomous turns (which produce no wire events at all).
   * `turns` are UPSERTs keyed by `MessageTurn.id` into the conversation
   * runtime store's background overlay; `settled` entries each raise one OS
   * notification; `outstanding` mirrors into the connection for the idle-sweep
   * exemption (nothing renders the count).
   */
  | {
      type: "background_activity"
      session_id: string
      turns?: MessageTurn[]
      outstanding: number
      settled?: BackgroundSettledInfo[]
      watermark: number
    }
  /**
   * A `delegate_to_agent` MCP tool call from the parent agent has spawned a
   * child sub-session and the child's prompt is in flight. Emitted as soon as
   * the broker registers the pending call. Frontend uses this to build the
   * parent ↔ child mapping for inline ToolCallBlock rendering.
   */
  | {
      type: "delegation_started"
      parent_connection_id: string
      parent_tool_use_id: string
      child_connection_id: string
      child_conversation_id: number
      agent_type: AgentType
      /** Bounded preview of the delegated task text. Labels the card on
       *  hosts whose parent tool call never carries the arguments in
       *  `raw_input` (Cursor). Optional for older-backend tolerance. */
      task_preview?: string | null
      /** Broker-minted task id (the `task_id=` embedded in the running ack). */
      task_id?: string | null
    }
  /**
   * The child sub-session has finished (or errored / timed out / been
   * canceled). The MCP tool_result has been delivered to the parent agent;
   * frontend updates the ToolCallBlock badge from "running" to ok/err.
   */
  | {
      type: "delegation_completed"
      parent_connection_id: string
      parent_tool_use_id: string
      child_connection_id: string
      child_conversation_id: number
      /** Child agent type. Carried so a frontend that missed the
       *  `delegation_started` event (mounted mid-flight, reconnect, or
       *  snapshot replay) can bind the correct agent instead of a default. */
      agent_type: AgentType
      result: DelegationResultSummary
    }
  /**
   * The user's submitted prompt, broadcast on the connection stream so OTHER
   * clients viewing this conversation synthesize the user turn in real time.
   * The sending client renders its own optimistic turn and ignores this echo.
   * Emitted only for root sends (delegation children synthesize kickoff text
   * separately).
   */
  | {
      type: "user_message"
      message_id: string
      blocks: UserMessageBlock[]
    }
  /**
   * The user submitted a live-feedback note while the agent is mid-turn (the
   * `check_user_feedback` steering path). Broadcast so every client viewing
   * this conversation renders the pending note; also captured in the snapshot.
   */
  | {
      type: "feedback_submitted"
      item: FeedbackItem
    }
  /**
   * The agent read one or more pending feedback notes via `check_user_feedback`.
   * Carries the note ids + the delivery instant; clients flip those notes to
   * `delivered` (they already hold the text from `feedback_submitted` / snapshot).
   */
  | {
      type: "feedback_consumed"
      ids: string[]
      delivered_at: string
    }
  /**
   * An agent called `ask_user_question`: a blocking multiple-choice prompt the
   * user must answer. Broadcast so every client renders the interactive card
   * above the input box; also captured in the snapshot for mid-turn attach.
   */
  | {
      type: "question_request"
      question_id: string
      questions: QuestionSpec[]
    }
  /**
   * A pending question was answered (from any client) or canceled (tool call
   * aborted / connection drained). Clients clear the matching card.
   */
  | {
      type: "question_resolved"
      question_id: string
    }
  /**
   * A Grok `exit_plan_mode` call: the agent finished planning and is blocked on
   * the user's approval of the plan. Broadcast so every client renders the
   * interactive plan-approval card; also captured in the snapshot for attach.
   */
  | {
      type: "plan_approval_request"
      approval_id: string
      tool_call_id: string
      plan_markdown: string
    }
  /**
   * A pending plan approval was answered (from any client) or canceled
   * (connection drained). Clients clear the matching card.
   */
  | {
      type: "plan_approval_resolved"
      approval_id: string
    }
  /**
   * The agent's effective settings (env vars / model provider / native config)
   * changed AFTER this connection spawned, so the running process is still on
   * its launch-time config. The frontend shows a "restart to apply" banner.
   * `stale: false` means a prior drift was reverted (the setting was changed
   * back) and the banner should clear. Mirrored into `LiveSessionSnapshot` so a
   * snapshot attach (reconnect, refresh, new tile) recovers the state.
   */
  | {
      type: "session_config_stale"
      stale: boolean
      kind: ConfigStaleKind
    }

/** Which settings surface drifted (mirror of Rust `ConfigStaleKind`), used to
 *  word the "restart to apply" banner. */
export type ConfigStaleKind = "agent_config" | "model_provider"

/** A block of a broadcast user prompt (mirror of Rust `UserMessageBlock`).
 *  Narrower than the persisted `ContentBlock`: only what a viewer needs to
 *  render the user turn. Resource/resource-link prompt blocks are folded into
 *  `text` markdown links backend-side. */
export type UserMessageBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mime_type: string }

/**
 * Mirror of Rust `DelegationResultSummary`. `kind` discriminates Ok vs Err;
 * Ok carries `duration_ms` (broker-measured) and an optional `text_preview`
 * (≤ ~2 KiB of the child's final assistant text, so the parent card can render
 * the result inline without re-fetching the child session); Err carries a
 * stable code from the `DelegationError` taxonomy (e.g. `"timeout"`,
 * `"canceled"`).
 */
export type DelegationResultSummary =
  | { kind: "ok"; duration_ms: number; text_preview?: string | null }
  | { kind: "err"; error_code: string }

/**
 * Wire envelope for all ACP events. JSON shape is flat via Rust's serde
 * flatten: { seq, connection_id, type, ...variant fields }. Expressed in TS
 * as an intersection that distributes over the AcpEvent discriminated union,
 * so `envelope.type` narrows the variant fields just like on AcpEvent.
 *
 * `seq` is a monotonically-increasing per-connection sequence number. Phase 0
 * always emits 0 (placeholder); Phase 1 wires it to the real counter, after
 * which clients use it as a dedup anchor between snapshot fetches and the
 * live event stream (drop events with seq <= last_event_seq from snapshot).
 *
 * 所有 ACP 事件统一通过此 envelope 发出，详见 spec phase 0/1。
 */
export type EventEnvelope = {
  seq: number
  connection_id: string
} & AcpEvent

// --- LiveSessionSnapshot wire types (mirror src-tauri/src/acp/session_state.rs) ---

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed"

export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "other"

export type ToolCallOutput =
  | { kind: "text"; content: string }
  | { kind: "error"; message: string }
  | { kind: "json"; value: unknown }

export interface ToolCallState {
  id: string
  kind: ToolKind
  label: string
  status: ToolCallStatus
  input: unknown | null
  output: ToolCallOutput | null
  content: string | null
  /** File locations affected by this tool call. Opaque pass-through. */
  locations: unknown | null
  /** ACP extensibility metadata. Opaque pass-through. */
  meta: Record<string, unknown> | null
  /**
   * Images attached to this tool call (e.g. codex-acp v0.14+ image gen).
   * Persisted on the snapshot so a frontend reconnecting mid-turn / after
   * refresh sees the same image. May be absent on older snapshots.
   */
  images?: ToolCallImageWire[]
}

export type LiveContentBlock =
  /** `parent_tool_use_id`: see `AcpEvent.content_delta` — subagent attribution. */
  | { kind: "text"; text: string; parent_tool_use_id?: string | null }
  | { kind: "thinking"; text: string; parent_tool_use_id?: string | null }
  | { kind: "tool_call_ref"; tool_call_id: string }
  | { kind: "plan"; entries: unknown }

export interface LiveMessage {
  id: string
  role: MessageRole
  content: LiveContentBlock[]
  started_at: string
}

export interface PendingPermissionState {
  request_id: string
  tool_call_id: string
  /**
   * Raw ACP tool_call JSON forwarded from the agent (rawInput / content /
   * locations / patch / plan all preserved). Frontend's
   * `parsePermissionToolCall` consumes this directly to render the approval
   * dialog after a refresh; flattening to a description loses everything
   * except the title.
   */
  tool_call: unknown
  options: PermissionOptionInfo[]
  created_at: string
  /** Requests queued behind this card; kept live by `permission_queue_depth`. */
  queued?: number
}

/**
 * Snapshot-recoverable record of an in-flight (running) sub-agent delegation,
 * keyed by `parent_tool_use_id`. Mirror of Rust `ActiveDelegationState`. Only
 * running delegations are carried here — completed ones are removed (recovered
 * instead from the child's persisted DB row via `inject_delegation_meta`, or
 * the live `DelegationProvider` binding). Unlike `active_tool_calls`, these
 * survive the parent's `TurnComplete`, so a web/server client can recover the
 * running parent↔child binding from the snapshot on any attach — even when it
 * missed the transient `delegation_started` event.
 */
export interface ActiveDelegationState {
  parent_tool_use_id: string
  child_connection_id: string
  child_conversation_id: number
  agent_type: AgentType
  /** Task label + broker task id mirrored from `delegation_started` so a
   *  snapshot re-attach reseeds the binding WITH its label (required on
   *  hosts whose tool call `raw_input` never carries the arguments). */
  task_preview?: string | null
  task_id?: string | null
}

/** Lifecycle of a live-feedback note (mirror of Rust `FeedbackStatus`). */
export type FeedbackStatus = "pending" | "delivered"

/**
 * A user-submitted live-feedback ("steering") note (mirror of Rust
 * `FeedbackItem`). Turn-scoped: the backend clears the set when the next turn's
 * `user_message` arrives. `delivered_at` is set once the agent reads it.
 */
export interface FeedbackItem {
  id: string
  text: string
  created_at: string
  status: FeedbackStatus
  delivered_at?: string | null
}

/** Snapshot of the most recent ACP runtime error. */
export interface SessionLastError {
  message: string
  code?: string | null
  /** Mirrors `AcpEvent` error `details`; already redacted by the backend. */
  details?: string | null
}

/**
 * One JetBrains AIR typed session failure record (mirror of Rust
 * `SessionFailureRecord`; claude-agent-acp 0.67+/codex-acp 1.2+, published
 * only because codeg advertises `clientCapabilities._meta.jetbrains.air`).
 *
 * The wire carries UPSERTS ONLY: a record is revised in place through
 * `id`+`revision` (per-id, from 1), and adapters never publish resolution —
 * consumers reject `revision <=` the stored one and infer lifecycle
 * themselves (see `lib/session-failures.ts`): severity-"warning" records
 * settle at CLEAN (`end_turn`) turn ends only — a cancelled/failed exit did
 * not recover, and a failed turn's terminal record arrives just before its
 * `turn_complete` (riding the prompt response) as a same-id higher-revision
 * error escalation — while severity-"error" records stay active until the
 * user acts (a new prompt settles everything; a recurrence re-arms via a
 * higher revision on the same id). Entries are retained resolved so each
 * doubles as its id's revision watermark — dropping one would let a delayed
 * stale upsert resurrect it.
 */
export interface SessionFailureRecord {
  id: string
  /** Per-id upsert revision, from 1. */
  revision: number
  /** AIR category — `connection|access|limit|request|service|unknown` today;
   *  unrecognized values fall back to the `unknown` rendering. */
  category: string
  /** `"warning"` (transient, auto-recovering) or `"error"` (terminal). */
  severity: string
  /** Adapter-authored user-facing text; may be empty (the banner then falls
   *  back to the localized category label). */
  title: string
  details?: string | null
  /** Suggested recovery actions — subset of `retry|login|new_session` today;
   *  unrecognized entries are not rendered. */
  actions?: string[]
  /** Client-inferred lifecycle (never on the wire). */
  resolved?: boolean
  /** Set when the USER closed the strip (client-local, never on the wire).
   *  Implies `resolved`, but must NOT render as "recovered": the incident was
   *  silenced, not fixed — saying otherwise would be a lie whenever the
   *  connection is still down. */
  dismissed?: boolean
}

export interface LiveSessionSnapshot {
  connection_id: string
  conversation_id: number | null
  folder_id: number | null
  status: ConnectionStatus
  external_id: string | null
  live_message: LiveMessage | null
  active_tool_calls: ToolCallState[]
  pending_permission: PendingPermissionState | null
  /** Awaiting-answer `ask_user_question`, recoverable on mid-turn attach.
   *  Absent (omitted) when no question is pending. */
  pending_question?: PendingQuestionState | null
  /** Awaiting-decision Grok `exit_plan_mode` approval, recoverable on mid-turn
   *  attach. Absent (omitted) when no approval is pending. */
  pending_plan_approval?: PendingPlanApprovalState | null
  /** In-flight user prompt for the current turn — lets a client attaching
   *  mid-turn render the user turn. Absent (omitted) when no turn is in flight. */
  pending_user_message?: {
    message_id: string
    blocks: UserMessageBlock[]
  } | null
  /** Live sub-agent delegations recoverable from the snapshot. May be absent
   *  on older server payloads (then treated as `[]`). */
  active_delegations?: ActiveDelegationState[]
  /** Live-feedback notes for the current turn. Absent on older payloads /
   *  when empty (then treated as `[]`). */
  feedback?: FeedbackItem[]
  /** Launched-but-unresolved background tasks (async sub-agents / background
   *  shells) accounted from the transcript. Lets a client attaching
   *  mid-episode recover the pending count the one-shot `background_activity`
   *  events won't replay. Absent / omitted when zero. */
  background_outstanding?: number
  /** Whether this agent has the `check_user_feedback` tool (fixed at launch).
   *  The frontend gates the feedback bar on this — the agent's real capability —
   *  not the (possibly later-toggled) global setting. Absent → `false`. */
  feedback_tool_available?: boolean
  /** Whether feedback notes ride the native `_session/steering` push channel
   *  (synthesized backend-side from advertisement + registry policy + runtime
   *  version proof — the frontend must NOT re-derive it from agent type).
   *  Absent → `false`. */
  native_steering_available?: boolean
  modes: SessionModeStateInfo | null
  current_mode: string | null
  config_options: SessionConfigOptionInfo[] | null
  prompt_capabilities: PromptCapabilitiesInfo | null
  usage: SessionUsageUpdateInfo | null
  fork_supported: boolean
  available_commands: AvailableCommandInfo[]
  selectors_ready: boolean
  /** Whether the running session is on stale (launch-time) config after a later
   *  settings save. Absent on older server payloads (then treated as `false`). */
  config_stale?: boolean
  /** Which settings surface drifted; present only while `config_stale`. */
  config_stale_kind?: ConfigStaleKind | null
  /** Latest agent/runtime error recoverable after reconnect. */
  last_error?: SessionLastError | null
  /** AIR typed session failure table — resolved entries and their revision
   *  watermarks included, so an attaching client seeds the same monotonic
   *  merge the live path applies. Absent while empty (the common case). */
  session_failures?: SessionFailureRecord[]
  /** Goal-control action vocabulary the goal card gates its buttons on: the
   *  advertised `_meta.goal.actions` for neutral-goal adapters (claude has no
   *  "pause"), else the legacy ["pause","clear"] pair. `null` while the
   *  connection is still initializing (nothing known yet — stay fail-closed
   *  and re-read); absent only on a server too old to carry the field. */
  goal_actions?: string[] | null
  event_seq: number
}

// Connection info returned by acp_list_connections
export interface ConnectionInfo {
  id: string
  agent_type: AgentType
  status: ConnectionStatus
}

// Live connection bound to a conversation, returned by
// acp_find_connection_for_conversation. `null` means no live connection (read
// persisted detail instead of attaching). `event_seq` is the connection's
// progress at discovery time — informational only; viewers always cold-attach
// (full snapshot, no cursor), since they've applied no prior events.
export interface ConversationConnectionInfo {
  connection_id: string
  event_seq: number
}

// ACP agent info returned by acp_list_agents
export interface AcpAgentInfo {
  agent_type: AgentType
  /**
   * Whether this agent has a codeg-known skill store — every built-in, and
   * custom agents that declared the shared `.agents/skills` store. Gates the
   * skills matrices.
   */
  skills_capable: boolean
  registry_id: string
  registry_version: string | null
  /**
   * Whether "install a specific version" can actually fetch that version.
   *
   * NOT the same as `registry_version != null`, which is what this page used to
   * infer it from: a binary agent's custom install substitutes the requested
   * version into the pinned download URL, and Antigravity's URLs carry a Google
   * build id rather than its registry version — so the substitution is a no-op
   * and the install would relabel the same bytes under a version that was never
   * fetched. The backend answers per-platform.
   */
  supports_custom_version: boolean
  name: string
  description: string
  available: boolean
  distribution_type: string
  /**
   * Whether codeg's entry for this agent is a third-party ACP *adapter*
   * wrapping a vendor CLI of a different name (Claude Code → claude-agent-acp,
   * Codex → codex-acp). Surfaces without a preflight result use it to say "the
   * ACP adapter isn't installed" rather than "the agent isn't" — the single
   * most-reported confusion.
   */
  is_acp_adapter: boolean
  /**
   * For custom agents, where the definition came from ("registry" | "manual");
   * null for built-ins. A manual definition's registry_version is user-typed,
   * so the version-status check shows only the local version for those.
   */
  custom_source: string | null
  enabled: boolean
  sort_order: number
  installed_version: string | null
  env: Record<string, string>
  /**
   * The RESOLVED `CODEG_ACP_HOST_TOOLS` verdict: whether the next launch hands
   * the `fs/*` + `terminal/*` channels — and, with them, codeg-mcp's delegation
   * tools — back to the agent. Resolved by the same Rust function the launch
   * uses, so it covers BOTH the per-agent `env` above and codeg's own process
   * env; reading `env` here would miss the second.
   */
  host_tools_agent_mode: boolean
  config_json: string | null
  config_file_path: string | null
  opencode_auth_json: string | null
  codex_auth_json: string | null
  codex_config_toml: string | null
  /** Compact structured codex model-catalog source (the custom-model list),
   *  round-tripped into the settings editor. Codex + api-key mode only. */
  codex_model_catalog: string | null
  /** Parsed sandbox / approval keys backing the Codex panel's structured
   * controls. Codex agent only; derived from codex_config_toml. */
  codex_sandbox_settings: CodexSandboxSettings | null
  cline_secrets_json: string | null
  /** Raw ~/.hermes/config.yaml text, for the Hermes panel's advanced editor. */
  hermes_config_yaml: string | null
  /** Raw ~/.grok/config.toml text, for the Grok panel's config-file editor. */
  grok_config_toml: string | null
  /** Parsed scalar settings backing the Grok panel's structured controls. Only
   * populated for the Grok agent; derived from grok_config_toml. */
  grok_settings: GrokSettings | null
  /** Raw ~/.cursor/cli-config.json text, for the Cursor panel's advanced view. */
  cursor_cli_config_json: string | null
  /** Parsed scalar settings backing the Cursor panel's structured controls
   * (sandbox / permission rules; the Run Everything permission mode is a
   * launch flag, not a config key). Cursor agent only. */
  cursor_settings: CursorSettings | null
  model_provider_id: number | null
  /** Display icon for a custom ACP agent — normally an inlined
   *  `data:image/…;base64,…` URL. Always null for built-ins, which ship
   *  hand-drawn marks in `agent-icon.tsx`. */
  icon_url: string | null
}

/** Parsed sandbox / approval keys from ~/.codex/config.toml. Serialized
 * snake_case to match AcpAgentInfo.
 *
 * These only matter for turns codex starts SERVER-side — `/goal`, `/review`,
 * `/compact` — because codex-acp attaches its own policy to every ordinary
 * turn from the composer's mode preset. Without them a user on
 * "Agent (full access)" still gets a workspace-write sandbox inside /goal. */
export interface CodexSandboxSettings {
  /** untrusted | on-request | never. The legacy `on-failure` spelling is a
   * serde alias of on-request upstream and is normalized on read. Null when
   * absent or when the granular table form is in use. */
  approval_policy: string | null
  /** approval_policy = { granular = { … } } — mutually exclusive with the
   * string form (the upstream enum is externally tagged). */
  granular: CodexGranularApproval | null
  /** read-only | workspace-write | danger-full-access. Null = absent, in which
   * case codex falls back to workspace-write for any directory with a
   * [projects] trust decision (read-only otherwise). */
  sandbox_mode: string | null
  /** [sandbox_workspace_write] — only consulted when the effective mode is
   * workspace-write. */
  workspace_write: CodexWorkspaceWrite
  /** default_permissions is set, so codex resolves permissions through the
   * profile pipeline and IGNORES sandbox_mode entirely. */
  shadowed_by_default_permissions: boolean
  /** A [permissions] profile table exists (a hard startup error upstream when
   * default_permissions is absent). */
  has_permissions_table: boolean
}

/** GranularApprovalConfig upstream. snake_case in BOTH directions (unlike the
 * camelCase parent payload) so one shape serves read and write. All five keys
 * are always written together: sandbox_approval / rules / mcp_elicitations have
 * no upstream default, so a partial table makes codex refuse to load. */
export interface CodexGranularApproval {
  sandbox_approval: boolean
  rules: boolean
  skill_approval: boolean
  request_permissions: boolean
  mcp_elicitations: boolean
}

/** [sandbox_workspace_write]. Every field defaults to false/empty upstream, so
 * codeg writes only the non-default ones. */
export interface CodexWorkspaceWrite {
  /** Extra writable folders. MUST be absolute: codex does not reject a
   * relative entry, it resolves it against CODEX_HOME (so "rel/dir" silently
   * becomes ~/.codex/rel/dir). */
  writable_roots: string[]
  network_access: boolean
  exclude_tmpdir_env_var: boolean
  exclude_slash_tmp: boolean
}

/** Structured-control values the Codex settings panel sends on save, merged
 * format-preservingly onto ~/.codex/config.toml server-side. camelCase on the
 * wire except the nested `granular` object.
 *
 * This is a per-field PATCH, not a snapshot: an ABSENT field leaves its key
 * exactly as the merge base has it. The panel sends the raw config.toml text
 * alongside this patch and the patch is applied last, so carrying the whole
 * group would silently revert any of these keys the user had hand-edited in the
 * raw editor — a surface the panel never parses back into its controls.
 *
 * `approvalPolicy` and `granular` move as a pair (upstream they are one
 * externally tagged key): both absent leaves it, both `null` removes it,
 * exactly one non-null writes that form. For the workspace-write fields, absent
 * leaves the key and `false`/`[]` removes it (identical to codex's defaults). */
export interface CodexSandboxStructuredConfig {
  approvalPolicy?: string | null
  granular?: CodexGranularApproval | null
  sandboxMode?: string | null
  writableRoots?: string[]
  networkAccess?: boolean
  excludeTmpdirEnvVar?: boolean
  excludeSlashTmp?: boolean
}

/** Parsed keys from ~/.grok/config.toml. `null` means the key is absent.
 * Serialized snake_case to match AcpAgentInfo. The stock per-session model is
 * NOT here — it's chosen from the composer. But a codeg-managed custom (BYO
 * endpoint) model IS: it's the `[model.<id>]` block whose id equals
 * [models].default, read back through the custom_* fields. */
export interface GrokSettings {
  default_reasoning_effort: string | null
  permission_mode: string | null
  /** The codeg-managed custom model id ([model.<id>] == [models].default). */
  custom_model_id: string | null
  /** [model.<id>].base_url — null ⇒ Grok's official xAI endpoint. */
  custom_base_url: string | null
  /** [model.<id>].api_key — inline key scoped to the custom endpoint. */
  custom_api_key: string | null
  /** [model.<id>].api_backend — chat_completions | responses | messages. */
  custom_api_backend: string | null
  /** [model.<id>].context_window — context size in tokens. */
  custom_context_window: number | null
  /** [session].auto_compact_threshold_percent — 0–100 (Grok default 85). */
  auto_compact_threshold_percent: number | null
}

/** Structured-control values the Grok settings panel sends on save. Each
 * non-null value sets its config.toml key; each null removes it. camelCase on
 * the wire to match the request body. A non-empty customModelId writes (or
 * renames to) [model.<id>] + [models].default; empty/null removes the managed
 * block. Within an active model, an empty sub-field omits its key. */
export interface GrokStructuredConfig {
  defaultReasoningEffort: string | null
  permissionMode: string | null
  customModelId: string | null
  customBaseUrl: string | null
  customApiKey: string | null
  customApiBackend: string | null
  customContextWindow: number | null
  autoCompactThresholdPercent: number | null
}

/** Parsed keys from ~/.cursor/cli-config.json (shared with the Cursor CLI's
 * own /config UI). Only the codeg-managed subset is projected; everything
 * else is preserved verbatim on write. */
export interface CursorSettings {
  /** sandbox.mode — "enabled" | "disabled". */
  sandbox_mode: string | null
  /** permissions.allow rules, e.g. Shell(ls). */
  permissions_allow: string[]
  /** permissions.deny rules. */
  permissions_deny: string[]
}

/** Structured-control values the Cursor settings panel sends on save. Null
 * fields leave the key untouched; non-null fields replace it (lists
 * wholesale; an empty-string scalar removes the key). camelCase on the wire
 * to match the request body. */
export interface CursorStructuredConfig {
  sandboxMode?: string | null
  permissionsAllow?: string[] | null
  permissionsDeny?: string[] | null
}

/** Result of probing `cursor-agent status --format json` (auth card). */
export interface CursorAuthStatus {
  installed: boolean
  is_authenticated: boolean
  raw_status: string | null
  email: string | null
  membership: string | null
  error: string | null
  /** Absolute path to the cursor-agent binary codeg would launch; the panel
   * builds a copy-pasteable `"<binary_path>" login` command from it (the
   * managed binary isn't on PATH). Null when not installed. */
  binary_path?: string | null
}

/** One `cursor-agent models` entry: `<id> - <label> [(default)]`. The picker
 * shows `label` (falling back to `id`) and passes `id` to the CLI as --model. */
export interface CursorModelInfo {
  id: string
  label: string
  is_default: boolean
}

/** Result of `cursor-agent models` (model picker). */
export interface CursorModelsResult {
  models: CursorModelInfo[]
  default_model: string | null
  error: string | null
}

/** Result of probing `qoder status -o json` (auth card). A probe that could
 * not run reports `error` with `logged_in: false`; the panel renders that as
 * "could not check", never as "signed out". */
export interface QoderAuthStatus {
  installed: boolean
  logged_in: boolean
  username: string | null
  email: string | null
  /** Account tier, e.g. `personal_standard`. */
  user_type: string | null
  /** Version the probed binary reports — the one that would actually launch,
   * not necessarily the version codeg's registry pins. */
  version: string | null
  allow_byok: boolean | null
  error: string | null
  /** Absolute path to the qoder binary codeg would launch; the panel builds a
   * copy-pasteable `"<binary_path>" login` command from it. */
  binary_path?: string | null
}

// Lightweight agent status returned by acp_get_agent_status
export interface AcpAgentStatus {
  agent_type: AgentType
  available: boolean
  enabled: boolean
  installed_version: string | null
  /** See AcpAgentInfo.is_acp_adapter. */
  is_acp_adapter: boolean
}

// Environment diagnostics (returned by acp_env_diagnostics). Mirrors the Rust
// AgentDiagnosticsReport in src-tauri/src/acp/types.rs (snake_case response DTO).
export type DiagLevel = "ok" | "warn" | "fail" | "info"

export interface DiagCheck {
  label: string
  value: string
  status: DiagLevel
  hint: string | null
}

export interface DiagSection {
  title: string
  checks: DiagCheck[]
}

export interface DiagnosticsVerdict {
  level: DiagLevel
  // Stable id localized via DiagnosticsSettings.verdict.<code>.
  code: string
  // Pre-formatted English sentence; used only in plain_text (copy blob).
  summary: string
}

export interface AgentDiagnosticsReport {
  generated_at: string
  agent_type: AgentType | null
  verdict: DiagnosticsVerdict
  sections: DiagSection[]
  // Backend-rendered text for the "copy all" button.
  plain_text: string
}

export type AgentSkillScope = "global" | "project"
export type AgentSkillLayout = "markdown_file" | "skill_directory"

export interface AgentSkillLocation {
  scope: AgentSkillScope
  path: string
  exists: boolean
}

export interface AgentSkillItem {
  id: string
  name: string
  scope: AgentSkillScope
  layout: AgentSkillLayout
  path: string
  description: string | null
  read_only: boolean
}

export interface AgentSkillsListResult {
  supported: boolean
  message: string | null
  locations: AgentSkillLocation[]
  skills: AgentSkillItem[]
}

export interface AgentSkillContent {
  skill: AgentSkillItem
  content: string
}

/**
 * Built-in expert skills, sourced from obra/superpowers and bundled into
 * the codeg binary. Experts live in a central store at `~/.codeg/skills/`
 * and are linked into agent skill directories on demand.
 */
export interface ExpertMetadata {
  id: string
  category: string
  icon: string | null
  sort_order: number
  display_name: Record<string, string>
  description: Record<string, string>
  bundled_hash: string
}

export interface ExpertListItem {
  metadata: ExpertMetadata
  installed_centrally: boolean
  user_modified: boolean
  central_path: string
}

export type ExpertLinkState =
  | "not_linked"
  | "linked_to_codeg"
  | "linked_elsewhere"
  | "blocked_by_real_directory"
  | "broken"

export interface ExpertInstallStatus {
  expertId: string
  agentType: AgentType
  state: ExpertLinkState
  linkPath: string
  targetPath: string | null
  expectedTargetPath: string
  copyMode: boolean
}

/** A single enable/disable request for one (skill, agent) pair. For office
 *  tools, `expertId` carries the office skill id. */
export interface LinkOp {
  expertId: string
  agentType: AgentType
  enable: boolean
}

/** Per-op outcome of a batch apply. A failed op never aborts the rest. */
export interface LinkOpResult {
  expertId: string
  agentType: AgentType
  ok: boolean
  /** Present on a successful enable; null for disables and failures. */
  status: ExpertInstallStatus | null
  error: string | null
}

/**
 * A user-authored "custom" skill. The fourth skill pack: unlike the bundled
 * experts/science/office packs, these are created/edited/imported/deleted by
 * the user, but live in the SAME central store (`~/.codeg/skills/<id>/`) and
 * reuse the experts link primitives. A skill is "custom" iff its central-store
 * directory id is not claimed by any bundled pack. Link statuses reuse
 * `ExpertInstallStatus`/`LinkOp`/`LinkOpResult` (the `expertId` field carries
 * the custom skill id).
 */
export interface CustomSkillItem {
  id: string
  /** Frontmatter `name:` if present, else the id. */
  name: string
  /** Best-effort one-line description from the SKILL.md frontmatter. */
  description: string | null
  central_path: string
}

/** Per-skill outcome of a batch delete (delete is skill-scoped, not per-agent). */
export interface CustomDeleteResult {
  id: string
  ok: boolean
  error: string | null
}

/**
 * Per-skill outcome of importing an agent's own skills into the central store.
 * `skipped` means the skill is already in the shared store (a linked built-in
 * skill or one imported earlier) — an idempotent no-op, not a failure.
 */
export interface CustomImportResult {
  id: string
  name: string
  ok: boolean
  skipped: boolean
  error: string | null
}

/**
 * Built-in scientific-research skills, curated from
 * K-Dense-AI/scientific-agent-skills and bundled into the codeg binary. They
 * share the central store (`~/.codeg/skills/`) and link primitives with
 * experts; link statuses reuse `ExpertInstallStatus`/`LinkOp`/`LinkOpResult`
 * (the `expertId` field carries the science skill id).
 */
export interface ScienceMetadata {
  id: string
  category: string
  icon: string | null
  sort_order: number
  /** Surface as a card in the new-session "Scientific Research" tab. */
  featured: boolean
  /** Color key indexing the ACCENTS map in quick-actions.tsx (featured only). */
  accent: string | null
  /** Primary workflow requires an external API key. */
  needs_key: boolean
  /** Ships scripts that may need a Python/uv environment. */
  needs_env: boolean
  display_name: Record<string, string>
  description: Record<string, string>
  bundled_hash: string
}

export interface ScienceListItem {
  metadata: ScienceMetadata
  installed_centrally: boolean
  user_modified: boolean
  central_path: string
}

export interface OfficecliInfo {
  installed: boolean
  version: string | null
  path: string | null
  // Set when the binary file is present (`installed = true`) but running it
  // failed — e.g. a missing system library (libicu) on a slim Linux server.
  // Carries an actionable diagnostic; null when officecli runs fine.
  runtimeError: string | null
}

export interface OfficecliSkill {
  id: string
  category: string
  icon: string
  sortOrder: number
  displayName: Record<string, string>
  description: Record<string, string>
  installedCentrally: boolean
}

export interface SkillSyncReport {
  synced: number
  errors: string[]
}

export interface SystemProxySettings {
  enabled: boolean
  proxy_url: string | null
}

export type AppLocale =
  | "en"
  | "zh_cn"
  | "zh_tw"
  | "ja"
  | "ko"
  | "es"
  | "de"
  | "fr"
  | "pt"
  | "ar"
export type LanguageMode = "system" | "manual"

export interface SystemLanguageSettings {
  mode: LanguageMode
  language: AppLocale
}

export interface SystemTerminalSettings {
  default_shell: string | null
}

export interface TerminalShellOption {
  id: string
  label_key: string
  value: string | null
  exists: boolean
  accepts_custom_path: boolean
}

export interface AvailableTerminalShells {
  options: TerminalShellOption[]
  resolved_shell: string
}

export interface SystemRenderingSettings {
  disable_hardware_acceleration: boolean
}

/** "Launch at login". The OS registration is the source of truth, so an update
 * returns the state the system actually settled on — which can differ from what
 * was requested (e.g. Windows Task Manager vetoing the Run entry). */
export interface SystemAutostartSettings {
  enabled: boolean
}

// --- Logging ---

export type LogLevel = "off" | "error" | "warn" | "info" | "debug" | "trace"

/** A per-target level override, e.g. `codeg_lib::acp` at `debug` while the
 * global level stays `info`. `target` is a tracing target (a Rust module path). */
export interface TargetDirective {
  target: string
  level: LogLevel
}

export interface LogSettings {
  level: LogLevel
  /** Omitted by the backend when empty; treat `undefined` as `[]`. */
  targets?: TargetDirective[]
}

/** What the Logs settings UI reads: the persisted level + per-target overrides,
 * plus whether an env var (CODEG_LOG/RUST_LOG) currently locks the controls
 * (env owns the live level). */
export interface LogSettingsView {
  level: LogLevel
  targets: TargetDirective[]
  env_locked: boolean
}

/** One enclosing span in an event's scope: its name + recorded fields. Ordered
 * root→leaf in `LogRecord.spans`. */
export interface SpanInfo {
  name: string
  fields: Record<string, string>
}

/** One captured log event. `level` is tracing's uppercase string
 * ("ERROR".."TRACE"); `target` is the emitting module path. `fields` holds the
 * event's own key-value fields and `spans` the enclosing span chain; both are
 * empty for plain-message logs. */
export interface LogRecord {
  seq: number
  timestamp_ms: number
  level: string
  target: string
  message: string
  fields: Record<string, string>
  spans: SpanInfo[]
}

export interface LogFileInfo {
  name: string
  size_bytes: number
  modified_ms: number
}

// --- Version Control ---

export interface GitCredentials {
  username: string
  password: string
}

export interface GitDetectResult {
  installed: boolean
  version: string | null
  path: string | null
}

export interface PackageManagerInfo {
  name: string
  installed: boolean
  version: string | null
}

/** Per-agent install status of the HyperFrames agent skills. */
export interface HyperframesSkillAgent {
  agent: string
  installed: boolean
}

export interface GitSettings {
  custom_path: string | null
}

/** A stored forge credential. Despite the name (kept for the wire format),
 *  this is any host's account — GitHub, GitLab, or a plain git remote. */
export interface GitHubAccount {
  id: string
  server_url: string
  username: string
  scopes: string[]
  avatar_url: string | null
  is_default: boolean
  created_at: string
  /** Which forge the token is for. Absent on accounts stored before GitLab
   *  support (and on plain git credentials), where it keeps meaning "a
   *  credential for this host, whichever forge lives there". */
  provider?: ForgeProviderId | null
}

export type ForgeProviderId = "github" | "gitlab"

export interface GitHubAccountsSettings {
  accounts: GitHubAccount[]
}

export interface GitHubTokenValidation {
  success: boolean
  username: string | null
  scopes: string[]
  avatar_url: string | null
  message: string | null
}

export type McpAppType =
  | "claude_code"
  | "codex"
  | "gemini"
  | "open_claw"
  | "open_code"
  | "cline"
  | "hermes"
  | "code_buddy"
  | "kimi_code"
  | "grok"
  | "cursor"
  | "deepseek"
  | "qoder"
  | "antigravity"

export interface LocalMcpServer {
  id: string
  spec: Record<string, unknown>
  apps: McpAppType[]
}

export interface McpMarketplaceProvider {
  id: string
  name: string
  description: string
}

export interface McpMarketplaceItem {
  provider_id: string
  server_id: string
  name: string
  description: string
  homepage: string | null
  remote: boolean
  verified: boolean
  icon_url: string | null
  latest_version: string | null
  protocols: string[]
  owner: string | null
  namespace: string | null
  downloads: number | null
  score: number | null
  is_deployed: boolean | null
}

export interface McpMarketplaceInstallParameter {
  key: string
  label: string
  description: string | null
  required: boolean
  secret: boolean
  kind: string
  default_value: unknown | null
  placeholder: string | null
  enum_values: string[]
  location: string | null
}

export interface McpMarketplaceInstallOption {
  id: string
  protocol: string
  label: string
  description: string | null
  spec: Record<string, unknown>
  parameters: McpMarketplaceInstallParameter[]
}

export interface McpMarketplaceServerDetail {
  provider_id: string
  server_id: string
  name: string
  description: string
  homepage: string | null
  remote: boolean
  verified: boolean
  icon_url: string | null
  latest_version: string | null
  protocols: string[]
  owner: string | null
  namespace: string | null
  downloads: number | null
  score: number | null
  is_deployed: boolean | null
  default_option_id: string | null
  install_options: McpMarketplaceInstallOption[]
  spec: Record<string, unknown>
}

export interface FolderCommand {
  id: number
  folder_id: number
  name: string
  command: string
  sort_order: number
  created_at: string
  updated_at: string
}

export interface QuickMessage {
  id: number
  title: string
  content: string
  sort_order: number
  created_at: string
  updated_at: string
}

export interface GitStatusEntry {
  status: string
  file: string
}

export type GitResetMode = "soft" | "mixed" | "hard" | "keep"

export interface GitBranchList {
  local: string[]
  remote: string[]
  /** Branches checked out in some *other* worktree than the queried path. */
  worktree_branches: string[]
  /**
   * The branch checked out in the repo's main working tree, when that is not the
   * queried path itself. It appears in `worktree_branches` like any other — but
   * its checkout is the repo, so it can neither be deleted nor removed.
   */
  main_worktree_branch: string | null
}

/**
 * State of a working tree's HEAD (mirrors Rust `GitHeadInfo`). Distinguishes a
 * non-repo, a detached HEAD, and being on a branch — the branch-only
 * `getGitBranch` contract collapsed the last two into `null`, hiding git
 * operations for detached repos (issue #279).
 */
export interface GitHeadInfo {
  is_repo: boolean
  /** Branch name when on a branch (incl. unborn); null when detached or non-repo. */
  branch: string | null
  detached: boolean
  /** Short commit hash, present when detached. */
  short_sha: string | null
}

/**
 * Where a branch is checked out, resolved against registered folders (mirrors
 * Rust `WorktreeResolution`). `path` is the canonical worktree/main-tree path
 * hosting the branch, or null when it is not checked out in any worktree.
 * `folder_id` is the registered folder owning that path, or null for an
 * external/unregistered worktree. Drives the branch selector's navigate-vs-
 * checkout decision.
 */
export interface WorktreeResolution {
  path: string | null
  folder_id: number | null
}

/**
 * What removing a worktree actually did (mirrors Rust `GitWorktreeRemoval`).
 * `worktree_path` is null when the branch had no worktree left to remove — what
 * a retry after a partially applied removal sees. `folder_id` is the workspace
 * folder dropped along with the directory (only the "…and branch" variant drops
 * one), and `reparented` counts the conversations it moved to the repo folder.
 */
export interface GitWorktreeRemoval {
  worktree_path: string | null
  branch_deleted: boolean
  folder_id: number | null
  reparented: number
}

export interface GitConflictInfo {
  has_conflicts: boolean
  conflicted_files: string[]
  operation: string
  upstream_commit?: string | null
}

export interface GitPullResult {
  updated_files: number
  conflict?: GitConflictInfo | null
}

export interface GitPushResult {
  pushed_commits: number
  upstream_set: boolean
}

export interface GitPushInfo {
  branch: string
  remotes: GitRemote[]
  tracking_remote: string | null
}

export interface GitMergeResult {
  merged_commits: number
  conflict?: GitConflictInfo | null
}

export interface GitRebaseResult {
  message: string
  conflict?: GitConflictInfo | null
}

export interface GitConflictFileVersions {
  base: string
  ours: string
  theirs: string
  merged: string
}

export interface GitCommitResult {
  committed_files: number
}

export interface GitRemote {
  name: string
  url: string
}

export interface GitStashEntry {
  index: number
  message: string
  branch: string
  date: string
  ref_name: string
}

export type FileTreeNode =
  | { kind: "file"; name: string; path: string }
  | {
      kind: "dir"
      name: string
      path: string
      children: FileTreeNode[]
      /**
       * The directory is a symlink on disk. Omitted (rather than `false`) for
       * ordinary directories to keep the broadcast tree snapshot small. The
       * backend does not descend through links, so `children` arrives empty
       * and the panel lazy-loads it on expand.
       */
      symlink?: boolean
    }

/** Flat gitignore-aware workspace entry returned by `list_workspace_files`. */
export interface WorkspaceFileEntry {
  name: string
  /** Path relative to the workspace root, always forward-slashed. */
  path: string
  kind: "file" | "dir"
}

/**
 * A directory the user symlinked into a workspace folder, turning one root into
 * a multi-folder workspace. `name` is the subdirectory the link occupies inside
 * the root; `targetPath` is the real directory it points at.
 */
export interface FolderLinkDetail {
  id: number
  folderId: number
  name: string
  targetPath: string
  status: FolderLinkStatus
}

/**
 * Live state of a link, recomputed from disk on every list.
 * - `ok` — the symlink is there and resolves to `targetPath`
 * - `missing` — nothing at `<root>/<name>` any more
 * - `conflicted` — a real directory (or a link elsewhere) took the name
 * - `broken` — the link is there but its target no longer resolves
 */
export type FolderLinkStatus = "ok" | "missing" | "conflicted" | "broken"

/** Why a picked directory cannot be linked. */
export type FolderLinkRejection =
  | "not_found"
  | "not_a_directory"
  | "same_as_root"
  | "ancestor_of_root"
  | "inside_root"
  | "already_linked"
  | "name_unavailable"

/**
 * Dry-run result for one picked directory: the name it would get and why it
 * would be skipped. Computed server-side so the dialog reflects what is
 * actually on disk rather than guessing.
 */
export interface FolderLinkPlan {
  targetPath: string
  /** Name derived from the directory, before disambiguation. */
  baseName: string
  /** Name that would be created; empty when `rejection` is set. */
  name: string
  /** True when `name` had to differ from `baseName`. */
  renamed: boolean
  /** The collision was with a real entry already in the root, not another link. */
  collidesWithExistingEntry: boolean
  rejection: FolderLinkRejection | null
  /** Name of the existing link, when `rejection` is `already_linked`. */
  existingLinkName: string | null
}

/** One directory to link, with an optional user-chosen name. */
export interface FolderLinkRequestItem {
  path: string
  name?: string
}

export interface DirectoryEntry {
  name: string
  path: string
  hasChildren: boolean
}

export interface DirectoryItem {
  name: string
  path: string
  isDir: boolean
  hasChildren: boolean
  size: number | null
}

export interface UploadAttachmentResult {
  path: string
  name: string
  size: number
  mimeType: string | null
}

export interface FilePreviewContent {
  path: string
  content: string
}

export interface FileEditContent {
  path: string
  content: string
  etag: string
  mtime_ms: number | null
  readonly: boolean
  line_ending: "lf" | "crlf" | "mixed" | "none"
}

export interface FileSaveResult {
  path: string
  etag: string
  mtime_ms: number | null
  readonly: boolean
  line_ending: "lf" | "crlf" | "mixed" | "none"
}

export interface WorkspaceGitEntry {
  path: string
  status: string
  additions: number
  deletions: number
}

export type WorkspaceDelta =
  | { kind: "tree_replace"; nodes: FileTreeNode[] }
  | { kind: "git_replace"; entries: WorkspaceGitEntry[] }
  | { kind: "meta"; reason: string }

export interface WorkspaceDeltaEnvelope {
  seq: number
  kind: "fs_delta" | "git_delta" | "meta" | "resync_hint" | string
  payload: WorkspaceDelta[]
  requires_resync: boolean
  changed_paths?: string[]
}

export interface WorkspaceStateEvent {
  root_path: string
  seq: number
  version: number
  kind: "fs_delta" | "git_delta" | "meta" | "resync_hint" | string
  payload: WorkspaceDelta[]
  requires_resync: boolean
  changed_paths?: string[]
}

export interface WorkspaceSnapshotResponse {
  root_path: string
  seq: number
  version: number
  full: boolean
  tree_snapshot: FileTreeNode[] | null
  git_snapshot: WorkspaceGitEntry[] | null
  deltas: WorkspaceDeltaEnvelope[]
  degraded: boolean
  is_git_repo: boolean
}

export interface GitLogResult {
  entries: GitLogEntry[]
  has_upstream: boolean
}

export interface GitLogEntry {
  hash: string
  full_hash: string
  author: string
  date: string
  message: string
  files: GitLogFileChange[]
  pushed: boolean | null
}

export interface GitLogFileChange {
  path: string
  status: string
  additions: number
  deletions: number
}

// Terminal types
export interface TerminalInfo {
  id: string
  title: string
}

export interface TerminalEvent {
  terminal_id: string
  data: string
}

export interface TokenBreakdown {
  input: number
  output: number
  cache_input: number
  cache_output: number
}

export interface DailyTokenStats {
  date: string
  breakdown: TokenBreakdown
  total: number
}

// Preflight check types
export type FixActionKind =
  | "open_url"
  | "redownload_binary"
  | "retry_connection"
  | "open_agents_settings"
  | "install_opencode_plugins"
  | "install_uv"

export interface FixAction {
  label: string
  kind: FixActionKind
  payload: string
}

export type CheckStatus = "pass" | "fail" | "warn"

export interface CheckItem {
  check_id: string
  label: string
  status: CheckStatus
  message: string
  fixes: FixAction[]
}

/**
 * Structured explainer data for agents whose codeg entry is a third-party ACP
 * adapter rather than the vendor's own CLI (Claude Code, Codex). The backend
 * ships only facts — the wording lives in i18n, the same way buildVersionCheck
 * owns the version card's copy.
 */
export interface AdapterInfo {
  /** npm spec codeg installs, e.g. "@agentclientprotocol/codex-acp@1.3.0". */
  adapter_package: string
  /** Command the launch gate resolves, e.g. "codex-acp". */
  adapter_cmd: string
  adapter_installed: boolean
  /** The vendor CLI, e.g. "codex". */
  native_cmd: string
  /** Display name for the vendor CLI, e.g. "Codex CLI". */
  native_label: string
  /** Where the user's own vendor CLI was found. codeg never launches it. */
  native_path: string | null
  /** Config dir both read, so installing the adapter needs no second login. */
  shared_config_dir: string
  docs_url: string
}

export interface PreflightResult {
  agent_type: AgentType
  agent_name: string
  passed: boolean
  checks: CheckItem[]
  /** Null unless this agent is an ACP adapter. Never affects `passed`. */
  adapter: AdapterInfo | null
}

// ─── OpenCode Plugins ───

export type PluginStatus = "installed" | "missing"

export interface PluginInfo {
  name: string
  declared_spec: string
  installed_version: string | null
  status: PluginStatus
}

export interface PluginCheckSummary {
  config_path: string
  cache_dir: string
  plugins: PluginInfo[]
  has_project_config_hint: boolean
}

// ─── OpenCode Provider Catalog (models.dev) ───

/** A model entry under a catalog provider, normalized from models.dev. */
export interface OpenCodeCatalogModel {
  id: string
  name: string
  reasoning: boolean
  tool_call: boolean
  context: number | null
  cost_in: number | null
  cost_out: number | null
}

/**
 * One provider from the models.dev catalog (the same registry OpenCode reads).
 * `auth_kind` is `"oauth"` for providers OpenCode signs into via a browser flow
 * (ChatGPT, GitHub Copilot, GitLab Duo), `"api"` otherwise.
 */
export interface OpenCodeCatalogProvider {
  id: string
  name: string
  npm: string | null
  env: string[]
  doc: string | null
  auth_kind: "api" | "oauth"
  models: OpenCodeCatalogModel[]
}

export type PluginInstallEventKind = "started" | "log" | "completed" | "failed"

export interface PluginInstallEvent {
  task_id: string
  kind: PluginInstallEventKind
  payload: string
}

export type AgentInstallEventKind = "started" | "log" | "completed" | "failed"

export interface AgentInstallEvent {
  task_id: string
  kind: AgentInstallEventKind
  payload: string
}

export type OfficecliInstallEventKind =
  | "started"
  | "log"
  | "completed"
  | "failed"

export interface OfficecliInstallEvent {
  task_id: string
  kind: OfficecliInstallEventKind
  payload: string
}

// ─── Chat Channels ───

export type ChannelType = "lark" | "telegram" | "weixin"

/** One configured event-notification webhook sink. */
export interface WebhookConfig {
  url: string
  enabled: boolean
}

export type ChannelConnectionStatus =
  | "connected"
  | "connecting"
  | "disconnected"
  | "error"

export interface ChatChannelInfo {
  id: number
  name: string
  channel_type: ChannelType
  enabled: boolean
  config_json: string
  event_filter_json: string | null
  daily_report_enabled: boolean
  daily_report_time: string | null
  created_at: string
  updated_at: string
}

export interface ChannelStatusInfo {
  channel_id: number
  name: string
  channel_type: ChannelType
  status: ChannelConnectionStatus
}

export interface ChatChannelMessageLog {
  id: number
  channel_id: number
  direction: "outbound" | "inbound"
  message_type: string
  content_preview: string
  status: "sent" | "failed"
  error_detail: string | null
  created_at: string
}

export interface ModelProviderInfo {
  id: number
  name: string
  api_url: string
  api_key: string
  api_key_masked: string
  agent_type: AgentType
  /**
   * Model value, interpretation depends on agent_type:
   * - claude_code: JSON string of {main, reasoning, haiku, sonnet, opus}
   * - codex / gemini / others: plain model name string
   */
  model: string | null
  created_at: string
  updated_at: string
}

/** Result of `updateModelProvider` (mirror of Rust `UpdateModelProviderResult`):
 *  the updated provider plus how many running sessions the credential/model
 *  cascade left on stale (launch-time) config — for the settings-side
 *  "N sessions need restart" toast. */
export interface UpdateModelProviderResult {
  provider: ModelProviderInfo
  affectedRunningSessions: number
}

export interface ClaudeProviderModel {
  main?: string
  reasoning?: string
  haiku?: string
  sonnet?: string
  opus?: string
  /** ANTHROPIC_CUSTOM_MODEL_OPTION — id of a custom entry appended to the
   *  in-session /model picker (e.g. a model the gateway serves). */
  customOption?: string
  /** ANTHROPIC_CUSTOM_MODEL_OPTION_NAME — display name for that entry. */
  customOptionName?: string
  /** ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION — description for that entry. */
  customOptionDescription?: string
}

export function parseClaudeProviderModel(
  raw: string | null
): ClaudeProviderModel {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return {}
    const out: ClaudeProviderModel = {}
    const keys: (keyof ClaudeProviderModel)[] = [
      "main",
      "reasoning",
      "haiku",
      "sonnet",
      "opus",
      "customOption",
      "customOptionName",
      "customOptionDescription",
    ]
    for (const k of keys) {
      const v = (parsed as Record<string, unknown>)[k]
      if (typeof v === "string" && v.trim()) out[k] = v.trim()
    }
    return out
  } catch {
    return {}
  }
}

export function serializeClaudeProviderModel(
  obj: ClaudeProviderModel
): string | null {
  const cleaned: ClaudeProviderModel = {}
  if (obj.main?.trim()) cleaned.main = obj.main.trim()
  if (obj.reasoning?.trim()) cleaned.reasoning = obj.reasoning.trim()
  if (obj.haiku?.trim()) cleaned.haiku = obj.haiku.trim()
  if (obj.sonnet?.trim()) cleaned.sonnet = obj.sonnet.trim()
  if (obj.opus?.trim()) cleaned.opus = obj.opus.trim()
  if (obj.customOption?.trim()) cleaned.customOption = obj.customOption.trim()
  if (obj.customOptionName?.trim())
    cleaned.customOptionName = obj.customOptionName.trim()
  if (obj.customOptionDescription?.trim())
    cleaned.customOptionDescription = obj.customOptionDescription.trim()
  return Object.keys(cleaned).length === 0 ? null : JSON.stringify(cleaned)
}

// ── Codex structured model catalog ──
//
// Codex custom models are stored as a compact list (each entry = a snapshot
// `base` slug + sparse `overrides`) inside the same single `model` string
// column used for Claude. The backend expands each entry into a full codex
// `ModelInfo` (cloning `base` from the bundled snapshot, forcing
// `visibility:"list"` + `supported_in_api:true`) and writes a
// `model_catalog_json` file. See src-tauri/src/acp/codex_model_catalog.rs.

/** A codex `ModelInfo` entry (from `codex debug models`). Friendly fields are
 *  typed; the rest stay opaque for the advanced editor + catalog cloning. */
export interface CodexModelInfo {
  slug: string
  display_name?: string
  description?: string | null
  context_window?: number | null
  max_context_window?: number | null
  visibility?: string
  [key: string]: unknown
}

/** One user-configured **custom** codex model, stored compactly. Heavy
 *  ModelInfo fields are cloned from `base` (a live-catalog slug) at
 *  catalog-generation time; `overrides` holds only fields the user changed. */
export interface CodexCustomEntry {
  slug: string
  displayName?: string
  contextWindow?: number
  base: string
  overrides?: Record<string, unknown>
}

/** The compact codex model config stored in a provider's `model` column / the
 *  codex agent's catalog source sidecar. Mirrors the Rust `CodexModelConfig`.
 *  Official models are auto-included from the live catalog, so only the user's
 *  deviations (custom additions + removed officials) are persisted. */
export interface CodexModelConfig {
  customs: CodexCustomEntry[]
  excludedOfficials?: string[]
  default?: string
}

/** Recursively sort object keys so serialized `overrides` are byte-stable (the
 *  edit dialog diffs `provider.model !== serialize(state)`). */
function sortJsonValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortJsonValue)
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortJsonValue((v as Record<string, unknown>)[k])
    }
    return out
  }
  return v
}

/** Parse one custom entry (new `customs` shape or legacy `models` shape — they
 *  are structurally identical). Returns null for a slug-less entry. */
function parseCustomEntry(m: unknown): CodexCustomEntry | null {
  if (!m || typeof m !== "object") return null
  const e = m as Record<string, unknown>
  const slug = typeof e.slug === "string" ? e.slug.trim() : ""
  if (!slug) return null
  const entry: CodexCustomEntry = {
    slug,
    base: typeof e.base === "string" && e.base.trim() ? e.base.trim() : slug,
  }
  if (typeof e.displayName === "string" && e.displayName.trim())
    entry.displayName = e.displayName.trim()
  if (typeof e.contextWindow === "number" && Number.isFinite(e.contextWindow))
    entry.contextWindow = e.contextWindow
  if (
    e.overrides &&
    typeof e.overrides === "object" &&
    !Array.isArray(e.overrides) &&
    Object.keys(e.overrides as object).length > 0
  ) {
    entry.overrides = e.overrides as Record<string, unknown>
  }
  return entry
}

function legacyBareSlug(raw: string): CodexModelConfig {
  const slug = raw.trim()
  return slug
    ? { customs: [{ slug, base: slug }], default: slug }
    : { customs: [] }
}

/** Parse the compact codex model config, with migration:
 *  - new shape `{customs,excludedOfficials,default}` → parsed;
 *  - legacy `{models}` → each model migrated to a custom;
 *  - a bare slug string → a single custom (matches the Rust `parse_model_config`
 *    back-compat so pre-existing providers keep working). */
export function parseCodexModelConfig(raw: string | null): CodexModelConfig {
  if (!raw || !raw.trim()) return { customs: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return legacyBareSlug(raw)
  }
  if (typeof parsed === "string") return legacyBareSlug(parsed)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return legacyBareSlug(raw)
  }
  const obj = parsed as Record<string, unknown>
  const rawList = Array.isArray(obj.customs)
    ? obj.customs
    : Array.isArray(obj.models)
      ? obj.models
      : null
  const customs: CodexCustomEntry[] = []
  for (const m of rawList ?? []) {
    const entry = parseCustomEntry(m)
    if (entry) customs.push(entry)
  }
  const result: CodexModelConfig = { customs }
  if (Array.isArray(obj.excludedOfficials)) {
    const excluded = obj.excludedOfficials
      .filter((s): s is string => typeof s === "string" && !!s.trim())
      .map((s) => s.trim())
    if (excluded.length) result.excludedOfficials = excluded
  }
  if (typeof obj.default === "string" && obj.default)
    result.default = obj.default
  return result
}

/** Serialize the compact codex model config to canonical JSON (fixed key order,
 *  sorted `overrides` + `excludedOfficials`), or `null` when the user has made
 *  no deviations (no customs, no removed officials). `serialize(parse(x)) === x`
 *  for any canonical `x`, so an unedited form never reports a spurious change. */
export function serializeCodexModelConfig(
  obj: CodexModelConfig
): string | null {
  const customs = (obj.customs ?? [])
    .filter((m) => m.slug && m.slug.trim())
    .map((m) => {
      const entry: Record<string, unknown> = { slug: m.slug.trim() }
      if (m.displayName?.trim()) entry.displayName = m.displayName.trim()
      if (
        typeof m.contextWindow === "number" &&
        Number.isFinite(m.contextWindow)
      )
        entry.contextWindow = m.contextWindow
      entry.base = m.base?.trim() || m.slug.trim()
      if (m.overrides && Object.keys(m.overrides).length > 0)
        entry.overrides = sortJsonValue(m.overrides)
      return entry
    })
  const excluded = Array.from(
    new Set(
      (obj.excludedOfficials ?? [])
        .filter((s) => s && s.trim())
        .map((s) => s.trim())
    )
  ).sort()
  // No deviations from codex's own catalog → feature off.
  if (customs.length === 0 && excluded.length === 0) return null
  const out: Record<string, unknown> = { customs }
  if (excluded.length) out.excludedOfficials = excluded
  // Preserve the user's `default` verbatim (it may name an official the
  // serializer can't see); the backend validates it against the live catalog at
  // expand time and falls back if it names no listed model.
  if (obj.default && obj.default.trim()) out.default = obj.default.trim()
  return JSON.stringify(out)
}

/** Whether a catalog entry is offered in codex's model picker. Codex flips
 *  retired models to `hide` rather than deleting them (they keep an `upgrade`
 *  migration stub), so "official the user can see" always means listable. */
function isListableModel(m: CodexModelInfo): boolean {
  return (m.visibility ?? "list") === "list"
}

/** Drop `excludedOfficials` entries that no longer name a **listable** official.
 *
 *  Codex retires models by flipping them to `visibility:"hide"` (0.147 did this
 *  to `gpt-5.4` / `gpt-5.4-mini`), which turns a past removal into a *ghost*: it
 *  is invisible in the editor yet still counts as a customization, so codeg goes
 *  on replacing codex's whole model table for no benefit. Pruning lets the
 *  config heal itself on the next save.
 *
 *  `officials` empty (catalog still loading, or codex unreachable) means "we
 *  can't tell" — the config is returned untouched so an offline session never
 *  destroys the user's removals. The trade-off when we *can* tell: temporarily
 *  running an older codex that lacks a model forgets that model's removal. That
 *  is rarer and far less harmful than ghosts accumulating forever. */
export function pruneCodexGhostExclusions(
  config: CodexModelConfig,
  officials: CodexModelInfo[]
): CodexModelConfig {
  const excluded = config.excludedOfficials ?? []
  if (!excluded.length || !officials.length) return config
  const listable = new Set(officials.filter(isListableModel).map((m) => m.slug))
  const kept = excluded.filter((slug) => listable.has(slug))
  if (kept.length === excluded.length) return config
  const next: CodexModelConfig = { ...config }
  if (kept.length) next.excludedOfficials = kept
  else delete next.excludedOfficials
  return next
}

/** Whether the user has deviated from codex's own catalog in a way that still
 *  applies — i.e. what actually justifies taking over `model_catalog_json`.
 *  Ghost exclusions (see [[pruneCodexGhostExclusions]]) don't count. */
export function hasCodexCustomization(
  config: CodexModelConfig,
  officials: CodexModelInfo[]
): boolean {
  if (config.customs.length > 0) return true
  return (
    (pruneCodexGhostExclusions(config, officials).excludedOfficials ?? [])
      .length > 0
  )
}

/** ModelInfo overrides that make a cloned GPT entry speak **plain** OpenAI
 *  Responses, for third-party gateways that only implement the public API.
 *
 *  Verified by capturing what codex 0.147 actually puts on the wire: a stock
 *  `gpt-5.6-sol` sends `tools: []` plus a non-standard `additional_tools`
 *  developer input item, no `instructions`, and `reasoning.context` — nothing a
 *  compatible endpoint can serve. With these overrides the same request becomes
 *  standard: `instructions` + a plain `function` tool array + `reasoning:
 *  {effort}`. `apply_patch_tool_type:null` additionally drops the
 *  `type:"custom"` freeform-grammar tool.
 *
 *  Not included on purpose: the residual `tool_search` / `web_search` /
 *  `namespace` tools come from codex's global feature flags, not from ModelInfo,
 *  so a per-model template cannot (and shouldn't) touch them. */
export const CODEX_COMPAT_OVERRIDES: Record<string, unknown> = {
  tool_mode: null,
  multi_agent_version: null,
  use_responses_lite: false,
  apply_patch_tool_type: null,
  supports_image_detail_original: false,
}

/** Apply (or clear) the compatibility bundle on an entry's overrides, keeping
 *  the sparse-write rule the editor uses everywhere: a value equal to the clone
 *  base carries no override, so `serialize` stays byte-stable. Overrides outside
 *  the bundle are left alone. Clearing drops the bundle keys so each field falls
 *  back to the base again. */
export function applyCodexCompatOverrides(
  entry: CodexCustomEntry,
  base: Record<string, unknown>,
  enabled: boolean
): Record<string, unknown> | undefined {
  const next = { ...(entry.overrides ?? {}) }
  for (const [key, value] of Object.entries(CODEX_COMPAT_OVERRIDES)) {
    if (!enabled || Object.is(value, base[key])) delete next[key]
    else next[key] = value
  }
  return Object.keys(next).length ? next : undefined
}

/** Whether an entry's **effective** values (override, else clone base) match the
 *  compatibility bundle. Derived rather than stored, so the persisted shape
 *  stays "sparse overrides only" — and a base that already ships a compat value
 *  (e.g. `gpt-5.2` has `use_responses_lite:false`) still reads as compatible
 *  even though no override records it. */
export function isCodexCompatEntry(
  entry: CodexCustomEntry,
  base: Record<string, unknown>
): boolean {
  const overrides = entry.overrides ?? {}
  return Object.entries(CODEX_COMPAT_OVERRIDES).every(([key, value]) =>
    Object.is(key in overrides ? overrides[key] : base[key], value)
  )
}
