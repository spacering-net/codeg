"use client"

import { useId, useState, type ReactNode } from "react"
import {
  ChevronDown,
  ChevronUp,
  Loader2,
  RefreshCw,
  TriangleAlert,
} from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { useHarnessView } from "@/contexts/harness-view-context"
import { useOpenHarness } from "@/hooks/use-open-harness"
import { pickLocalized } from "@/lib/harness/display"
import { isRetryableFailure } from "@/lib/harness/errors"
import { closeHarnessDialog } from "@/lib/harness/mcp-install-state"
import {
  declaresAllowedTools,
  grownSince,
  holdersOf,
  keptAgents,
  needsSkillYankedConfirm,
  previewIsStale,
  setKeepAllowedTools,
  setSkillInstallName,
  shownLinks,
  shownSkillSnapshot,
  skillInstallBlockersOf,
  skillInstallModeOf,
  skillNameProblemOf,
  toggleSkillAgent,
  type SkillInstallBlocker,
  type SkillInstallInput,
  type SkillInstallMode,
} from "@/lib/harness/skill-install"
import {
  backToSkillInput,
  canConfirmSkillInstall,
  confirmSkillInstall,
  planSkillInstall,
  setSkillAcceptYanked,
  updateSkillInput,
  type SkillInstallDialog as SkillInstallDialogState,
} from "@/lib/harness/skill-install-state"
import type {
  HarnessSkillInstallResult,
  HarnessSkillPhase,
  HarnessSkillPlan,
} from "@/lib/harness/skill-install-types"
import { affectedAgents, isApplied, reachesOthers } from "@/lib/skills/ops"
import type { SkillsApplyResult } from "@/lib/skills/types"
import { cn } from "@/lib/utils"
import { Code } from "../discover/detail-sections"
import { useDiscoverLabels } from "../discover/use-discover-labels"
import { MachineText } from "../machine-text"
import { AgentGlyph } from "../mcp/mcp-bits"
import { McpDialogFrame } from "../mcp/mcp-dialog-frame"
import { SHOW_ALL_AGENTS_CLASS } from "../mcp/mcp-server-detail"
import { AgentSelectAll } from "../mcp/mcp-target-list"
import { Headline, Technical } from "../mcp/mcp-plan"
import { OpList } from "../skills/effects-dialog"
import { SkillPath } from "../skills/skill-bits"
import { useSkillsLabels } from "../skills/use-skills-labels"
import {
  InstallBlocked,
  InstallChangeList,
  InstallFailureNotice,
  InstallItemLine,
  InstallPackagePart,
  InstallPart,
  InstallReasonList,
  InstallSnapshot,
  YankedConfirm,
} from "./install-parts"
import { useSkillInstallLabels } from "./use-skill-install-labels"

const code = (chunks: ReactNode) => <Code>{chunks}</Code>

/** A machine name inside a sentence: left to right, broken between its
 *  parts. */
const machine = (chunks: ReactNode) => (
  <bdi dir="ltr">
    <MachineText>{chunks}</MachineText>
  </bdi>
)

/** Warnings with a part of their own in the dialog: said there, not twice. */
const OWN_PART_WARNINGS = new Set([
  "allowed_tools",
  "files_changed_locally",
  "files_unreadable",
])

/** A list of paths, each on its own line, broken where it has to be. */
function PathList({ paths }: { paths: readonly string[] }) {
  return (
    <ul className="min-w-0 space-y-0.5">
      {paths.map((path) => (
        <li key={path} className="min-w-0">
          <SkillPath path={path} className="text-foreground" />
        </li>
      ))}
    </ul>
  )
}

// ─── The input's parts ────────────────────────────────────────────────

/** What will be put in Codeg's store: the skill as SKILL.md describes it
 *  (third-party text, shown as text), where its files come from, and the
 *  files themselves. */
function PackagePart({ plan }: { plan: HarnessSkillPlan }) {
  const t = useTranslations("Harness.skillInstall.package")
  const { skill } = plan
  return (
    <InstallPackagePart pkg={plan.package}>
      <p className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <bdi dir="ltr" className="font-mono text-sm font-medium">
          <MachineText>{skill.name || plan.install_name.name}</MachineText>
        </bdi>
      </p>
      {skill.description && (
        <p dir="auto" className="break-words text-muted-foreground">
          {skill.description}
        </p>
      )}
      {(skill.license || skill.compatibility) && (
        <p className="text-muted-foreground">
          {skill.license && (
            <span dir="auto">{t("license", { license: skill.license })}</span>
          )}
          {skill.license && skill.compatibility && " · "}
          {skill.compatibility && (
            <span dir="auto">
              {t("compatibility", { compatibility: skill.compatibility })}
            </span>
          )}
        </p>
      )}
    </InstallPackagePart>
  )
}

/** The name it goes under in Codeg's store and every agent's folder — the
 *  plan's proposal, and why it is not the skill's own name when it is not. */
function NamePart({
  plan,
  dialogId,
  input,
}: {
  plan: HarnessSkillPlan
  dialogId: number
  input: SkillInstallInput
}) {
  const t = useTranslations("Harness.skillInstall.name")
  const labels = useSkillInstallLabels()
  const { slots } = useHarnessView()
  const id = `skill-install-${dialogId}-name`
  const name = input.name.trim()
  const problem = skillNameProblemOf(plan, name)
  const fixed = plan.installed !== null
  const own = plan.install_name
  const tried = [...new Set(own.taken.map((entry) => entry.name))].filter(
    (entry) => entry !== own.default
  )
  const holders = problem === "taken" ? holdersOf(plan, name) : []
  return (
    <InstallPart title={t("title")}>
      <div className="min-w-0 space-y-1.5">
        {/* The part's title already names the field. */}
        <label htmlFor={id} className="sr-only">
          {t("label")}
        </label>
        <Input
          id={id}
          value={input.name}
          readOnly={fixed}
          aria-invalid={problem && problem !== "fixed" ? true : undefined}
          dir="ltr"
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          maxLength={200}
          onChange={(event) =>
            updateSkillInput(slots, dialogId, (prev, current) =>
              setSkillInstallName(current, prev, event.target.value)
            )
          }
          className={cn(
            "font-mono text-[0.8125rem] max-md:h-10",
            fixed && "bg-muted/40"
          )}
        />
        {problem === "invalid" && (
          <p className="flex items-start gap-1.5 text-xs text-destructive">
            <TriangleAlert
              aria-hidden="true"
              className="mt-0.5 size-3.5 shrink-0"
            />
            <span className="min-w-0">{t("invalid")}</span>
          </p>
        )}
        {holders.length > 0 && (
          <div className="flex items-start gap-1.5 text-xs text-destructive">
            <TriangleAlert
              aria-hidden="true"
              className="mt-0.5 size-3.5 shrink-0"
            />
            <div className="min-w-0">
              {t.rich("takenNow", { name, code: machine })}
              <ul className="mt-0.5 list-disc ps-4">
                {holders.map((holder, index) => (
                  <li key={index}>{labels.taken(holder)}</li>
                ))}
              </ul>
            </div>
          </div>
        )}
        {fixed ? (
          <p className="text-xs text-muted-foreground">{t("fixed")}</p>
        ) : (
          <>
            {name === own.default && tried.length > 0 && (
              <div className="min-w-0 text-xs text-muted-foreground">
                {tried.map((taken) => (
                  <div key={taken} className="min-w-0">
                    {t.rich("renamed", {
                      name: taken,
                      default: own.default,
                      code: machine,
                    })}
                    <ul className="mt-0.5 list-disc ps-4">
                      {own.taken
                        .filter((entry) => entry.name === taken)
                        .map((entry, index) => (
                          <li key={index}>{labels.taken(entry)}</li>
                        ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
            <p className="text-xs text-muted-foreground">{t("rule")}</p>
          </>
        )}
        {name !== "" &&
          plan.skill.name !== "" &&
          name !== plan.skill.name &&
          problem === null && (
            <p className="text-xs text-muted-foreground">
              {t.rich("rewrite", { name, code: machine })}
            </p>
          )}
      </div>
    </InstallPart>
  )
}

/** SKILL.md's `allowed-tools`: dropped unless the user keeps it — with what
 *  it would let the agent do. */
function AllowedToolsPart({
  plan,
  dialogId,
  input,
}: {
  plan: HarnessSkillPlan
  dialogId: number
  input: SkillInstallInput
}) {
  const t = useTranslations("Harness.skillInstall.allowedTools")
  const { slots } = useHarnessView()
  const id = `skill-install-${dialogId}-allowed-tools`
  if (!declaresAllowedTools(plan)) return null
  const tools = plan.skill.allowed_tools ?? []
  return (
    <InstallPart title={t("title")}>
      <div className="min-w-0 space-y-2 rounded-lg border px-3 py-2.5 text-xs">
        <p className="text-muted-foreground">{t("body")}</p>
        <p className="flex min-w-0 flex-wrap gap-1">
          {tools.map((tool, index) => (
            <Code key={index}>{tool}</Code>
          ))}
        </p>
        <div className="flex min-w-0 items-start gap-2.5">
          <Checkbox
            id={id}
            checked={input.keepAllowedTools}
            aria-describedby={`${id}-note`}
            onCheckedChange={(next) =>
              updateSkillInput(slots, dialogId, (prev, current) =>
                setKeepAllowedTools(current, prev, next === true)
              )
            }
            className="mt-0.5 max-md:size-5"
          />
          <div className="min-w-0">
            <label htmlFor={id} className="cursor-pointer text-sm font-medium">
              {t("keep")}
            </label>
            <p
              id={`${id}-note`}
              className={cn(
                input.keepAllowedTools
                  ? "text-tone-warning"
                  : "text-muted-foreground"
              )}
            >
              {t(input.keepAllowedTools ? "on" : "off")}
              {plan.installed?.rewrites.allowedTools === "kept" &&
                ` ${t("keptBefore")}`}
            </p>
          </div>
        </div>
      </div>
    </InstallPart>
  )
}

/** What is worth saying of one ticked agent's link, by the preview on show:
 *  only what is in the way or reaches beyond it — a link that just goes
 *  where the tick says goes without a word. */
function useAgentNote(links: SkillsApplyResult | null) {
  const t = useTranslations("Harness.skillInstall.agents")
  const skills = useSkillsLabels()
  return (agent: string): { note: ReactNode; warn: boolean } | null => {
    const op = links?.ops.find((entry) => entry.agent === agent)
    if (!op) return null
    if (op.status === "blocked") {
      const reason = op.issues[0]
      return {
        note: reason ? (
          <>
            {t("cannotLink")} · {skills.issue(reason)}
          </>
        ) : (
          t("cannotLink")
        ),
        warn: true,
      }
    }
    if (reachesOthers(op)) {
      return {
        note: t("needsAck", {
          agents: skills.agents(
            affectedAgents(op).filter((other) => other !== agent)
          ),
        }),
        warn: true,
      }
    }
    const warning = op.warnings[0] ?? op.issues[0]
    return warning ? { note: skills.issue(warning), warn: true } : null
  }
}

/**
 * The agents to link it to: each with where its link would go, and a word
 * only where something is off — a shared folder others read too, nothing to
 * link into, a link in the way, other agents it reaches. Confirming the
 * dialog confirms that.
 */
function AgentsPart({
  dialog,
  plan,
  input,
  mode,
}: {
  dialog: SkillInstallDialogState
  plan: HarnessSkillPlan
  input: SkillInstallInput
  mode: SkillInstallMode
}) {
  const t = useTranslations("Harness.skillInstall.agents")
  const tInstall = useTranslations("Harness.install")
  const labels = useSkillInstallLabels()
  const { slots } = useHarnessView()
  const baseId = useId()
  const [showAll, setShowAll] = useState(false)
  const kept = keptAgents(plan)
  const links = shownLinks(plan, dialog.planAgents, dialog.relinks, input)
  const noteOf = useAgentNote(links)
  const checking = dialog.replanning || previewIsStale(dialog.planAgents, input)
  const otherName = input.name.trim() !== plan.install_name.default
  const rows = plan.agents.filter(
    (info) =>
      showAll ||
      info.installed !== false ||
      info.sees ||
      info.default ||
      input.agents.includes(info.agent)
  )
  const hidden = plan.agents.length - rows.length
  // Select-all speaks for the agents on show that can be ticked.
  const tickable = rows.filter(
    (info) => info.link_dir !== null && !kept.includes(info.agent)
  )
  const blocked = links?.ops.some((op) => op.status === "blocked") ?? false
  const others = links?.ops.some(reachesOthers) ?? false
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <fieldset className="min-w-0 space-y-1.5">
        <legend className="pb-1 text-2xs font-semibold tracking-wide text-muted-foreground uppercase">
          {t("title")}
        </legend>
        <p className="text-xs text-muted-foreground">
          {t(mode === "install" ? "hint" : "hintInstalled")}
        </p>
        {rows.length > 0 && (
          <div className="overflow-hidden rounded-lg border">
            <AgentSelectAll
              total={tickable.length}
              checked={
                tickable.filter((info) => input.agents.includes(info.agent))
                  .length
              }
              // One change for the lot: each change of agents asks the host
              // for a new preview.
              onChange={(on) =>
                updateSkillInput(slots, dialog.id, (prev, current) =>
                  tickable.reduce(
                    (next, info) =>
                      toggleSkillAgent(current, next, info.agent, on),
                    prev
                  )
                )
              }
            />
            <ul className="divide-y">
              {rows.map((info) => {
                const id = `${baseId}-${info.agent}`
                const checked = input.agents.includes(info.agent)
                const keeps = kept.includes(info.agent)
                const linkable = info.link_dir !== null
                const status = checked && !keeps ? noteOf(info.agent) : null
                // What the row says of the agent, most specific first; a
                // shared folder is worth a warning only where it is about to
                // be linked into.
                const note = !linkable
                  ? { text: t("noFolder"), warn: false }
                  : keeps
                    ? { text: t("keeps"), warn: false }
                    : status
                      ? { text: status.note, warn: status.warn }
                      : info.link_dir_shared && checked
                        ? { text: t("shared"), warn: true }
                        : null
                return (
                  <li
                    key={info.agent}
                    className="flex min-w-0 items-center gap-3 px-3 py-2"
                  >
                    <Checkbox
                      id={id}
                      checked={checked}
                      disabled={!linkable || keeps}
                      aria-describedby={`${id}-note`}
                      onCheckedChange={(next) =>
                        updateSkillInput(slots, dialog.id, (prev, current) =>
                          toggleSkillAgent(
                            current,
                            prev,
                            info.agent,
                            next === true
                          )
                        )
                      }
                      className="max-md:size-5"
                    />
                    <label
                      htmlFor={id}
                      className={cn(
                        "flex min-w-0 flex-1 items-center gap-x-3",
                        linkable && !keeps && "cursor-pointer"
                      )}
                    >
                      <span className="flex shrink-0 items-center gap-2 text-sm">
                        <AgentGlyph agent={info.agent} />
                        <span
                          className={cn(
                            "font-medium whitespace-nowrap",
                            !linkable && "text-muted-foreground"
                          )}
                        >
                          {labels.agent(info.agent)}
                        </span>
                        {info.installed === false && (
                          <span className="text-xs whitespace-nowrap text-muted-foreground">
                            {t("notInstalled")}
                          </span>
                        )}
                      </span>
                      <span
                        id={`${id}-note`}
                        className={cn(
                          "flex min-w-0 items-start gap-1 text-xs leading-snug",
                          note?.warn
                            ? "text-tone-warning"
                            : "text-muted-foreground"
                        )}
                      >
                        {note?.warn && (
                          <TriangleAlert
                            aria-hidden="true"
                            className="mt-px size-3 shrink-0"
                          />
                        )}
                        <span className="min-w-0">{note?.text}</span>
                      </span>
                      {/* Where the link would go, at the row's end. Cut
                          short from its start, so the agent's own folder at
                          its end stays in view; whole on hover. */}
                      {info.link_dir && (
                        <span
                          dir="rtl"
                          title={info.link_dir}
                          className="ms-auto hidden max-w-[45%] min-w-0 truncate text-start font-mono text-2xs text-muted-foreground/80 sm:block"
                        >
                          <bdi dir="ltr">{info.link_dir}</bdi>
                        </span>
                      )}
                    </label>
                  </li>
                )
              })}
            </ul>
          </div>
        )}
        {(hidden > 0 || showAll) && (
          <Button
            type="button"
            variant="link"
            size="sm"
            aria-expanded={showAll}
            onClick={() => setShowAll(!showAll)}
            className={SHOW_ALL_AGENTS_CLASS}
          >
            {showAll ? (
              <ChevronUp aria-hidden="true" />
            ) : (
              <ChevronDown aria-hidden="true" />
            )}
            {showAll ? t("hideNotInstalled") : t("showAll", { count: hidden })}
          </Button>
        )}
      </fieldset>
      {/* What is left to say of the ticked ones as a whole: none ticked, a
          preview on its way, a warning. Each agent's own is on its row. */}
      <div aria-live="polite" className="min-w-0 space-y-2 empty:hidden">
        {input.agents.length === 0 && !checking ? (
          <p className="text-xs text-muted-foreground">{t("none")}</p>
        ) : dialog.replanning ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
            {t("checking")}
          </p>
        ) : checking ? (
          // The host kept answering for other agents than those ticked:
          // asked again only when the user says so.
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              void planSkillInstall(slots, dialog.id, {
                agents: input.agents,
              })
            }
            className="max-md:h-10"
          >
            <RefreshCw aria-hidden="true" />
            {tInstall("dialog.checkAgain")}
          </Button>
        ) : links ? (
          <>
            {blocked && <Headline tone="warning">{t("blocked")}</Headline>}
            {others && <Headline tone="warning">{t("others")}</Headline>}
          </>
        ) : otherName ? (
          <p className="text-xs text-muted-foreground">
            {t.rich("otherName", { name: input.name.trim(), code: machine })}
          </p>
        ) : null}
      </div>
    </div>
  )
}

/** An update: what the user changed in the installed folder (kept in the
 *  backups), and what the new version asks for that the installed one did
 *  not — by both versions' states as the catalog gives them now. */
function UpdatePart({
  dialog,
  plan,
  mode,
}: {
  dialog: SkillInstallDialogState
  plan: HarnessSkillPlan
  mode: SkillInstallMode
}) {
  const t = useTranslations("Harness.skillInstall.update")
  const installed = plan.installed
  if (!installed) return null
  const { changed, added, missing } = installed.files
  const unreadable =
    installed.state === "unknown" ||
    plan.warnings.some((warning) => warning.code === "files_unreadable")
  const baseline = dialog.baseline
  const growth =
    mode === "update" && baseline?.phase === "ready"
      ? grownSince(baseline.snapshot, shownSkillSnapshot(plan, dialog.restate))
      : null
  return (
    <InstallPart title={t("title")}>
      <div className="min-w-0 space-y-2.5 rounded-lg border px-3 py-2.5 text-xs">
        {unreadable ? (
          <p className="text-tone-warning">{t("unreadable")}</p>
        ) : changed.length + added.length + missing.length === 0 ? (
          <p className="text-muted-foreground">{t("asInstalled")}</p>
        ) : null}
        {changed.length > 0 && (
          <div className="min-w-0 space-y-0.5">
            <p className="text-tone-warning">{t("changedFiles")}</p>
            <PathList paths={changed} />
          </div>
        )}
        {added.length > 0 && (
          <div className="min-w-0 space-y-0.5">
            <p className="text-tone-warning">{t("addedFiles")}</p>
            <PathList paths={added} />
          </div>
        )}
        {(changed.length > 0 || added.length > 0 || unreadable) && (
          <p className="text-muted-foreground">
            {t.rich("backupNote", { code })}
          </p>
        )}
        {missing.length > 0 && (
          <div className="min-w-0 space-y-0.5">
            <p className="text-muted-foreground">{t("missingFiles")}</p>
            <PathList paths={missing} />
          </div>
        )}
        {mode === "update" && (
          <div className="min-w-0 space-y-1.5 border-t pt-2.5">
            {!baseline || baseline.phase === "loading" ? (
              <p className="flex items-center gap-2 text-muted-foreground">
                <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
                {t("grownChecking")}
              </p>
            ) : !growth ? (
              <p className="text-muted-foreground">{t("grownUnknown")}</p>
            ) : growth.grown.length === 0 ? (
              <p className="text-muted-foreground">
                {growth.complete ? t("grownNone") : t("grownPartial")}
              </p>
            ) : (
              <>
                <p className="font-medium text-tone-warning">
                  {t("grownTitle")}
                </p>
                <InstallChangeList changes={growth.grown} />
                {!growth.complete && (
                  <p className="text-muted-foreground">{t("grownPartial")}</p>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </InstallPart>
  )
}

function BlockerLine({ blocker }: { blocker: SkillInstallBlocker }) {
  const t = useTranslations("Harness.skillInstall.missing")
  switch (blocker.kind) {
    case "name":
      return t(
        blocker.problem === "empty"
          ? "nameEmpty"
          : blocker.problem === "taken"
            ? "nameTaken"
            : blocker.problem === "fixed"
              ? "nameFixed"
              : "name"
      )
    case "item":
      return null
    default:
      return t(blocker.kind)
  }
}

/** What still has to be done before the button can install — said, rather
 *  than left to a greyed button. */
function MissingSummary({
  dialog,
  plan,
  input,
}: {
  dialog: SkillInstallDialogState
  plan: HarnessSkillPlan
  input: SkillInstallInput
}) {
  const t = useTranslations("Harness.skillInstall.missing")
  const blockers = skillInstallBlockersOf(
    plan,
    input,
    dialog.restate,
    dialog.planAgents
  ).filter((blocker) => blocker.kind !== "links" || !dialog.replanning)
  if (blockers.length === 0) return null
  return (
    <div
      data-install-missing=""
      className="min-w-0 rounded-lg bg-muted/50 px-3 py-2 text-xs"
    >
      <p className="font-medium">{t("title")}</p>
      <ul className="mt-1 list-disc space-y-0.5 ps-5 text-muted-foreground">
        {blockers.map((blocker, index) => (
          <li key={index}>
            <BlockerLine blocker={blocker} />
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The item, and what an update or a reinstall does to what is there. */
function ItemHead({
  dialog,
  plan,
  mode,
}: {
  dialog: SkillInstallDialogState
  plan: HarnessSkillPlan
  mode: SkillInstallMode
}) {
  const t = useTranslations("Harness.skillInstall.dialog")
  const installed = plan.installed
  return (
    <div className="min-w-0 space-y-2">
      <InstallItemLine
        itemRef={plan.item.ref || dialog.itemRef}
        version={plan.item.version}
        revision={plan.item.revision}
        publishedAt={plan.item.published_at}
        listed={plan.item_status === "listed"}
      />
      {mode === "update" && installed && (
        <p className="text-xs">
          {t.rich("updateFromTo", {
            from: installed.version ?? `#${installed.revision}`,
            to: plan.item.version ?? `#${plan.item.revision}`,
            code,
          })}
        </p>
      )}
      {mode === "reinstall" && (
        <p className="text-xs text-muted-foreground">{t("reinstallNote")}</p>
      )}
    </div>
  )
}

function InputBody({
  dialog,
  plan,
  input,
  mode,
}: {
  dialog: SkillInstallDialogState
  plan: HarnessSkillPlan
  input: SkillInstallInput
  mode: SkillInstallMode
}) {
  const t = useTranslations("Harness.skillInstall")
  const labels = useSkillInstallLabels()
  const { slots } = useHarnessView()
  const yanked = needsSkillYankedConfirm(plan, dialog.restate)
  const warnings = plan.warnings.filter(
    (warning) => !OWN_PART_WARNINGS.has(warning.code)
  )
  return (
    <div className="min-w-0 space-y-5">
      <ItemHead dialog={dialog} plan={plan} mode={mode} />
      {dialog.notice && (
        <Headline tone="neutral">{t(`notices.${dialog.notice}`)}</Headline>
      )}
      {dialog.issues.length > 0 && (
        <div role="alert" className="min-w-0 space-y-1.5">
          <Headline tone="warning">{t("notices.refused")}</Headline>
          <InstallReasonList
            reasons={dialog.issues}
            tone="blocking"
            wording={labels.reason}
            className="ps-1"
          />
        </div>
      )}
      {dialog.failure && <InstallFailureNotice failure={dialog.failure} />}
      {plan.blocking.length > 0 ? (
        <>
          <InstallBlocked reasons={plan.blocking} wording={labels.reason} />
          <InstallSnapshot
            snapshot={shownSkillSnapshot(plan, dialog.restate)}
          />
        </>
      ) : (
        <>
          {yanked && (
            <YankedConfirm
              id={`skill-install-${dialog.id}-yanked`}
              checked={input.acceptYanked}
              onChange={(accept) =>
                setSkillAcceptYanked(slots, dialog.id, accept)
              }
            />
          )}
          <InstallSnapshot
            snapshot={shownSkillSnapshot(plan, dialog.restate)}
          />
          {warnings.length > 0 && (
            <InstallPart title={t("warnings.title")}>
              <InstallReasonList
                reasons={warnings}
                tone="warning"
                wording={labels.reason}
              />
            </InstallPart>
          )}
          <UpdatePart dialog={dialog} plan={plan} mode={mode} />
          <PackagePart plan={plan} />
          <NamePart plan={plan} dialogId={dialog.id} input={input} />
          <AllowedToolsPart plan={plan} dialogId={dialog.id} input={input} />
          <AgentsPart dialog={dialog} plan={plan} input={input} mode={mode} />
          <MissingSummary dialog={dialog} plan={plan} input={input} />
        </>
      )}
    </div>
  )
}

// ─── The other steps ──────────────────────────────────────────────────

function StateChangedBody({
  dialog,
  plan,
  input,
}: {
  dialog: SkillInstallDialogState
  plan: HarnessSkillPlan
  input: SkillInstallInput
}) {
  const t = useTranslations("Harness.install.changes")
  const tSkill = useTranslations("Harness.skillInstall")
  const labels = useSkillInstallLabels()
  const { slots } = useHarnessView()
  const restate = dialog.restate
  if (!restate) return null
  return (
    <div className="min-w-0 space-y-4">
      <div role="alert" className="min-w-0 space-y-2">
        <Headline tone="warning">{t("title")}</Headline>
        <p className="text-xs text-muted-foreground">{t("body")}</p>
      </div>
      {dialog.issues.length > 0 && (
        <div role="alert" className="min-w-0 space-y-1.5">
          <Headline tone="warning">{tSkill("notices.refused")}</Headline>
          <InstallReasonList
            reasons={dialog.issues}
            tone="blocking"
            wording={labels.reason}
            className="ps-1"
          />
        </div>
      )}
      {dialog.failure && <InstallFailureNotice failure={dialog.failure} />}
      <InstallChangeList changes={restate.changes} />
      {needsSkillYankedConfirm(plan, restate) && (
        <YankedConfirm
          id={`skill-install-${dialog.id}-yanked-again`}
          checked={input.acceptYanked}
          onChange={(accept) => setSkillAcceptYanked(slots, dialog.id, accept)}
        />
      )}
      <InstallSnapshot snapshot={restate.snapshot} />
    </div>
  )
}

/** The steps of an install, as far as it got. */
function PhaseList({ phases }: { phases: readonly HarnessSkillPhase[] }) {
  const t = useTranslations("Harness.skillInstall.outcome")
  const labels = useSkillInstallLabels()
  if (phases.length === 0) return null
  return (
    <div className="min-w-0 space-y-1 text-xs">
      <p className="text-muted-foreground">{t("steps")}</p>
      <ol className="min-w-0 divide-y rounded-lg border">
        {phases.map((phase, index) => (
          <li
            key={index}
            className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 px-3 py-1.5"
          >
            <span className="font-medium">{labels.phase(phase.phase)}</span>
            <span
              className={cn(
                phase.status === "failed" || phase.status === "rolled_back"
                  ? "text-tone-warning"
                  : "text-muted-foreground"
              )}
            >
              {labels.phaseStatus(phase.status)}
            </span>
            {phase.detail && (
              <span className="basis-full">
                <Technical detail={phase.detail} />
              </span>
            )}
          </li>
        ))}
      </ol>
    </div>
  )
}

/** Paths under a heading, where there are any. */
function PathsNote({
  title,
  paths,
  tone = "neutral",
}: {
  title: ReactNode
  paths: readonly string[]
  tone?: "neutral" | "warning"
}) {
  if (paths.length === 0) return null
  return (
    <div className="min-w-0 space-y-0.5 text-xs">
      <p
        className={cn(
          tone === "warning" ? "text-tone-warning" : "text-muted-foreground"
        )}
      >
        {title}
      </p>
      <PathList paths={paths} />
    </div>
  )
}

/** An install that went through: each agent's link, as the Skills section
 *  shows a change to the links, what was left out, the copies, the backup,
 *  and what was changed in SKILL.md. */
function InstalledBody({
  result,
  mode,
}: {
  result: HarnessSkillInstallResult
  mode: SkillInstallMode
}) {
  const t = useTranslations("Harness.skillInstall.outcome")
  const links = result.links
  const skipped = result.links_skipped
  const linked = links !== null && links.ops.length > 0
  const rewrites = result.rewrites
  return (
    <div role="status" className="min-w-0 space-y-3">
      <Headline tone="fine">{t(`done.${mode}`)}</Headline>
      {rewrites?.name && (
        <p className="text-xs text-muted-foreground">
          {t.rich("nameRewritten", { to: rewrites.name.to, code: machine })}
        </p>
      )}
      {rewrites?.allowedTools === "removed" && (
        <p className="text-xs text-muted-foreground">
          {t("allowedToolsRemoved")}
        </p>
      )}
      {rewrites?.allowedTools === "kept" && (
        <p className="text-xs text-tone-warning">{t("allowedToolsKept")}</p>
      )}
      {linked && links && (
        <>
          {!isApplied(links) && (
            <Headline tone="warning">{t("linksPartial")}</Headline>
          )}
          <OpList result={links} phase="result" named="agent" />
        </>
      )}
      {skipped.length > 0 && (
        <div className="min-w-0 space-y-1.5">
          <Headline tone="warning">{t("skipped")}</Headline>
          <OpList
            result={{
              outcome: "preflight",
              ok: false,
              ops: skipped,
              issues: [],
            }}
            phase="result"
            named="agent"
          />
        </div>
      )}
      {!linked && skipped.length === 0 && (
        <p className="text-xs text-muted-foreground">{t("notLinked")}</p>
      )}
      {result.copies && (
        <>
          <PathsNote
            title={t("copiesRefreshed")}
            paths={result.copies.refreshed}
          />
          <PathsNote
            title={t("copiesKept")}
            paths={result.copies.kept_changed}
            tone="warning"
          />
          {result.copies.problems.length > 0 && (
            <div className="min-w-0 space-y-0.5 text-xs">
              <p className="text-tone-warning">{t("copiesProblems")}</p>
              {result.copies.problems.map((problem, index) => (
                <Technical key={index} detail={problem} />
              ))}
            </div>
          )}
        </>
      )}
      {result.backup && (
        <PathsNote title={t("backup")} paths={[result.backup]} />
      )}
      <PathsNote title={t("kept")} paths={result.kept} tone="warning" />
    </div>
  )
}

function ResultBody({
  dialog,
  mode,
}: {
  dialog: SkillInstallDialogState
  mode: SkillInstallMode
}) {
  const t = useTranslations("Harness.skillInstall.outcome")
  const labels = useSkillInstallLabels()
  const result = dialog.result
  if (!result) return null
  if (result.outcome === "installed") {
    return <InstalledBody result={result} mode={mode} />
  }
  const headline =
    result.outcome === "aborted"
      ? t("aborted")
      : result.outcome === "invalid_package"
        ? t("invalidPackage")
        : result.outcome === "busy"
          ? t("busy")
          : result.outcome === "write_failed"
            ? t("writeFailed")
            : t("unknown")
  return (
    <div role="alert" className="min-w-0 space-y-3">
      <Headline tone="warning">{headline}</Headline>
      {result.issues.length > 0 && (
        <InstallReasonList
          reasons={result.issues}
          tone={result.outcome === "busy" ? "warning" : "blocking"}
          wording={labels.reason}
        />
      )}
      {result.outcome === "aborted" && result.snapshot && (
        <InstallSnapshot snapshot={result.snapshot} />
      )}
      {result.outcome !== "aborted" && result.outcome !== "busy" && (
        <PhaseList phases={result.phases} />
      )}
      <PathsNote title={t("kept")} paths={result.kept} tone="warning" />
    </div>
  )
}

function Progress({ children }: { children: ReactNode }) {
  return (
    <p
      role="status"
      className="flex min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground"
    >
      <Loader2 aria-hidden="true" className="size-4 animate-spin" />
      {children}
    </p>
  )
}

// ─── The dialog ───────────────────────────────────────────────────────

/**
 * Install a skill from Harness — or update one, or install the installed
 * version again: one dialog, made of what the plan says.
 *
 * It shows who the item is, what the catalog says of the version right now
 * (never what the page it was opened from said), what the package holds and
 * where it comes from, the name it goes under and why, `allowed-tools`, and
 * the agents with what linking them does — and installs only when its own
 * button is pressed, with exactly what it showed. Each way an install can
 * come back without writing is told for what it is: a link that reaches
 * other agents in a way not shown (shown, to confirm), the catalog's account
 * changed (the changes, to confirm again), or the package is not what it
 * says.
 */
export function SkillInstallDialog({
  dialog,
}: {
  dialog: SkillInstallDialogState
}) {
  const t = useTranslations("Harness.install")
  const tSkill = useTranslations("Harness.skillInstall.dialog")
  const discover = useDiscoverLabels()
  const { slots } = useHarnessView()
  const { openHarness } = useOpenHarness()
  const plan = dialog.plan
  const input = dialog.input
  const mode: SkillInstallMode = plan
    ? skillInstallModeOf(plan)
    : dialog.purpose === "update"
      ? "update"
      : "install"
  // The catalog's title, as text: the plan's, or before the plan is in, the
  // one the page that opened the dialog had; else the address.
  const title =
    pickLocalized(plan?.item.title, discover.lang) ??
    pickLocalized(dialog.knownTitle, discover.lang) ??
    (plan?.item.ref || dialog.itemRef)
  const close = () => closeHarnessDialog(slots, dialog.id)
  const confirm = () => void confirmSkillInstall(slots, dialog.id)
  const confirmable = canConfirmSkillInstall(dialog)
  const installing = dialog.step === "installing"
  const retryPlan = () =>
    void planSkillInstall(slots, dialog.id, {
      agents: dialog.input?.agents,
      notice: dialog.notice,
    })

  let body: ReactNode
  let footer: ReactNode
  if (dialog.planPhase === "error" && dialog.planFailure) {
    // No plan, or a new one could not be had: the old one is not what would
    // be confirmed any more.
    body = <InstallFailureNotice failure={dialog.planFailure} />
    footer = (
      <>
        <Button type="button" variant="outline" onClick={close}>
          {t("dialog.close")}
        </Button>
        {isRetryableFailure(dialog.planFailure) && (
          <Button type="button" onClick={retryPlan}>
            <RefreshCw aria-hidden="true" />
            {t("dialog.retry")}
          </Button>
        )}
      </>
    )
  } else if (dialog.planPhase === "loading" || !plan || !input) {
    body = <Progress>{tSkill("loading")}</Progress>
    footer = (
      <Button type="button" variant="outline" onClick={close}>
        {t("dialog.cancel")}
      </Button>
    )
  } else if (dialog.step === "installing") {
    body = <Progress>{tSkill(`working.${mode}`)}</Progress>
    footer = (
      <Button type="button" disabled>
        {tSkill(`working.${mode}`)}
      </Button>
    )
  } else if (dialog.step === "stateChanged") {
    body = <StateChangedBody dialog={dialog} plan={plan} input={input} />
    footer = (
      <>
        <Button
          type="button"
          variant="outline"
          onClick={() => backToSkillInput(slots, dialog.id)}
        >
          {t("dialog.back")}
        </Button>
        <Button type="button" disabled={!confirmable} onClick={confirm}>
          {tSkill(`confirmAgain.${mode}`)}
        </Button>
      </>
    )
  } else if (dialog.step === "result" && dialog.result) {
    body = <ResultBody dialog={dialog} mode={mode} />
    const outcome = dialog.result.outcome
    footer =
      outcome === "installed" ? (
        <>
          {dialog.from === "discover" && (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                const skillId = dialog.result?.name ?? input.name.trim()
                close()
                openHarness({ section: "skills", skillId })
              }}
            >
              {tSkill("showInSkills")}
            </Button>
          )}
          <Button type="button" onClick={close}>
            {t("dialog.done")}
          </Button>
        </>
      ) : outcome === "busy" ? (
        <>
          <Button
            type="button"
            variant="outline"
            onClick={() => backToSkillInput(slots, dialog.id)}
          >
            {t("dialog.back")}
          </Button>
          <Button type="button" disabled={!confirmable} onClick={confirm}>
            <RefreshCw aria-hidden="true" />
            {t("dialog.retry")}
          </Button>
        </>
      ) : (
        <Button type="button" onClick={close}>
          {t("dialog.close")}
        </Button>
      )
  } else {
    body = <InputBody dialog={dialog} plan={plan} input={input} mode={mode} />
    footer =
      plan.blocking.length > 0 ? (
        <Button type="button" onClick={close}>
          {t("dialog.close")}
        </Button>
      ) : (
        <>
          <Button type="button" variant="outline" onClick={close}>
            {t("dialog.cancel")}
          </Button>
          <Button type="button" disabled={!confirmable} onClick={confirm}>
            {tSkill(`confirm.${mode}`)}
          </Button>
        </>
      )
  }

  return (
    <McpDialogFrame
      size="wide"
      title={tSkill.rich(`title.${mode}`, {
        title,
        name: (chunks) => <bdi>{chunks}</bdi>,
      })}
      onRequestClose={() => !installing && close()}
      footer={footer}
      // Not the request: a new link preview for other ticks is the same
      // screen. A notice is news, and is read first.
      step={`${dialog.step}:${dialog.planPhase}:${dialog.notice ?? ""}`}
    >
      {body}
    </McpDialogFrame>
  )
}
