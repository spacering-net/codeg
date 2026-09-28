"use client"

/**
 * Multi-agent delegation settings panel. Two top-level concerns split into
 * tabs:
 *
 *   * "General" — feature kill switch + chain depth limit. Persisted as
 *     `delegation.enabled` / `delegation.depth_limit` on the Rust side.
 *   * "Agent defaults" — per-agent overrides (mode + config_values) that
 *     codeg-mcp uses when spawning a subagent for a `delegate_to_agent`
 *     call. Persisted as `delegation.agent_defaults` (one JSON blob).
 *
 * Cancellation is handled out-of-band via MCP `notifications/cancelled`
 * forwarded from the parent agent CLI; there is no broker-side timeout to
 * configure here.
 *
 * Mounted under `/settings/collaboration` above the in-conversation tools,
 * because delegation is a global feature — not per-agent — and doesn't belong
 * inside the 7,800-line `acp-agent-settings.tsx` that powers
 * `/settings/agents`.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { AlertTriangle, Bubbles, Gauge, HardDrive, Power } from "lucide-react"
import { toast } from "sonner"

import { SettingCard, SettingRow } from "@/components/shared/setting-card"
import {
  SettingsError,
  SettingsSaveBar,
  SettingsSection,
} from "@/components/shared/settings-section"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  acpListAgents,
  type DelegationSettings,
  getDelegationSettings,
  setDelegationSettings,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { subscribe } from "@/lib/platform"
import { DELEGATION_SETTINGS_CHANGED_EVENT } from "@/lib/types"
import type { AgentDelegationDefaults, AgentType } from "@/lib/types"
import { DelegationAgentDefaultsPanel } from "./delegation-agent-defaults"

const DEPTH_MIN = 1
const DEPTH_MAX = 8
const DEFAULT_CACHE_MB = 512

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo
  return Math.min(hi, Math.max(lo, Math.trunc(n)))
}

/** Cache budget in MB: floor at 0 (= unlimited), drop fractional MB, no upper
 * bound (it's a memory choice, not a safety rail). NaN (cleared/garbage input)
 * falls back to the product default rather than silently disabling the valve. */
function clampCacheMb(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_CACHE_MB
  return Math.max(0, Math.trunc(n))
}

export function DelegationSettingsSection() {
  const t = useTranslations("AcpAgentSettings.multiAgent")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [depth, setDepth] = useState<number>(1)
  const [cacheMb, setCacheMb] = useState<number>(DEFAULT_CACHE_MB)
  const [agentDefaults, setAgentDefaults] = useState<
    Partial<Record<AgentType, AgentDelegationDefaults>>
  >({})
  const [loadError, setLoadError] = useState<string | null>(null)
  // Enabled agents whose per-agent sandbox switch withholds the delegation
  // tools (see `withheldByHostTools`). Empty until the agent list loads, and
  // left empty if it fails — this is an explanatory note, never a gate.
  const [withheldAgents, setWithheldAgents] = useState<string[]>([])
  /** Last value of the switch that came from the backend — a load, a save, or
   * the broadcast below. `enabled !== baselineEnabledRef.current` is therefore
   * "the user moved this and hasn't saved yet". */
  const baselineEnabledRef = useRef(false)
  /** Bumped by every broadcast, so the initial load can tell that its own read
   * is the older fact and leave the switch alone. */
  const remoteGenRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    const gen = remoteGenRef.current
    void getDelegationSettings()
      .then((s) => {
        if (cancelled) return
        if (remoteGenRef.current === gen) {
          setEnabled(s.enabled)
          baselineEnabledRef.current = s.enabled
        }
        setDepth(s.depth_limit)
        setCacheMb(s.completed_cache_max_mb)
        setAgentDefaults(s.agent_defaults ?? {})
        setLoadError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setLoadError(toErrorMessage(err))
      })
      .finally(() => {
        if (cancelled) return
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // The switch above is not the only thing that decides whether an agent gets
  // `delegate_to_agent`: the per-agent "the agent handles files and commands
  // itself" switch withholds the delegation tool group too, because delegation
  // routes the same work back through codeg's process. That override is
  // invisible from here, which reads as "I turned multi-agent on and the tools
  // are gone" — so name the agents it applies to.
  //
  // `host_tools_agent_mode` is the backend's RESOLVED verdict, not a re-read of
  // `env`: the knob also resolves from codeg's own process env, and an operator
  // who exported it there would otherwise see no warning while every agent
  // silently lost delegation.
  useEffect(() => {
    let cancelled = false
    void acpListAgents()
      .then((agents) => {
        if (cancelled) return
        setWithheldAgents(
          agents
            .filter((a) => a.enabled && a.host_tools_agent_mode)
            .map((a) => a.name)
        )
      })
      .catch(() => {
        // Nothing to say if we can't tell — leave the note off rather than
        // warning about agents that may well be able to delegate.
        if (!cancelled) setWithheldAgents([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  /**
   * Converge on a delegation write that happened elsewhere.
   *
   * The status-bar codeg-mcp popover flips `enabled` on its own, while the save
   * below submits the whole record. Without this, a form left open across such
   * a toggle would send its stale `enabled` on the next save — changing only the
   * depth limit would silently switch delegation back off.
   *
   * A switch the user has already moved keeps their pending value; only the
   * baseline follows the remote, so their edit still wins on save.
   */
  useEffect(() => {
    let disposed = false
    let unsubscribe: (() => void) | undefined
    void subscribe<DelegationSettings>(
      DELEGATION_SETTINGS_CHANGED_EVENT,
      (remote) => {
        remoteGenRef.current += 1
        // Snapshot the old baseline before overwriting it, rather than reading
        // the ref from inside the updater. React usually computes an updater
        // eagerly, which would read it before the line below — but only while
        // the fiber has no pending work; once it defers, the updater would see
        // the NEW baseline, conclude an untouched switch had been edited, and
        // refuse the broadcast, which is the one case this exists for. Reading
        // it here is correct under both schedules.
        const previousBaseline = baselineEnabledRef.current
        baselineEnabledRef.current = remote.enabled
        setEnabled((current) =>
          current === previousBaseline ? remote.enabled : current
        )
      }
    )
      .then((fn) => {
        if (disposed) fn()
        else unsubscribe = fn
      })
      // Transport not ready is not a reason to break the form; this window just
      // keeps whatever it loaded.
      .catch(() => {})
    return () => {
      disposed = true
      unsubscribe?.()
    }
  }, [])

  const save = useCallback(async () => {
    const payload: DelegationSettings = {
      enabled,
      depth_limit: clamp(depth, DEPTH_MIN, DEPTH_MAX),
      completed_cache_max_mb: clampCacheMb(cacheMb),
      agent_defaults: agentDefaults,
    }
    setSaving(true)
    try {
      const applied = await setDelegationSettings(payload)
      // Mirror any server-side clamps / filter passes back into the UI so the
      // inputs reflect what was actually persisted.
      setEnabled(applied.enabled)
      baselineEnabledRef.current = applied.enabled
      setDepth(applied.depth_limit)
      setCacheMb(applied.completed_cache_max_mb)
      setAgentDefaults(applied.agent_defaults ?? {})
      toast.success(t("saved"))
    } catch (err: unknown) {
      toast.error(t("saveFailed"), {
        description: toErrorMessage(err),
      })
    } finally {
      setSaving(false)
    }
  }, [enabled, depth, cacheMb, agentDefaults, t])

  return (
    <SettingsSection
      icon={Bubbles}
      title={t("title")}
      description={t("description")}
    >
      {loadError && (
        <SettingsError>{t("loadFailed", { detail: loadError })}</SettingsError>
      )}

      <Tabs defaultValue="general">
        <TabsList>
          <TabsTrigger value="general">{t("tabGeneral")}</TabsTrigger>
          <TabsTrigger value="agentDefaults">
            {t("tabAgentDefaults")}
          </TabsTrigger>
        </TabsList>

        {/* The kill switch and the two valves it gates are one decision, so
            they share a card — the greyed-out inputs then read as belonging to
            the switch above them rather than as three unrelated lines. */}
        <TabsContent value="general" className="pt-2">
          <SettingCard>
            <SettingRow
              icon={Power}
              title={t("enable")}
              description={t("enableHint")}
              htmlFor="delegation-enabled"
              control={
                <Switch
                  id="delegation-enabled"
                  checked={enabled}
                  onCheckedChange={setEnabled}
                  disabled={loading}
                />
              }
            />
            {enabled && withheldAgents.length > 0 && (
              // Padded like a `SettingRow` (`px-3`) so the glyph and text line
              // up with the rows it sits between, rather than hanging a notch
              // to their left inside the shared card.
              <p className="flex items-start gap-1.5 px-3 py-2 text-2xs text-amber-700 dark:text-amber-400">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                <span>
                  {t("withheldByHostTools", {
                    agents: withheldAgents.join(", "),
                  })}
                </span>
              </p>
            )}
            <SettingRow
              icon={Gauge}
              title={t("depthLimit")}
              description={t("depthHint", { min: DEPTH_MIN, max: DEPTH_MAX })}
              htmlFor="delegation-depth"
              control={
                <Input
                  id="delegation-depth"
                  type="number"
                  min={DEPTH_MIN}
                  max={DEPTH_MAX}
                  value={depth}
                  onChange={(e) => setDepth(Number(e.target.value))}
                  disabled={loading || !enabled}
                  className="h-8 w-24 bg-background text-xs"
                />
              }
            />
            <SettingRow
              icon={HardDrive}
              title={t("completedCacheLabel")}
              description={t("completedCacheHint")}
              htmlFor="delegation-cache-mb"
              control={
                <Input
                  id="delegation-cache-mb"
                  type="number"
                  min={0}
                  step={1}
                  value={Number.isNaN(cacheMb) ? "" : cacheMb}
                  onChange={(e) => {
                    const raw = e.target.value
                    // Empty (cleared) → NaN so `clampCacheMb` restores the
                    // default on save, instead of `Number("") === 0` silently
                    // persisting 0 (= unlimited). Explicit "0" still means
                    // unlimited.
                    setCacheMb(raw === "" ? NaN : Number(raw))
                  }}
                  disabled={loading || !enabled}
                  className="h-8 w-24 bg-background text-xs"
                />
              }
            />
          </SettingCard>
        </TabsContent>

        <TabsContent value="agentDefaults" className="pt-2">
          <DelegationAgentDefaultsPanel
            value={agentDefaults}
            onChange={setAgentDefaults}
            disabled={loading || !enabled}
          />
        </TabsContent>
      </Tabs>

      <SettingsSaveBar
        onSave={() => void save()}
        saving={saving}
        disabled={loading}
        label={t("save")}
        savingLabel={t("saving")}
      />
    </SettingsSection>
  )
}
