"use client"

import { useTranslations } from "next-intl"

import type {
  HarnessExpertLink,
  HarnessPluginInstallResult,
  HarnessPluginSkillsPlan,
} from "@/lib/harness/plugin-install-types"
import { notableOps, reachesOthers } from "@/lib/skills/ops"
import { Headline, Technical } from "../mcp/mcp-plan"
import { OpList } from "../skills/effects-dialog"
import { SkillPath } from "../skills/skill-bits"
import { InstallReasonList } from "./install-parts"
import { HostOutcomes, NamesNote, RowNote } from "./plugin-install-dialog"
import { usePluginInstallLabels } from "./use-plugin-install-labels"

/**
 * The parts the dialogs that manage an installed plugin share — update, a
 * change for one agent, repair, uninstall: what one agent's skills preview
 * says, the Experts pack's links taken or given back, and what came of it.
 */

/** The Experts pack's links an operation takes out of what an agent reads —
 *  and, where the folder is shared, who else stops seeing them — or gives
 *  back. */
export function ExpertsNote({
  agent,
  links,
  give = false,
}: {
  agent: string
  links: readonly HarnessExpertLink[]
  give?: boolean
}) {
  const t = useTranslations("Harness.pluginInstall.hosts")
  const tManage = useTranslations("Harness.plugins.dialog")
  const tAgents = useTranslations("Harness.skillInstall.agents")
  const labels = usePluginInstallLabels()
  if (links.length === 0) return null
  const others = [...new Set(links.flatMap((link) => link.agents))].filter(
    (other) => other !== agent
  )
  return (
    <NamesNote
      label={(count) =>
        give ? tManage("giveBack", { count }) : t("experts", { count })
      }
      names={links.map((link) => link.name)}
      tone={others.length > 0 ? "warning" : "muted"}
      suffix={
        others.length > 0
          ? tAgents("needsAck", { agents: labels.agents(others) })
          : undefined
      }
    />
  )
}

/** One agent's skills preview: names held, issues, copies that go to the
 *  backups, and the links that reach other agents or are blocked. */
export function SkillsPlanEffects({
  plan,
}: {
  plan: HarnessPluginSkillsPlan | null | undefined
}) {
  const t = useTranslations("Harness.pluginInstall.hosts")
  const labels = usePluginInstallLabels()
  if (!plan) return null
  const ops = plan.links ? notableOps(plan.links) : []
  const showOps = ops.some((op) => op.status === "blocked" || reachesOthers(op))
  return (
    <div className="min-w-0 space-y-1 empty:hidden">
      <NamesNote
        label={(count) => t("held", { count })}
        names={plan.held.map((held) => held.name)}
        tone="warning"
      />
      {plan.issues.length > 0 && (
        <InstallReasonList
          reasons={plan.issues}
          tone="blocking"
          wording={labels.reason}
        />
      )}
      {plan.copies_to_take.length > 0 && (
        <div className="min-w-0 space-y-0.5 text-xs">
          <p className="text-tone-warning">{t("copiesToTake")}</p>
          <ul className="min-w-0 space-y-0.5">
            {plan.copies_to_take.map((path) => (
              <li key={path} className="min-w-0">
                <SkillPath path={path} className="text-foreground" />
              </li>
            ))}
          </ul>
        </div>
      )}
      {!plan.links && <RowNote tone="warning">{t("noPreview")}</RowNote>}
      {plan.links && showOps && (
        <OpList result={plan.links} phase="review" named />
      )}
    </div>
  )
}

/** What a plugin operation came to: done, or why not — each agent's step,
 *  the agents left needing repair, and the cleanup left for later. */
export function PluginOperationResult({
  result,
  done,
  doneText,
}: {
  result: HarnessPluginInstallResult
  done: boolean
  doneText: string
}) {
  const t = useTranslations("Harness.pluginInstall.outcome")
  const tSkill = useTranslations("Harness.skillInstall.outcome")
  const tManage = useTranslations("Harness.plugins.dialog")
  const labels = usePluginInstallLabels()
  const headline = done
    ? doneText
    : result.outcome === "refused"
      ? tManage("refused")
      : result.outcome === "aborted"
        ? tSkill("aborted")
        : result.outcome === "invalid_package"
          ? tSkill("invalidPackage")
          : result.outcome === "busy"
            ? t("busy")
            : result.outcome === "failed"
              ? tManage("failed")
              : t("unknown")
  return (
    <div role={done ? "status" : "alert"} className="min-w-0 space-y-3">
      <Headline tone={done ? "fine" : "warning"}>{headline}</Headline>
      {result.issues.length > 0 && (
        <InstallReasonList
          reasons={result.issues}
          tone={done || result.outcome === "busy" ? "warning" : "blocking"}
          wording={labels.reason}
        />
      )}
      <HostOutcomes hosts={result.hosts} />
      {result.needs_repair.length > 0 && (
        <p className="text-xs text-tone-warning">
          {t("needsRepair", { agents: labels.agents(result.needs_repair) })}
        </p>
      )}
      {result.problems.length > 0 && (
        <div className="min-w-0 space-y-0.5 text-xs">
          <p className="text-tone-warning">{t("problems")}</p>
          {result.problems.map((problem, index) => (
            <Technical key={index} detail={problem} />
          ))}
        </div>
      )}
    </div>
  )
}
