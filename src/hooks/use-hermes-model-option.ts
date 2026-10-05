"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { acpHermesModelOptions, acpSetHermesModel } from "@/lib/api"
import { isModelConfigOption } from "@/lib/model-config-groups"
import { subscribe } from "@/lib/platform"
import type {
  AgentType,
  ConnectionStatus,
  HermesModelOptions,
  SessionConfigOptionInfo,
} from "@/lib/types"

/**
 * Id of the synthetic model option this hook contributes to the composer.
 *
 * The `codeg:` prefix marks it as codeg's own so the composer's change handler
 * routes it to the Hermes writer. It must never reach the backend's
 * `session/set_config_option` — Hermes advertises no such option and would
 * reject the id.
 */
export const HERMES_MODEL_CONFIG_ID = "codeg:hermes-model"

/**
 * Per-agent cache of the last successful lookup, so opening a second tab on the
 * same Hermes profile doesn't re-list the provider's catalogue (OpenRouter's is
 * hundreds of rows). Keyed by agent type because that is what resolves the
 * profile's HERMES_HOME.
 *
 * Dropped wholesale whenever agent settings change — see `agentsUpdatedEvent`.
 * The catalogue belongs to ONE provider (the profile's `model.provider`), so a
 * provider switch in the settings window invalidates every row of it. Serving
 * the old provider's models after that is the worst possible failure: the list
 * looks fine, and the user only learns it was wrong when a send is rejected.
 */
const optionsCache = new Map<AgentType, HermesModelOptions>()

/**
 * The agent-settings-changed signal, as a subscribable store.
 *
 * Settings live in their own window, so a provider or API-key change reaches
 * the composer only over this event (the backend emits it on every Hermes
 * config write). ONE module-level subscription serves every mounted composer —
 * the per-consumer subscription this would otherwise need is exactly the
 * duplicate-fetch problem `use-acp-agents` had to coalesce away.
 */
const agentsUpdatedEvent = (() => {
  const ACP_AGENTS_UPDATED_EVENT = "app://acp-agents-updated"
  const listeners = new Set<() => void>()
  let started = false
  let generation = 0
  const start = () => {
    if (started) return
    started = true
    void subscribe<unknown>(ACP_AGENTS_UPDATED_EVENT, () => {
      optionsCache.clear()
      generation += 1
      for (const listener of listeners) listener()
    })
  }
  return {
    getGeneration: () => generation,
    subscribe(listener: () => void) {
      start()
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
})()

/**
 * The composer's model picker for Hermes agents — the built-in entry and every
 * custom profile registered against Hermes' own CLI.
 *
 * WHY this exists at all: every other agent's model picker comes from the ACP
 * `configOptions` its agent advertises. Hermes advertises none — its model
 * lives in `model.default` of the profile's own `config.yaml`, read once at
 * process start — so the composer showed no model control for it. This reads
 * that file, lists the provider's catalogue, and synthesizes the option the
 * composer already knows how to render.
 *
 * `selectModel` writes the file and then reconnects to apply it, because a
 * running Hermes process cannot be re-pointed at another model. The reconnect
 * waits for the current turn to finish — cutting a turn off mid-answer to
 * change a setting would lose the answer.
 */
export function useHermesModelOption(args: {
  agentType: AgentType
  /** The agent's own ACP options. An agent that advertises a model selector
   *  owns it; this hook then contributes nothing. */
  configOptions: SessionConfigOptionInfo[]
  /** Live connection status, used to defer the reconnect past a running turn. */
  status: ConnectionStatus | null
  /** Reconnects the session so the agent re-reads its config (`reapplyConfig`). */
  reapplyConfig: () => Promise<boolean>
  /** False for viewers and delegation children — they don't own the process,
   *  so reconnecting isn't theirs to do (mirrors the stale-config banner). */
  canReconnect: boolean
}): {
  /** The synthetic option to merge into the composer's list, or null. */
  option: SessionConfigOptionInfo | null
  /** Handles a pick on `HERMES_MODEL_CONFIG_ID`. */
  selectModel: (model: string) => void
} {
  const { agentType, configOptions, status, reapplyConfig, canReconnect } = args
  const t = useTranslations("Folder.chat.hermesModel")
  // Bumped when agent settings change; re-runs the lookup below against the
  // newly selected provider.
  const generation = useSyncExternalStore(
    agentsUpdatedEvent.subscribe,
    agentsUpdatedEvent.getGeneration,
    agentsUpdatedEvent.getGeneration
  )
  // Stamped with the agent it describes, and read back through that stamp, so
  // retargeting a tab to another agent can never show the previous agent's
  // model for a frame — and needs no state reset on the way through.
  const [stored, setStored] = useState<{
    agentType: AgentType
    generation: number
    options: HermesModelOptions
  } | null>(null)
  // The stamp carries the generation too: a settings change must not leave the
  // previous provider's catalogue on screen while the new one is being fetched.
  const options =
    stored?.agentType === agentType && stored.generation === generation
      ? stored.options
      : (optionsCache.get(agentType) ?? null)

  // An agent that advertises its own model selector owns it — never shadow it.
  const agentOwnsModelOption = configOptions.some(isModelConfigOption)

  useEffect(() => {
    if (agentOwnsModelOption) return
    if (optionsCache.has(agentType)) return
    let cancelled = false
    acpHermesModelOptions(agentType)
      .then((result) => {
        if (cancelled || !result) return
        optionsCache.set(agentType, result)
        setStored({ agentType, generation, options: result })
      })
      .catch((e: unknown) => {
        // A lookup failure costs a picker, never a session — the composer keeps
        // rendering everything else.
        console.error("[HermesModel] options:", e)
      })
    return () => {
      cancelled = true
    }
  }, [agentType, agentOwnsModelOption, generation])

  // A reconnect requested while a turn was in flight, applied once it settles.
  const pendingReconnectRef = useRef(false)
  const reapplyConfigRef = useRef(reapplyConfig)
  useEffect(() => {
    reapplyConfigRef.current = reapplyConfig
  }, [reapplyConfig])
  // Read through a ref, never the closure: the write is async, so a turn that
  // finishes while it is in flight would leave a captured "prompting" behind.
  // Acting on that stale value parks the reconnect waiting for a transition
  // that already happened — the new model would then sit unapplied until the
  // user happened to run another turn.
  const statusRef = useRef(status)
  useEffect(() => {
    statusRef.current = status
  }, [status])

  const reconnect = useCallback(() => {
    reapplyConfigRef
      .current()
      .then((reconnected) => {
        if (reconnected) toast.success(t("applied"))
      })
      .catch((e: unknown) => {
        toast.error(t("applyFailed"), {
          description: e instanceof Error ? e.message : String(e),
        })
      })
  }, [t])

  useEffect(() => {
    if (!pendingReconnectRef.current) return
    if (status === "prompting") return
    pendingReconnectRef.current = false
    reconnect()
  }, [status, reconnect])

  const selectModel = useCallback(
    (model: string) => {
      const previous = optionsCache.get(agentType) ?? options
      // Optimistic: the picker must show the pick immediately, or it reads as a
      // dropped click during the write + reconnect.
      const next: HermesModelOptions = {
        current_model: model,
        models: previous?.models ?? [],
        error: previous?.error ?? null,
      }
      optionsCache.set(agentType, next)
      setStored({ agentType, generation, options: next })

      acpSetHermesModel({ agentType, model })
        .then(() => {
          if (!canReconnect) return
          // The file is written; a running Hermes still holds the old model.
          if (statusRef.current === "prompting") {
            pendingReconnectRef.current = true
            toast.info(t("appliesAfterTurn"))
            return
          }
          reconnect()
        })
        .catch((e: unknown) => {
          // Put the real model back — leaving the optimistic value would have
          // the composer name a model the agent is not on.
          if (previous) {
            optionsCache.set(agentType, previous)
            setStored({ agentType, generation, options: previous })
          } else {
            optionsCache.delete(agentType)
            setStored(null)
          }
          toast.error(t("saveFailed"), {
            description: e instanceof Error ? e.message : String(e),
          })
        })
    },
    [agentType, canReconnect, generation, options, reconnect, t]
  )

  const option = useMemo<SessionConfigOptionInfo | null>(() => {
    if (agentOwnsModelOption || !options) return null
    const current = options.current_model ?? ""
    // The current model always appears, even when it is missing from the
    // provider's list (a stale id, or a list codeg could not fetch) — a picker
    // whose selected value has no row shows a blank trigger.
    const values = options.models.includes(current)
      ? options.models
      : current
        ? [current, ...options.models]
        : options.models
    if (values.length === 0) return null
    return {
      id: HERMES_MODEL_CONFIG_ID,
      name: t("label"),
      description: options.error ?? null,
      // Drives the composer's `provider/`-prefix grouping and its searchable
      // long-list picker, same as an agent-advertised model option.
      category: "model",
      kind: {
        type: "select",
        current_value: current,
        options: values.map((value) => ({ value, name: value })),
        groups: [],
      },
    }
  }, [agentOwnsModelOption, options, t])

  return { option, selectModel }
}
