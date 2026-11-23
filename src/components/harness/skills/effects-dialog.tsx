"use client"

import type { ReactNode } from "react"
import {
  CircleAlert,
  CircleCheck,
  Info,
  Loader2,
  RefreshCw,
  TriangleAlert,
} from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { useHarnessSlot, useHarnessView } from "@/contexts/harness-view-context"
import {
  canConfirm,
  closeEffects,
  confirmEffects,
  planEffects,
  type EffectsDialog,
  type EffectsIntent,
  type Links,
} from "@/lib/harness/skill-links"
import { notableOps, reachesOthers } from "@/lib/skills/ops"
import type { SkillOpResult, SkillsApplyResult } from "@/lib/skills/types"
import { cn } from "@/lib/utils"
import { Code } from "../discover/detail-sections"
import { AgentGlyph } from "../mcp/mcp-bits"
import { McpDialogFrame } from "../mcp/mcp-dialog-frame"
import { FailureText, IssueList, SkillPath } from "./skill-bits"
import { useSkillsLabels } from "./use-skills-labels"

const code = (chunks: ReactNode) => <Code>{chunks}</Code>

/** Agents, each with its mark, in a line that wraps. */
export function AgentNames({ agents }: { agents: readonly string[] }) {
  const labels = useSkillsLabels()
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 align-middle">
      {agents.map((agent) => (
        <span key={agent} className="inline-flex items-center gap-1">
          <AgentGlyph agent={agent} className="size-3.5" />
          <span className="font-medium text-foreground">
            {labels.agent(agent)}
          </span>
        </span>
      ))}
    </span>
  )
}

function Headline({
  tone,
  children,
}: {
  tone: "fine" | "warning" | "neutral" | "info"
  children: ReactNode
}) {
  const Icon =
    tone === "fine" ? CircleCheck : tone === "warning" ? TriangleAlert : Info
  return (
    <p
      className={cn(
        "flex min-w-0 items-start gap-2 rounded-lg px-3 py-2 text-sm",
        tone === "fine" && "bg-tone-success/10",
        tone === "warning" && "bg-tone-warning/10",
        tone === "info" && "bg-tone-info/10",
        tone === "neutral" && "bg-muted/60"
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "mt-0.5 size-4 shrink-0",
          tone === "fine" && "text-tone-success",
          tone === "warning" && "text-tone-warning",
          tone === "info" && "text-tone-info",
          tone === "neutral" && "text-muted-foreground"
        )}
      />
      <span className="min-w-0">{children}</span>
    </p>
  )
}

/** One op: what it creates, removes or moves, and who else it reaches. */
export function OpEffects({
  op,
  named,
  phase,
  withSkill = true,
}: {
  op: SkillOpResult
  /** Several ops in one request: each says which skill and agent it is. */
  named: boolean
  phase: "review" | "result"
  /** Name the skill beside the agent — not where every op is of one skill
   *  the reader already knows. */
  withSkill?: boolean
}) {
  const t = useTranslations("Harness.skills.effects")
  const labels = useSkillsLabels()
  // Under review, an op that waits for the user's yes is what the dialog is
  // for; after a run, it is one that was not made.
  const stopped =
    op.status === "blocked" ||
    op.status === "failed" ||
    op.status === "rollback_failed" ||
    (op.status === "needs_ack" && phase === "result")
  const fine = !stopped
  const Icon = fine ? CircleCheck : CircleAlert
  const showStatus =
    named || !fine || phase === "result" || op.status === "unchanged"
  const kindOf = (kind: string, verb: "create" | "remove") => {
    if (kind === "link" || kind === "copy" || kind === "broken_link") {
      return t(`${verb}.${kind}` as never)
    }
    return t(`${verb}.other` as never)
  }
  return (
    <li className="min-w-0 space-y-1.5 px-3 py-2.5 text-xs">
      {showStatus && (
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {named && op.agent && (
            <>
              <AgentGlyph agent={op.agent} />
              <span className="text-sm font-medium">
                {labels.agent(op.agent)}
              </span>
              {withSkill && (
                <>
                  <span className="text-muted-foreground">·</span>
                  <bdi dir="ltr" className="font-mono text-foreground">
                    {op.skill}
                  </bdi>
                </>
              )}
            </>
          )}
          <span
            className={cn(
              "inline-flex items-center gap-1",
              fine ? "text-muted-foreground" : "text-tone-warning"
            )}
          >
            <Icon aria-hidden="true" className="size-3.5" />
            {labels.status(op.status)}
          </span>
        </div>
      )}
      {(phase === "review" || op.status === "done") && (
        <ul className="space-y-1 text-muted-foreground">
          {op.creates.map((change) => (
            <li key={`c:${change.path}`} className="min-w-0">
              {kindOf(change.kind, "create")}
              <SkillPath path={change.path} className="text-foreground" />
            </li>
          ))}
          {op.removes.map((change) => (
            <li key={`r:${change.path}`} className="min-w-0">
              {kindOf(change.kind, "remove")}
              <SkillPath path={change.path} className="text-foreground" />
            </li>
          ))}
          {op.moves.map((move) => (
            <li key={`m:${move.from}`} className="min-w-0">
              {t("move")}
              <SkillPath path={move.from} className="text-foreground" />
              <span className="block">{t("moveTo")}</span>
              <SkillPath path={move.to} className="text-foreground" />
            </li>
          ))}
        </ul>
      )}
      {op.gains.length > 0 && (
        <p className="text-foreground">
          {t("gains")} <AgentNames agents={op.gains} />
        </p>
      )}
      {op.loses.length > 0 && (
        <p className="text-foreground">
          {t("loses")} <AgentNames agents={op.loses} />
        </p>
      )}
      {op.touches.length > 0 && (
        <p className="text-foreground">
          {t("touches")} <AgentNames agents={op.touches} />
        </p>
      )}
      <IssueList issues={op.warnings} tone="info" />
      <IssueList issues={op.issues} />
    </li>
  )
}

/** The ops of a plan or a result worth saying something about — as this
 *  dialog shows them, and as the skill install dialog shows its links. */
export function OpList({
  result,
  phase,
  named: alwaysNamed = false,
}: {
  result: SkillsApplyResult
  phase: "review" | "result"
  /** Name each op's agent (and skill) even when there is only one;
   *  `"agent"`: its agent alone, every op being of one skill. */
  named?: boolean | "agent"
}) {
  const ops = notableOps(result)
  if (ops.length === 0) return null
  const named = alwaysNamed !== false || result.ops.length > 1
  return (
    <ul className="divide-y rounded-lg border">
      {ops.map((op) => (
        <OpEffects
          key={op.index}
          op={op}
          named={named}
          phase={phase}
          withSkill={alwaysNamed !== "agent"}
        />
      ))}
    </ul>
  )
}

function useIntentText(intent: EffectsIntent, count: number) {
  const t = useTranslations("Harness.skills.effects")
  const labels = useSkillsLabels()
  switch (intent.kind) {
    case "toggle": {
      const values = {
        skill: intent.skill,
        agent: labels.agent(intent.agent),
        code,
      }
      return {
        title: t.rich(intent.on ? "title.on" : "title.off", values),
        confirm: t(intent.on ? "confirm.on" : "confirm.off"),
        about: null,
        destructive: !intent.on,
      }
    }
    case "only": {
      const agent = labels.agent(intent.agent)
      return {
        title: t.rich("title.only", { skill: intent.skill, agent, code }),
        confirm: t("confirm.only", { agent }),
        about: t("about.only", { agent }),
        destructive: false,
      }
    }
    case "refresh": {
      const values = {
        skill: intent.skill,
        agent: labels.agent(intent.agent),
        code,
      }
      return {
        title: t.rich(
          intent.replace ? "title.replace" : "title.refresh",
          values
        ),
        confirm: t(intent.replace ? "confirm.replace" : "confirm.refresh"),
        about: intent.replace ? t("about.replace") : t("about.refresh"),
        destructive: false,
      }
    }
    case "repair":
      return {
        title: t.rich(
          intent.action === "repoint" ? "title.repoint" : "title.remove",
          { skill: intent.skill, code }
        ),
        confirm: t(
          intent.action === "repoint" ? "confirm.repoint" : "confirm.remove"
        ),
        about: null,
        destructive: intent.action === "remove",
      }
    case "batch":
      return {
        title: t(intent.on ? "title.batchOn" : "title.batchOff", { count }),
        confirm: t(intent.on ? "confirm.batchOn" : "confirm.batchOff"),
        about: null,
        destructive: !intent.on,
      }
    case "backupLinks":
      return {
        title: t.rich("title.backupLinks", { skill: intent.skill, code }),
        confirm: t("confirm.backupLinks"),
        about: t("about.backupLinks"),
        destructive: true,
      }
  }
}

/**
 * What a change to the links would do, shown before it is made: per op, the
 * links and copies it creates, removes or moves, the other agents that start
 * or stop seeing the skill, and those whose folders change though they keep
 * it. Nothing is written until the user confirms what this shows — and the
 * engine takes the confirmation only for exactly this plan: if anything
 * changed in between, the plan is made again and shown again.
 */
export function SkillEffectsDialog({ links }: { links: Links }) {
  const [dialog] = useHarnessSlot(links.effects)
  if (!dialog || (dialog.quiet && dialog.step !== "result")) return null
  return <EffectsDialogView key={dialog.id} dialog={dialog} links={links} />
}

function EffectsDialogView({
  dialog,
  links,
}: {
  dialog: EffectsDialog
  links: Links
}) {
  const t = useTranslations("Harness.skills.effects")
  const tDialog = useTranslations("Harness.mcp.dialog")
  const { slots } = useHarnessView()
  const count = dialog.ops.length || 1
  const intent = useIntentText(dialog.intent, count)
  const plan = dialog.plan
  const close = () => closeEffects(slots, links, dialog.id)
  const saving = dialog.step === "saving"
  const checking = dialog.step === "checking"
  const blocked = plan !== null && !(plan.outcome === "preflight" && plan.ok)
  const others = plan?.ops.some(reachesOthers) ?? false
  // A broken link is not repointed where the agent already sees the skill
  // elsewhere: it would see it twice. Removing the link is what is left.
  const removeInstead =
    blocked &&
    dialog.intent.kind === "repair" &&
    dialog.intent.action === "repoint" &&
    [...plan.issues, ...plan.ops.flatMap((op) => op.issues)].some(
      (issue) => issue.code === "already_visible"
    )
      ? dialog.intent
      : null

  let body: ReactNode
  if (dialog.step === "result") {
    const result = dialog.result
    body = (
      <div role="status" className="min-w-0 space-y-3">
        {dialog.failure && (
          <Headline tone="warning">
            <FailureText failure={dialog.failure} />
          </Headline>
        )}
        {result && (
          <>
            <Headline tone="warning">
              {result.outcome === "busy"
                ? t("result.busy")
                : result.outcome === "write_failed"
                  ? t("result.writeFailed")
                  : result.outcome === "invalid"
                    ? t("result.invalid")
                    : t("result.unknown")}
            </Headline>
            <IssueList issues={result.issues} />
            <OpList result={result} phase="result" />
          </>
        )}
      </div>
    )
  } else {
    body = (
      <div
        role="region"
        aria-label={t("reviewLabel")}
        aria-busy={checking}
        className="min-w-0 space-y-3"
      >
        {dialog.notice === "effectsChanged" && (
          <Headline tone="neutral">{t("changed")}</Headline>
        )}
        {intent.about && !blocked && (
          <p className="text-sm text-muted-foreground">{intent.about}</p>
        )}
        {dialog.failure && (
          <Headline tone="warning">
            <FailureText failure={dialog.failure} />
          </Headline>
        )}
        {checking && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
            {t("checking")}
          </p>
        )}
        {plan && (
          <>
            {blocked ? (
              <Headline tone="warning">{t("blocked")}</Headline>
            ) : others ? (
              <Headline tone="info">{t("others")}</Headline>
            ) : (
              <Headline tone="neutral">{t("ready")}</Headline>
            )}
            <IssueList issues={plan.issues} />
            <OpList result={plan} phase="review" />
            {removeInstead && (
              <p className="text-sm text-muted-foreground">
                {t("alreadyVisible")}
              </p>
            )}
          </>
        )}
      </div>
    )
  }

  let footer: ReactNode
  if (dialog.step === "result") {
    footer = (
      <>
        <Button type="button" variant="outline" onClick={close}>
          {tDialog("close")}
        </Button>
        {dialog.result?.outcome === "busy" && (
          <Button
            type="button"
            onClick={() => void confirmEffects(slots, links, dialog.id)}
          >
            <RefreshCw aria-hidden="true" />
            {tDialog("retry")}
          </Button>
        )}
      </>
    )
  } else {
    footer = (
      <>
        <Button
          type="button"
          variant="outline"
          disabled={saving}
          onClick={close}
        >
          {tDialog("cancel")}
        </Button>
        {removeInstead && (
          <Button
            type="button"
            variant="destructive"
            onClick={() =>
              void planEffects(slots, links, {
                id: dialog.id,
                intent: { ...removeInstead, action: "remove" },
                repair: { path: removeInstead.path, action: "remove" },
              })
            }
          >
            {t("removeInstead")}
          </Button>
        )}
        {blocked || dialog.failure ? (
          <Button
            type="button"
            onClick={() =>
              void planEffects(slots, links, {
                id: dialog.id,
                intent: dialog.intent,
                ops: dialog.ops,
                repair: dialog.repair ?? undefined,
              })
            }
          >
            <RefreshCw aria-hidden="true" />
            {tDialog("checkAgain")}
          </Button>
        ) : (
          <Button
            type="button"
            variant={intent.destructive ? "destructive" : "default"}
            disabled={!canConfirm(dialog) || saving}
            onClick={() => void confirmEffects(slots, links, dialog.id)}
          >
            {saving && <Loader2 aria-hidden="true" className="animate-spin" />}
            {intent.confirm}
          </Button>
        )}
      </>
    )
  }

  return (
    <McpDialogFrame
      title={intent.title}
      onRequestClose={() => !saving && close()}
      footer={footer}
      step={dialog.step === "result" ? "result" : "review"}
    >
      {body}
    </McpDialogFrame>
  )
}
