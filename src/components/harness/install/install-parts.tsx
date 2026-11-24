"use client"

import { useState, type ReactNode } from "react"
import {
  ChevronRight,
  CircleAlert,
  FolderGit2,
  Info,
  PackageCheck,
  PackageX,
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
import type { HarnessSkillPackageFile } from "@/lib/harness/skill-install-types"
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
import { useSkillInstallLabels } from "./use-skill-install-labels"

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

type PermissionValueState = "both" | "undeclared" | "declaredOnly"

/** Values shown in a kind of access before the rest are folded away. */
const PERMISSION_VALUES_SHOWN = 12

/** The chip's look for each state — explained once, in the legend. */
const PERMISSION_CHIP_CLASS: Record<PermissionValueState, string> = {
  both: "border-border bg-muted/60 text-foreground",
  undeclared: "border-tone-warning/35 bg-tone-warning/10 text-tone-warning",
  declaredOnly: "border-dashed border-border text-muted-foreground",
}

function PermissionChip({
  state,
  children,
}: {
  state: PermissionValueState
  children: ReactNode
}) {
  const t = useTranslations("Harness.install.snapshot")
  const note = state === "both" ? null : t(state)
  return (
    <span
      title={note ?? undefined}
      className={cn(
        "inline-flex max-w-full min-w-0 items-center rounded-md border px-1.5 py-px font-mono text-2xs leading-4",
        PERMISSION_CHIP_CLASS[state]
      )}
    >
      <bdi dir="ltr" className="min-w-0">
        <MachineText>{children}</MachineText>
      </bdi>
      {note && <span className="sr-only"> ({note})</span>}
    </span>
  )
}

/** One kind of access: its values as chips, a long list folded after the
 *  first few — with how many more there are, and how many of those were
 *  found but not declared, so folding hides nothing that matters. */
function PermissionValues({
  values,
}: {
  values: readonly { value: string; state: PermissionValueState }[]
}) {
  const t = useTranslations("Harness.install.snapshot")
  const tDetail = useTranslations("Harness.discover.detail")
  const [expanded, setExpanded] = useState(false)
  const foldable = values.length > PERMISSION_VALUES_SHOWN + 2
  const shown =
    foldable && !expanded ? values.slice(0, PERMISSION_VALUES_SHOWN) : values
  const hidden = values.length - shown.length
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {shown.map(({ value, state }, index) => (
        <PermissionChip key={index} state={state}>
          {value === "*" ? tDetail("allTools") : value}
        </PermissionChip>
      ))}
      {foldable && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          className="inline-flex h-5 items-center rounded-md px-1.5 text-2xs text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {expanded ? t("fewerValues") : t("moreValues", { count: hidden })}
        </button>
      )}
    </div>
  )
}

/**
 * What the item asks for, as its publisher declared it and as the catalog's
 * checks found it — one row per kind of access, its values as chips. What
 * was found but not declared (or declared but not found) is told by the
 * chip's look, explained once in a legend, and counted beside the kind.
 * Only the kinds with something in them are listed.
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
    const values = [...new Set([...detected, ...declared])].map((value) => ({
      value,
      state: (!declared.includes(value)
        ? "undeclared"
        : !detected.includes(value)
          ? "declaredOnly"
          : "both") as PermissionValueState,
    }))
    return values.length > 0 ? [{ key, values }] : []
  })
  if (rows.length === 0) {
    return <p className="text-muted-foreground">{t("noPermissions")}</p>
  }
  const states = new Set(rows.flatMap((row) => row.values.map((v) => v.state)))
  // Nothing declared at all: every value is found-not-declared, said once
  // for the lot rather than counted on every row.
  const noneDeclared = states.size === 1 && states.has("undeclared")
  const legend = noneDeclared
    ? []
    : (["undeclared", "declaredOnly"] as const).filter((state) =>
        states.has(state)
      )
  return (
    <div className="min-w-0 space-y-2.5">
      {noneDeclared && (
        <p className="flex min-w-0 items-start gap-1.5 text-tone-warning">
          <TriangleAlert
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0"
          />
          <span className="min-w-0">{t("noneDeclared")}</span>
        </p>
      )}
      {legend.length > 0 && (
        <p className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground">
          {legend.map((state) => (
            <span key={state} className="inline-flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className={cn(
                  "inline-block size-2.5 rounded-sm border",
                  PERMISSION_CHIP_CLASS[state]
                )}
              />
              {t(state)}
            </span>
          ))}
        </p>
      )}
      <dl className="grid min-w-0 gap-x-4 gap-y-2.5 sm:grid-cols-[minmax(5.5rem,max-content)_minmax(0,1fr)]">
        {rows.map(({ key, values }) => {
          const undeclared = values.filter(
            (v) => v.state === "undeclared"
          ).length
          return (
            <div key={key} className="contents">
              <dt className="min-w-0 leading-5">
                <span className="font-medium">{tDetail(`perms.${key}`)}</span>
                <span className="ms-1.5 text-muted-foreground tabular-nums">
                  {values.length}
                </span>
                {undeclared > 0 && !noneDeclared && (
                  <span className="block text-2xs text-tone-warning">
                    {t("undeclaredCount", { count: undeclared })}
                  </span>
                )}
              </dt>
              <dd className="min-w-0 max-sm:-mt-1.5">
                <PermissionValues values={values} />
              </dd>
            </div>
          )
        })}
      </dl>
    </div>
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
          <p className="pb-2 text-muted-foreground">{t("permissions")}</p>
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
  part: "mcp" | "skills" | "plugins"
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

// ─── What a package installs ──────────────────────────────────────────

/** Where a package's files come from, and the files: the part of a skill's
 *  and a plugin's install confirmation that says what lands on disk. */
export interface InstallPackageContents {
  archive: { sha256: string } | null
  source: { repository: string; commit: string; path: string } | null
  files: readonly HarnessSkillPackageFile[]
  total_bytes: number
}

/** A machine name inside a sentence. */
const machineChunk = (chunks: ReactNode) => (
  <bdi dir="ltr" className="font-mono text-foreground">
    <MachineText>{chunks}</MachineText>
  </bdi>
)

/** A file's folder, dimmed, and its name — so a long list reads by name. */
function FilePath({ path }: { path: string }) {
  const cut = path.lastIndexOf("/") + 1
  return (
    <bdi dir="ltr" className="min-w-0 font-mono">
      {cut > 0 && (
        <span className="text-muted-foreground">
          <MachineText breaks="path">{path.slice(0, cut)}</MachineText>
        </span>
      )}
      <MachineText>{path.slice(cut)}</MachineText>
    </bdi>
  )
}

/** The files, behind a toggle: a scrolling list, each with its size in a
 *  column of its own and a mark on what may be run. */
function PackageFileList({
  files,
}: {
  files: readonly HarnessSkillPackageFile[]
}) {
  const t = useTranslations("Harness.skillInstall.package")
  const labels = useSkillInstallLabels()
  const [open, setOpen] = useState(false)
  const executable = files.filter((file) => file.executable).length
  return (
    <div className="min-w-0 border-t">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-start outline-none hover:bg-muted/40 focus-visible:bg-muted/40"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform rtl:-scale-x-100",
            open && "rotate-90 rtl:scale-x-100"
          )}
        />
        <span className="min-w-0 font-medium">{t("fileList")}</span>
        {executable > 0 && (
          <DiscoverMark size="sm" tone="warning">
            {t("executableCount", { count: executable })}
          </DiscoverMark>
        )}
      </button>
      {open && (
        <ul className="max-h-72 min-w-0 overflow-y-auto overscroll-contain border-t py-1">
          {files.map((file) => (
            <li
              key={file.path}
              className="flex min-w-0 items-baseline gap-3 px-3 py-0.5 hover:bg-muted/40"
            >
              <span className="min-w-0 flex-1">
                <FilePath path={file.path} />
              </span>
              {file.executable && (
                <DiscoverMark size="sm" tone="warning" className="self-center">
                  {t("executable")}
                </DiscoverMark>
              )}
              <span className="w-16 shrink-0 text-end text-muted-foreground tabular-nums">
                {labels.bytes(file.size)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * What will be put in Codeg's store: what it is (`children` — a skill's name
 * and description, where there is one), where the files come from and how
 * they are checked, and the files themselves.
 */
export function InstallPackagePart({
  pkg,
  children,
}: {
  pkg: InstallPackageContents
  children?: ReactNode
}) {
  const t = useTranslations("Harness.skillInstall.package")
  const labels = useSkillInstallLabels()
  const SourceIcon = pkg.archive
    ? PackageCheck
    : pkg.source
      ? FolderGit2
      : PackageX
  return (
    <InstallPart
      title={t("title")}
      aside={t("size", {
        count: pkg.files.length,
        size: labels.bytes(pkg.total_bytes),
      })}
    >
      <div className="min-w-0 overflow-hidden rounded-lg border text-xs">
        {children && (
          <div className="min-w-0 space-y-1 border-b px-3 py-2.5">
            {children}
          </div>
        )}
        <div className="flex min-w-0 items-start gap-2.5 px-3 py-2.5">
          <SourceIcon
            aria-hidden="true"
            className={cn(
              "mt-px size-4 shrink-0",
              pkg.archive || pkg.source
                ? "text-tone-success"
                : "text-tone-warning"
            )}
          />
          <p className="min-w-0 leading-relaxed text-muted-foreground">
            {pkg.archive
              ? t.rich("archive", {
                  hash: pkg.archive.sha256.slice(0, 16),
                  code: machineChunk,
                })
              : pkg.source
                ? t.rich("source", {
                    repository: pkg.source.repository,
                    commit: pkg.source.commit.slice(0, 12),
                    path: pkg.source.path || "/",
                    code: machineChunk,
                  })
                : t("noSource")}
          </p>
        </div>
        {pkg.files.length > 0 && <PackageFileList files={pkg.files} />}
      </div>
    </InstallPart>
  )
}
