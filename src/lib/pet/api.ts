// Transport-aware bindings for the pet command surface.
// All functions go through `getTransport().call(...)` so the same code runs
// in Tauri (`invoke`) and standalone-server (`fetch`) modes.

import { getShellTransport, getTransport } from "@/lib/transport"
import type { PetState } from "@/lib/pet/animation"
import type {
  ImportablePet,
  ImportCodexPetsRequest,
  ImportCodexPetsResult,
  MarketplaceInstallRequest,
  MarketplaceInstallResponse,
  MarketplaceListParams,
  MarketplaceListResponse,
  NewPetInput,
  PetCodexImportAvailability,
  PetDetail,
  PetMetaPatch,
  PetSessionsPayload,
  PetSpriteAsset,
  PetSummary,
  PetWindowConfig,
  PetWindowStatePatch,
} from "./types"

export async function listPets(): Promise<PetSummary[]> {
  return getTransport().call("pet_list")
}

export async function getPet(id: string): Promise<PetDetail> {
  return getTransport().call("pet_get", { id })
}

export async function readPetSpritesheet(id: string): Promise<PetSpriteAsset> {
  return getTransport().call("pet_read_spritesheet", { id })
}

export async function addPet(input: NewPetInput): Promise<PetSummary> {
  return getTransport().call("pet_add", { ...input })
}

export async function updatePetMeta(
  id: string,
  patch: PetMetaPatch
): Promise<PetSummary> {
  return getTransport().call("pet_update_meta", { id, patch })
}

export async function replacePetSprite(
  id: string,
  spritesheetBase64: string
): Promise<void> {
  return getTransport().call("pet_replace_sprite", { id, spritesheetBase64 })
}

export async function deletePet(id: string): Promise<void> {
  return getTransport().call("pet_delete", { id })
}

export async function listImportableCodexPets(): Promise<ImportablePet[]> {
  return getTransport().call("pet_list_importable_codex")
}

export async function importCodexPets(
  request: ImportCodexPetsRequest
): Promise<ImportCodexPetsResult> {
  return getTransport().call("pet_import_codex", { ...request })
}

export async function isCodexImportAvailable(): Promise<PetCodexImportAvailability> {
  return getTransport().call("pet_codex_import_available")
}

export async function listMarketplacePets(
  params: MarketplaceListParams
): Promise<MarketplaceListResponse> {
  return getTransport().call("pet_marketplace_list", { ...params })
}

export async function installMarketplacePet(
  request: MarketplaceInstallRequest
): Promise<MarketplaceInstallResponse> {
  return getTransport().call("pet_marketplace_install", { ...request })
}

// Proxy a marketplace image (poster / preview / spritesheet) through the
// backend. The webview can't always reach codex-pets.net directly, but the
// backend can, so it fetches the bytes and returns them as `{ mime, dataBase64 }`
// (same shape as `readPetSpritesheet`) for the renderer to turn into a blob URL.
export async function fetchMarketplaceAsset(
  url: string
): Promise<PetSpriteAsset> {
  return getTransport().call("pet_marketplace_asset", { url })
}

export async function getPetSettings(): Promise<PetWindowConfig> {
  return getTransport().call("pet_get_settings")
}

export async function setActivePet(
  petId: string | null
): Promise<PetWindowConfig> {
  return getTransport().call("pet_set_active", { petId })
}

export async function savePetWindowState(
  patch: PetWindowStatePatch
): Promise<PetWindowConfig> {
  return getTransport().call("pet_save_window_state", { ...patch })
}

// Manual oneshot trigger for events the backend can't observe directly
// (e.g. merge-completed, which is emitted only from the renderer). The
// backend forwards the request as a `pet://oneshot` event so the pet
// window animates regardless of which transport the user is on.
//
// Mirrors Rust `PetCelebrationKind`: only the three transient cues that
// the renderer actually plays are accepted at the API boundary.
export type PetCelebrationKind = "jumping" | "waving" | "failed"

export async function petCelebrate(kind: PetCelebrationKind): Promise<void> {
  return getTransport().call("pet_celebrate", { kind })
}

// Snapshot of the current ambient pet state. The mapper only emits
// `pet://state` on transitions, so a window mounted *after* the agent
// already started prompting would otherwise sit on the default `idle`.
// `usePetState` calls this on mount to fill in the gap.
export async function getCurrentPetState(): Promise<PetState> {
  return getTransport().call("pet_get_current_state")
}

// Snapshot of all active agent sessions (prompting / awaiting permission /
// errored) with their conversation titles and any pending permission. The
// sprite badge + panel call this on mount; live updates arrive on the
// `pet://sessions` event. Counts follow the ambient precedence (a
// permission-blocked session counts as waiting, not running).
export async function listActivePetSessions(): Promise<PetSessionsPayload> {
  return getTransport().call("pet_list_active_sessions")
}

// Tauri-only — these target the local desktop shell (never a remote
// codeg-server, even when invoked from a remote-workspace desktop window).
// Callers should branch on `isDesktop()` before invoking them.
export async function openPetWindow(): Promise<void> {
  return getShellTransport().call("open_pet_window")
}

export async function closePetWindow(): Promise<void> {
  return getShellTransport().call("close_pet_window")
}

export async function isPetWindowOpen(): Promise<boolean> {
  return getShellTransport().call("is_pet_window_open")
}

export async function recordPetWindowPosition(
  x: number,
  y: number
): Promise<void> {
  return getTransport().call("pet_window_record_position", { x, y })
}

// Toggle the session panel anchored next to the sprite (open if closed, close
// if open). Tauri-only. The backend guards the toggle-vs-blur race so a tap
// that dismissed the panel via click-away doesn't immediately reopen it.
export async function togglePetPanel(): Promise<void> {
  return getTransport().call("toggle_pet_panel")
}

export async function closePetPanel(): Promise<void> {
  return getTransport().call("close_pet_panel")
}

// Resize the open session panel to fit its measured content height (logical
// px) and re-anchor it to the sprite. Tauri-only; the panel renderer calls
// this after layout so the window hugs its content instead of leaving dead
// space. No-op on the backend if the panel isn't open.
export async function resizePetPanel(height: number): Promise<void> {
  return getTransport().call("resize_pet_panel", { height })
}

// Bring the main workspace forward and focus a conversation, without reloading
// it (the main window's PetFocusBridge calls openTab). `agent` is the
// snake_case AgentType. Tauri-only.
export async function focusConversation(
  folderId: number,
  conversationId: number,
  agent: string
): Promise<void> {
  return getTransport().call("focus_conversation", {
    folderId,
    conversationId,
    agent,
  })
}

export interface PetMenuLabels {
  scale: string
  openManager: string
  close: string
}

/** Pop up the native right-click context menu. Tauri-only; in web mode the
 * pet route doesn't render a context menu at all (no window to manage). */
export async function showPetContextMenu(
  labels: PetMenuLabels,
  x: number,
  y: number
): Promise<void> {
  return getTransport().call("pet_show_context_menu", { labels, x, y })
}

// Slug a free-form display name into a pet id. Mirrors the backend's
// validate_pet_id rules: lowercase ASCII, digits, '-' and '_'. Used as a
// suggestion when adding a pet — the user can override.
export function slugifyPetId(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
}
