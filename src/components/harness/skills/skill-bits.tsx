"use client"

import {
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
  type UIEvent,
} from "react"
import {
  ArrowUpCircle,
  CircleArrowUp,
  RotateCw,
  TriangleAlert,
} from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { useHarnessView } from "@/contexts/harness-view-context"
import { useAcpAgents } from "@/hooks/use-acp-agents"
import type { HarnessSlot } from "@/lib/harness-slots"
import type { SkillsHarnessState } from "@/lib/harness/skills-marks"
import { piUsesCustomAgentDir } from "@/lib/pi-config"
import type { SkillsFailure } from "@/lib/skills/errors"
import type { SkillsModel } from "@/lib/skills/model"
import type { SkillsAgent, SkillsIssue, StoreSkill } from "@/lib/skills/types"
import { cn } from "@/lib/utils"
import { DiscoverMark } from "../discover/discover-card"
import { useHarnessHost } from "../harness-host-label"
import { MachineText } from "../machine-text"
import { AgentGlyph, PathText } from "../mcp/mcp-bits"
import { detailIsWording, useSkillsLabels } from "./use-skills-labels"

/** Technical text: untranslated, left to right, broken between its parts. */
export function Technical({
  detail,
  className,
}: {
  detail: string | null | undefined
  className?: string
}) {
  if (!detail) return null
  // The line is the page's (it starts where the page's text starts); only
  // the text in it runs left to right.
  return (
    <span
      className={cn(
        "mt-0.5 block font-mono text-2xs leading-4 text-muted-foreground",
        className
      )}
    >
      <bdi dir="ltr">
        <MachineText>{detail}</MachineText>
      </bdi>
    </span>
  )
}

/** A path, as the MCP section shows one, with a line height that suits its
 *  small type when it wraps. */
export function SkillPath({
  path,
  className,
}: {
  path: string
  className?: string
}) {
  return <PathText path={path} className={cn("leading-4", className)} />
}

/** Codes, each with its path and its technical detail under it. */
export function IssueList({
  issues,
  tone = "warning",
}: {
  issues: readonly SkillsIssue[]
  tone?: "warning" | "info"
}) {
  const t = useTranslations("Harness.skills")
  const labels = useSkillsLabels()
  if (issues.length === 0) return null
  return (
    <ul className="space-y-1 text-xs">
      {issues.map((issue, index) => (
        <li key={index} className="flex min-w-0 items-start gap-1.5">
          <TriangleAlert
            aria-hidden="true"
            className={cn(
              "mt-0.5 size-3 shrink-0",
              tone === "warning" ? "text-tone-warning" : "text-tone-info"
            )}
          />
          <span className="min-w-0 flex-1">
            {labels.issue(issue)}
            {issue.path && <SkillPath path={issue.path} className="mt-0.5" />}
            {!detailIsWording(issue) && <Technical detail={issue.detail} />}
            {issue.kept && issue.kept.length > 0 && (
              <span className="mt-1 block">
                {t("issues.kept")}
                {issue.kept.map((path) => (
                  <SkillPath key={path} path={path} className="mt-0.5" />
                ))}
              </span>
            )}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** A rejected command in words. */
export function FailureText({ failure }: { failure: SkillsFailure }) {
  const t = useTranslations("Harness.skills.errors")
  const labels = useSkillsLabels()
  let message: ReactNode
  switch (failure.kind) {
    case "coded":
      message = labels.issue({
        code: failure.code ?? "",
        detail: failure.detail,
        agents: failure.agents,
      })
      break
    case "unsupported":
      message = t("commandUnsupported")
      break
    case "invalidResponse":
      message = t("invalidResponse")
      break
    default:
      message = t("failed")
  }
  const wording =
    failure.kind === "coded" &&
    detailIsWording({ code: failure.code ?? "", detail: failure.detail })
  return (
    <>
      {message}
      {!wording && <Technical detail={failure.detail} />}
    </>
  )
}

/** A warning block: something did not happen, and why. */
export function FailureNote({
  children,
  className,
  role = "alert",
}: {
  children: ReactNode
  className?: string
  role?: "alert" | "status"
}) {
  return (
    <div
      role={role}
      className={cn(
        "flex min-w-0 items-start gap-2 rounded-lg bg-tone-warning/10 px-3 py-2 text-xs",
        className
      )}
    >
      <TriangleAlert
        aria-hidden="true"
        className="mt-0.5 size-3.5 shrink-0 text-tone-warning"
      />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

/** In place of a section on a backend too old to have the skills engine:
 *  which Codeg needs updating, worded for the host. */
export function SkillsUnsupported({
  messages,
}: {
  messages: { local: string; remote: string; web: string }
}) {
  const host = useHarnessHost()
  return (
    <div
      role="alert"
      className="flex h-full min-h-48 items-center justify-center p-6"
    >
      <div className="flex max-w-md min-w-0 flex-col items-center gap-3 text-center">
        <span className="flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <CircleArrowUp aria-hidden="true" className="size-5" />
        </span>
        <p className="text-sm text-foreground">
          {host.kind === "remote"
            ? messages.remote
            : host.kind === "web"
              ? messages.web
              : messages.local}
        </p>
      </div>
    </div>
  )
}

export function LoadFailure({
  failure,
  variant,
  onRetry,
}: {
  failure: SkillsFailure
  variant: "pane" | "banner"
  onRetry: () => void
}) {
  const t = useTranslations("Harness.skills.errors")
  const retry = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={onRetry}
      className="max-md:h-10"
    >
      <RotateCw aria-hidden="true" />
      {t("retry")}
    </Button>
  )
  if (variant === "banner") {
    return (
      <div
        role="alert"
        className="mx-2 mb-2 flex min-w-0 flex-wrap items-center gap-2 rounded-lg bg-tone-warning/10 px-3 py-2 text-xs"
      >
        <TriangleAlert
          aria-hidden="true"
          className="size-3.5 shrink-0 text-tone-warning"
        />
        <span className="min-w-0 flex-1">
          {t("refreshFailed")}
          <Technical detail={failure.detail} />
        </span>
        {retry}
      </div>
    )
  }
  return (
    <div role="alert" className="flex min-h-48 items-center justify-center p-6">
      <div className="flex max-w-md min-w-0 flex-col items-center gap-3 text-center">
        <span className="flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <TriangleAlert aria-hidden="true" className="size-5" />
        </span>
        <p className="text-sm text-foreground">
          {failure.kind === "invalidResponse"
            ? t("invalidResponse")
            : t("loadFailed")}
        </p>
        <Technical detail={failure.detail} />
        {retry}
      </div>
    </div>
  )
}

export function EmptyState({
  icon,
  title,
  hint,
  children,
}: {
  icon: ReactNode
  title: string
  hint?: ReactNode
  children?: ReactNode
}) {
  return (
    // Top-aligned, not centred: a list's and a detail's stand side by side,
    // and their icons line up whatever each says under them.
    <div className="flex justify-center px-6 pt-10 pb-6">
      <div className="flex max-w-sm min-w-0 flex-col items-center gap-2 text-center">
        <span className="flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          {icon}
        </span>
        <p className="text-sm font-medium">{title}</p>
        {hint && (
          <p className="text-xs text-balance text-muted-foreground">{hint}</p>
        )}
        {children}
      </div>
    </div>
  )
}

/** Where a store skill comes from — and, for a Harness skill, which version
 *  its install recorded, and what the update check says of it. */
export function OriginMarks({
  skill,
  state,
  updateAvailable = false,
}: {
  skill: StoreSkill
  state?: SkillsHarnessState
  /** A newer version is out, whatever `state` says first (a folder changed
   *  here, a withdrawn version): said beside it. */
  updateAvailable?: boolean
}) {
  const t = useTranslations("Harness.skills")
  const labels = useSkillsLabels()
  return (
    <>
      <DiscoverMark tone={skill.origin === "harness" ? "info" : "neutral"}>
        {skill.origin === "harness" && skill.harness?.version
          ? t("marks.harnessVersion", { version: skill.harness.version })
          : labels.origin(skill.origin)}
      </DiscoverMark>
      {state && state !== "latest" && (
        <DiscoverMark tone={state === "updateAvailable" ? "info" : "warning"}>
          {state === "updateAvailable" && <ArrowUpCircle aria-hidden="true" />}
          {t(`harnessStates.${state}`)}
        </DiscoverMark>
      )}
      {updateAvailable && state !== "updateAvailable" && (
        <DiscoverMark tone="info">
          <ArrowUpCircle aria-hidden="true" />
          {t("harnessStates.updateAvailable")}
        </DiscoverMark>
      )}
    </>
  )
}

/** The agents a skill is on for, as a row of their marks — said in words for
 *  a screen reader by the row that holds it. */
export function AgentStrip({ agents }: { agents: readonly string[] }) {
  if (agents.length === 0) return null
  return (
    <span
      aria-hidden="true"
      className="flex min-w-0 flex-wrap items-center gap-1"
    >
      {agents.map((agent) => (
        <AgentGlyph key={agent} agent={agent} />
      ))}
    </span>
  )
}

/**
 * The agents a section shows a column (or a row) for. An agent that is not
 * installed, and sees nothing of Codeg's, is folded away until `showAll`; a
 * pi pointed at its own `PI_CODING_AGENT_DIR` is never shown — Codeg's
 * store links into the default directory, which that pi does not read.
 */
export function useSkillAgents(
  model: SkillsModel | null,
  showAll: boolean
): {
  shown: SkillsAgent[]
  hidden: number
  /** Of those shown, the agents Codeg knows are not installed. */
  notInstalled: ReadonlySet<string>
} {
  const { agents } = useAcpAgents()
  return useMemo(() => {
    if (!model) return { shown: [], hidden: 0, notInstalled: new Set<string>() }
    const known = new Map(agents.map((agent) => [agent.agent_type, agent]))
    const managed = model.agents.filter((agent) => {
      const info = known.get(agent.agent)
      return !(info && piUsesCustomAgentDir(info))
    })
    const holds = (agent: SkillsAgent) =>
      model.inventory.skills.some((skill) =>
        skill.cells.some(
          (cell) => cell.agent === agent.agent && cell.state !== "not_linked"
        )
      )
    const installed = (agent: SkillsAgent) => {
      const info = known.get(agent.agent)
      // Not in the registry (yet): shown rather than hidden on a guess.
      return (
        !info || info.installed_version !== null || info.custom_source !== null
      )
    }
    const shown = managed.filter(
      (agent) => showAll || installed(agent) || holds(agent)
    )
    const notInstalled = new Set(
      shown.filter((agent) => !installed(agent)).map((agent) => agent.agent)
    )
    return { shown, hidden: managed.length - shown.length, notInstalled }
  }, [model, agents, showAll])
}

/** A detail's scroller, put back at the offset it was left at — for the same
 *  detail only. */
export function useDetailScroll(
  slot: HarnessSlot<{ id: string; top: number } | null>,
  id: string
) {
  const { slots } = useHarnessView()
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const saved = slots.get(slot)
    if (ref.current) ref.current.scrollTop = saved?.id === id ? saved.top : 0
  }, [slots, slot, id])
  const onScroll = (event: UIEvent<HTMLDivElement>) =>
    slots.set(slot, { id, top: event.currentTarget.scrollTop })
  return { ref, onScroll }
}
