"use client"

import { useState } from "react"
import { ChevronDown, ChevronUp, Loader2 } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
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

/** One part that runs on its own: host · event · command on a line, and in
 *  full — the command, and the file that declares it, read by its hash —
 *  once expanded. */
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
  const [open, setOpen] = useState(false)
  const [file, setFile] = useState<FileState>({ phase: "idle" })
  const what = part.event ?? part.name ?? part.path
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
    <li className="min-w-0 px-3 py-1.5">
      <div className="flex min-w-0 items-start gap-2">
        <DiscoverMark
          size="sm"
          tone={oneOf(AUTORUN_TYPES, part.type) ? "warning" : "danger"}
        >
          {labels.autorunType(part.type)}
        </DiscoverMark>
        <span
          className={cn(
            "min-w-0 flex-1 text-xs",
            !open && "line-clamp-2 break-all"
          )}
        >
          <span className="font-medium">{labels.host(part.host)}</span>
          {what && (
            <>
              {" · "}
              <bdi dir="ltr" className="font-mono">
                <MachineText>{what}</MachineText>
              </bdi>
            </>
          )}
          {part.command && (
            <>
              {" · "}
              <bdi dir="ltr" className="font-mono text-muted-foreground">
                {open ? (
                  part.command
                ) : (
                  <MachineText>{part.command}</MachineText>
                )}
              </bdi>
            </>
          )}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-expanded={open}
          aria-label={t(open ? "hide" : "show")}
          title={t(open ? "hide" : "show")}
          onClick={toggle}
          className="-my-1 shrink-0"
        >
          {open ? (
            <ChevronUp aria-hidden="true" />
          ) : (
            <ChevronDown aria-hidden="true" />
          )}
        </Button>
      </div>
      {open && (
        <div className="mt-1.5 min-w-0 space-y-1 text-xs">
          {part.path && (
            <p className="text-muted-foreground">
              <bdi dir="ltr" className="font-mono">
                <MachineText>{part.path}</MachineText>
              </bdi>
            </p>
          )}
          {file.phase === "loading" && (
            <p className="flex items-center gap-2 text-muted-foreground">
              <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
              {t("reading")}
            </p>
          )}
          {file.phase === "error" && (
            <p role="alert" className="text-tone-warning">
              {failureMessage(file.failure)}
            </p>
          )}
          {file.phase === "ready" && (
            <pre
              dir="ltr"
              className="max-h-64 overflow-auto rounded-md bg-muted/60 px-2.5 py-2 font-mono text-2xs whitespace-pre-wrap break-all"
            >
              {file.text}
            </pre>
          )}
        </div>
      )}
    </li>
  )
}

/** What runs on its own once the plugin is installed whole. */
export function AutorunList({
  parts,
  pkg,
}: {
  parts: readonly HarnessAutorunPart[]
  /** The package the parts are of: their files are read from it. */
  pkg: {
    archive: unknown
    files: readonly { path: string; sha256: string }[]
  } | null
}) {
  if (parts.length === 0) return null
  return (
    <ul className="min-w-0 divide-y rounded-lg border">
      {parts.map((part, index) => {
        const sha256 = autorunFileOf(pkg, part)?.sha256 ?? null
        // Keyed by what it shows: a new plan with another file (or command)
        // here is a new entry, so no text read for the old one stays on
        // show, and no answer for it lands.
        return (
          <AutorunEntry
            key={`${index}:${part.host}:${part.type}:${part.path}:${part.command ?? ""}:${sha256 ?? ""}`}
            part={part}
            sha256={sha256}
          />
        )
      })}
    </ul>
  )
}
