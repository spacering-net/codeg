import type {
  BuiltinProviderInfo,
  ModelProviderDraft,
  ModelProviderRecord,
  ProbeOutcome,
  ProbeParams,
  SaveResult,
  TestOutcome,
} from "./model-provider-types"

/**
 * The full surface the Model Providers settings UI talks to. Today it is backed
 * by an in-memory mock store (`src/stores/model-provider-mock.ts`) so the page
 * is fully interactive without the backend; the transport-backed implementation
 * (Tauri command / Axum endpoint, same payloads) swaps in later by returning a
 * different `ModelProviderService` from `useModelProviderService()`.
 *
 * Error convention: `create`/`update`/`remove` reject with plain user-facing
 * messages (e.g. an id collision).
 */
export interface ModelProviderService {
  list(): Promise<ModelProviderRecord[]>
  listBuiltins(): Promise<BuiltinProviderInfo[]>
  create(draft: ModelProviderDraft): Promise<SaveResult>
  update(draft: ModelProviderDraft): Promise<SaveResult>
  remove(providerId: string): Promise<void>
  setEnabled(providerId: string, enabled: boolean): Promise<void>
  reorder(providerIds: string[]): Promise<void>
  probe(params: ProbeParams): Promise<ProbeOutcome>
  test(
    providerId: string,
    modelId: string,
    apiKey?: string
  ): Promise<TestOutcome>
  /** Copy a built-in into an editable draft. Credentials are never copied: the
   *  API key always comes back blank for the user to fill in. */
  cloneBuiltin(builtinId: string): Promise<ModelProviderDraft>
}
