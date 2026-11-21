"use client"

import {
  createContext,
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { Puzzle } from "lucide-react"
import * as nextIntl from "next-intl"
import { HostPluginSurface } from "@/components/host-plugin-surface"
import type {
  AdaptedContentPart,
  AdaptedPluginTimelineReplacementPart,
  AdaptedToolCallPart,
} from "@/lib/adapters/ai-elements-adapter"
import {
  prepareTimelineTransformItem,
  runPluginTimelineTransforms,
  selectPluginTimelineTransformers,
  useHostPlugins,
  usePluginHostScope,
  type InstalledPlugin,
  type PluginTimelineTransformOutcome,
  type ResolvedPluginTimelineTransformer,
  type TimelineSourceItem,
  type TimelineSourceType,
  type TimelineTransformPhase,
} from "@/lib/host-plugins"
import type { Transport } from "@/lib/transport"

const DEFAULT_STREAMING_DEBOUNCE_MS = 120

function useFallbackLocale(): string {
  return "en"
}

const useOptionalLocale =
  typeof (nextIntl as { useLocale?: () => string }).useLocale === "function"
    ? (nextIntl as { useLocale: () => string }).useLocale
    : useFallbackLocale

export interface PluginTimelineTransformContextValue {
  conversationId: number | null
  enabled: boolean
  plugins: readonly InstalledPlugin[] | undefined
  transport: Transport | null
  scopeKey: string
  transportReady: boolean
  streamingDebounceMs: number
}

const PluginTimelineTransformContext =
  createContext<PluginTimelineTransformContextValue | null>(null)

export interface PluginTimelineTransformProviderProps {
  conversationId: number | null
  enabled?: boolean
  streamingDebounceMs?: number
  children: ReactNode
}

/**
 * Shares a single host-plugin catalog subscription and conversation scope
 * across an entire message thread so per-turn timeline transforms never fan
 * out redundant `host_plugins_list` RPCs.
 */
export function PluginTimelineTransformProvider({
  conversationId,
  enabled = true,
  streamingDebounceMs = DEFAULT_STREAMING_DEBOUNCE_MS,
  children,
}: PluginTimelineTransformProviderProps) {
  const scope = usePluginHostScope()
  const activeEnabled = enabled && scope.transportReady
  const { data: plugins, transport } = useHostPlugins(activeEnabled)

  const value = useMemo<PluginTimelineTransformContextValue>(
    () => ({
      conversationId,
      enabled: activeEnabled,
      plugins,
      transport,
      scopeKey: scope.scopeKey,
      transportReady: scope.transportReady,
      streamingDebounceMs,
    }),
    [
      activeEnabled,
      conversationId,
      plugins,
      scope.scopeKey,
      scope.transportReady,
      streamingDebounceMs,
      transport,
    ]
  )

  return (
    <PluginTimelineTransformContext.Provider value={value}>
      {children}
    </PluginTimelineTransformContext.Provider>
  )
}

function usePluginTimelineTransformContext(
  skip: boolean
): PluginTimelineTransformContextValue {
  const provided = useContext(PluginTimelineTransformContext)
  const fallbackEnabled = !provided && !skip
  const scope = usePluginHostScope()
  const { data: fallbackPlugins, transport: fallbackTransport } =
    useHostPlugins(fallbackEnabled && scope.transportReady)

  return useMemo(() => {
    if (provided) return provided
    return {
      conversationId: null,
      enabled: fallbackEnabled && scope.transportReady,
      plugins: fallbackPlugins,
      transport: fallbackTransport,
      scopeKey: scope.scopeKey,
      transportReady: scope.transportReady,
      streamingDebounceMs: DEFAULT_STREAMING_DEBOUNCE_MS,
    }
  }, [
    fallbackEnabled,
    fallbackPlugins,
    fallbackTransport,
    provided,
    scope.scopeKey,
    scope.transportReady,
  ])
}

function parseToolPayload(raw: string | null | undefined): unknown {
  if (raw == null) return undefined
  const trimmed = raw.trim()
  if (
    trimmed.length > 0 &&
    (trimmed.startsWith("{") || trimmed.startsWith("["))
  ) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return raw
    }
  }
  return raw
}

function isToolCallLive(
  part: AdaptedToolCallPart,
  isStreaming: boolean
): boolean {
  if (!isStreaming) return false
  return (
    part.state === "input-streaming" ||
    part.state === "input-available" ||
    part.toolStatus === "pending" ||
    part.toolStatus === "in_progress" ||
    part.toolStatus === "running"
  )
}

function deriveToolCallStatus(
  part: AdaptedToolCallPart,
  live: boolean
): string {
  const explicit = part.toolStatus?.trim()
  if (explicit) return explicit
  if (part.state === "output-error") return "failed"
  if (part.state === "output-available" && !live) return "completed"
  return "running"
}

function deriveReplacementStepStatus(
  part: AdaptedToolCallPart,
  live: boolean
): "running" | "succeeded" | "failed" {
  if (part.state === "output-error") return "failed"
  if (live) return "running"
  return "succeeded"
}

function buildToolCallSourceItem(
  part: AdaptedToolCallPart,
  live: boolean
): TimelineSourceItem {
  const rawInput = parseToolPayload(part.input)
  const rawOutput = parseToolPayload(
    part.output != null ? part.output : part.errorText
  )
  return {
    id: part.toolCallId,
    toolName: part.toolName,
    status: deriveToolCallStatus(part, live),
    ...(rawInput !== undefined ? { rawInput } : {}),
    ...(rawOutput !== undefined ? { rawOutput } : {}),
  }
}

interface TransformCandidate {
  partIndex: number
  sourceItemId: string
  itemType: TimelineSourceType
  phase: TimelineTransformPhase
  sourceStatus?: "running" | "succeeded" | "failed"
  wireItem: TimelineSourceItem
  transformers: ResolvedPluginTimelineTransformer[]
  snapshotKey: string
}

interface StoredRowOutcome {
  snapshotKey: string
  outcome: PluginTimelineTransformOutcome
}

interface TransformStore {
  transport: Transport | null
  scopeKey: string
  conversationId: number | null
  rows: Record<string, StoredRowOutcome>
}

function transformersSignature(
  transformers: readonly ResolvedPluginTimelineTransformer[]
): string {
  return transformers
    .map(
      (t) =>
        `${t.key}:${t.rendererKind}@${t.rendererVersion}:${t.method}:${t.rendererTitle}`
    )
    .join("|")
}

/**
 * Applies enabled host plugin timeline transformers to an assistant turn's
 * native parts (`tool_call` and `assistant_message`) BEFORE trailing-answer
 * splitting or tool grouping.
 *
 * - Zero RPCs, zero timers, and identity-preserving return when no enabled
 *   transformers exist or the host transport is not ready.
 * - Independent per-row error isolation and streaming snapshot coalescing.
 * - Immediate synchronous withdrawal back to native parts on host/conversation
 *   switch, `Transport` replacement, or plugin disable/removal.
 */
export function useTransformedAssistantParts(
  parts: AdaptedContentPart[],
  isStreaming: boolean,
  options?: { skip?: boolean }
): AdaptedContentPart[] {
  const skip = options?.skip === true
  const locale = useOptionalLocale()
  const {
    conversationId,
    enabled,
    plugins,
    transport,
    scopeKey,
    transportReady,
    streamingDebounceMs,
  } = usePluginTimelineTransformContext(skip)

  const active = !skip && enabled && transportReady && transport !== null

  const allTransformers = useMemo(
    () =>
      active
        ? selectPluginTimelineTransformers(
            plugins,
            undefined,
            undefined,
            locale
          )
        : [],
    [active, locale, plugins]
  )

  const candidates = useMemo<TransformCandidate[]>(() => {
    if (!active || allTransformers.length === 0 || parts.length === 0) {
      return []
    }
    const assistantTransformers = allTransformers.filter(
      (t) => t.itemType === "assistant_message"
    )
    const hasToolTransformers = allTransformers.some(
      (t) => t.itemType === "tool_call"
    )
    const result: TransformCandidate[] = []

    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]!
      if (part.type === "tool-call" && hasToolTransformers) {
        const matched = selectPluginTimelineTransformers(
          plugins,
          "tool_call",
          part.toolName,
          locale
        )
        if (matched.length === 0) continue
        const live = isToolCallLive(part, isStreaming)
        const phase: TimelineTransformPhase = live ? "streaming" : "complete"
        const wireItem = prepareTimelineTransformItem(
          buildToolCallSourceItem(part, live)
        )
        if (!wireItem) continue
        result.push({
          partIndex: index,
          sourceItemId: wireItem.id,
          itemType: "tool_call",
          phase,
          sourceStatus: deriveReplacementStepStatus(part, live),
          wireItem,
          transformers: matched,
          snapshotKey: `${scopeKey}|${conversationId ?? "draft"}|tool_call|${phase}|${locale}|${transformersSignature(matched)}|${JSON.stringify(wireItem)}`,
        })
      } else if (
        part.type === "text" &&
        assistantTransformers.length > 0 &&
        part.text.trim().length > 0
      ) {
        const phase: TimelineTransformPhase = isStreaming
          ? "streaming"
          : "complete"
        const sourceId = `assistant-message:${index}`
        const wireItem = prepareTimelineTransformItem({
          id: sourceId,
          text: part.text,
        })
        if (!wireItem) continue
        result.push({
          partIndex: index,
          sourceItemId: wireItem.id,
          itemType: "assistant_message",
          phase,
          wireItem,
          transformers: assistantTransformers,
          snapshotKey: `${scopeKey}|${conversationId ?? "draft"}|assistant_message|${phase}|${locale}|${transformersSignature(assistantTransformers)}|${JSON.stringify(wireItem)}`,
        })
      }
    }
    return result
  }, [
    active,
    allTransformers,
    conversationId,
    isStreaming,
    locale,
    parts,
    plugins,
    scopeKey,
  ])

  const [store, setStore] = useState<TransformStore>({
    transport: null,
    scopeKey: "",
    conversationId: null,
    rows: {},
  })

  const dispatchedRef = useRef<Map<string, string>>(new Map())
  const generationsRef = useRef<Map<string, number>>(new Map())
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map()
  )
  const scopeIdentityRef = useRef<{
    transport: Transport | null
    scopeKey: string
    conversationId: number | null
  }>({
    transport: null,
    scopeKey: "",
    conversationId: null,
  })

  useEffect(() => {
    const timers = timersRef.current
    const dispatched = dispatchedRef.current
    const generations = generationsRef.current
    return () => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      dispatched.clear()
      for (const [key, gen] of generations.entries()) {
        generations.set(key, gen + 1)
      }
    }
  }, [])

  useEffect(() => {
    const timers = timersRef.current
    const dispatched = dispatchedRef.current
    const generations = generationsRef.current
    const prevScope = scopeIdentityRef.current
    const scopeChanged =
      prevScope.transport !== transport ||
      prevScope.scopeKey !== scopeKey ||
      prevScope.conversationId !== conversationId

    if (scopeChanged) {
      scopeIdentityRef.current = { transport, scopeKey, conversationId }
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      dispatched.clear()
      for (const [key, gen] of generations.entries()) {
        generations.set(key, gen + 1)
      }
    }

    if (!active || !transport || candidates.length === 0) {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      dispatched.clear()
      return
    }

    const activeIds = new Set(candidates.map((c) => c.sourceItemId))
    for (const [id, timer] of timers.entries()) {
      if (!activeIds.has(id)) {
        clearTimeout(timer)
        timers.delete(id)
      }
    }
    for (const id of dispatched.keys()) {
      if (!activeIds.has(id)) {
        dispatched.delete(id)
        generations.set(id, (generations.get(id) ?? 0) + 1)
      }
    }

    for (const candidate of candidates) {
      const id = candidate.sourceItemId
      if (dispatched.get(id) === candidate.snapshotKey) continue

      const existingTimer = timers.get(id)
      if (existingTimer !== undefined) {
        clearTimeout(existingTimer)
        timers.delete(id)
      }

      const nextGen = (generations.get(id) ?? 0) + 1
      generations.set(id, nextGen)
      dispatched.set(id, candidate.snapshotKey)

      const isRowCurrent = () =>
        generations.get(id) === nextGen &&
        scopeIdentityRef.current.transport === transport &&
        scopeIdentityRef.current.scopeKey === scopeKey &&
        scopeIdentityRef.current.conversationId === conversationId

      const run = () => {
        timers.delete(id)
        if (!isRowCurrent()) return
        void runPluginTimelineTransforms({
          transport,
          transformers: candidate.transformers,
          itemType: candidate.itemType,
          phase: candidate.phase,
          conversationId,
          locale,
          item: candidate.wireItem,
          isActive: isRowCurrent,
        }).then((result) => {
          if (!result || !isRowCurrent()) return
          setStore((prev) => {
            const sameScope =
              prev.transport === transport &&
              prev.scopeKey === scopeKey &&
              prev.conversationId === conversationId
            const nextRows = sameScope ? { ...prev.rows } : {}
            nextRows[id] = {
              snapshotKey: candidate.snapshotKey,
              outcome: result.outcome,
            }
            return {
              transport,
              scopeKey,
              conversationId,
              rows: nextRows,
            }
          })
        })
      }

      if (candidate.phase === "streaming" && streamingDebounceMs > 0) {
        timers.set(id, setTimeout(run, streamingDebounceMs))
      } else {
        run()
      }
    }
  }, [
    active,
    candidates,
    conversationId,
    locale,
    scopeKey,
    streamingDebounceMs,
    transport,
  ])

  return useMemo(() => {
    if (
      !active ||
      !transport ||
      candidates.length === 0 ||
      store.transport !== transport ||
      store.scopeKey !== scopeKey ||
      store.conversationId !== conversationId
    ) {
      return parts
    }

    const candidateByIndex = new Map<number, TransformCandidate>()
    for (const candidate of candidates) {
      candidateByIndex.set(candidate.partIndex, candidate)
    }

    let changed = false
    const nextParts: AdaptedContentPart[] = []

    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]!
      const candidate = candidateByIndex.get(index)
      if (!candidate) {
        nextParts.push(part)
        continue
      }
      const stored = store.rows[candidate.sourceItemId]
      if (!stored || stored.outcome.action === "keep") {
        nextParts.push(part)
        continue
      }

      const owner = stored.outcome
      const owningTransformer = candidate.transformers.find(
        (t) => t.pluginId === owner.pluginId && t.id === owner.transformerId
      )
      if (!owningTransformer) {
        nextParts.push(part)
        continue
      }

      changed = true
      if (owner.action === "omit") {
        continue
      }

      const replacementPart: AdaptedPluginTimelineReplacementPart = {
        type: "plugin-timeline-replacement",
        sourceItemId: candidate.sourceItemId,
        sourceType: candidate.itemType,
        ...(candidate.sourceStatus
          ? { sourceStatus: candidate.sourceStatus }
          : {}),
        pluginId: owner.pluginId,
        pluginName: owningTransformer.pluginName,
        transformerId: owner.transformerId,
        rendererKind: owner.rendererKind,
        rendererVersion: owner.rendererVersion,
        rendererTitle: owningTransformer.rendererTitle,
        items: owner.items,
        scopeKey,
        conversationId,
      }
      nextParts.push(replacementPart)
    }

    return changed ? nextParts : parts
  }, [active, candidates, conversationId, parts, scopeKey, store, transport])
}

export const PluginTimelineReplacementCards = memo(
  function PluginTimelineReplacementCards({
    part,
  }: {
    part: AdaptedPluginTimelineReplacementPart
  }) {
    return (
      <div
        data-slot="plugin-timeline-replacements"
        data-plugin-id={part.pluginId}
        data-transformer-id={part.transformerId}
        data-source-item-id={part.sourceItemId}
        className="space-y-2"
      >
        {part.items.map((item, index) => {
          const itemId = item.id ?? String(index)
          const cardKey = `${part.scopeKey}:${part.conversationId ?? "draft"}:${part.sourceItemId}:${part.pluginId}:${part.transformerId}:${itemId}`
          return (
            <section
              key={cardKey}
              data-slot="plugin-timeline-replacement-card"
              data-plugin-id={part.pluginId}
              data-transformer-id={part.transformerId}
              data-source-item-id={part.sourceItemId}
              data-item-id={itemId}
              className="overflow-hidden rounded-lg border border-border/70 bg-card text-card-foreground"
            >
              <header className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b border-border/60 bg-muted/30 px-3 py-1.5">
                <div className="flex min-w-0 items-center gap-1.5">
                  <Puzzle
                    className="size-3.5 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <span className="truncate text-xs font-medium">
                    {part.rendererTitle}
                  </span>
                </div>
                <span className="max-w-40 truncate rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                  {part.pluginName}
                </span>
              </header>
              <HostPluginSurface
                pluginId={part.pluginId}
                title={part.rendererTitle}
                context={{
                  type: "timelineItem",
                  kind: item.kind,
                  version: item.version,
                  itemId,
                  conversationId: part.conversationId,
                  data: item.data,
                }}
                className="h-44 rounded-none border-0"
              />
            </section>
          )
        })}
      </div>
    )
  }
)

PluginTimelineReplacementCards.displayName = "PluginTimelineReplacementCards"
