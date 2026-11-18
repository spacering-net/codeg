"use client"

import type { ReactNode } from "react"
import {
  CircleAlert,
  Info,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"

import { Checkbox } from "@/components/ui/checkbox"
import {
  formatDate,
  knownRisk,
  oneOf,
  pickLocalized,
} from "@/lib/harness/display"
import type { HarnessFailure } from "@/lib/harness/errors"
import type {
  HarnessPackageState,
  HarnessReason,
  HarnessVersionState,
} from "@/lib/harness/mcp-install-types"
import { HARNESS_PERMISSION_KEYS } from "@/lib/harness/types"
import { cn } from "@/lib/utils"
import { Code } from "../discover/detail-sections"
import { DiscoverMark } from "../discover/discover-card"
import { useHarnessFailureMessage } from "../discover/discover-failure"
import { useDiscoverLabels } from "../discover/use-discover-labels"
import { useHarnessHost } from "../harness-host-label"
import { MachineText } from "../machine-text"
import { Headline, Technical } from "../mcp/mcp-plan"
import { MCP_SECTION_TITLE_CLASS } from "../mcp/mcp-bits"
import { useInstallLabels, VERSION_STATUSES } from "./use-install-labels"

/**
 * The parts of an install confirmation that are not about MCP: who the item
 * is, what the catalog says of the version right now, why it cannot be
 * installed, what changed since the user looked, and the "withdrawn
 * version" question. The skill install dialog is made of the same parts.
 *
 * Everything the catalog wrote — a title, an address, a package's name — is
 * text, shown as text; machine text is isolated left to right and broken
 * between its parts (`MachineText`), so a long one wraps instead of pushing
 * the dialog sideways.
 */

const RISK_ICONS: Record<"low" | "medium" | "high" | "unknown", LucideIcon> = {
  low: ShieldCheck,
  medium: ShieldAlert,
  high: ShieldAlert,
  unknown: ShieldQuestion,
}

/** A titled part of the dialog. */
export function InstallPart({
  title,
  aside,
  children,
  className,
}: {
  title: string
  aside?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn("min-w-0", className)}>
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 pb-2">
        <h3 className={MCP_SECTION_TITLE_CLASS}>{title}</h3>
        {aside && (
          <span className="min-w-0 text-2xs text-muted-foreground">
            {aside}
          </span>
        )}
      </div>
      {children}
    </section>
  )
}

/** The item: its title where there is one (the catalog's text), its address,
 *  its version and revision, when it was out. */
export function InstallItemLine({
  itemRef,
  version,
  revision,
  publishedAt,
  listed,
  title,
}: {
  itemRef: string
  version: string | null
  revision: number
  publishedAt: string
  listed?: boolean
  /** Shown first, the address under it; without one, the address leads. */
  title?: { en?: string; zh?: string } | null
}) {
  const t = useTranslations("Harness.install.item")
  const labels = useDiscoverLabels()
  const date = formatDate(publishedAt, labels.locale)
  const name = pickLocalized(title, labels.lang)
  return (
    <div className="min-w-0 space-y-1 text-xs text-muted-foreground">
      {name && (
        <p
          dir="auto"
          className="text-sm font-medium break-words text-foreground"
        >
          {name}
        </p>
      )}
      <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <bdi
          dir="ltr"
          className={cn("min-w-0 font-mono", !name && "text-foreground")}
        >
          <MachineText>{itemRef}</MachineText>
        </bdi>
        {listed && <DiscoverMark>{t("listed")}</DiscoverMark>}
      </p>
      <p>
        {version
          ? t.rich("version", {
              version,
              revision,
              code: (chunks) => <Code>{chunks}</Code>,
            })
          : t("revisionOnly", { revision })}
        {date && ` · ${t("published", { date })}`}
      </p>
    </div>
  )
}

function StatusMark({ status }: { status: string }) {
  const labels = useInstallLabels()
  const known = oneOf(VERSION_STATUSES, status)
  return (
    <DiscoverMark
      tone={
        known === "ok"
          ? "success"
          : known === "yanked"
            ? "warning"
            : known === "blocked"
              ? "danger"
              : "neutral"
      }
    >
      {labels.status(status)}
    </DiscoverMark>
  )
}

function PackageRow({ pkg }: { pkg: HarnessPackageState }) {
  const t = useTranslations("Harness.install.snapshot")
  const labels = useInstallLabels()
  const check = pkg.verified
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <span className="shrink-0 text-muted-foreground">
        <bdi>{pkg.registryType || t("package")}</bdi>
      </span>
      <Code>
        {pkg.version ? `${pkg.identifier}@${pkg.version}` : pkg.identifier}
      </Code>
      <DiscoverMark
        tone={
          check === "ok"
            ? "success"
            : check === "missing"
              ? "danger"
              : check === "pending" || check === "unchecked"
                ? "warning"
                : "neutral"
        }
      >
        {labels.check(check)}
      </DiscoverMark>
      {pkg.hasInstallScript && (
        <DiscoverMark tone="warning">{t("installScript")}</DiscoverMark>
      )}
    </li>
  )
}

/**
 * What the item asks for, as its publisher declared it and as the catalog's
 * checks found it — in one list per kind of access, with what was found but
 * not declared marked. Only the kinds with something in them are listed.
 */
function PermissionRows({
  permissions,
}: {
  permissions: NonNullable<HarnessVersionState["permissions"]>
}) {
  const t = useTranslations("Harness.install.snapshot")
  const tDetail = useTranslations("Harness.discover.detail")
  const rows = HARNESS_PERMISSION_KEYS.flatMap((key) => {
    const declared = permissions.declared[key]
    const detected = permissions.detected[key]
    const values = [...new Set([...detected, ...declared])]
    return values.length > 0 ? [{ key, declared, detected, values }] : []
  })
  if (rows.length === 0) {
    return <p className="text-muted-foreground">{t("noPermissions")}</p>
  }
  return (
    <dl className="min-w-0 space-y-1.5">
      {rows.map(({ key, declared, detected, values }) => (
        <div key={key} className="min-w-0">
          <dt className="font-medium">{tDetail(`perms.${key}`)}</dt>
          <dd className="mt-0.5 flex min-w-0 flex-wrap gap-1">
            {values.map((value, index) => {
              const undeclared =
                detected.includes(value) && !declared.includes(value)
              const notFound =
                declared.includes(value) && !detected.includes(value)
              return (
                <span
                  key={index}
                  className="inline-flex max-w-full min-w-0 flex-wrap items-center gap-1"
                >
                  <Code
                    className={cn(
                      undeclared && "bg-tone-warning/10 text-tone-warning",
                      notFound && "text-muted-foreground"
                    )}
                  >
                    {value === "*" ? tDetail("allTools") : value}
                  </Code>
                  {undeclared && (
                    <span className="text-2xs text-tone-warning">
                      {t("undeclared")}
                    </span>
                  )}
                  {notFound && (
                    <span className="text-2xs text-muted-foreground">
                      {t("declaredOnly")}
                    </span>
                  )}
                </span>
              )
            })}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * What the catalog says of the version now — read right before the dialog
 * opened, never from the page the user came from: its status, the risk its
 * checks put it at, whether a person reviewed it, what the checks found,
 * whether each package's pinned version was found at its registry, and what
 * it asks for. A part the catalog left out says so; it is never filled in
 * with something reassuring.
 */
export function InstallSnapshot({
  snapshot,
  className,
}: {
  snapshot: HarnessVersionState | null
  className?: string
}) {
  const t = useTranslations("Harness.install.snapshot")
  const tDetail = useTranslations("Harness.discover.detail")
  const discover = useDiscoverLabels()
  if (!snapshot) {
    return (
      <InstallPart title={t("title")} className={className}>
        <p className="rounded-lg border px-3 py-2.5 text-xs text-muted-foreground">
          {t("none")}
        </p>
      </InstallPart>
    )
  }
  const risk =
    snapshot.risk === null ? null : (knownRisk(snapshot.risk) ?? "unknown")
  const Icon = RISK_ICONS[risk ?? "unknown"]
  const review = snapshot.checks
    ? oneOf(["off", "pending", "done"] as const, snapshot.checks.review)
    : null
  const findings = snapshot.checks?.findings
  const total = findings ? findings.high + findings.medium + findings.low : 0
  return (
    <InstallPart title={t("title")} aside={t("fresh")} className={className}>
      <div className="divide-y rounded-lg border text-xs">
        <div className="flex min-w-0 items-start gap-2.5 px-3 py-2.5">
          <Icon
            aria-hidden="true"
            className={cn(
              "mt-0.5 size-4 shrink-0",
              risk === "low" && "text-tone-success",
              risk === "medium" && "text-tone-warning",
              risk === "high" && "text-tone-danger",
              (risk === "unknown" || risk === null) && "text-muted-foreground"
            )}
          />
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-sm font-medium">
                {risk === null ? t("riskNotStated") : discover.risk(risk)}
              </span>
              <StatusMark status={snapshot.status} />
            </p>
            {risk !== null && (
              <p className="text-muted-foreground">
                {tDetail(`riskNote.${risk}`)}
              </p>
            )}
            <p className="text-muted-foreground">
              {snapshot.reviewed === null
                ? t("reviewNotStated")
                : tDetail(snapshot.reviewed ? "reviewed" : "notReviewed")}
              {review && ` · ${tDetail(`modelReview.${review}`)}`}
            </p>
          </div>
        </div>
        <div className="space-y-0.5 px-3 py-2">
          {snapshot.checks === null || !findings ? (
            <p className="text-muted-foreground">{t("checksNotStated")}</p>
          ) : (
            <>
              <p>
                {total === 0
                  ? t("noFindings")
                  : t("findings", {
                      high: findings.high,
                      medium: findings.medium,
                      low: findings.low,
                    })}
              </p>
              {snapshot.checks.secrets > 0 && (
                <p className="text-tone-warning">
                  {t("secrets", { count: snapshot.checks.secrets })}
                </p>
              )}
            </>
          )}
        </div>
        {snapshot.packages === null ? (
          <p className="px-3 py-2 text-muted-foreground">
            {t("packagesNotStated")}
          </p>
        ) : snapshot.packages.length > 0 ? (
          <div className="px-3 py-2">
            <p className="pb-1 text-muted-foreground">{t("packages")}</p>
            <ul className="space-y-1">
              {snapshot.packages.map((pkg, index) => (
                <PackageRow key={index} pkg={pkg} />
              ))}
            </ul>
          </div>
        ) : null}
        <div className="px-3 py-2">
          <p className="pb-1 text-muted-foreground">{t("permissions")}</p>
          {snapshot.permissions === null ? (
            <p className="text-muted-foreground">{t("permissionsNotStated")}</p>
          ) : (
            <PermissionRows permissions={snapshot.permissions} />
          )}
        </div>
      </div>
    </InstallPart>
  )
}

/** Reasons, each on a line of its own, with its technical detail under it
 *  where it has one. */
export function InstallReasonList({
  reasons,
  tone,
  parameterName,
  wording,
  className,
}: {
  reasons: readonly HarnessReason[]
  tone: "blocking" | "warning" | "info"
  parameterName?: (key: string) => string
  /** Words for the reasons, where a step has codes of its own (a skill's
   *  package, its name); the MCP step's words otherwise. */
  wording?: (reason: HarnessReason) => ReactNode
  className?: string
}) {
  const labels = useInstallLabels()
  const Icon =
    tone === "blocking"
      ? CircleAlert
      : tone === "warning"
        ? TriangleAlert
        : Info
  return (
    <ul className={cn("min-w-0 space-y-1 text-xs", className)}>
      {reasons.map((reason, index) => (
        <li key={index} className="flex min-w-0 items-start gap-1.5">
          <Icon
            aria-hidden="true"
            className={cn(
              "mt-0.5 size-3.5 shrink-0",
              tone === "blocking" && "text-tone-danger",
              tone === "warning" && "text-tone-warning",
              tone === "info" && "text-tone-info"
            )}
          />
          <span className="min-w-0">
            {wording
              ? wording(reason)
              : labels.reason(reason, { parameterName })}
            <Technical detail={reason.detail} />
          </span>
        </li>
      ))}
    </ul>
  )
}

/** The item as a whole cannot be installed: why, and that there is nothing
 *  to confirm. */
export function InstallBlocked({
  reasons,
  wording,
}: {
  reasons: readonly HarnessReason[]
  wording?: (reason: HarnessReason) => ReactNode
}) {
  const t = useTranslations("Harness.install.blocked")
  return (
    <div
      role="alert"
      className="min-w-0 space-y-2 rounded-lg border border-tone-danger/30 bg-tone-danger/5 px-3 py-2.5"
    >
      <p className="text-sm font-medium">{t("title")}</p>
      <InstallReasonList reasons={reasons} tone="blocking" wording={wording} />
      <p className="text-xs text-muted-foreground">{t("nothingToConfirm")}</p>
    </div>
  )
}

/** What the catalog's account of the version changed in, since the user
 *  was shown it. */
export function InstallChangeList({
  changes,
}: {
  changes: readonly HarnessReason[]
}) {
  const labels = useInstallLabels()
  return (
    <ul className="min-w-0 divide-y rounded-lg border text-xs">
      {changes.map((change, index) => (
        <li key={index} className="flex min-w-0 items-start gap-2 px-3 py-2">
          <TriangleAlert
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0 text-tone-warning"
          />
          <span className="min-w-0">{labels.change(change)}</span>
        </li>
      ))}
    </ul>
  )
}

/** "The author withdrew this version": to be ticked before it installs. */
export function YankedConfirm({
  id,
  checked,
  disabled,
  onChange,
}: {
  id: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  const t = useTranslations("Harness.install.yanked")
  return (
    <div className="min-w-0 space-y-2 rounded-lg border border-tone-warning/30 bg-tone-warning/10 px-3 py-2.5 text-xs">
      <p className="text-sm font-medium">{t("title")}</p>
      <p className="text-muted-foreground">{t("body")}</p>
      <div className="flex min-w-0 items-start gap-2.5">
        <Checkbox
          id={id}
          checked={checked}
          disabled={disabled}
          onCheckedChange={(next) => onChange(next === true)}
          className="mt-0.5 bg-background max-md:size-5"
        />
        <label htmlFor={id} className="min-w-0 cursor-pointer font-medium">
          {t("accept")}
        </label>
      </div>
    </div>
  )
}

/**
 * A request that was turned down before it got anywhere: the catalog
 * switched off or out of reach, an older Codeg. An older Codeg is worded for
 * the host — which Codeg needs updating is the whole message.
 */
export function InstallFailureNotice({
  failure,
  children,
}: {
  failure: HarnessFailure
  children?: ReactNode
}) {
  const t = useTranslations("Harness.install.notices")
  const host = useHarnessHost()
  const message = useHarnessFailureMessage()
  const text =
    failure.kind === "unsupported"
      ? t(
          host.kind === "remote"
            ? "unsupportedRemote"
            : host.kind === "web"
              ? "unsupportedWeb"
              : "unsupported"
        )
      : message(failure)
  return (
    <div role="alert" className="min-w-0 space-y-2">
      <Headline tone="warning">
        {text}
        {failure.kind === "unknown" && <Technical detail={failure.detail} />}
        {failure.kind === "recordUnreadable" && (
          <Technical detail={failure.detail} />
        )}
      </Headline>
      {children}
    </div>
  )
}

/**
 * What the host's record of one part of what it installed from Harness — its
 * MCP servers, or its skills — came to when it could not be read: that part
 * is shown without Harness marks, and nothing is installed into it from
 * Harness until it can be read. The other part is unaffected.
 */
export function HarnessRecordProblem({
  part,
  problem,
  className,
}: {
  part: "mcp" | "skills"
  problem: HarnessReason
  className?: string
}) {
  const t = useTranslations("Harness.record")
  return (
    <div
      role="note"
      data-harness-record-problem={part}
      className={cn(
        "flex min-w-0 items-start gap-2 rounded-lg bg-tone-warning/10 px-3 py-2 text-xs",
        className
      )}
    >
      <TriangleAlert
        aria-hidden="true"
        className="mt-0.5 size-3.5 shrink-0 text-tone-warning"
      />
      <span className="min-w-0">
        {t(part)}
        <Technical detail={problem.detail} />
      </span>
    </div>
  )
}
