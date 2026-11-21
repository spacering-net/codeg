"use client"

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import {
  AlertCircle,
  Check,
  ChevronDown,
  Loader2,
  Puzzle,
  Search,
} from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { toErrorMessage } from "@/lib/app-error"
import {
  isCurrentReadyHostTransport,
  selectPluginNewWorkspaceItems,
  useHostPlugins,
  usePluginHostScope,
  validateNewWorkspaceOptionsResult,
  validateNewWorkspacePatchResult,
  type NewWorkspaceFormTarget,
  type NewWorkspaceMetadataValue,
  type NewWorkspaceMethodInput,
  type NewWorkspacePatch,
  type ResolvedNewWorkspaceOption,
  type ResolvedPluginNewWorkspaceItem,
} from "@/lib/host-plugins"
import type { Transport } from "@/lib/transport"
import { cn } from "@/lib/utils"

const SEARCH_DEBOUNCE_MS = 180
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect

export type PluginMetadataMap = Record<
  string,
  Record<string, Exclude<NewWorkspaceMetadataValue, null>>
>

export interface PluginNewWorkspaceItemsProps {
  target: NewWorkspaceFormTarget
  folderPath?: string
  baseRef?: string
  branch?: string
  metadataByPlugin: PluginMetadataMap
  onApplyPatch: (pluginId: string, patch: NewWorkspacePatch) => void
  onPrunePlugins?: (activePluginIds: ReadonlySet<string>) => void
  disabled?: boolean
  resetKey?: string
  className?: string
}

interface ComboboxItemState {
  open: boolean
  query: string
  items: ResolvedNewWorkspaceOption[]
  loading: boolean
  error: string | null
  selectedLabel?: string
}

interface SelectItemState {
  open: boolean
  items: ResolvedNewWorkspaceOption[]
  loaded: boolean
  loading: boolean
  error: string | null
  selectedId?: string
  selectedLabel?: string
}

/**
 * Renders enabled host-plugin `contributes.newWorkspaceItems` controls for the
 * New Workspace (`workspace`) or New Worktree (`worktree`) dialog.
 *
 * Isolation & lifecycle:
 * - Renders zero DOM when the host transport is not ready (`?remoteConnectionId=N`
 *   booting) or when no enabled items match the active `target`.
 * - Scopes all async calls to `(transport, scopeKey, resetKey)` with monotonic
 *   per-control request counters, discarding stale responses on close/reopen,
 *   host switch, Transport replacement, or plugin disable/update/removal.
 * - Never auto-submits the parent form; only emits validated patches.
 */
export const PluginNewWorkspaceItems = memo(function PluginNewWorkspaceItems({
  target,
  folderPath,
  baseRef,
  branch,
  metadataByPlugin,
  onApplyPatch,
  onPrunePlugins,
  disabled = false,
  resetKey = "",
  className,
}: PluginNewWorkspaceItemsProps) {
  const t = useTranslations("HostPlugins")
  const locale = useLocale()
  const hostScope = usePluginHostScope()
  const { data: plugins, transport } = useHostPlugins(true)

  const items = useMemo(
    () =>
      hostScope.transportReady && transport
        ? selectPluginNewWorkspaceItems(plugins, target, locale)
        : [],
    [hostScope.transportReady, locale, plugins, target, transport]
  )

  const liveItemKeys = useMemo(
    () => new Set(items.map((item) => item.key)),
    [items]
  )
  const livePluginIds = useMemo(
    () => new Set(items.map((item) => item.pluginId)),
    [items]
  )

  const sessionToken = `${hostScope.scopeKey}::${target}::${resetKey}`
  const [comboboxByKey, setComboboxByKey] = useState<{
    transport: Transport | null
    sessionToken: string
    entries: Record<string, ComboboxItemState>
  }>({ transport: null, sessionToken: "", entries: {} })
  const [selectByKey, setSelectByKey] = useState<{
    transport: Transport | null
    sessionToken: string
    entries: Record<string, SelectItemState>
  }>({ transport: null, sessionToken: "", entries: {} })
  const [toggleValues, setToggleValues] = useState<{
    transport: Transport | null
    sessionToken: string
    entries: Record<string, boolean>
  }>({ transport: null, sessionToken: "", entries: {} })
  const [busyByKey, setBusyByKey] = useState<{
    transport: Transport | null
    sessionToken: string
    entries: Record<string, boolean>
  }>({ transport: null, sessionToken: "", entries: {} })
  const [errorByKey, setErrorByKey] = useState<{
    transport: Transport | null
    sessionToken: string
    entries: Record<string, string | null>
  }>({ transport: null, sessionToken: "", entries: {} })

  const generationRef = useRef(0)
  const seqByKeyRef = useRef(new Map<string, number>())
  const debounceTimersRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>()
  )
  const liveRef = useRef({
    transportReady: hostScope.transportReady,
    scopeKey: hostScope.scopeKey,
    sessionToken,
    transport,
    target,
    locale,
    folderPath,
    baseRef,
    branch,
    metadataByPlugin,
    disabled,
    liveItemKeys,
    onApplyPatch,
  })

  useIsomorphicLayoutEffect(() => {
    liveRef.current = {
      transportReady: hostScope.transportReady,
      scopeKey: hostScope.scopeKey,
      sessionToken,
      transport,
      target,
      locale,
      folderPath,
      baseRef,
      branch,
      metadataByPlugin,
      disabled,
      liveItemKeys,
      onApplyPatch,
    }
  }, [
    hostScope.transportReady,
    hostScope.scopeKey,
    sessionToken,
    transport,
    target,
    locale,
    folderPath,
    baseRef,
    branch,
    metadataByPlugin,
    disabled,
    liveItemKeys,
    onApplyPatch,
  ])

  const clearAllTimers = useCallback(() => {
    for (const timer of debounceTimersRef.current.values()) {
      clearTimeout(timer)
    }
    debounceTimersRef.current.clear()
  }, [])

  // Bump generation and cancel debounce timers on host/transport/target/reset change.
  useEffect(() => {
    generationRef.current += 1
    clearAllTimers()
    seqByKeyRef.current.clear()
  }, [clearAllTimers, sessionToken, transport])

  // Clear timers/seq tokens for withdrawn items and notify parent to drop stale metadata.
  useEffect(() => {
    for (const key of Array.from(seqByKeyRef.current.keys())) {
      if (!liveItemKeys.has(key)) {
        seqByKeyRef.current.delete(key)
      }
    }
    for (const [key, timer] of Array.from(
      debounceTimersRef.current.entries()
    )) {
      if (!liveItemKeys.has(key)) {
        clearTimeout(timer)
        debounceTimersRef.current.delete(key)
      }
    }
    if (plugins !== undefined) {
      onPrunePlugins?.(livePluginIds)
    }
  }, [liveItemKeys, livePluginIds, onPrunePlugins, plugins])

  useEffect(() => {
    const seqMap = seqByKeyRef.current
    return () => {
      generationRef.current += 1
      clearAllTimers()
      seqMap.clear()
    }
  }, [clearAllTimers])

  const buildInput = useCallback(
    (
      item: ResolvedPluginNewWorkspaceItem,
      extra?: { query?: string; value?: boolean }
    ): NewWorkspaceMethodInput => {
      const live = liveRef.current
      const input: NewWorkspaceMethodInput = {
        itemId: item.id,
        target: live.target,
        locale: live.locale,
      }
      if (extra?.query !== undefined) input.query = extra.query
      if (extra?.value !== undefined) input.value = extra.value
      const trimmedFolder = live.folderPath?.trim()
      if (trimmedFolder) input.folderPath = trimmedFolder
      const trimmedBase = live.baseRef?.trim()
      if (trimmedBase) input.baseRef = trimmedBase
      const trimmedBranch = live.branch?.trim()
      if (trimmedBranch) input.branch = trimmedBranch
      const pluginMeta = live.metadataByPlugin[item.pluginId]
      if (pluginMeta && Object.keys(pluginMeta).length > 0) {
        input.metadata = { ...pluginMeta }
      }
      return input
    },
    []
  )

  const getActiveCombobox = (key: string): ComboboxItemState =>
    comboboxByKey.transport === transport &&
    comboboxByKey.sessionToken === sessionToken &&
    comboboxByKey.entries[key]
      ? comboboxByKey.entries[key]
      : { open: false, query: "", items: [], loading: false, error: null }

  const getActiveSelect = (key: string): SelectItemState =>
    selectByKey.transport === transport &&
    selectByKey.sessionToken === sessionToken &&
    selectByKey.entries[key]
      ? selectByKey.entries[key]
      : { open: false, items: [], loaded: false, loading: false, error: null }

  const getActiveToggleValue = (
    item: ResolvedPluginNewWorkspaceItem,
    defaultValue: boolean
  ): boolean =>
    toggleValues.transport === transport &&
    toggleValues.sessionToken === sessionToken &&
    item.key in toggleValues.entries
      ? toggleValues.entries[item.key]
      : defaultValue

  const isItemBusy = (key: string): boolean =>
    busyByKey.transport === transport &&
    busyByKey.sessionToken === sessionToken &&
    busyByKey.entries[key] === true

  const getItemError = (key: string): string | null =>
    errorByKey.transport === transport &&
    errorByKey.sessionToken === sessionToken
      ? (errorByKey.entries[key] ?? null)
      : null

  const updateCombobox = useCallback(
    (
      capturedTransport: Transport,
      capturedSession: string,
      key: string,
      updater: (prev: ComboboxItemState) => ComboboxItemState
    ) => {
      setComboboxByKey((prev) => {
        const baseEntries =
          prev.transport === capturedTransport &&
          prev.sessionToken === capturedSession
            ? prev.entries
            : {}
        const current = baseEntries[key] ?? {
          open: false,
          query: "",
          items: [],
          loading: false,
          error: null,
        }
        return {
          transport: capturedTransport,
          sessionToken: capturedSession,
          entries: { ...baseEntries, [key]: updater(current) },
        }
      })
    },
    []
  )

  const updateSelect = useCallback(
    (
      capturedTransport: Transport,
      capturedSession: string,
      key: string,
      updater: (prev: SelectItemState) => SelectItemState
    ) => {
      setSelectByKey((prev) => {
        const baseEntries =
          prev.transport === capturedTransport &&
          prev.sessionToken === capturedSession
            ? prev.entries
            : {}
        const current = baseEntries[key] ?? {
          open: false,
          items: [],
          loaded: false,
          loading: false,
          error: null,
        }
        return {
          transport: capturedTransport,
          sessionToken: capturedSession,
          entries: { ...baseEntries, [key]: updater(current) },
        }
      })
    },
    []
  )

  const setItemBusy = useCallback(
    (
      capturedTransport: Transport,
      capturedSession: string,
      key: string,
      busy: boolean
    ) => {
      setBusyByKey((prev) => {
        const baseEntries =
          prev.transport === capturedTransport &&
          prev.sessionToken === capturedSession
            ? prev.entries
            : {}
        return {
          transport: capturedTransport,
          sessionToken: capturedSession,
          entries: { ...baseEntries, [key]: busy },
        }
      })
    },
    []
  )

  const setItemError = useCallback(
    (
      capturedTransport: Transport,
      capturedSession: string,
      key: string,
      error: string | null
    ) => {
      setErrorByKey((prev) => {
        const baseEntries =
          prev.transport === capturedTransport &&
          prev.sessionToken === capturedSession
            ? prev.entries
            : {}
        return {
          transport: capturedTransport,
          sessionToken: capturedSession,
          entries: { ...baseEntries, [key]: error },
        }
      })
    },
    []
  )

  const runComboboxSearch = useCallback(
    (item: ResolvedPluginNewWorkspaceItem, query: string) => {
      if (item.control.kind !== "combobox") return
      const live = liveRef.current
      if (
        live.disabled ||
        !live.transportReady ||
        !live.transport ||
        !isCurrentReadyHostTransport(live.transport) ||
        !live.liveItemKeys.has(item.key) ||
        typeof live.transport.call !== "function"
      ) {
        return
      }
      const capturedTransport = live.transport
      const capturedSession = live.sessionToken
      const generation = generationRef.current
      const seq = (seqByKeyRef.current.get(item.key) ?? 0) + 1
      seqByKeyRef.current.set(item.key, seq)

      updateCombobox(capturedTransport, capturedSession, item.key, (prev) => ({
        ...prev,
        loading: true,
        error: null,
      }))

      const method = item.control.searchMethod
      const input = buildInput(item, { query })
      void Promise.resolve()
        .then(() =>
          capturedTransport.call<unknown>("host_plugins_call", {
            pluginId: item.pluginId,
            method,
            input,
          })
        )
        .then((raw) => {
          const current = liveRef.current
          if (
            generation !== generationRef.current ||
            seqByKeyRef.current.get(item.key) !== seq ||
            !current.transportReady ||
            current.transport !== capturedTransport ||
            current.sessionToken !== capturedSession ||
            !isCurrentReadyHostTransport(capturedTransport) ||
            !current.liveItemKeys.has(item.key)
          ) {
            return
          }
          const validated = validateNewWorkspaceOptionsResult(raw, "combobox")
          updateCombobox(
            capturedTransport,
            capturedSession,
            item.key,
            (prev) => ({
              ...prev,
              items: validated,
              loading: false,
              error: null,
            })
          )
        })
        .catch((err: unknown) => {
          const current = liveRef.current
          if (
            generation !== generationRef.current ||
            seqByKeyRef.current.get(item.key) !== seq ||
            !current.transportReady ||
            current.transport !== capturedTransport ||
            current.sessionToken !== capturedSession ||
            !isCurrentReadyHostTransport(capturedTransport) ||
            !current.liveItemKeys.has(item.key)
          ) {
            return
          }
          updateCombobox(
            capturedTransport,
            capturedSession,
            item.key,
            (prev) => ({
              ...prev,
              loading: false,
              error: toErrorMessage(err),
            })
          )
        })
    },
    [buildInput, updateCombobox]
  )

  const handleToggleComboboxOpen = useCallback(
    (item: ResolvedPluginNewWorkspaceItem, nextOpen: boolean) => {
      const live = liveRef.current
      if (!live.transport || live.disabled) return
      const existingTimer = debounceTimersRef.current.get(item.key)
      if (existingTimer) {
        clearTimeout(existingTimer)
        debounceTimersRef.current.delete(item.key)
      }
      if (!nextOpen) {
        seqByKeyRef.current.set(
          item.key,
          (seqByKeyRef.current.get(item.key) ?? 0) + 1
        )
        updateCombobox(live.transport, live.sessionToken, item.key, (prev) => ({
          ...prev,
          open: false,
          loading: false,
        }))
        return
      }
      updateCombobox(live.transport, live.sessionToken, item.key, (prev) => ({
        ...prev,
        open: true,
        query: "",
        error: null,
      }))
      runComboboxSearch(item, "")
    },
    [runComboboxSearch, updateCombobox]
  )

  const handleComboboxQueryChange = useCallback(
    (item: ResolvedPluginNewWorkspaceItem, nextQuery: string) => {
      const live = liveRef.current
      if (!live.transport || live.disabled) return
      updateCombobox(live.transport, live.sessionToken, item.key, (prev) => ({
        ...prev,
        query: nextQuery,
      }))
      const existingTimer = debounceTimersRef.current.get(item.key)
      if (existingTimer) clearTimeout(existingTimer)
      const generation = generationRef.current
      const capturedTransport = live.transport
      const capturedSession = live.sessionToken
      const timer = setTimeout(() => {
        debounceTimersRef.current.delete(item.key)
        const current = liveRef.current
        if (
          generation !== generationRef.current ||
          current.transport !== capturedTransport ||
          current.sessionToken !== capturedSession ||
          !current.liveItemKeys.has(item.key)
        ) {
          return
        }
        runComboboxSearch(item, nextQuery)
      }, SEARCH_DEBOUNCE_MS)
      debounceTimersRef.current.set(item.key, timer)
    },
    [runComboboxSearch, updateCombobox]
  )

  const handleSelectComboboxOption = useCallback(
    (
      item: ResolvedPluginNewWorkspaceItem,
      option: ResolvedNewWorkspaceOption
    ) => {
      const live = liveRef.current
      if (
        live.disabled ||
        !live.transport ||
        !live.liveItemKeys.has(item.key) ||
        !isCurrentReadyHostTransport(live.transport)
      ) {
        return
      }
      const existingTimer = debounceTimersRef.current.get(item.key)
      if (existingTimer) {
        clearTimeout(existingTimer)
        debounceTimersRef.current.delete(item.key)
      }
      updateCombobox(live.transport, live.sessionToken, item.key, (prev) => ({
        ...prev,
        open: false,
        loading: false,
        selectedLabel: option.label,
      }))
      if (option.patch) {
        live.onApplyPatch(item.pluginId, option.patch)
      }
    },
    [updateCombobox]
  )

  const loadDynamicSelectOptions = useCallback(
    (item: ResolvedPluginNewWorkspaceItem) => {
      if (item.control.kind !== "select" || !item.control.optionsMethod) return
      const live = liveRef.current
      if (
        live.disabled ||
        !live.transportReady ||
        !live.transport ||
        !isCurrentReadyHostTransport(live.transport) ||
        !live.liveItemKeys.has(item.key) ||
        typeof live.transport.call !== "function"
      ) {
        return
      }
      const capturedTransport = live.transport
      const capturedSession = live.sessionToken
      const generation = generationRef.current
      const seq = (seqByKeyRef.current.get(item.key) ?? 0) + 1
      seqByKeyRef.current.set(item.key, seq)

      updateSelect(capturedTransport, capturedSession, item.key, (prev) => ({
        ...prev,
        loading: true,
        error: null,
      }))

      const method = item.control.optionsMethod
      const input = buildInput(item)
      void Promise.resolve()
        .then(() =>
          capturedTransport.call<unknown>("host_plugins_call", {
            pluginId: item.pluginId,
            method,
            input,
          })
        )
        .then((raw) => {
          const current = liveRef.current
          if (
            generation !== generationRef.current ||
            seqByKeyRef.current.get(item.key) !== seq ||
            !current.transportReady ||
            current.transport !== capturedTransport ||
            current.sessionToken !== capturedSession ||
            !isCurrentReadyHostTransport(capturedTransport) ||
            !current.liveItemKeys.has(item.key)
          ) {
            return
          }
          const validated = validateNewWorkspaceOptionsResult(raw, "select")
          updateSelect(
            capturedTransport,
            capturedSession,
            item.key,
            (prev) => ({
              ...prev,
              items: validated,
              loaded: true,
              loading: false,
              error: null,
            })
          )
        })
        .catch((err: unknown) => {
          const current = liveRef.current
          if (
            generation !== generationRef.current ||
            seqByKeyRef.current.get(item.key) !== seq ||
            !current.transportReady ||
            current.transport !== capturedTransport ||
            current.sessionToken !== capturedSession ||
            !isCurrentReadyHostTransport(capturedTransport) ||
            !current.liveItemKeys.has(item.key)
          ) {
            return
          }
          updateSelect(
            capturedTransport,
            capturedSession,
            item.key,
            (prev) => ({
              ...prev,
              loading: false,
              error: toErrorMessage(err),
            })
          )
        })
    },
    [buildInput, updateSelect]
  )

  const handleToggleSelectOpen = useCallback(
    (item: ResolvedPluginNewWorkspaceItem, nextOpen: boolean) => {
      if (item.control.kind !== "select") return
      const live = liveRef.current
      if (!live.transport || live.disabled) return
      const capturedTransport = live.transport
      const capturedSession = live.sessionToken
      updateSelect(capturedTransport, capturedSession, item.key, (prev) => ({
        ...prev,
        open: nextOpen,
      }))
      if (nextOpen && item.control.optionsMethod) {
        const currentState =
          selectByKey.transport === capturedTransport &&
          selectByKey.sessionToken === capturedSession
            ? selectByKey.entries[item.key]
            : undefined
        if (!currentState?.loaded && !currentState?.loading) {
          loadDynamicSelectOptions(item)
        }
      }
    },
    [loadDynamicSelectOptions, selectByKey, updateSelect]
  )

  const handleSelectOption = useCallback(
    (
      item: ResolvedPluginNewWorkspaceItem,
      option: ResolvedNewWorkspaceOption
    ) => {
      const live = liveRef.current
      if (
        live.disabled ||
        !live.transport ||
        !live.liveItemKeys.has(item.key) ||
        !isCurrentReadyHostTransport(live.transport)
      ) {
        return
      }
      updateSelect(live.transport, live.sessionToken, item.key, (prev) => ({
        ...prev,
        open: false,
        selectedId: option.id,
        selectedLabel: option.label,
      }))
      if (option.patch) {
        live.onApplyPatch(item.pluginId, option.patch)
      }
    },
    [updateSelect]
  )

  const handleToggleChange = useCallback(
    (item: ResolvedPluginNewWorkspaceItem, nextValue: boolean) => {
      if (item.control.kind !== "toggle") return
      const live = liveRef.current
      if (
        live.disabled ||
        !live.transportReady ||
        !live.transport ||
        !isCurrentReadyHostTransport(live.transport) ||
        !live.liveItemKeys.has(item.key)
      ) {
        return
      }
      const capturedTransport = live.transport
      const capturedSession = live.sessionToken
      setToggleValues((prev) => {
        const baseEntries =
          prev.transport === capturedTransport &&
          prev.sessionToken === capturedSession
            ? prev.entries
            : {}
        return {
          transport: capturedTransport,
          sessionToken: capturedSession,
          entries: { ...baseEntries, [item.key]: nextValue },
        }
      })
      setItemError(capturedTransport, capturedSession, item.key, null)

      const staticPatch = nextValue
        ? item.control.enabledPatch
        : item.control.disabledPatch
      if (staticPatch) {
        live.onApplyPatch(item.pluginId, staticPatch)
      }

      if (
        item.control.onChangeMethod &&
        typeof capturedTransport.call === "function"
      ) {
        const generation = generationRef.current
        const seq = (seqByKeyRef.current.get(item.key) ?? 0) + 1
        seqByKeyRef.current.set(item.key, seq)
        setItemBusy(capturedTransport, capturedSession, item.key, true)
        const method = item.control.onChangeMethod
        const input = buildInput(item, { value: nextValue })
        void Promise.resolve()
          .then(() =>
            capturedTransport.call<unknown>("host_plugins_call", {
              pluginId: item.pluginId,
              method,
              input,
            })
          )
          .then((raw) => {
            const current = liveRef.current
            if (
              generation !== generationRef.current ||
              seqByKeyRef.current.get(item.key) !== seq ||
              !current.transportReady ||
              current.transport !== capturedTransport ||
              current.sessionToken !== capturedSession ||
              !isCurrentReadyHostTransport(capturedTransport) ||
              !current.liveItemKeys.has(item.key)
            ) {
              return
            }
            setItemBusy(capturedTransport, capturedSession, item.key, false)
            const dynamicPatch = validateNewWorkspacePatchResult(raw)
            if (dynamicPatch) {
              current.onApplyPatch(item.pluginId, dynamicPatch)
            }
          })
          .catch((err: unknown) => {
            const current = liveRef.current
            if (
              generation !== generationRef.current ||
              seqByKeyRef.current.get(item.key) !== seq ||
              !current.transportReady ||
              current.transport !== capturedTransport ||
              current.sessionToken !== capturedSession ||
              !isCurrentReadyHostTransport(capturedTransport) ||
              !current.liveItemKeys.has(item.key)
            ) {
              return
            }
            const message = toErrorMessage(err)
            setItemBusy(capturedTransport, capturedSession, item.key, false)
            setItemError(capturedTransport, capturedSession, item.key, message)
            toast.error(t("newWorkspaceActionFailed"), { description: message })
          })
      }
    },
    [buildInput, setItemBusy, setItemError, t]
  )

  const handleActionClick = useCallback(
    (item: ResolvedPluginNewWorkspaceItem) => {
      if (item.control.kind !== "action") return
      const live = liveRef.current
      if (
        live.disabled ||
        !live.transportReady ||
        !live.transport ||
        !isCurrentReadyHostTransport(live.transport) ||
        !live.liveItemKeys.has(item.key) ||
        typeof live.transport.call !== "function"
      ) {
        return
      }
      const capturedTransport = live.transport
      const capturedSession = live.sessionToken
      if (
        busyByKey.transport === capturedTransport &&
        busyByKey.sessionToken === capturedSession &&
        busyByKey.entries[item.key]
      ) {
        return
      }
      const generation = generationRef.current
      const seq = (seqByKeyRef.current.get(item.key) ?? 0) + 1
      seqByKeyRef.current.set(item.key, seq)
      setItemBusy(capturedTransport, capturedSession, item.key, true)
      setItemError(capturedTransport, capturedSession, item.key, null)

      const method = item.control.method
      const input = buildInput(item)
      void Promise.resolve()
        .then(() =>
          capturedTransport.call<unknown>("host_plugins_call", {
            pluginId: item.pluginId,
            method,
            input,
          })
        )
        .then((raw) => {
          const current = liveRef.current
          if (
            generation !== generationRef.current ||
            seqByKeyRef.current.get(item.key) !== seq ||
            !current.transportReady ||
            current.transport !== capturedTransport ||
            current.sessionToken !== capturedSession ||
            !isCurrentReadyHostTransport(capturedTransport) ||
            !current.liveItemKeys.has(item.key)
          ) {
            return
          }
          setItemBusy(capturedTransport, capturedSession, item.key, false)
          const patch = validateNewWorkspacePatchResult(raw)
          if (patch) {
            current.onApplyPatch(item.pluginId, patch)
          }
        })
        .catch((err: unknown) => {
          const current = liveRef.current
          if (
            generation !== generationRef.current ||
            seqByKeyRef.current.get(item.key) !== seq ||
            !current.transportReady ||
            current.transport !== capturedTransport ||
            current.sessionToken !== capturedSession ||
            !isCurrentReadyHostTransport(capturedTransport) ||
            !current.liveItemKeys.has(item.key)
          ) {
            return
          }
          const message = toErrorMessage(err)
          setItemBusy(capturedTransport, capturedSession, item.key, false)
          setItemError(capturedTransport, capturedSession, item.key, message)
          toast.error(t("newWorkspaceActionFailed"), { description: message })
        })
    },
    [buildInput, busyByKey, setItemBusy, setItemError, t]
  )

  const metadataBadges = useMemo(() => {
    const badges: Array<{ id: string; key: string; value: string }> = []
    for (const [pluginId, meta] of Object.entries(metadataByPlugin)) {
      if (!livePluginIds.has(pluginId)) continue
      for (const [key, value] of Object.entries(meta)) {
        badges.push({ id: `${pluginId}:${key}`, key, value: String(value) })
      }
    }
    return badges
  }, [livePluginIds, metadataByPlugin])

  if (!hostScope.transportReady || !transport || items.length === 0) {
    return null
  }

  return (
    <section
      data-slot="plugin-new-workspace-items"
      aria-label={t("newWorkspaceSection")}
      className={cn(
        "space-y-3 rounded-lg border border-border/70 bg-muted/25 p-3",
        className
      )}
    >
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Puzzle className="size-3.5 shrink-0" aria-hidden />
        <span>{t("newWorkspaceSection")}</span>
      </div>

      <div className="space-y-3">
        {items.map((item) => {
          const control = item.control
          const itemError = getItemError(item.key)

          if (control.kind === "combobox") {
            const state = getActiveCombobox(item.key)
            const placeholder =
              control.placeholder ?? t("newWorkspaceSearchPlaceholder")
            return (
              <div
                key={item.key}
                data-slot="plugin-new-workspace-item"
                data-control-kind="combobox"
                className="space-y-1.5"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-1">
                  <Label className="text-xs font-medium">{item.title}</Label>
                  <span className="text-[11px] text-muted-foreground">
                    {item.pluginName}
                  </span>
                </div>
                {item.description && (
                  <p className="text-xs text-muted-foreground">
                    {item.description}
                  </p>
                )}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={disabled}
                  aria-expanded={state.open}
                  onClick={() => handleToggleComboboxOpen(item, !state.open)}
                  className="w-full justify-between font-normal"
                >
                  <span className="truncate">
                    {state.selectedLabel ?? placeholder}
                  </span>
                  <ChevronDown
                    className="size-3.5 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                </Button>
                {state.open && (
                  <div className="space-y-2 rounded-md border bg-background p-2 shadow-xs">
                    <div className="flex items-center gap-1.5 rounded border border-input px-2 py-1">
                      <Search
                        className="size-3.5 shrink-0 text-muted-foreground"
                        aria-hidden
                      />
                      <input
                        type="search"
                        role="searchbox"
                        autoFocus
                        disabled={disabled}
                        value={state.query}
                        onChange={(event) =>
                          handleComboboxQueryChange(item, event.target.value)
                        }
                        placeholder={placeholder}
                        aria-label={placeholder}
                        className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
                        autoComplete="off"
                        spellCheck={false}
                      />
                      {state.loading && (
                        <Loader2
                          className="size-3.5 shrink-0 animate-spin text-muted-foreground"
                          aria-hidden
                        />
                      )}
                    </div>
                    {state.loading && (
                      <p className="px-1 text-[11px] text-muted-foreground">
                        {t("newWorkspaceSearching")}
                      </p>
                    )}
                    {state.error && (
                      <div
                        role="alert"
                        className="flex items-center justify-between gap-2 rounded bg-destructive/5 px-2 py-1.5 text-xs text-destructive"
                      >
                        <span className="min-w-0 break-words">
                          {state.error}
                        </span>
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          onClick={() => runComboboxSearch(item, state.query)}
                        >
                          {t("retry")}
                        </Button>
                      </div>
                    )}
                    {!state.loading &&
                      !state.error &&
                      state.items.length === 0 && (
                        <p className="px-2 py-2 text-center text-xs text-muted-foreground">
                          {t("newWorkspaceNoMatches")}
                        </p>
                      )}
                    {state.items.length > 0 && (
                      <ul
                        role="listbox"
                        aria-label={item.title}
                        className="max-h-44 space-y-0.5 overflow-y-auto"
                      >
                        {state.items.map((option) => (
                          <li key={option.id}>
                            <button
                              type="button"
                              disabled={disabled}
                              onClick={() =>
                                handleSelectComboboxOption(item, option)
                              }
                              className="flex w-full flex-col rounded px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent hover:text-accent-foreground"
                            >
                              <span className="truncate font-medium">
                                {option.label}
                              </span>
                              {option.description && (
                                <span className="truncate text-[11px] text-muted-foreground">
                                  {option.description}
                                </span>
                              )}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            )
          }

          if (control.kind === "select") {
            const state = getActiveSelect(item.key)
            const options = control.options ?? state.items
            const placeholder =
              control.placeholder ?? t("newWorkspaceSelectPlaceholder")
            return (
              <div
                key={item.key}
                data-slot="plugin-new-workspace-item"
                data-control-kind="select"
                className="space-y-1.5"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-1">
                  <Label className="text-xs font-medium">{item.title}</Label>
                  <span className="text-[11px] text-muted-foreground">
                    {item.pluginName}
                  </span>
                </div>
                {item.description && (
                  <p className="text-xs text-muted-foreground">
                    {item.description}
                  </p>
                )}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={disabled}
                  aria-expanded={state.open}
                  onClick={() => handleToggleSelectOpen(item, !state.open)}
                  className="w-full justify-between font-normal"
                >
                  <span className="truncate">
                    {state.selectedLabel ?? placeholder}
                  </span>
                  <ChevronDown
                    className="size-3.5 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                </Button>
                {state.open && (
                  <div className="space-y-1 rounded-md border bg-background p-1.5 shadow-xs">
                    {state.loading ? (
                      <div className="flex items-center justify-center gap-1.5 py-2 text-xs text-muted-foreground">
                        <Loader2
                          className="size-3.5 animate-spin"
                          aria-hidden
                        />
                        <span>{t("loading")}</span>
                      </div>
                    ) : state.error ? (
                      <div
                        role="alert"
                        className="flex items-center justify-between gap-2 rounded bg-destructive/5 px-2 py-1.5 text-xs text-destructive"
                      >
                        <span className="min-w-0 break-words">
                          {state.error}
                        </span>
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          onClick={() => loadDynamicSelectOptions(item)}
                        >
                          {t("retry")}
                        </Button>
                      </div>
                    ) : options.length === 0 ? (
                      <p className="px-2 py-2 text-center text-xs text-muted-foreground">
                        {t("newWorkspaceNoMatches")}
                      </p>
                    ) : (
                      <ul
                        role="listbox"
                        aria-label={item.title}
                        className="max-h-44 space-y-0.5 overflow-y-auto"
                      >
                        {options.map((option) => (
                          <li key={option.id}>
                            <button
                              type="button"
                              disabled={disabled}
                              onClick={() => handleSelectOption(item, option)}
                              className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent hover:text-accent-foreground"
                            >
                              <div className="min-w-0 flex-1">
                                <div className="truncate font-medium">
                                  {option.label}
                                </div>
                                {option.description && (
                                  <div className="truncate text-[11px] text-muted-foreground">
                                    {option.description}
                                  </div>
                                )}
                              </div>
                              {state.selectedId === option.id && (
                                <Check
                                  className="size-3.5 shrink-0 text-primary"
                                  aria-hidden
                                />
                              )}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            )
          }

          if (control.kind === "toggle") {
            const checked = getActiveToggleValue(item, control.defaultValue)
            const busy = isItemBusy(item.key)
            return (
              <div
                key={item.key}
                data-slot="plugin-new-workspace-item"
                data-control-kind="toggle"
                className="space-y-1"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs font-medium">{item.title}</span>
                      <span className="text-[11px] text-muted-foreground">
                        {item.pluginName}
                      </span>
                    </div>
                    {item.description && (
                      <p className="text-xs text-muted-foreground">
                        {item.description}
                      </p>
                    )}
                  </div>
                  <Switch
                    aria-label={item.title}
                    checked={checked}
                    disabled={disabled || busy}
                    onCheckedChange={(next) => handleToggleChange(item, next)}
                  />
                </div>
                {itemError && (
                  <p
                    role="alert"
                    className="flex items-center gap-1 text-xs text-destructive"
                  >
                    <AlertCircle className="size-3 shrink-0" aria-hidden />
                    <span className="break-words">{itemError}</span>
                  </p>
                )}
              </div>
            )
          }

          // control.kind === "action"
          const busy = isItemBusy(item.key)
          return (
            <div
              key={item.key}
              data-slot="plugin-new-workspace-item"
              data-control-kind="action"
              className="space-y-1"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium">{item.title}</div>
                  {item.description && (
                    <p className="text-xs text-muted-foreground">
                      {item.description}
                    </p>
                  )}
                </div>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={disabled || busy}
                  onClick={() => handleActionClick(item)}
                >
                  {busy && (
                    <Loader2 className="size-3.5 animate-spin" aria-hidden />
                  )}
                  {item.title}
                </Button>
              </div>
              {itemError && (
                <p
                  role="alert"
                  className="flex items-center gap-1 text-xs text-destructive"
                >
                  <AlertCircle className="size-3 shrink-0" aria-hidden />
                  <span className="break-words">{itemError}</span>
                </p>
              )}
            </div>
          )
        })}
      </div>

      {metadataBadges.length > 0 && (
        <div
          data-slot="plugin-new-workspace-metadata"
          aria-label={t("newWorkspaceMetadata")}
          className="flex flex-wrap items-center gap-1.5 border-t border-border/60 pt-2"
        >
          {metadataBadges.map((entry) => (
            <span
              key={entry.id}
              className="inline-flex max-w-full items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
            >
              <span className="truncate font-medium text-foreground">
                {entry.key}:
              </span>
              <span className="truncate">{entry.value}</span>
            </span>
          ))}
        </div>
      )}
    </section>
  )
})

PluginNewWorkspaceItems.displayName = "PluginNewWorkspaceItems"
