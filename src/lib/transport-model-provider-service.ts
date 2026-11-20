import { getTransport } from "./transport"
import type { ModelProviderService } from "./model-provider-service"
import type {
  BuiltinProviderInfo,
  ModelProviderDraft,
  ModelProviderRecord,
  ProbeOutcome,
  ProbeParams,
  SaveResult,
  TestOutcome,
} from "./model-provider-types"

function normalizeProbe(value: ProbeOutcome): ProbeOutcome {
  if (value.ok) return { ok: true, models: value.models ?? [] }
  return { ok: false, error: value.error ?? "Unknown probe error" }
}

function normalizeTest(value: TestOutcome): TestOutcome {
  if (value.ok) return { ok: true, reply: value.reply ?? "" }
  return { ok: false, error: value.error ?? "Unknown test error" }
}

export function createTransportModelProviderService(): ModelProviderService {
  const transport = getTransport()
  return {
    list: () => transport.call<ModelProviderRecord[]>("model_provider_list"),
    listBuiltins: () =>
      transport.call<BuiltinProviderInfo[]>("model_provider_builtin_list"),
    create: (draft) =>
      transport.call<SaveResult>("model_provider_create", { draft }),
    update: (draft) =>
      transport.call<SaveResult>("model_provider_update", { draft }),
    remove: (providerId) =>
      transport.call<void>("model_provider_delete", { providerId }),
    setEnabled: (providerId, enabled) =>
      transport.call<void>("model_provider_set_enabled", {
        providerId,
        enabled,
      }),
    reorder: (providerIds) =>
      transport.call<void>("model_provider_reorder", { providerIds }),
    probe: (params: ProbeParams) =>
      transport
        .call<ProbeOutcome>("model_provider_probe", { params })
        .then(normalizeProbe),
    test: (providerId, modelId, apiKey) =>
      transport
        .call<TestOutcome>("model_provider_test", {
          providerId,
          modelId,
          apiKey,
        })
        .then(normalizeTest),
    cloneBuiltin: (builtinId) =>
      transport.call<ModelProviderDraft>("model_provider_clone_builtin", {
        builtinId,
      }),
  }
}
