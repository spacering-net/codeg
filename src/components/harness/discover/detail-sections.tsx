"use client"

import {
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import {
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  type LucideIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useHarnessSlot } from "@/contexts/harness-view-context"
import {
  DISCOVER_DETAIL_EXPANDED,
  type DiscoverDetailPart,
  type Loadable,
} from "@/lib/harness/discover-state"
import {
  formatBytes,
  formatDate,
  githubTreeUrl,
  itemTitle,
  knownRisk,
  oneOf,
  shortUrl,
  showsRuntime,
} from "@/lib/harness/display"
import {
  HARNESS_PERMISSION_KEYS,
  type HarnessFinding,
  type HarnessItemDetail,
  type HarnessVersionSummary,
} from "@/lib/harness/types"
import { cn } from "@/lib/utils"
import { MachineText } from "../machine-text"
import { DiscoverMark, RiskMark } from "./discover-card"
import { DiscoverFailure } from "./discover-failure"
import { HarnessLink } from "./harness-link"
import { ReadmeContent } from "./readme-content"
import { useDiscoverLabels } from "./use-discover-labels"

/**
 * The parts an item's detail is put together from. Each kind's body
 * (`detail-kinds.tsx`) picks the ones that mean something for it; they share
 * nothing but the item.
 *
 * Every string that reaches the page from here is either one of the app's own
 * messages or the catalog's text shown as text. The catalog's vocabulary —
 * the reasons an item is only listed, the names of the checks — is looked up
 * in the messages only for the values this build knows; anything newer is
 * shown as the catalog spells it.
 */

/** The reasons an item is listed but not browsed, as the catalog codes them. */
const LISTED_REASONS = [
  "no_repository",
  "no_description",
  "remote_not_public",
  "package_unverifiable",
  "package_missing",
  "package_unverified",
  "nothing_to_install",
  "deprecated",
  "duplicate",
  "bulk_publisher",
  "secrets",
  "format",
  "prompt_partial",
  "prompt_short",
  "needs_plugin",
] as const

/** The checks a finding can come from, besides a named rule. */
const FINDING_CHECKS = [
  "executable_binary",
  "encrypted_archive",
  "nested_archive",
  "document_container",
  "padding",
  "blank_lines",
  "long_line",
  "hidden_characters",
  "encoded_blob",
  "long_html_comment",
  "skips_confirmation",
  "auto_approves",
  "runs_hooks",
  "launches_mcp",
] as const

const ITEM_SOURCES = ["registry", "github", "upload", "form"] as const
const PACKAGE_CHECKS = ["ok", "missing", "unchecked", "pending"] as const
const MODEL_REVIEWS = ["off", "pending", "done"] as const

/** How many rows of a long list are shown before "Show all". */
const FILES_SHOWN = 60
const VERSIONS_SHOWN = 8

/** How much of a long description is shown before "Show all", in rem — and
 *  how much longer than that it has to be for folding it to be worth a
 *  button. */
const README_FOLD_REM = 26
const README_FOLD_SLACK_REM = 6

/** A section's title. Set apart from the headings a description brings with
 *  it, which are the author's and can say anything. */
const SECTION_TITLE_CLASS = "text-[0.9375rem] font-semibold text-foreground"

/**
 * Whether one of the open item's long parts is shown in full, and the way to
 * change that. Held in a slot (see `DISCOVER_DETAIL_EXPANDED`), so it is
 * still so after a trip to a conversation.
 */
export function useExpanded(
  part: DiscoverDetailPart
): [boolean, (expanded: boolean) => void] {
  const [expanded, setExpanded] = useHarnessSlot(DISCOVER_DETAIL_EXPANDED)
  const set = useCallback(
    (next: boolean) =>
      setExpanded((prev) => {
        if (prev.includes(part) === next) return prev
        return next ? [...prev, part] : prev.filter((entry) => entry !== part)
      }),
    [part, setExpanded]
  )
  return [expanded.includes(part), set]
}

/** Machine text — an address, a path, a package, a version. Always
 *  left-to-right, isolated from the sentence it sits in, and broken between
 *  its parts when it does not fit (see `MachineText`). */
export function Code({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <code
      dir="ltr"
      className={cn(
        "rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]",
        className
      )}
    >
      <MachineText>{children}</MachineText>
    </code>
  )
}

interface DetailSectionProps {
  title: string
  /** A count or a total, at the end of the title's line. */
  aside?: ReactNode
  children: ReactNode
  className?: string
}

export function DetailSection({
  title,
  aside,
  children,
  className,
}: DetailSectionProps) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className={cn("min-w-0", className)}>
      <div className="flex min-w-0 items-baseline justify-between gap-3 pb-3">
        <h3 id={headingId} className={SECTION_TITLE_CLASS}>
          {title}
        </h3>
        {aside && (
          <span className="shrink-0 text-xs text-muted-foreground">
            {aside}
          </span>
        )}
      </div>
      {children}
    </section>
  )
}

export function LinesSkeleton({ lines }: { lines: number }) {
  return (
    <div aria-hidden="true" className="space-y-2">
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton
          key={index}
          className={cn("h-3.5", index % 3 === 2 ? "w-2/3" : "w-full")}
        />
      ))}
    </div>
  )
}

// ─── Listed only ──────────────────────────────────────────────────────

/** Why an item can be opened but not browsed. Shown for every "listed" item:
 *  it got here by a link or by its exact name, and should say what the
 *  catalog holds against it before anything else does. */
export function ListedNotice({ item }: { item: HarnessItemDetail }) {
  const t = useTranslations("Harness.discover.detail")
  if (item.status !== "listed") return null
  return (
    <div className="rounded-lg border border-tone-warning/30 bg-tone-warning/10 px-3 py-2.5 text-xs">
      <p className="font-medium text-foreground">{t("listed")}</p>
      <p className="mt-1 text-muted-foreground">{t("listedNote")}</p>
      {item.listedReasons.length > 0 && (
        <ul className="mt-1.5 list-disc space-y-0.5 ps-5 text-foreground">
          {item.listedReasons.map((reason, index) => {
            const known = oneOf(LISTED_REASONS, reason)
            return (
              <li key={index}>
                {known ? t(`listedReasons.${known}`) : <Code>{reason}</Code>}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

// ─── Description ──────────────────────────────────────────────────────

interface DescriptionSectionProps {
  item: HarnessItemDetail
  readme: Loadable<string>
  onRetry: () => void
  /** The section's title, where the kind has its own word for what its
   *  description is — an assistant's instructions. */
  title?: string
  /** Openings that only repeat the page's heading, besides the item's title
   *  and name (see `readmeNodes`). Keep it the same array between renders. */
  omitHeading?: readonly string[]
  /** How much is shown before "Show all", in rem. */
  foldRem?: number
}

export function DescriptionSection({
  item,
  readme,
  onRetry,
  title: sectionTitle,
  omitHeading: alsoOmit,
  foldRem = README_FOLD_REM,
}: DescriptionSectionProps) {
  const t = useTranslations("Harness.discover.detail")
  const { lang } = useDiscoverLabels()
  const sourceTree = githubTreeUrl(item.install.source)
  const title = itemTitle(item, lang)
  const omitHeading = useMemo(
    () => [title, item.name, ...(alsoOmit ?? [])],
    [title, item.name, alsoOmit]
  )

  let content: ReactNode
  if (item.readme === null) {
    // No copy is kept here. Where the files themselves are read from GitHub,
    // that is where the description is; otherwise there simply is none, and
    // the section is not shown.
    if (!sourceTree) return null
    content = (
      <p className="text-sm text-muted-foreground">
        {t("readmeElsewhere")}{" "}
        <HarnessLink href={sourceTree}>{t("openSource")}</HarnessLink>
      </p>
    )
  } else if (readme.phase === "error" && readme.error) {
    content = (
      <DiscoverFailure
        variant="inline"
        failure={readme.error}
        onRetry={onRetry}
      />
    )
  } else if (readme.phase !== "ready") {
    content = <LinesSkeleton lines={6} />
  } else if (!readme.value) {
    return null
  } else {
    content = (
      <FoldedBox
        part="readme"
        foldRem={foldRem}
        className=""
        contentClassName=""
        bare
      >
        <ReadmeContent
          fragment={readme.value}
          // The page's heading already says what the item is called.
          omitHeading={omitHeading}
        />
      </FoldedBox>
    )
  }
  return (
    <DetailSection title={sectionTitle ?? t("description")}>
      {content}
    </DetailSection>
  )
}

interface FoldedBoxProps {
  /** Which of the open item's parts this is, for whether it is unfolded. */
  part: DiscoverDetailPart
  /** How much is shown while folded, in rem. */
  foldRem: number
  /** The box: its border, its background. */
  className?: string
  /** Around the content: its padding. */
  contentClassName?: string
  /** No box at all: the part runs on in the page, and "Show all" follows
   *  it without a rule above. */
  bare?: boolean
  children: ReactNode
}

/**
 * A long part — a description, a prompt's text — cut off after a screenful
 * when it is much longer than that.
 *
 * Descriptions run from two lines to thousands, and what comes after one —
 * what the item needs, what the checks found — should not be a long scroll
 * away. Whether there is anything to fold is measured, not guessed from the
 * text's length: a table or a block of code is tall in few characters, and a
 * line of prose is two lines on a phone.
 */
export function FoldedBox({
  part,
  foldRem,
  className = "rounded-lg border",
  contentClassName = "px-3 py-3",
  bare = false,
  children,
}: FoldedBoxProps) {
  const t = useTranslations("Harness.discover.detail")
  const [expanded, setExpanded] = useExpanded(part)
  const [long, setLong] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const contentId = useId()

  // Before paint, so a long part is never shown whole and then cut.
  useLayoutEffect(() => {
    const content = contentRef.current
    if (!content) return
    const measure = () => {
      const rem =
        Number.parseFloat(
          getComputedStyle(document.documentElement).fontSize
        ) || 16
      setLong(content.scrollHeight > (foldRem + README_FOLD_SLACK_REM) * rem)
    }
    measure()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(content)
    return () => observer.disconnect()
  }, [foldRem])

  const folded = long && !expanded
  return (
    <div className={className}>
      <div
        id={contentId}
        // What is cut off cannot be seen, but a link in it can still be
        // tabbed to: the fold opens rather than let the focus go where the
        // eye cannot follow.
        onFocusCapture={() => {
          if (folded) setExpanded(true)
        }}
        style={folded ? { maxHeight: `${foldRem}rem` } : undefined}
        className={cn(
          contentClassName,
          // The last lines fade out, which is what says there is more.
          folded &&
            "overflow-hidden [mask-image:linear-gradient(to_bottom,black_calc(100%-3rem),transparent)]"
        )}
      >
        <div ref={contentRef}>{children}</div>
      </div>
      {long && (
        <div className={bare ? "-ms-3 pt-1" : "border-t px-1.5 py-1"}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={expanded}
            aria-controls={contentId}
            className="max-md:h-10"
            onClick={() => setExpanded(!expanded)}
          >
            {t(expanded ? "collapse" : "expand")}
          </Button>
        </div>
      )}
    </div>
  )
}

// ─── Permissions ──────────────────────────────────────────────────────

function PermissionValues({
  values,
  undeclared,
}: {
  /** `undefined`: the publisher said nothing about this row. */
  values: string[] | undefined
  /** Detected values the publisher's declaration does not cover. */
  undeclared?: readonly string[]
}) {
  const t = useTranslations("Harness.discover.detail")
  if (values === undefined) {
    return (
      <span className="text-muted-foreground">
        <span aria-hidden="true">—</span>
        <span className="sr-only">{t("notStated")}</span>
      </span>
    )
  }
  if (values.length === 0) {
    return <span className="text-muted-foreground">{t("none")}</span>
  }
  return (
    <span className="flex min-w-0 flex-wrap gap-1">
      {values.map((value, index) => {
        const differs = undeclared?.includes(value) === true
        return (
          <span key={index} className="inline-flex min-w-0 items-center">
            <Code
              className={cn(differs && "bg-tone-warning/10 text-tone-warning")}
            >
              {value === "*" ? t("allTools") : value}
            </Code>
            {differs && <span className="sr-only"> ({t("undeclared")})</span>}
          </span>
        )
      })}
    </span>
  )
}

/**
 * What the item needs, as its publisher states it and as the catalog's own
 * scan found it — side by side, because the difference is the point. A
 * detected value its publisher did not declare is marked.
 */
export function PermissionsSection({ item }: { item: HarnessItemDetail }) {
  const t = useTranslations("Harness.discover.detail")
  const { declared, detected } = item.permissions
  const columns =
    "grid grid-cols-2 gap-x-3 gap-y-1 px-3 @xl/discover:grid-cols-[10rem_minmax(0,1fr)_minmax(0,1fr)]"
  return (
    <DetailSection title={t("permissions")}>
      <div
        role="table"
        aria-label={t("permissions")}
        className="rounded-lg border text-xs"
      >
        <div
          role="row"
          className={cn(
            columns,
            "border-b bg-muted/30 py-1.5 text-2xs font-semibold tracking-wide text-muted-foreground uppercase"
          )}
        >
          {/* The corner cell: the section's title already says what the
              rows are, so this is a name for a screen reader only. It still
              has to be a cell where the table has three columns, and must
              not be one where it has two. */}
          <span
            role="columnheader"
            className="sr-only @xl/discover:not-sr-only"
          >
            <span className="sr-only">{t("permissions")}</span>
          </span>
          <span role="columnheader">{t("declared")}</span>
          <span role="columnheader">{t("detected")}</span>
        </div>
        {HARNESS_PERMISSION_KEYS.map((key) => {
          const stated = declared[key]
          const found = detected[key]
          const undeclared = stated
            ? found.filter((value) => !stated.includes(value))
            : []
          return (
            <div
              key={key}
              role="row"
              className={cn(columns, "border-b py-2 last:border-b-0")}
            >
              <span
                role="rowheader"
                className="col-span-2 font-medium @xl/discover:col-span-1"
              >
                {t(`perms.${key}`)}
              </span>
              <span role="cell" className="min-w-0">
                <PermissionValues values={stated} />
              </span>
              <span role="cell" className="min-w-0">
                <PermissionValues values={found} undeclared={undeclared} />
              </span>
            </div>
          )
        })}
      </div>
    </DetailSection>
  )
}

// ─── Checks ───────────────────────────────────────────────────────────

const RISK_ICONS: Record<"low" | "medium" | "high" | "unknown", LucideIcon> = {
  low: ShieldCheck,
  medium: ShieldAlert,
  high: ShieldAlert,
  unknown: ShieldQuestion,
}

const RISK_BANNER_TONES: Record<
  "low" | "medium" | "high" | "unknown",
  { band: string; text: string }
> = {
  low: { band: "bg-tone-success/10", text: "text-tone-success" },
  medium: { band: "bg-tone-warning/10", text: "text-tone-warning" },
  high: { band: "bg-tone-danger/10", text: "text-tone-danger" },
  unknown: { band: "bg-muted/60", text: "text-muted-foreground" },
}

/** What the checks made of the item, in a line: the band at the head of the
 *  detail's side card. The whole story is in the Checks section. */
export function RiskBanner({ risk }: { risk: string }) {
  const t = useTranslations("Harness.discover.detail")
  const labels = useDiscoverLabels()
  const known = knownRisk(risk) ?? "unknown"
  const Icon = RISK_ICONS[known]
  const tone = RISK_BANNER_TONES[known]
  return (
    <div
      className={cn(
        "flex min-w-0 items-start gap-2 border-b px-4 py-3 text-[0.8125rem]",
        tone.band
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn("mt-0.5 size-4 shrink-0", tone.text)}
      />
      <p className="min-w-0">
        <span className={cn("font-semibold", tone.text)}>
          {labels.risk(risk)}
        </span>{" "}
        <span className="text-muted-foreground">{t(`riskNote.${known}`)}</span>
      </p>
    </div>
  )
}

/** High before medium before anything else a newer catalog might send. */
const severityRank = (severity: string) =>
  severity === "high" ? 0 : severity === "medium" ? 1 : 2

function FindingRow({ finding }: { finding: HarnessFinding }) {
  const t = useTranslations("Harness.discover.detail")
  const check = oneOf(FINDING_CHECKS, finding.check)
  const place = finding.path
    ? `${finding.path}${finding.line ? `:${finding.line}` : ""}`
    : ""
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2">
      <RiskMark risk={finding.severity} />
      <span className="min-w-0">
        {finding.check === "rule" ? (
          t("findingRule", { name: finding.category ?? finding.rule ?? "" })
        ) : check ? (
          t(`findings.${check}`)
        ) : (
          <Code>{finding.check}</Code>
        )}
      </span>
      {place && <Code className="text-muted-foreground">{place}</Code>}
    </li>
  )
}

/**
 * What the catalog's checks made of the item, in short: the risk they put it
 * at, whether a person has looked at it, the findings that deserve a look
 * and how many do not. The full report is on the website.
 */
export function ChecksSection({ item }: { item: HarnessItemDetail }) {
  const t = useTranslations("Harness.discover.detail")
  const labels = useDiscoverLabels()
  const risk = knownRisk(item.risk) ?? "unknown"
  const Icon = RISK_ICONS[risk]
  const review = oneOf(MODEL_REVIEWS, item.checks.review)
  const { findings, secrets, dropped } = item.checks
  const notable = findings
    .filter((finding) => finding.severity !== "low")
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
  const minor = findings.length - notable.length

  return (
    <DetailSection title={t("checks")}>
      <div className="rounded-lg border text-xs">
        <div className="flex min-w-0 items-start gap-2.5 px-3 py-2.5">
          <Icon
            aria-hidden="true"
            className={cn(
              "mt-0.5 size-4 shrink-0",
              risk === "low" && "text-tone-success",
              risk === "medium" && "text-tone-warning",
              risk === "high" && "text-tone-danger",
              risk === "unknown" && "text-muted-foreground"
            )}
          />
          <div className="min-w-0 space-y-0.5">
            <p className="text-sm font-medium">{labels.risk(item.risk)}</p>
            <p className="text-muted-foreground">{t(`riskNote.${risk}`)}</p>
            <p className="text-muted-foreground">
              {t(item.reviewed ? "reviewed" : "notReviewed")}
              {review && ` · ${t(`modelReview.${review}`)}`}
            </p>
          </div>
        </div>
        {notable.length > 0 && (
          <ul className="divide-y border-t">
            {notable.map((finding, index) => (
              <FindingRow key={index} finding={finding} />
            ))}
          </ul>
        )}
        {(minor > 0 || secrets > 0 || dropped.length > 0) && (
          <div className="space-y-1 border-t px-3 py-2 text-muted-foreground">
            {minor > 0 && <p>{t("minorFindings", { count: minor })}</p>}
            {secrets > 0 && <p>{t("secretsFound", { count: secrets })}</p>}
            {dropped.length > 0 && (
              <p>
                {t("dropped", { count: dropped.length })}{" "}
                {dropped.slice(0, 12).map((entry, index) => (
                  <span key={index}>
                    {index > 0 && " "}
                    <Code>{entry.path}</Code>
                  </span>
                ))}
              </p>
            )}
          </div>
        )}
      </div>
    </DetailSection>
  )
}

// ─── MCP server ───────────────────────────────────────────────────────

interface Remote {
  type: string
  url: string
}

/** The remote endpoints a `server.json` names. Read defensively: the file is
 *  the registry's, passed through as published. */
function remotesOf(server: unknown): Remote[] {
  if (server === null || typeof server !== "object") return []
  const { remotes } = server as { remotes?: unknown }
  if (!Array.isArray(remotes)) return []
  return remotes.flatMap((remote): Remote[] => {
    if (remote === null || typeof remote !== "object") return []
    const { type, url } = remote as { type?: unknown; url?: unknown }
    if (typeof url !== "string" || !url) return []
    return [{ type: typeof type === "string" ? type : "", url }]
  })
}

/**
 * What an MCP server is made of: the packages it runs, pinned to the version
 * the catalog checked, and the remote endpoints it can be reached at. The
 * endpoints are shown as text — they are not pages to open.
 */
export function ServerSection({ item }: { item: HarnessItemDetail }) {
  const t = useTranslations("Harness.discover.detail")
  const packages = item.install.packages ?? []
  const remotes = remotesOf(item.install.server)
  if (packages.length === 0 && remotes.length === 0) return null

  return (
    <DetailSection title={t("server")}>
      <div className="divide-y rounded-lg border text-xs">
        {packages.map((pinned, index) => {
          const check = oneOf(PACKAGE_CHECKS, pinned.verified)
          return (
            <div
              key={`package-${index}`}
              className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2"
            >
              <span className="shrink-0 text-muted-foreground">
                <bdi>{pinned.registryType || t("packages")}</bdi>
              </span>
              <Code>
                {pinned.version
                  ? `${pinned.identifier}@${pinned.version}`
                  : pinned.identifier}
              </Code>
              <DiscoverMark
                tone={
                  check === "ok"
                    ? "success"
                    : check === "missing"
                      ? "danger"
                      : check === null
                        ? "neutral"
                        : "warning"
                }
              >
                {t(`verified.${check ?? "unknown"}`)}
              </DiscoverMark>
              {pinned.hasInstallScript === true && (
                <DiscoverMark tone="warning">{t("installScript")}</DiscoverMark>
              )}
            </div>
          )
        })}
        {remotes.map((remote, index) => (
          <div
            key={`remote-${index}`}
            className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2"
          >
            <span className="shrink-0 text-muted-foreground">
              {t("remotes")}
              {remote.type && (
                <>
                  {" · "}
                  <bdi>{remote.type}</bdi>
                </>
              )}
            </span>
            <Code>{remote.url}</Code>
          </div>
        ))}
      </div>
    </DetailSection>
  )
}

// ─── Files ────────────────────────────────────────────────────────────

/** The package's file list, as the catalog recorded it for this version. */
export function FilesSection({ item }: { item: HarnessItemDetail }) {
  const t = useTranslations("Harness.discover.detail")
  const { locale } = useDiscoverLabels()
  const [showAll, setShowAll] = useExpanded("files")
  const { files } = item.install
  if (files.length === 0) return null
  const total = files.reduce((sum, file) => sum + file.size, 0)
  const visible = showAll ? files : files.slice(0, FILES_SHOWN)

  return (
    <DetailSection
      title={t("files")}
      aside={t("filesTotal", {
        count: files.length,
        size: formatBytes(total, locale),
      })}
    >
      <ul className="divide-y rounded-lg border text-xs">
        {visible.map((file, index) => (
          <li
            key={index}
            className="flex min-w-0 items-baseline justify-between gap-3 px-3 py-1.5"
          >
            <span className="min-w-0">
              <bdi dir="ltr" className="font-mono">
                <MachineText>{file.path}</MachineText>
              </bdi>
              {file.executable && (
                <span className="ms-2 text-2xs text-muted-foreground">
                  {t("executable")}
                </span>
              )}
            </span>
            {/* "11.1 KB" is a number and a Latin unit: left to itself in a
                right-to-left line, the two swap places. */}
            <bdi
              dir="ltr"
              className="shrink-0 text-muted-foreground tabular-nums"
            >
              {formatBytes(file.size, locale)}
            </bdi>
          </li>
        ))}
      </ul>
      {files.length > FILES_SHOWN && !showAll && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-1.5 max-md:h-10"
          onClick={() => setShowAll(true)}
        >
          {t("showAll", { count: files.length })}
        </Button>
      )}
    </DetailSection>
  )
}

// ─── Versions ─────────────────────────────────────────────────────────

interface VersionsSectionProps {
  item: HarnessItemDetail
  versions: Loadable<HarnessVersionSummary[]>
  onRetry: () => void
}

export function VersionsSection({
  item,
  versions,
  onRetry,
}: VersionsSectionProps) {
  const t = useTranslations("Harness.discover.detail")
  const { locale } = useDiscoverLabels()
  const [showAll, setShowAll] = useExpanded("versions")

  let content: ReactNode
  if (versions.phase === "error" && versions.error) {
    content = (
      <DiscoverFailure
        variant="inline"
        failure={versions.error}
        onRetry={onRetry}
      />
    )
  } else if (versions.phase !== "ready" || versions.value === null) {
    content = <LinesSkeleton lines={3} />
  } else if (versions.value.length === 0) {
    return null
  } else {
    const all = versions.value
    const visible = showAll ? all : all.slice(0, VERSIONS_SHOWN)
    content = (
      <>
        <ol className="divide-y rounded-lg border text-xs">
          {visible.map((version, index) => (
            <li
              key={index}
              className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2"
            >
              <bdi
                dir="ltr"
                className="shrink-0 font-mono text-muted-foreground tabular-nums"
              >
                #{version.revision}
              </bdi>
              {version.version && (
                <bdi dir="ltr" className="min-w-0 font-mono">
                  <MachineText>{version.version}</MachineText>
                </bdi>
              )}
              {version.revision === item.latest.revision && (
                <DiscoverMark>{t("latest")}</DiscoverMark>
              )}
              {version.status === "yanked" ? (
                <DiscoverMark tone="warning">
                  {t("versionStatus.yanked")}
                </DiscoverMark>
              ) : version.status === "blocked" ? (
                <DiscoverMark tone="danger">
                  {t("versionStatus.blocked")}
                </DiscoverMark>
              ) : version.status !== "ok" ? (
                <DiscoverMark>{t("statusUnknown")}</DiscoverMark>
              ) : null}
              <RiskMark risk={version.risk} />
              <span className="ms-auto shrink-0 text-muted-foreground">
                {formatDate(version.publishedAt, locale)}
              </span>
            </li>
          ))}
        </ol>
        {all.length > VERSIONS_SHOWN && !showAll && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-1.5 max-md:h-10"
            onClick={() => setShowAll(true)}
          >
            {t("showAll", { count: all.length })}
          </Button>
        )}
      </>
    )
  }
  return <DetailSection title={t("versions")}>{content}</DetailSection>
}

// ─── Details ──────────────────────────────────────────────────────────

/** A link in the particulars: the text is one short line, so its hit area is
 *  padded out to the height of its row. */
export const FACT_LINK_CLASS = "-my-2 inline-block py-2"

/**
 * An address in the particulars — the repository, the website. Too long for
 * its row, it breaks after a `/` only (`github.com/browser-use/` /
 * `browser-use`), never inside a name at one of its hyphens, and a name
 * longer than the whole row breaks wherever it has to rather than run out of
 * the panel. The full address is the link's tooltip.
 */
function FactAddress({ href }: { href: string }) {
  return (
    <HarnessLink href={href} className={cn(FACT_LINK_CLASS, "max-w-full")}>
      <bdi dir="ltr">
        <MachineText breaks="path">{shortUrl(href)}</MachineText>
      </bdi>
    </HarnessLink>
  )
}

/** One row of the particulars. A kind's own rows (`FactsPanel`'s `head`)
 *  are made of these too. */
export function Fact({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-4 py-2">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-end font-medium break-words">{children}</dd>
    </div>
  )
}

/** The item's license, or that it states none. */
export function LicenseFact({ item }: { item: HarnessItemDetail }) {
  const t = useTranslations("Harness.discover.detail")
  return (
    <Fact label={t("license")}>
      {item.license ? (
        <bdi dir="ltr">
          <MachineText>{item.license}</MachineText>
        </bdi>
      ) : (
        <span className="text-muted-foreground">{t("noLicense")}</span>
      )}
    </Fact>
  )
}

interface FactsPanelProps {
  item: HarnessItemDetail
  /** The kind's own rows, at the head of the panel: what a prompt was
   *  written for, how long it is. */
  head?: ReactNode
  /** The kind's rows say whose the item is (a prompt can belong to whoever
   *  shared it, not to a license), so the license row is left to them. */
  sayRights?: boolean
}

/** The item's particulars: its version, license, where it runs and where it
 *  comes from. The links here are the item's "source". */
export function FactsPanel({ item, head, sayRights = false }: FactsPanelProps) {
  const t = useTranslations("Harness.discover.detail")
  const labels = useDiscoverLabels()
  const headingId = useId()
  const source = oneOf(ITEM_SOURCES, item.source)
  const sourceLabel = t(`sources.${source ?? "unknown"}`)

  return (
    <section
      aria-labelledby={headingId}
      className="min-w-0 rounded-2xl border bg-card px-3.5 pt-2.5 pb-0.5 text-sm"
    >
      <div className="flex min-w-0 items-center justify-between gap-3 border-b pb-2.5">
        <h3 id={headingId} className="shrink-0 font-semibold">
          {t("facts")}
        </h3>
        <div className="flex min-w-0 flex-wrap justify-end gap-1.5">
          <span className="inline-flex h-6 items-center rounded-full bg-muted px-2.5 text-xs">
            {labels.kind(item.kind)}
          </span>
          {showsRuntime(item) && (
            <span className="inline-flex h-6 min-w-0 items-center rounded-full border px-2.5 text-xs">
              <bdi className="truncate">{labels.runtime(item.runtime)}</bdi>
            </span>
          )}
        </div>
      </div>
      <dl className="divide-y">
        {head}
        {item.latest.version && (
          <Fact label={t("version")}>
            <bdi dir="ltr">
              <MachineText>{item.latest.version}</MachineText>
            </bdi>
          </Fact>
        )}
        <Fact label={t("revision")}>
          <bdi dir="ltr">#{item.latest.revision}</bdi>
        </Fact>
        {!sayRights && <LicenseFact item={item} />}
        <Fact label={t("source")}>
          <HarnessLink href={item.sourceUrl} className={FACT_LINK_CLASS}>
            {sourceLabel}
          </HarnessLink>
        </Fact>
        {item.repositoryUrl && (
          <Fact label={t("repository")}>
            <FactAddress href={item.repositoryUrl} />
          </Fact>
        )}
        {item.websiteUrl && (
          <Fact label={t("website")}>
            <FactAddress href={item.websiteUrl} />
          </Fact>
        )}
      </dl>
    </section>
  )
}

const FACT_SKELETON_WIDTHS = ["w-10", "w-12", "w-16", "w-28", "w-14", "w-20"]

/** The facts card's place while the item is read: its heading and chips,
 *  then rows of a label and a value, as the card will have them — `rows` of
 *  them, and a second chip when the runtime will have one. */
export function FactsSkeleton({
  rows = 4,
  runtime = true,
}: {
  rows?: number
  runtime?: boolean
}) {
  return (
    <div
      aria-hidden="true"
      data-testid="discover-facts-loading"
      className="min-w-0 rounded-2xl border bg-card px-3.5 pt-2.5 pb-0.5"
    >
      <div className="flex items-center justify-between gap-3 border-b pb-2.5">
        <Skeleton className="h-4 w-12" />
        <div className="flex gap-1.5">
          <Skeleton className="h-6 w-12 rounded-full" />
          {runtime && <Skeleton className="h-6 w-14 rounded-full" />}
        </div>
      </div>
      <div className="divide-y">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="flex items-center justify-between py-2.5">
            <Skeleton className="h-3.5 w-12" />
            <Skeleton
              className={cn(
                "h-3.5",
                FACT_SKELETON_WIDTHS[index % FACT_SKELETON_WIDTHS.length]
              )}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
