"use client"

import { useId, useState } from "react"
import {
  Activity,
  Braces,
  ChevronDown,
  CircleHelp,
  FileCode2,
  FileText,
  Loader2,
  Plug,
  SquareTerminal,
  Webhook,
  type LucideIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"

import { Checkbox } from "@/components/ui/checkbox"
import { harnessBlob } from "@/lib/harness/api"
import { harnessFailureOf, type HarnessFailure } from "@/lib/harness/errors"
import { oneOf } from "@/lib/harness/display"
import {
  autorunFileOf,
  pluginVersionsOf,
  type PluginVersions,
} from "@/lib/harness/plugin-install"
import type {
  HarnessAutorunPart,
  HarnessPluginHostInfo,
  HarnessPluginMember,
} from "@/lib/harness/plugin-install-types"
import { cn } from "@/lib/utils"
import { Code } from "../discover/detail-sections"
import { DiscoverMark } from "../discover/discover-card"
import { useHarnessFailureMessage } from "../discover/discover-failure"
import { MachineText } from "../machine-text"
import {
  AUTORUN_TYPES,
  usePluginInstallLabels,
} from "./use-plugin-install-labels"

/**
 * The parts of a plugin that the install dialog, its detail in Discover and
 * (later) the installed list all show: the two versions when they are not
 * one, the members, what runs on its own, and what each host gets. Text the
 * catalog wrote — a name, a summary, a command — is text, shown as text.
 */

/** "完整安装：7.0.1（7.0.2 待审核）" or "完整安装待审核" — nothing when the
 *  latest may be installed whole. */
export function PluginVersionsLine({
  full,
  latest,
  notFull,
  className,
}: {
  full: { revision: number; version: string | null } | null
  latest: { revision: number; version: string | null }
  notFull: string | null
  className?: string
}) {
  const versions = pluginVersionsOf(full, latest, notFull)
  if (versions.kind === "same") return null
  return (
    <p className={cn("text-xs text-tone-warning", className)}>
      <PluginVersionsText versions={versions} />
    </p>
  )
}

function PluginVersionsText({
  versions,
}: {
  versions: Exclude<PluginVersions, { kind: "same" }>
}) {
  const t = useTranslations("Harness.pluginInstall.versions")
  const code = (chunks: React.ReactNode) => <Code>{chunks}</Code>
  if (versions.kind === "none") {
    return <>{t(versions.reason === "unpinned" ? "unpinned" : "pending")}</>
  }
  return (
    <>
      {t.rich(
        versions.reason === "unpinned" ? "behindUnpinned" : "behindPending",
        { full: versions.full, latest: versions.latest, code }
      )}
    </>
  )
}

/** The members, read-only: installed with the plugin, never one by one. */
export function PluginMemberList({
  members,
}: {
  members: readonly HarnessPluginMember[]
}) {
  const t = useTranslations("Harness.pluginInstall.members")
  if (members.length === 0) {
    return <p className="text-xs text-muted-foreground">{t("none")}</p>
  }
  const sorted = [...members].sort((a, b) =>
    a.kind === b.kind
      ? a.name.localeCompare(b.name)
      : a.kind === "skill"
        ? -1
        : 1
  )
  return (
    <ul className="min-w-0 divide-y rounded-lg border text-xs">
      {sorted.map((member) => (
        <li
          key={`${member.kind}:${member.name}`}
          className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-1.5"
        >
          <bdi dir="ltr" className="min-w-0 font-mono font-medium">
            <MachineText>{member.name}</MachineText>
          </bdi>
          {member.kind !== "skill" && (
            <DiscoverMark size="sm">
              {t(
                `kinds.${oneOf(["assistant"] as const, member.kind) ?? "unknown"}`
              )}
            </DiscoverMark>
          )}
          {member.summary && (
            <span
              dir="auto"
              className="min-w-0 basis-full break-words text-muted-foreground"
            >
              {member.summary}
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}

/** What each host the plugin has a manifest for gets: skills 15 · hooks 1… */
export function PluginHostList({
  hosts,
}: {
  hosts: readonly HarnessPluginHostInfo[]
}) {
  const t = useTranslations("Harness.pluginInstall.hostParts")
  const labels = usePluginInstallLabels()
  if (hosts.length === 0) return null
  const parts = [
    "skills",
    "agents",
    "commands",
    "hooks",
    "mcp",
    "code",
  ] as const
  return (
    <ul className="min-w-0 divide-y rounded-lg border text-xs">
      {hosts.map((host) => {
        const has = parts.filter((part) => host[part] > 0)
        return (
          <li
            key={host.host}
            className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-3 py-1.5"
          >
            <span className="font-medium">{labels.host(host.host)}</span>
            <span className="text-muted-foreground">
              {has.length > 0
                ? has.map((part) => t(part, { count: host[part] })).join(" · ")
                : t("nothing")}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

type FileState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "ready"; text: string }
  | { phase: "error"; failure: HarnessFailure }

/** Each kind of part that runs on its own, by an icon of the same width —
 *  so the rows line up whatever the kind's name. */
const AUTORUN_ICONS: Record<(typeof AUTORUN_TYPES)[number], LucideIcon> = {
  hook: Webhook,
  code: FileCode2,
  mcp: Plug,
  lsp: Braces,
  monitor: Activity,
  bin: SquareTerminal,
}

/** One part that runs on its own: the host, its kind and event on a line,
 *  the command (or the file) under it on one line; in full — the command,
 *  and the file that declares it, read by its hash — once expanded. */
function AutorunEntry({
  part,
  sha256,
}: {
  part: HarnessAutorunPart
  /** The declaring file's hash, when SpaceRing keeps a copy of it. */
  sha256: string | null
}) {
  const t = useTranslations("Harness.pluginInstall.autorun")
  const labels = usePluginInstallLabels()
  const failureMessage = useHarnessFailureMessage()
  const panelId = useId()
  const [open, setOpen] = useState(false)
  const [file, setFile] = useState<FileState>({ phase: "idle" })
  const type = oneOf(AUTORUN_TYPES, part.type)
  const Icon = type ? AUTORUN_ICONS[type] : CircleHelp
  const what = part.event ?? part.name
  // The second line: the command, or — for a part that is a file — the file.
  // It stays put when the entry opens and only unfolds to its full length
  // there, so the panel below never repeats it.
  const detail = part.command ?? part.path
  // The icon and the chevron sit in a band as tall as the header's first two
  // lines, so they stay where they are when the second line unfolds.
  const band = detail ? "h-8.5" : "h-7"
  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next && sha256 && (file.phase === "idle" || file.phase === "error")) {
      setFile({ phase: "loading" })
      harnessBlob(sha256).then(
        (text) => setFile({ phase: "ready", text }),
        (error) => setFile({ phase: "error", failure: harnessFailureOf(error) })
      )
    }
  }
  return (
    <li className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        title={t(open ? "hide" : "show")}
        onClick={toggle}
        className="flex w-full min-w-0 items-start gap-3 px-3 py-2 text-start outline-none hover:bg-muted/40 focus-visible:bg-muted/40"
      >
        <span
          aria-hidden="true"
          className={cn("flex shrink-0 items-center", band)}
        >
          <span
            className={cn(
              "flex size-7 items-center justify-center rounded-md",
              type
                ? "bg-tone-warning/10 text-tone-warning"
                : "bg-tone-danger/10 text-tone-danger"
            )}
          >
            <Icon className="size-3.5" />
          </span>
        </span>
        <span className="flex min-h-7 min-w-0 flex-1 flex-col justify-center">
          <span className="flex min-w-0 items-baseline gap-1.5 text-xs leading-4">
            <span className="shrink-0 font-medium">
              {labels.host(part.host)}
            </span>
            <span className="shrink-0 text-muted-foreground">
              {labels.autorunType(part.type)}
            </span>
            {what && (
              <bdi
                dir="ltr"
                className="min-w-0 truncate font-mono text-2xs text-foreground"
              >
                {what}
              </bdi>
            )}
          </span>
          {detail && (
            <bdi
              dir="ltr"
              className={cn(
                "mt-0.5 block min-w-0 font-mono text-2xs leading-4 text-muted-foreground",
                open
                  ? "whitespace-pre-wrap [overflow-wrap:anywhere]"
                  : "truncate"
              )}
            >
              {detail}
            </bdi>
          )}
        </span>
        <span
          aria-hidden="true"
          className={cn("flex shrink-0 items-center", band)}
        >
          <ChevronDown
            className={cn(
              "size-4 text-muted-foreground transition-transform",
              open && "rotate-180"
            )}
          />
        </span>
      </button>
      {open && (
        // pt-1 plus the header's own py-2 matches the px-3/pb-3 on the
        // other sides, so the panel sits 12px clear of everything around it.
        <div
          id={panelId}
          className="min-w-0 px-3 pt-1 pb-3 text-xs empty:hidden sm:ps-13"
        >
          {part.path && (
            <div className="min-w-0 overflow-hidden rounded-md border">
              {/* The path is the header's second line unless a command is. */}
              {part.command && (
                <p className="flex min-w-0 items-center gap-1.5 border-b bg-muted/40 px-2.5 py-1.5 text-2xs text-muted-foreground">
                  <FileText aria-hidden="true" className="size-3 shrink-0" />
                  <bdi dir="ltr" className="min-w-0 font-mono">
                    <MachineText breaks="path">{part.path}</MachineText>
                  </bdi>
                </p>
              )}
              {file.phase === "loading" && (
                <p className="flex items-center gap-2 px-2.5 py-2 text-muted-foreground">
                  <Loader2
                    aria-hidden="true"
                    className="size-3.5 animate-spin"
                  />
                  {t("reading")}
                </p>
              )}
              {file.phase === "error" && (
                <p role="alert" className="px-2.5 py-2 text-tone-warning">
                  {failureMessage(file.failure)}
                </p>
              )}
              {file.phase === "ready" && (
                <pre
                  dir="ltr"
                  className="max-h-64 overflow-auto px-2.5 py-2 font-mono text-2xs whitespace-pre-wrap [overflow-wrap:anywhere]"
                >
                  {file.text}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  )
}

/** The user's own agreement to what runs on its own — at the foot of the
 *  list it is about, or alone where there is no list. */
export interface AutorunConsent {
  id: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}

function AutorunConsentRow({
  consent,
  count,
  attached,
}: {
  consent: AutorunConsent
  count: number
  attached: boolean
}) {
  const t = useTranslations("Harness.pluginInstall.autorun")
  return (
    <div
      className={cn(
        "flex min-w-0 items-start gap-3 px-3 py-3 transition-colors",
        consent.checked ? "bg-tone-warning/5" : "bg-tone-warning/10",
        attached ? "border-t border-tone-warning/30" : ""
      )}
    >
      <Checkbox
        id={consent.id}
        checked={consent.checked}
        disabled={consent.disabled}
        onCheckedChange={(next) => consent.onChange(next === true)}
        className="mt-px bg-background max-md:size-5"
      />
      <label
        htmlFor={consent.id}
        className={cn(
          "min-w-0 flex-1 space-y-0.5",
          consent.disabled ? "cursor-default opacity-60" : "cursor-pointer"
        )}
      >
        <span className="block text-sm leading-4 font-medium">
          {t("consent")}
        </span>
        <span className="block text-xs text-muted-foreground">
          {count > 0 ? t("consentNote", { count }) : t("consentNoteNoList")}
        </span>
      </label>
    </div>
  )
}

/** What runs on its own once the plugin is installed whole — and, where it
 *  is asked for, the user's agreement to it, at the list's foot. */
export function AutorunList({
  parts,
  pkg,
  consent,
}: {
  parts: readonly HarnessAutorunPart[]
  /** The package the parts are of: their files are read from it. */
  pkg: {
    archive: unknown
    files: readonly { path: string; sha256: string }[]
  } | null
  consent?: AutorunConsent
}) {
  if (parts.length === 0 && !consent) return null
  return (
    <div
      className={cn(
        "min-w-0 overflow-hidden rounded-lg border",
        consent && "border-tone-warning/30"
      )}
    >
      {parts.length > 0 && (
        <ul className="min-w-0 divide-y">
          {parts.map((part, index) => {
            const sha256 = autorunFileOf(pkg, part)?.sha256 ?? null
            // Keyed by what it shows: a new plan with another file (or
            // command) here is a new entry, so no text read for the old one
            // stays on show, and no answer for it lands.
            return (
              <AutorunEntry
                key={`${index}:${part.host}:${part.type}:${part.path}:${part.command ?? ""}:${sha256 ?? ""}`}
                part={part}
                sha256={sha256}
              />
            )
          })}
        </ul>
      )}
      {consent && (
        <AutorunConsentRow
          consent={consent}
          count={parts.length}
          attached={parts.length > 0}
        />
      )}
    </div>
  )
}
