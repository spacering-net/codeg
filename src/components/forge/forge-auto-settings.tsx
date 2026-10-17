"use client"

import { useCallback, useEffect, useState } from "react"
import { useLocale, useTranslations } from "next-intl"
import {
  Activity,
  CalendarClock,
  Check,
  CircleDot,
  Copy,
  Eye,
  EyeOff,
  GitPullRequest,
  History,
  Info,
  MessageSquare,
  Play,
  RefreshCw,
  Tag,
  Webhook,
} from "lucide-react"

import { forgeAutoScanNow, forgeAutoStatus, forgeListLabels } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import {
  forgeWebhookUrls,
  generateWebhookSecret,
  scanIntervalOptions,
} from "@/lib/forge-auto"
import type {
  ForgeAutoScanReport,
  ForgeAutoSettings,
  ForgeAutoSkip,
  ForgeAutoStatus,
  ForgeAutoTrigger,
} from "@/lib/types"
import { copyTextToClipboard } from "@/lib/utils"
import {
  SettingCard,
  SettingNote,
  SettingRow,
} from "@/components/shared/setting-card"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { ScenarioSelect } from "./forge-scenario-select"
import { initialScenario, scenariosForKind } from "./forge-start-dialog"
import { PatternListInput } from "./pattern-list-input"

/** How often the activity card re-reads the processor's in-memory status
 *  while it is on screen. A read costs nothing on the backend; the cadence
 *  only decides how soon a scan that finished behind the dialog shows up. */
const STATUS_POLL_MS = 5_000

const TRIGGER_KEYS = {
  schedule: "autoTriggerSchedule",
  webhook: "autoTriggerWebhook",
  manual: "autoTriggerManual",
} as const satisfies Record<ForgeAutoTrigger, string>

const SKIP_KEYS = {
  kind: "autoSkipKind",
  not_open: "autoSkipNotOpen",
  draft: "autoSkipDraft",
  excluded_label: "autoSkipExcludedLabel",
  excluded_author: "autoSkipExcludedAuthor",
  missing_label: "autoSkipMissingLabel",
  author_not_included: "autoSkipAuthorNotIncluded",
} as const satisfies Record<ForgeAutoSkip, string>

/** A date the way this section prints one: short, in the UI's language. */
function useFormatTime() {
  const locale = useLocale()
  return useCallback(
    (iso: string) => {
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return iso
      return date.toLocaleString(locale, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    },
    [locale]
  )
}

/**
 * The repository panel's auto-processing: what wakes it (a schedule, a
 * webhook), what it picks up (kinds, rules), and what happens to a task it
 * mints. Edits a scope's `auto` block in place; saving is the dialog's.
 *
 * The rules read top to bottom the way they are applied: kinds, then the
 * window, then exclusions-win label and author lists. Every switch here is
 * cautious by default — issues only, drafts left alone, nothing commented
 * back, no backlog swept up — because the one thing worse than a feature that
 * does too little unattended is one that does too much.
 */
export function ForgeAutoSettingsSection({
  value,
  onChange,
  folderId,
  savedEnabledAt,
  scanBlockedReason,
}: {
  value: ForgeAutoSettings
  onChange: (next: ForgeAutoSettings) => void
  /** The folder being edited, or `null` for the global row. */
  folderId: number | null
  /** When the SAVED settings of this scope switched auto-processing on, if
   *  they have — what the "from when" hint names. */
  savedEnabledAt: string | null
  /** Why "Scan now" is unavailable right now (unsaved edits, nothing on), or
   *  `null` when it may run. */
  scanBlockedReason: string | null
}) {
  const t = useTranslations("Forge")
  const formatTime = useFormatTime()
  const set = <K extends keyof ForgeAutoSettings>(
    key: K,
    next: ForgeAutoSettings[K]
  ) => onChange({ ...value, [key]: next })

  // The repository's own labels, as suggestions for the label lists. Only a
  // folder scope has a repository; the global row offers free text alone.
  const [labelNames, setLabelNames] = useState<string[]>([])
  useEffect(() => {
    if (folderId == null) return
    let cancelled = false
    forgeListLabels(folderId)
      .then((result) => {
        if (!cancelled) setLabelNames(result.labels.map((label) => label.name))
      })
      .catch(() => {
        /* suggestions are a convenience; free text still works */
      })
    return () => {
      cancelled = true
    }
  }, [folderId])

  const removeLabel = (pattern: string) => t("autoRemovePattern", { pattern })
  const windowHint = value.include_existing
    ? t("autoIncludeExistingOnHint")
    : savedEnabledAt != null
      ? t("autoSinceHint", { time: formatTime(savedEnabledAt) })
      : t("autoIncludeExistingHint")

  return (
    <div className="flex flex-col gap-3">
      <SettingNote icon={Info}>
        {t("autoIntro")}
        {folderId == null ? ` ${t("autoGlobalNote")}` : null}
      </SettingNote>

      {/* What wakes it. Both can be on: the webhook for speed, the schedule to
          catch a delivery that never arrived. */}
      <SettingCard>
        <SettingRow
          icon={CalendarClock}
          title={t("autoSchedule")}
          description={t("autoScheduleHint")}
          htmlFor="forge-auto-schedule"
          control={
            <Switch
              id="forge-auto-schedule"
              checked={value.schedule}
              onCheckedChange={(on) => set("schedule", on)}
            />
          }
        >
          {value.schedule ? (
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">
                {t("autoInterval")}
              </span>
              <IntervalSelect
                value={value.interval_minutes}
                onChange={(minutes) => set("interval_minutes", minutes)}
              />
            </div>
          ) : null}
        </SettingRow>
        <SettingRow
          icon={Webhook}
          title={t("autoWebhook")}
          description={t("autoWebhookHint")}
          htmlFor="forge-auto-webhook"
          control={
            <Switch
              id="forge-auto-webhook"
              checked={value.webhook}
              onCheckedChange={(on) =>
                onChange({
                  ...value,
                  webhook: on,
                  // Minted here rather than on save, so the secret to paste
                  // into the forge is on screen the moment the switch is.
                  // Kept when switched off — it is already in the forge.
                  webhook_secret:
                    on && !value.webhook_secret
                      ? generateWebhookSecret()
                      : value.webhook_secret,
                })
              }
            />
          }
        >
          {value.webhook ? (
            <WebhookSetup
              secret={value.webhook_secret}
              onRegenerate={() =>
                set("webhook_secret", generateWebhookSecret())
              }
            />
          ) : null}
        </SettingRow>
      </SettingCard>

      {/* What it picks up, and how each kind is handled. */}
      <SettingCard>
        <SettingRow
          icon={CircleDot}
          title={t("autoIssues")}
          description={t("autoIssuesHint")}
          htmlFor="forge-auto-issues"
          control={
            <Switch
              id="forge-auto-issues"
              checked={value.issues}
              onCheckedChange={(on) => set("issues", on)}
            />
          }
        >
          {value.issues ? (
            <LabelledLine label={t("autoHandleWith")}>
              <ScenarioSelect
                label={t("autoIssueScenario")}
                value={initialScenario(false, value.issue_scenario)}
                options={scenariosForKind(false)}
                onChange={(id) => set("issue_scenario", id)}
              />
            </LabelledLine>
          ) : null}
        </SettingRow>
        <SettingRow
          icon={GitPullRequest}
          title={t("autoPulls")}
          description={t("autoPullsHint")}
          htmlFor="forge-auto-pulls"
          control={
            <Switch
              id="forge-auto-pulls"
              checked={value.pull_requests}
              onCheckedChange={(on) => set("pull_requests", on)}
            />
          }
        >
          {value.pull_requests ? (
            <>
              <LabelledLine label={t("autoHandleWith")}>
                <ScenarioSelect
                  label={t("autoPrScenario")}
                  value={initialScenario(true, value.pr_scenario)}
                  options={scenariosForKind(true)}
                  onChange={(id) => set("pr_scenario", id)}
                />
              </LabelledLine>
              <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                <Checkbox
                  checked={value.skip_drafts}
                  onCheckedChange={(on) => set("skip_drafts", on === true)}
                />
                {t("autoSkipDrafts")}
              </label>
            </>
          ) : null}
        </SettingRow>
        <SettingRow
          icon={History}
          title={t("autoIncludeExisting")}
          description={windowHint}
          htmlFor="forge-auto-existing"
          control={
            <Switch
              id="forge-auto-existing"
              checked={value.include_existing}
              onCheckedChange={(on) => set("include_existing", on)}
            />
          }
        />
      </SettingCard>

      {/* The rules, said once above the lists rather than four times inside
          them. */}
      <SettingNote icon={Tag}>{t("autoRulesHint")}</SettingNote>
      <SettingCard>
        <SettingRow
          title={t("autoIncludeLabels")}
          htmlFor="forge-auto-include-labels"
        >
          <PatternListInput
            id="forge-auto-include-labels"
            values={value.include_labels}
            onChange={(next) => set("include_labels", next)}
            ariaLabel={t("autoIncludeLabels")}
            placeholder={t("autoLabelPlaceholder")}
            removeLabel={removeLabel}
            suggestions={labelNames}
          />
        </SettingRow>
        <SettingRow
          title={t("autoExcludeLabels")}
          htmlFor="forge-auto-exclude-labels"
        >
          <PatternListInput
            id="forge-auto-exclude-labels"
            values={value.exclude_labels}
            onChange={(next) => set("exclude_labels", next)}
            ariaLabel={t("autoExcludeLabels")}
            placeholder={t("autoLabelPlaceholder")}
            removeLabel={removeLabel}
            suggestions={labelNames}
          />
        </SettingRow>
        <SettingRow
          title={t("autoIncludeAuthors")}
          htmlFor="forge-auto-include-authors"
        >
          <PatternListInput
            id="forge-auto-include-authors"
            values={value.include_authors}
            onChange={(next) => set("include_authors", next)}
            ariaLabel={t("autoIncludeAuthors")}
            placeholder={t("autoAuthorPlaceholder")}
            removeLabel={removeLabel}
          />
        </SettingRow>
        <SettingRow
          title={t("autoExcludeAuthors")}
          htmlFor="forge-auto-exclude-authors"
        >
          <PatternListInput
            id="forge-auto-exclude-authors"
            values={value.exclude_authors}
            onChange={(next) => set("exclude_authors", next)}
            ariaLabel={t("autoExcludeAuthors")}
            placeholder={t("autoAuthorPlaceholder")}
            removeLabel={removeLabel}
          />
        </SettingRow>
      </SettingCard>

      {/* What happens to a task once it exists. */}
      <SettingCard>
        <SettingRow
          icon={Play}
          title={t("autoAutoStart")}
          description={t("autoAutoStartHint")}
          htmlFor="forge-auto-start"
          control={
            <Switch
              id="forge-auto-start"
              checked={value.auto_start}
              onCheckedChange={(on) => set("auto_start", on)}
            />
          }
        />
        <SettingRow
          icon={MessageSquare}
          title={t("autoWriteback")}
          description={t("autoWritebackHint")}
          htmlFor="forge-auto-writeback"
          control={
            <Switch
              id="forge-auto-writeback"
              checked={value.writeback}
              onCheckedChange={(on) => set("writeback", on)}
            />
          }
        />
      </SettingCard>

      {folderId != null ? (
        <ForgeAutoActivity
          folderId={folderId}
          scanBlockedReason={scanBlockedReason}
        />
      ) : null}
    </div>
  )
}

/** A muted label on the left, a control on the right — the second line of a
 *  setting row whose switch is on. */
function LabelledLine({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}

function IntervalSelect({
  value,
  onChange,
}: {
  value: number
  onChange: (minutes: number) => void
}) {
  const t = useTranslations("Forge")
  const label = (minutes: number) =>
    minutes % 60 === 0
      ? t("autoIntervalHours", { count: minutes / 60 })
      : t("autoIntervalMinutes", { count: minutes })
  return (
    <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
      <SelectTrigger
        className="h-8 w-36 bg-background text-xs"
        aria-label={t("autoInterval")}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {scanIntervalOptions(value).map((minutes) => (
          <SelectItem key={minutes} value={String(minutes)} className="text-xs">
            {label(minutes)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/**
 * Everything the forge's webhook form asks for, in the order it asks: where
 * to deliver, the secret, which events. The URL is only what this window can
 * see of codeg — it still has to be reachable from the forge, which the note
 * says, and the schedule is the answer when it is not.
 */
function WebhookSetup({
  secret,
  onRegenerate,
}: {
  secret: string | null
  onRegenerate: () => void
}) {
  const t = useTranslations("Forge")
  const [urls, setUrls] = useState<string[] | null>(null)
  const [shown, setShown] = useState(false)
  useEffect(() => {
    let cancelled = false
    forgeWebhookUrls()
      .then((found) => {
        if (!cancelled) setUrls(found)
      })
      .catch(() => {
        if (!cancelled) setUrls([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-muted-foreground">
        {t("autoWebhookUrl")}
      </span>
      {urls == null ? null : urls.length === 0 ? (
        <span className="text-xs leading-5 text-muted-foreground">
          {t("autoWebhookUrlUnavailable")}
        </span>
      ) : (
        urls.map((url) => <CopyableField key={url} value={url} />)
      )}
      <span className="text-xs font-medium text-muted-foreground">
        {t("autoWebhookSecret")}
      </span>
      {secret ? (
        <div className="flex items-center gap-1.5">
          <CopyableField
            value={secret}
            display={shown ? secret : "•".repeat(Math.min(secret.length, 24))}
          />
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            className="size-7 shrink-0"
            aria-label={
              shown ? t("autoWebhookHideSecret") : t("autoWebhookShowSecret")
            }
            title={
              shown ? t("autoWebhookHideSecret") : t("autoWebhookShowSecret")
            }
            onClick={() => setShown((v) => !v)}
          >
            {shown ? (
              <EyeOff className="size-3.5" aria-hidden="true" />
            ) : (
              <Eye className="size-3.5" aria-hidden="true" />
            )}
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            className="size-7 shrink-0"
            aria-label={t("autoWebhookRegenerate")}
            title={t("autoWebhookRegenerate")}
            onClick={onRegenerate}
          >
            <RefreshCw className="size-3.5" aria-hidden="true" />
          </Button>
        </div>
      ) : (
        <span className="text-xs leading-5 text-muted-foreground">
          {t("autoWebhookSecretPending")}
        </span>
      )}
      <span className="text-xs leading-5 text-muted-foreground">
        {t("autoWebhookSetup")}
      </span>
    </div>
  )
}

/** A read-only value with a copy button. `display` masks what is shown
 *  without changing what is copied. */
function CopyableField({
  value,
  display,
}: {
  value: string
  display?: string
}) {
  const t = useTranslations("Forge")
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const handle = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(handle)
  }, [copied])
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5">
      <code className="min-w-0 flex-1 truncate rounded-md border border-border/60 bg-background px-2 py-1 font-mono text-[0.6875rem]">
        {display ?? value}
      </code>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        className="size-7 shrink-0"
        aria-label={copied ? t("autoCopied") : t("autoCopy")}
        title={copied ? t("autoCopied") : t("autoCopy")}
        onClick={() => {
          void copyTextToClipboard(value).then((ok) => setCopied(ok))
        }}
      >
        {copied ? (
          <Check className="size-3.5" aria-hidden="true" />
        ) : (
          <Copy className="size-3.5" aria-hidden="true" />
        )}
      </Button>
    </div>
  )
}

/**
 * What auto-processing has done for one folder, and a button to make it look
 * now. The processor keeps this in memory, so it is re-read while on screen —
 * a scheduled scan or a webhook that lands behind the dialog shows up here.
 *
 * Failures are said INLINE, here, rather than in a toast: this is where the
 * reader is looking, and a scan that stopped (no account, a dead token, an
 * unsupported host) is precisely the answer they opened the dialog for.
 */
export function ForgeAutoActivity({
  folderId,
  scanBlockedReason,
}: {
  folderId: number
  scanBlockedReason: string | null
}) {
  const t = useTranslations("Forge")
  const formatTime = useFormatTime()
  const [status, setStatus] = useState<ForgeAutoStatus | null>(null)
  const [requesting, setRequesting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    forgeAutoStatus(folderId)
      .then(setStatus)
      .catch(() => {
        /* the next poll tries again */
      })
  }, [folderId])

  useEffect(() => {
    refresh()
    const handle = window.setInterval(refresh, STATUS_POLL_MS)
    return () => window.clearInterval(handle)
  }, [refresh])

  const scanNow = async () => {
    setRequesting(true)
    setError(null)
    try {
      const report = await forgeAutoScanNow(folderId)
      setStatus((prev) => (prev ? { ...prev, last_scan: report } : prev))
      refresh()
    } catch (e) {
      setError(toErrorMessage(e))
    } finally {
      setRequesting(false)
    }
  }

  const scanning = requesting || status?.scanning === true
  const unavailable = status != null && !status.available
  const blocked = scanBlockedReason ?? null

  return (
    <SettingCard>
      <SettingRow
        icon={Activity}
        title={t("autoActivity")}
        control={
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 text-xs"
            disabled={scanning || unavailable || blocked != null}
            onClick={() => void scanNow()}
          >
            <RefreshCw
              className={scanning ? "size-3.5 animate-spin" : "size-3.5"}
              aria-hidden="true"
            />
            {scanning ? t("autoStatusScanning") : t("autoScanNow")}
          </Button>
        }
      >
        <div className="flex flex-col gap-1 text-xs leading-5 text-muted-foreground">
          {unavailable ? (
            <span>{t("autoStatusUnavailable")}</span>
          ) : status?.last_scan ? (
            <ScanSummary report={status.last_scan} formatTime={formatTime} />
          ) : status != null ? (
            <span>{t("autoStatusNever")}</span>
          ) : null}
          {status?.next_scan_at ? (
            <span>
              {t("autoStatusNext", { time: formatTime(status.next_scan_at) })}
            </span>
          ) : null}
          {status?.last_delivery_at ? (
            <span>
              {t("autoStatusDelivery", {
                time: formatTime(status.last_delivery_at),
              })}
            </span>
          ) : null}
          {blocked != null && !unavailable ? <span>{blocked}</span> : null}
          {error != null ? (
            <span role="alert" className="text-destructive">
              {error}
            </span>
          ) : null}
        </div>
      </SettingRow>
    </SettingCard>
  )
}

/** One scan, in the words the user needs to judge their rules: what it
 *  looked at, what it took, what it passed over and why. */
function ScanSummary({
  report,
  formatTime,
}: {
  report: ForgeAutoScanReport
  formatTime: (iso: string) => string
}) {
  const t = useTranslations("Forge")
  const head = {
    time: formatTime(report.started_at),
    trigger: t(TRIGGER_KEYS[report.trigger]),
  }
  if (report.error != null) {
    return (
      <span role="status" className="text-destructive">
        {t("autoStatusError", { ...head, error: report.error })}
      </span>
    )
  }
  const skipped = (Object.keys(SKIP_KEYS) as ForgeAutoSkip[])
    .filter((reason) => (report.skipped[reason] ?? 0) > 0)
    .map((reason) => `${t(SKIP_KEYS[reason])} ${report.skipped[reason]}`)
  return (
    <>
      <span role="status">
        {t("autoStatusLast", head)}{" "}
        {t("autoStatusCounts", {
          examined: report.examined,
          matched: report.matched,
          handled: report.already_handled,
          created: report.created.length,
        })}
      </span>
      {report.created.length > 0 ? (
        <span>
          {t("autoStatusCreated", {
            items: report.created
              .map((item) => `#${item.number} ${item.title}`)
              .join(", "),
          })}
        </span>
      ) : null}
      {skipped.length > 0 ? (
        <span>{t("autoStatusSkipped", { list: skipped.join(" · ") })}</span>
      ) : null}
      {report.failed.length > 0 ? (
        <span className="text-destructive">
          {t("autoStatusFailed", {
            items: report.failed
              .map((item) => `#${item.number}: ${item.error}`)
              .join("; "),
          })}
        </span>
      ) : null}
      {report.created.some((item) => item.start_error != null) ? (
        <span className="text-destructive">
          {t("autoStatusStartFailed", {
            error:
              report.created.find((item) => item.start_error != null)
                ?.start_error ?? "",
          })}
        </span>
      ) : null}
      {report.truncated ? <span>{t("autoStatusTruncated")}</span> : null}
    </>
  )
}
