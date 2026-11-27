"use client"

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Copy,
  ExternalLink,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { useCopiedFlag } from "@/hooks/use-copied-flag"
import type { McpFlow, McpProbeRecord } from "@/lib/harness/mcp-state"
import { openInSystemBrowser } from "@/lib/link-open"
import { mcpApply, mcpProbe } from "@/lib/mcp/api"
import { mcpFailureOf } from "@/lib/mcp/errors"
import type { McpAgentInfo, McpModel } from "@/lib/mcp/model"
import {
  canonicalizeRemoteMcpUrl,
  matchOAuthRouteForDefinition,
  mcpOAuthBridgeDefinition,
  mcpOAuthCancel,
  mcpOAuthCompleteCallback,
  mcpOAuthList,
  mcpOAuthStart,
  onMcpOAuthChanged,
  parseOAuthScopesInput,
  planBridgeRouteApply,
  planRestoreDirectUrl,
  type McpOAuthBridgeSnapshot,
  type McpOAuthRouteInfo,
  type McpOAuthStartResult,
} from "@/lib/mcp/oauth"
import { basisFromResult, type McpPlan } from "@/lib/mcp/ops"
import { isSaved } from "@/lib/mcp/results"
import type { McpAgentId } from "@/lib/mcp/types"
import { copyTextToClipboard } from "@/lib/utils"
import { Code } from "../discover/detail-sections"
import { DiscoverMark } from "../discover/discover-card"
import { MachineText } from "../machine-text"
import { AgentGlyph, MCP_SECTION_TITLE_CLASS } from "./mcp-bits"
import { McpDialogFrame } from "./mcp-dialog-frame"
import { McpResults, McpReview, Technical } from "./mcp-plan"
import { McpProbeButton, McpProbePanel } from "./mcp-probe-panel"
import { AgentSelectAll } from "./mcp-target-list"
import { useMcpLabels } from "./use-mcp-labels"

const code = (chunks: ReactNode) => <Code>{chunks}</Code>

export interface McpOAuthDialogProps {
  serverKey: string
  upstreamUrl: string
  transport: "http" | "sse"
  resourceMetadataUrl?: string | null
  existingRoute?: McpOAuthRouteInfo | null
  /** Writable agents in the current model supporting `transport` (both built-in
   *  and custom ACP agents). */
  availableTargets: readonly McpAgentInfo[]
  /** Current MCP model used to build preflight/apply/restore plans. */
  model: McpModel | null
  /** Optional OAuth snapshot for annotating per-agent bridge/port status. */
  oauthSnapshot?: McpOAuthBridgeSnapshot | null
  /** Starting mode: `"authorize"` (default), `"apply"` (already authorized ->
   *  route agents), or `"restore"` (switch bridged agents back to direct URL). */
  initialMode?: "authorize" | "apply" | "restore"
  onClose: () => void
  onApplied?: () => Promise<void> | void
  onOAuthChanged?: () => Promise<void> | void
}

type DialogStep =
  | "prepare"
  | "waiting"
  | "authorized"
  | "restore"
  | "review"
  | "saving"
  | "result"

function defaultSelectedTargets(
  availableTargets: readonly McpAgentInfo[],
  serverKey: string,
  mode: "apply" | "restore",
  oauthSnapshot: McpOAuthBridgeSnapshot | null | undefined
): McpAgentId[] {
  const validIds = availableTargets.flatMap((info) =>
    info.agent ? [info.agent] : []
  )
  const holdingIds = availableTargets.flatMap((info) => {
    if (!info.agent) return []
    const entry = info.inventory.entries.find((item) => item.key === serverKey)
    if (!entry) return []
    if (mode === "restore") {
      const match = matchOAuthRouteForDefinition(
        entry.definition,
        oauthSnapshot ?? null
      )
      return match?.kind === "bridged" ? [info.agent] : []
    }
    return [info.agent]
  })
  if (holdingIds.length > 0) return holdingIds
  if (mode === "restore") {
    return availableTargets.flatMap((info) => {
      if (!info.agent) return []
      return info.inventory.entries.some((item) => item.key === serverKey)
        ? [info.agent]
        : []
    })
  }
  const installed = availableTargets.flatMap((info) =>
    info.agent && info.installed === true ? [info.agent] : []
  )
  return installed.length > 0 ? installed : validIds
}

export function McpOAuthDialog({
  serverKey,
  upstreamUrl,
  transport,
  resourceMetadataUrl,
  existingRoute,
  availableTargets,
  model,
  oauthSnapshot,
  initialMode = "authorize",
  onClose,
  onApplied,
  onOAuthChanged,
}: McpOAuthDialogProps) {
  const t = useTranslations("Harness.mcp.oauth")
  const tDialog = useTranslations("Harness.mcp.dialog")
  const labels = useMcpLabels()
  const baseId = useId()
  const [copiedLink, markCopiedLink] = useCopiedFlag()

  const initialStep: DialogStep =
    initialMode === "restore"
      ? "restore"
      : initialMode === "apply" && existingRoute?.status === "authorized"
        ? "authorized"
        : "prepare"

  const [step, setStep] = useState<DialogStep>(initialStep)
  const [route, setRoute] = useState<McpOAuthRouteInfo | null>(
    existingRoute ?? null
  )
  const [startFlow, setStartFlow] = useState<McpOAuthStartResult | null>(null)

  // Advanced manual OAuth client inputs (never persisted)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [clientId, setClientId] = useState("")
  const [clientSecret, setClientSecret] = useState("")
  const [scopesInput, setScopesInput] = useState("")

  // Manual callback paste inputs (for Docker / remote server / tests)
  const [manualCallbackOpen, setManualCallbackOpen] = useState(false)
  const [callbackUrlInput, setCallbackUrlInput] = useState("")

  // Busy & error states
  const [starting, setStarting] = useState(false)
  const [completing, setCompleting] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [preparingPlan, setPreparingPlan] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [errorDetail, setErrorDetail] = useState<string | null>(null)

  // Target selection for apply / restore
  const [selectedTargets, setSelectedTargets] = useState<McpAgentId[]>(() =>
    defaultSelectedTargets(
      availableTargets,
      serverKey,
      initialMode === "restore" ? "restore" : "apply",
      oauthSnapshot
    )
  )

  // Track whether current review/result is for bridge apply vs direct restore.
  const [planMode, setPlanMode] = useState<"apply" | "restore">(
    initialMode === "restore" ? "restore" : "apply"
  )

  // Local apply flow (kept out of HarnessSlotStore so bridge bearer tokens are
  // never persisted or cached outside the active in-memory dialog).
  const [applyFlow, setApplyFlow] = useState<McpFlow>({
    step: "input",
    plan: null,
    preflight: null,
    result: null,
    failure: null,
    notice: null,
    request: 0,
  })
  // Ref holds the in-flight plan transiently only between review and commit,
  // and is cleared immediately after commit or back/close.
  const pendingPlanRef = useRef<McpPlan | null>(null)

  // Inline end-to-end probe state
  const [probeRecord, setProbeRecord] = useState<McpProbeRecord | null>(null)

  const clearPendingPlan = useCallback(() => {
    pendingPlanRef.current = null
  }, [])

  // Subscribe to `mcp://oauth-changed` while waiting for browser callback.
  useEffect(() => {
    if (step !== "waiting" || !startFlow) return
    let cancelled = false
    let unsubscribe: (() => void) | null = null
    const canonicalUpstream = canonicalizeRemoteMcpUrl(upstreamUrl)

    onMcpOAuthChanged((evt) => {
      if (cancelled) return
      const matchesRoute =
        evt.route_id === startFlow.route_id ||
        (evt.upstream_url &&
          canonicalizeRemoteMcpUrl(evt.upstream_url) === canonicalUpstream)
      if (!matchesRoute) return
      if (evt.status === "authorized") {
        void (async () => {
          try {
            const snap = await mcpOAuthList()
            if (cancelled) return
            const found =
              snap.routes.find((r) => r.route_id === startFlow.route_id) ??
              snap.routes.find(
                (r) =>
                  canonicalizeRemoteMcpUrl(r.upstream_url) === canonicalUpstream
              )
            if (found) {
              setRoute(found)
            } else {
              setRoute({
                route_id: startFlow.route_id,
                upstream_url: startFlow.upstream_url || upstreamUrl,
                transport,
                bridge_url: null,
                status: "authorized",
                scopes: [],
                has_refresh_token: false,
                updated_at: new Date().toISOString(),
              })
            }
          } catch {
            if (cancelled) return
            setRoute({
              route_id: startFlow.route_id,
              upstream_url: startFlow.upstream_url || upstreamUrl,
              transport,
              bridge_url: null,
              status: "authorized",
              scopes: [],
              has_refresh_token: false,
              updated_at: new Date().toISOString(),
            })
          }
          setErrorMsg(null)
          setErrorDetail(null)
          setPlanMode("apply")
          setStep("authorized")
          void onOAuthChanged?.()
        })()
      }
    })
      .then((stop) => {
        if (cancelled) stop()
        else unsubscribe = stop
      })
      .catch(() => {
        // Manual callback paste remains available even without an event stream.
      })

    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [step, startFlow, upstreamUrl, transport, onOAuthChanged])

  // Clear transient plan ref on unmount.
  useEffect(() => clearPendingPlan, [clearPendingPlan])

  const handleStartOAuth = async () => {
    if (starting) return
    setStarting(true)
    setErrorMsg(null)
    setErrorDetail(null)
    try {
      const scopes = parseOAuthScopesInput(scopesInput)
      const result = await mcpOAuthStart({
        upstream_url: upstreamUrl,
        transport,
        resource_metadata_url: resourceMetadataUrl,
        client_id: clientId,
        client_secret: clientSecret,
        scopes: scopes.length > 0 ? scopes : undefined,
      })
      setStartFlow(result)
      setStep("waiting")
      void openInSystemBrowser(result.authorization_url).catch(() => {
        // User can retry with "Open authorization page again" or copy link.
      })
    } catch (error) {
      const failure = mcpFailureOf(error)
      setErrorMsg(t("startFailed"))
      setErrorDetail(failure.detail || null)
    } finally {
      setStarting(false)
    }
  }

  const handleCompleteManualCallback = async () => {
    if (!startFlow || completing) return
    const trimmed = callbackUrlInput.trim()
    if (!trimmed) return
    setCompleting(true)
    setErrorMsg(null)
    setErrorDetail(null)
    try {
      const completedRoute = await mcpOAuthCompleteCallback({
        flow_id: startFlow.flow_id,
        callback_url: trimmed,
      })
      setRoute(completedRoute)
      setPlanMode("apply")
      setStep("authorized")
      void onOAuthChanged?.()
    } catch (error) {
      const failure = mcpFailureOf(error)
      setErrorMsg(t("callbackFailed"))
      setErrorDetail(failure.detail || null)
    } finally {
      setCompleting(false)
    }
  }

  const handleCancelFlowAndClose = async () => {
    if (step === "saving") return
    clearPendingPlan()
    if (step === "waiting" && startFlow && !cancelling) {
      setCancelling(true)
      try {
        await mcpOAuthCancel(startFlow.flow_id)
      } catch {
        // Ignore cancel failures when closing the dialog.
      } finally {
        setCancelling(false)
      }
    }
    onClose()
  }

  const toggleTarget = (agentId: McpAgentId, checked: boolean) => {
    setSelectedTargets((prev) => {
      if (checked) {
        return prev.includes(agentId) ? prev : [...prev, agentId]
      }
      return prev.filter((id) => id !== agentId)
    })
  }

  const validTargetIds = useMemo(
    () => availableTargets.flatMap((info) => (info.agent ? [info.agent] : [])),
    [availableTargets]
  )

  const effectiveSelectedTargets = useMemo(
    () => selectedTargets.filter((id) => validTargetIds.includes(id)),
    [selectedTargets, validTargetIds]
  )

  const handleReviewPlan = async (mode: "apply" | "restore") => {
    if (!model || effectiveSelectedTargets.length === 0 || preparingPlan) return
    setPreparingPlan(true)
    setErrorMsg(null)
    setErrorDetail(null)
    setPlanMode(mode)
    try {
      let plan: McpPlan | null = null
      if (mode === "apply") {
        if (!route) return
        // Fetch bridge definition only right before planning; never render or cache.
        const bridgeDef = await mcpOAuthBridgeDefinition(route.route_id)
        plan = planBridgeRouteApply(
          model,
          serverKey,
          effectiveSelectedTargets,
          bridgeDef
        )
      } else {
        plan = planRestoreDirectUrl(
          model,
          serverKey,
          effectiveSelectedTargets,
          route?.upstream_url ?? upstreamUrl,
          route?.transport ?? transport
        )
      }
      if (!plan) {
        setErrorMsg(t("applyFailed"))
        return
      }
      pendingPlanRef.current = plan
      setApplyFlow({
        step: "review",
        plan: { ops: [], basis: plan.basis },
        preflight: null,
        result: null,
        failure: null,
        notice: null,
        request: 1,
      })
      setStep("review")
      const preflight = await mcpApply({
        basis: plan.basis,
        ops: plan.ops,
        preflight: true,
      })
      setApplyFlow((prev) => ({
        ...prev,
        preflight,
      }))
    } catch (error) {
      clearPendingPlan()
      const failure = mcpFailureOf(error)
      setErrorMsg(t("applyFailed"))
      setErrorDetail(failure.detail || null)
      setStep(mode === "restore" ? "restore" : "authorized")
    } finally {
      setPreparingPlan(false)
    }
  }

  const handleCommitPlan = async () => {
    const plan = pendingPlanRef.current
    if (!plan || !applyFlow.preflight?.ok) return
    const basis = { ...plan.basis, ...basisFromResult(applyFlow.preflight) }
    setStep("saving")
    setApplyFlow((prev) => ({ ...prev, step: "saving", failure: null }))
    try {
      const result = await mcpApply({
        basis,
        ops: plan.ops,
        preflight: false,
      })
      clearPendingPlan()
      setApplyFlow((prev) => ({
        ...prev,
        step: "result",
        result,
        failure: null,
      }))
      setStep("result")
      if (isSaved(result)) {
        await onApplied?.()
      }
    } catch (error) {
      clearPendingPlan()
      setApplyFlow((prev) => ({
        ...prev,
        step: "result",
        result: null,
        failure: mcpFailureOf(error),
      }))
      setStep("result")
    }
  }

  const handleProbeBridge = async () => {
    if (!route) return
    setProbeRecord({
      phase: "loading",
      fingerprint: null,
      result: probeRecord?.result ?? null,
      failure: null,
      request: 1,
    })
    try {
      // Fetch bridge definition ephemerally for probing; never store or display it.
      const bridgeDef = await mcpOAuthBridgeDefinition(route.route_id)
      const result = await mcpProbe({ definition: bridgeDef })
      setProbeRecord({
        phase: "ready",
        fingerprint: null,
        result,
        failure: null,
        request: 1,
      })
    } catch (error) {
      setProbeRecord({
        phase: "error",
        fingerprint: null,
        result: null,
        failure: mcpFailureOf(error),
        request: 1,
      })
    }
  }

  const title =
    planMode === "restore" || step === "restore"
      ? t.rich("restoreTitle", { key: serverKey, code })
      : initialMode === "apply"
        ? t.rich("applyTitle", { key: serverKey, code })
        : t.rich("title", { key: serverKey, code })

  const description =
    step === "prepare" || step === "waiting" ? t("description") : undefined

  const describeAgentNote = (info: McpAgentInfo, mode: "apply" | "restore") => {
    const entry = info.inventory.entries.find((item) => item.key === serverKey)
    if (!entry)
      return mode === "restore" ? t("agentNotConfigured") : t("agentWillAdd")
    const match = matchOAuthRouteForDefinition(
      entry.definition,
      oauthSnapshot ?? null
    )
    if (mode === "restore") {
      return match?.kind === "bridged"
        ? t("agentWillRestore")
        : t("agentCurrentlyDirect")
    }
    if (match?.kind === "bridged") {
      return match.portDrifted
        ? t("agentPortDrifted")
        : t("agentAlreadyBridged")
    }
    return t("agentCurrentlyDirect")
  }

  const renderTargetSelector = (mode: "apply" | "restore") => (
    <fieldset className="min-w-0 space-y-2">
      <legend className={MCP_SECTION_TITLE_CLASS}>
        {mode === "restore" ? t("restoreAgentsLegend") : t("routeAgentsLegend")}
      </legend>
      <p className="text-xs text-muted-foreground">
        {mode === "restore" ? t("restoreAgentsHint") : t("routeAgentsHint")}
      </p>
      {availableTargets.length === 0 ? (
        <p className="rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          {t("noCompatibleTargets")}
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <AgentSelectAll
            total={validTargetIds.length}
            checked={effectiveSelectedTargets.length}
            onChange={(on) => {
              setSelectedTargets(on ? [...validTargetIds] : [])
            }}
          />
          <ul className="divide-y">
            {availableTargets.map((info) => {
              if (!info.agent) return null
              const agentId = info.agent
              const id = `${baseId}-target-${agentId}`
              const checked = effectiveSelectedTargets.includes(agentId)
              return (
                <li
                  key={agentId}
                  className="flex min-w-0 items-center gap-3 px-3 py-2"
                >
                  <Checkbox
                    id={id}
                    checked={checked}
                    onCheckedChange={(val) =>
                      toggleTarget(agentId, val === true)
                    }
                    className="max-md:size-5"
                  />
                  <label
                    htmlFor={id}
                    className="flex min-w-0 flex-1 cursor-pointer items-center justify-between gap-2"
                  >
                    <span className="flex min-w-0 items-center gap-2 text-sm">
                      <AgentGlyph agent={agentId} />
                      <span className="truncate font-medium">
                        {info.displayName?.trim() || labels.agent(agentId)}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {describeAgentNote(info, mode)}
                    </span>
                  </label>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </fieldset>
  )

  const errorBanner = errorMsg && (
    <div
      role="alert"
      className="flex min-w-0 items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-foreground"
    >
      <TriangleAlert
        aria-hidden="true"
        className="mt-0.5 size-3.5 shrink-0 text-destructive"
      />
      <div className="min-w-0 flex-1">
        <p>{errorMsg}</p>
        <Technical detail={errorDetail} />
      </div>
    </div>
  )

  let body: ReactNode
  let footer: ReactNode

  if (step === "prepare") {
    body = (
      <div className="min-w-0 space-y-4 text-sm">
        <div className="space-y-2 rounded-lg border bg-muted/25 p-3">
          <div className="flex min-w-0 items-center justify-between gap-2 text-xs">
            <span className="text-muted-foreground">{t("targetServer")}</span>
            <DiscoverMark size="sm">{labels.transport(transport)}</DiscoverMark>
          </div>
          <bdi
            dir="ltr"
            className="block truncate font-mono text-xs text-foreground"
          >
            <MachineText>{upstreamUrl}</MachineText>
          </bdi>
          <p className="flex items-start gap-1.5 pt-1 text-xs text-muted-foreground">
            <ShieldCheck
              aria-hidden="true"
              className="mt-0.5 size-3.5 shrink-0 text-tone-success"
            />
            <span>{t("securityNote")}</span>
          </p>
        </div>

        <div className="rounded-lg border">
          <button
            type="button"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((prev) => !prev)}
            className="flex w-full items-center gap-1.5 px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            {advancedOpen ? (
              <ChevronDown aria-hidden="true" className="size-3.5" />
            ) : (
              <ChevronRight
                aria-hidden="true"
                className="size-3.5 rtl:rotate-180"
              />
            )}
            <span>{t("advancedToggle")}</span>
          </button>
          {advancedOpen && (
            <div className="space-y-3 border-t px-3 py-3 text-xs">
              <p className="text-muted-foreground">{t("advancedHint")}</p>
              <div className="space-y-1">
                <label
                  htmlFor={`${baseId}-client-id`}
                  className="block font-medium text-foreground"
                >
                  {t("clientId")}
                </label>
                <Input
                  id={`${baseId}-client-id`}
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder={t("clientIdPlaceholder")}
                  autoComplete="off"
                />
              </div>
              <div className="space-y-1">
                <label
                  htmlFor={`${baseId}-client-secret`}
                  className="block font-medium text-foreground"
                >
                  {t("clientSecret")}
                </label>
                <Input
                  id={`${baseId}-client-secret`}
                  type="password"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  placeholder={t("clientSecretPlaceholder")}
                  autoComplete="off"
                />
              </div>
              <div className="space-y-1">
                <label
                  htmlFor={`${baseId}-scopes`}
                  className="block font-medium text-foreground"
                >
                  {t("scopes")}
                </label>
                <Input
                  id={`${baseId}-scopes`}
                  value={scopesInput}
                  onChange={(e) => setScopesInput(e.target.value)}
                  placeholder={t("scopesPlaceholder")}
                  autoComplete="off"
                />
              </div>
            </div>
          )}
        </div>

        {errorBanner}
      </div>
    )
    footer = (
      <>
        <Button
          type="button"
          variant="outline"
          onClick={() => void handleCancelFlowAndClose()}
        >
          {tDialog("cancel")}
        </Button>
        <Button
          type="button"
          disabled={starting}
          onClick={() => void handleStartOAuth()}
        >
          {starting ? (
            <Loader2 aria-hidden="true" className="animate-spin" />
          ) : (
            <KeyRound aria-hidden="true" />
          )}
          {starting ? t("starting") : t("authorizeInBrowser")}
        </Button>
      </>
    )
  } else if (step === "waiting" && startFlow) {
    body = (
      <div className="min-w-0 space-y-4 text-sm">
        <div className="space-y-2 rounded-lg border bg-muted/25 p-3.5">
          <div className="flex items-center gap-2 font-medium text-foreground">
            <Loader2
              aria-hidden="true"
              className="size-4 shrink-0 animate-spin text-primary"
            />
            <span>{t("waitingTitle")}</span>
            <DiscoverMark size="sm" className="ms-auto">
              {startFlow.registration_mode === "manual"
                ? t("registrationManual")
                : t("registrationDynamic")}
            </DiscoverMark>
          </div>
          <p className="text-xs text-muted-foreground">{t("waitingHint")}</p>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => {
                void openInSystemBrowser(startFlow.authorization_url)
              }}
            >
              <ExternalLink aria-hidden="true" className="size-3" />
              {t("reopenAuthPage")}
            </Button>
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => {
                void copyTextToClipboard(startFlow.authorization_url).then(
                  (ok) => {
                    if (ok) markCopiedLink()
                  }
                )
              }}
            >
              {copiedLink ? (
                <Check aria-hidden="true" className="size-3" />
              ) : (
                <Copy aria-hidden="true" className="size-3" />
              )}
              {copiedLink ? t("copiedAuthLink") : t("copyAuthLink")}
            </Button>
          </div>
        </div>

        <div className="rounded-lg border">
          <button
            type="button"
            aria-expanded={manualCallbackOpen}
            onClick={() => setManualCallbackOpen((prev) => !prev)}
            className="flex w-full items-center gap-1.5 px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            {manualCallbackOpen ? (
              <ChevronDown aria-hidden="true" className="size-3.5" />
            ) : (
              <ChevronRight
                aria-hidden="true"
                className="size-3.5 rtl:rotate-180"
              />
            )}
            <span>{t("manualCallbackToggle")}</span>
          </button>
          {manualCallbackOpen && (
            <div className="space-y-2.5 border-t px-3 py-3 text-xs">
              <p className="text-muted-foreground">{t("manualCallbackHint")}</p>
              <div className="flex min-w-0 items-center gap-2">
                <Input
                  aria-label={t("manualCallbackToggle")}
                  value={callbackUrlInput}
                  onChange={(e) => setCallbackUrlInput(e.target.value)}
                  placeholder={t("manualCallbackPlaceholder")}
                  autoComplete="off"
                  className="min-w-0 flex-1 font-mono text-xs"
                />
                <Button
                  type="button"
                  size="sm"
                  disabled={completing || callbackUrlInput.trim() === ""}
                  onClick={() => void handleCompleteManualCallback()}
                >
                  {completing && (
                    <Loader2 aria-hidden="true" className="animate-spin" />
                  )}
                  {completing ? t("completingCallback") : t("completeCallback")}
                </Button>
              </div>
            </div>
          )}
        </div>

        {errorBanner}
      </div>
    )
    footer = (
      <Button
        type="button"
        variant="outline"
        disabled={cancelling}
        onClick={() => void handleCancelFlowAndClose()}
      >
        {cancelling ? t("cancelling") : tDialog("cancel")}
      </Button>
    )
  } else if (step === "authorized" && route) {
    body = (
      <div className="min-w-0 space-y-4 text-sm">
        <div className="space-y-2 rounded-lg border border-tone-success/30 bg-tone-success/10 p-3 text-xs">
          <div className="flex flex-wrap items-center gap-2 font-medium text-foreground">
            <CircleCheck
              aria-hidden="true"
              className="size-4 shrink-0 text-tone-success"
            />
            <span>{t("authorizedBanner")}</span>
            <DiscoverMark size="sm" tone="neutral" className="ms-auto">
              {route.has_refresh_token
                ? t("autoRefreshSupported")
                : t("autoRefreshUnsupported")}
            </DiscoverMark>
          </div>
          <dl className="grid grid-cols-1 gap-x-3 gap-y-1 pt-0.5 sm:grid-cols-[max-content_minmax(0,1fr)]">
            <dt className="text-muted-foreground">{t("upstreamUrl")}</dt>
            <dd className="min-w-0">
              <bdi
                dir="ltr"
                className="block truncate font-mono text-foreground"
              >
                <MachineText>{route.upstream_url}</MachineText>
              </bdi>
            </dd>
            {route.issuer && (
              <>
                <dt className="text-muted-foreground">{t("issuer")}</dt>
                <dd className="min-w-0">
                  <bdi
                    dir="ltr"
                    className="block truncate font-mono text-foreground"
                  >
                    <MachineText>{route.issuer}</MachineText>
                  </bdi>
                </dd>
              </>
            )}
            {route.scopes.length > 0 && (
              <>
                <dt className="text-muted-foreground">{t("scopesLabel")}</dt>
                <dd className="flex flex-wrap gap-1">
                  {route.scopes.map((scope) => (
                    <code
                      key={scope}
                      className="rounded bg-background/80 px-1.5 py-0.5 font-mono text-2xs text-foreground"
                    >
                      {scope}
                    </code>
                  ))}
                </dd>
              </>
            )}
            {route.expires_at && (
              <>
                <dt className="text-muted-foreground">{t("expiresAt")}</dt>
                <dd className="text-foreground">
                  {labels.date(route.expires_at)}
                </dd>
              </>
            )}
          </dl>
          <div className="pt-1">
            <McpProbeButton
              size="xs"
              variant="outline"
              loading={probeRecord?.phase === "loading"}
              tested={probeRecord?.phase === "ready"}
              label={
                probeRecord?.phase === "loading"
                  ? undefined
                  : t("testConnectionNow")
              }
              onClick={() => void handleProbeBridge()}
            />
          </div>
          {probeRecord && (
            <div className="pt-1">
              <McpProbePanel record={probeRecord} compact />
            </div>
          )}
        </div>

        {renderTargetSelector("apply")}
        {errorBanner}
      </div>
    )
    footer = (
      <>
        <Button type="button" variant="outline" onClick={onClose}>
          {tDialog("close")}
        </Button>
        <Button
          type="button"
          disabled={
            !model || effectiveSelectedTargets.length === 0 || preparingPlan
          }
          onClick={() => void handleReviewPlan("apply")}
        >
          {preparingPlan && (
            <Loader2 aria-hidden="true" className="animate-spin" />
          )}
          {preparingPlan ? t("preparingPlan") : t("reviewApply")}
        </Button>
      </>
    )
  } else if (step === "restore") {
    body = (
      <div className="min-w-0 space-y-4 text-sm">
        <div className="space-y-1.5 rounded-lg border bg-muted/25 p-3 text-xs">
          <span className="text-muted-foreground">{t("upstreamUrl")}</span>
          <bdi dir="ltr" className="block truncate font-mono text-foreground">
            <MachineText>{route?.upstream_url ?? upstreamUrl}</MachineText>
          </bdi>
        </div>
        {renderTargetSelector("restore")}
        {errorBanner}
      </div>
    )
    footer = (
      <>
        <Button type="button" variant="outline" onClick={onClose}>
          {tDialog("cancel")}
        </Button>
        <Button
          type="button"
          disabled={
            !model || effectiveSelectedTargets.length === 0 || preparingPlan
          }
          onClick={() => void handleReviewPlan("restore")}
        >
          {preparingPlan && (
            <Loader2 aria-hidden="true" className="animate-spin" />
          )}
          {preparingPlan ? t("preparingPlan") : t("reviewRestore")}
        </Button>
      </>
    )
  } else if (step === "review" || step === "saving") {
    const canSave = applyFlow.preflight?.ok === true && step === "review"
    const canRetryCheck =
      applyFlow.preflight?.outcome === "changed_elsewhere" ||
      applyFlow.failure !== null
    body = <McpReview flow={applyFlow} />
    footer = (
      <>
        <Button
          type="button"
          variant="outline"
          disabled={step === "saving"}
          onClick={() => {
            clearPendingPlan()
            setStep(planMode === "restore" ? "restore" : "authorized")
          }}
        >
          {tDialog("back")}
        </Button>
        {canRetryCheck ? (
          <Button type="button" onClick={() => void handleReviewPlan(planMode)}>
            <RefreshCw aria-hidden="true" />
            {tDialog("checkAgain")}
          </Button>
        ) : (
          <Button
            type="button"
            disabled={!canSave}
            onClick={() => void handleCommitPlan()}
          >
            {step === "saving" ? tDialog("saving") : tDialog("save")}
          </Button>
        )}
      </>
    )
  } else {
    const saved = applyFlow.result !== null && isSaved(applyFlow.result)
    body = (
      <div className="min-w-0 space-y-3">
        <McpResults flow={applyFlow} />
        {saved && planMode === "apply" && route && (
          <div className="space-y-2 pt-1">
            <McpProbeButton
              size="xs"
              variant="outline"
              loading={probeRecord?.phase === "loading"}
              tested={probeRecord?.phase === "ready"}
              label={
                probeRecord?.phase === "loading"
                  ? undefined
                  : t("testConnectionNow")
              }
              onClick={() => void handleProbeBridge()}
            />
            {probeRecord && <McpProbePanel record={probeRecord} compact />}
          </div>
        )}
      </div>
    )
    footer = saved ? (
      <Button type="button" onClick={onClose}>
        {tDialog("done")}
      </Button>
    ) : (
      <>
        <Button
          type="button"
          variant="outline"
          onClick={() =>
            setStep(planMode === "restore" ? "restore" : "authorized")
          }
        >
          {tDialog("back")}
        </Button>
        <Button type="button" onClick={onClose}>
          {tDialog("close")}
        </Button>
      </>
    )
  }

  return (
    <McpDialogFrame
      title={title}
      description={description}
      step={step}
      onRequestClose={() => void handleCancelFlowAndClose()}
      footer={footer}
      size="default"
    >
      {body}
    </McpDialogFrame>
  )
}
