// Mirrors of the Rust pet types used over `getTransport().call(...)`. Kept
// in their own file so the animation runtime can import them without pulling
// in the API layer.

import type {
  AgentType,
  ConnectionStatus,
  PermissionOptionInfo,
} from "@/lib/types"

export interface PetSummary {
  id: string
  displayName: string
  description: string | null
  spritesheetPath: string
}

export interface PetDetail {
  id: string
  displayName: string
  description: string | null
  spritesheetPath: string
}

export interface PetSpriteAsset {
  mime: string
  dataBase64: string
}

export interface NewPetInput {
  id: string
  displayName: string
  description?: string | null
  spritesheetBase64: string
}

export interface PetMetaPatch {
  displayName?: string
  // Two-level optional matches the Rust `Option<Option<String>>`. Sending
  // `null` clears the description; omitting the key leaves it untouched.
  description?: string | null
}

export interface PetWindowConfig {
  enabled: boolean
  activePetId: string | null
  x: number | null
  y: number | null
  scale: number
  alwaysOnTop: boolean
}

export interface PetWindowStatePatch {
  x?: number
  y?: number
  scale?: number
  alwaysOnTop?: boolean
  enabled?: boolean
}

export interface ImportablePet {
  id: string
  displayName: string
  description: string | null
  sourcePath: string
  alreadyImported: boolean
}

export interface ImportCodexPetsRequest {
  ids?: string[]
  overwriteWithSuffix?: boolean
}

export interface ImportCodexPetsResult {
  importedIds: string[]
  skipped: ImportSkipped[]
}

export interface ImportSkipped {
  sourceId: string
  reason: string
}

export interface PetCodexImportAvailability {
  available: boolean
}

export interface MarketplacePet {
  id: string
  displayName: string
  description: string
  kind?: string
  tags: string[]
  ownerName?: string
  ownerHandle?: string
  viewCount: number
  downloadCount: number
  likeCount: number
  uploadedAt?: string
  posterUrl?: string
  previewUrl?: string
  downloadUrl: string
  alreadyInstalled: boolean
}

export interface MarketplaceListParams {
  page?: number
  pageSize?: number
  q?: string
  kind?: string
  sort?: string
  tags?: string[]
}

export interface MarketplaceListResponse {
  pets: MarketplacePet[]
  page: number
  pageSize: number
  total: number
  totalPages: number
}

export interface MarketplaceInstallRequest {
  id: string
  downloadUrl: string
  overwrite?: boolean
}

export interface MarketplaceInstallResponse {
  pet: PetSummary
}

// ─── active-session list (pet panel) ────────────────────────────────────

/** Compact pending-permission view shown in the pet panel. `toolCall` is the
 *  agent's raw JSON (same as the main dialog) so `parsePermissionToolCall` can
 *  render the command / diff / plan preview. Mirrors Rust `PetPermissionSummary`. */
export interface PetPermissionSummary {
  requestId: string
  toolCall: unknown
  options: PermissionOptionInfo[]
}

/** Where a delegation sub-agent row belongs — set only on rows the backend kept
 *  because the sub-agent is blocked on the user. A child is never openable as a
 *  tab, so the row jumps to the conversation that delegated it and names that
 *  parent. Mirrors Rust `PetParentRef`. */
export interface PetParentRef {
  conversationId: number
  folderId: number
  agentType: AgentType
  title: string
}

/** One active agent session row. Mirrors Rust `PetSessionEntry`. */
export interface PetSessionEntry {
  connectionId: string
  conversationId: number
  folderId: number
  agentType: AgentType
  title: string
  status: ConnectionStatus
  pending?: PetPermissionSummary
  /** Present iff this row is a delegation sub-agent (see `PetParentRef`). */
  parent?: PetParentRef
  /** The assistant a delegation sub-agent runs as, by the name it started
   *  with. Mirrors Rust `PetSessionEntry.assistant_name`. */
  assistantName?: string
}

/** Aggregate payload for the `pet://sessions` event + `pet_list_active_sessions`
 *  snapshot. Counts follow the ambient precedence (a permission-blocked session
 *  is `waiting`, not `running`). Mirrors Rust `PetSessionsPayload`. */
export interface PetSessionsPayload {
  runningCount: number
  waitingCount: number
  errorCount: number
  sessions: PetSessionEntry[]
}
