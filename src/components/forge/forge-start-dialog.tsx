"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronDown, MessageSquare } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { SettingCard, SettingRow } from "@/components/shared/setting-card"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import { workTaskCreateFromForge } from "@/lib/api"
import {
  toLocalizedErrorMessage,
  type AppErrorTranslator,
} from "@/lib/app-error"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import type {
  ForgeIssueRow,
  ForgePanelSettings,
  ForgeProviderId,
  ForgeRemote,
  ForgeScenarioId,
  WorkTask,
} from "@/lib/types"

/** GitLab and CNB call it a merge request, and a dialog that promises a pull
 *  request and then opens a merge request reads like the wrong tool answered. */
function descriptionKey(isPr: boolean, provider: ForgeProviderId) {
  if (!isPr) return "dialogDescription"
  return provider === "gitlab" || provider === "cnb"
    ? "dialogDescriptionMr"
    : "dialogDescriptionPr"
}

/** The kind's scenario menu, default first — the server enforces the same
 *  split, this list only decides what the dialog offers. Labels/hints stay
 *  provider-neutral so PRs and MRs share one set of keys.
 *
 *  There is no "investigate only" entry for issues: reproducing the report and
 *  finding its cause is now the first step of BOTH issue templates, so offering
 *  it as a separate mode made the check look like something the other two could
 *  skip — which is how a task ends up fixing a problem that was never there. */
export function scenariosForKind(isPr: boolean): ForgeScenarioId[] {
  return isPr ? ["review_fix", "review_only"] : ["fix", "plan_first"]
}

/**
 * The scenario a fresh dialog opens on: the default configured for this folder
 * when it is one this kind actually offers, otherwise the kind's first entry.
 *
 * The guard is the point. A stored `review_only` on an ISSUE (settings written
 * for the other kind, or a name this build has retired) would preselect a
 * radio that is not on screen, leaving the group with no visible selection and
 * the Create button sending a scenario the server refuses.
 */
export function initialScenario(
  isPr: boolean,
  configured: string | null | undefined
): ForgeScenarioId {
  const offered = scenariosForKind(isPr)
  return offered.find((id) => id === configured) ?? offered[0]
}

/** Literal key pairs — `t()` is typed against the message schema, so these
 *  must stay literals rather than computed strings. */
const SCENARIO_KEYS = {
  fix: { label: "scenarioFix", hint: "scenarioFixHint" },
  plan_first: { label: "scenarioPlanFirst", hint: "scenarioPlanFirstHint" },
  review_fix: { label: "scenarioReviewFix", hint: "scenarioReviewFixHint" },
  review_only: { label: "scenarioReviewOnly", hint: "scenarioReviewOnlyHint" },
} as const satisfies Record<ForgeScenarioId, { label: string; hint: string }>

/**
 * Trigger dialog: confirm the work item, optionally add an instruction, and
 * mint the task. The snapshot preview is READ-ONLY by design — the prompt
 * (instruction wording + untrusted-data envelope) is composed server-side, so
 * there is nothing editable to show; what you see is what the envelope wraps.
 * A duplicate answer swaps the footer into "view existing / create anyway".
 */
export function ForgeStartDialog({
  row,
  remote,
  folderId,
  settings,
  onClose,
  onCreated,
}: {
  row: ForgeIssueRow
  remote: ForgeRemote
  folderId: number
  /** The preferences in force FOR THIS FOLDER, already resolved by the page —
   *  what this dialog OPENS with. `null` while they are still loading (or if
   *  the read failed), which reads as the built-in defaults: a trigger must not
   *  wait on a preferences round trip to draw. */
  settings?: ForgePanelSettings | null
  onClose: () => void
  onCreated: (task: WorkTask) => void
}) {
  const t = useTranslations("Forge")
  // Root-scoped: backend errors carry FULL dotted keys the namespaced `t`
  // above cannot resolve. See `backup-settings.tsx` for the same pairing.
  const tRoot = useTranslations()
  const { setRoute } = useWorkbenchRoute()
  const scenarios = scenariosForKind(row.is_pr)
  const [scenario, setScenario] = useState<ForgeScenarioId>(() =>
    initialScenario(
      row.is_pr,
      row.is_pr
        ? settings?.default_pr_scenario
        : settings?.default_issue_scenario
    )
  )
  const [instruction, setInstruction] = useState("")
  // Asked here, once per work item, rather than kept as a project-wide switch:
  // this is the one thing the task will do in a thread other people are
  // reading, so the decision belongs in front of the item it publishes on.
  // The panel settings only choose the STARTING position — the switch is on
  // screen either way, and what it says on Create is what gets recorded.
  const [writeback, setWriteback] = useState(
    () => settings?.writeback_default ?? true
  )
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [duplicate, setDuplicate] = useState<WorkTask | null>(null)

  const submit = async (force: boolean) => {
    setSubmitting(true)
    setError(null)
    try {
      const result = await workTaskCreateFromForge({
        folder_id: folderId,
        source: {
          kind: row.is_pr ? "pr" : "issue",
          provider: remote.provider,
          server_host: remote.server_host,
          owner_repo: remote.owner_repo,
          number: row.number,
        },
        snapshot: {
          title: row.title,
          body: row.body,
          // Names only: the snapshot is TEXT handed to an agent, and a colour
          // means nothing there.
          labels: row.labels.map((l) => l.name),
          author: row.author,
        },
        scenario,
        instruction: instruction.trim() || null,
        writeback,
        force,
      })
      switch (result.outcome) {
        case "created":
          onCreated(result.task)
          return
        case "duplicate":
          setDuplicate(result.existing)
          return
        case "folder_mismatch": {
          const remoteLabel = result.folder_remote
            ? `${result.folder_remote.server_host}/${result.folder_remote.owner_repo}`
            : "—"
          setError(t("folderMismatch", { remote: remoteLabel }))
          return
        }
      }
    } catch (e) {
      // A rejected `invoke()` throws the SERIALIZED AppCommandError object,
      // not an Error — `String(e)` on it renders "[object Object]".
      setError(
        toLocalizedErrorMessage(e, tRoot as unknown as AppErrorTranslator)
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="truncate">
            #{row.number} · {row.title}
          </DialogTitle>
          <DialogDescription>
            {t(descriptionKey(row.is_pr, remote.provider), {
              repo: `${remote.server_host}/${remote.owner_repo}`,
            })}
          </DialogDescription>
        </DialogHeader>

        {duplicate == null ? (
          // ONE card, three sections divided by hairlines, rather than three
          // surfaces floating in the dialog's own `gap-6`: what is on screen is
          // a single form — pick how, decide whether to say so, add anything
          // else — and three separately-bordered blocks read as three unrelated
          // questions that happen to share a dialog.
          <div className="flex flex-col gap-2.5">
            <SettingCard>
              <RadioGroup
                value={scenario}
                onValueChange={(v) => setScenario(v as ForgeScenarioId)}
                aria-label={t("scenarioLabel")}
                className="gap-0 divide-y divide-border/60"
              >
                {scenarios.map((id) => (
                  <label
                    key={id}
                    htmlFor={`forge-scenario-${id}`}
                    className={cn(
                      // No border of its own: the card supplies the outline and
                      // the hairlines, so a selected option is marked by FILL
                      // rather than by growing a second frame inside the first.
                      "flex cursor-pointer items-start gap-2.5 p-3 transition-colors",
                      scenario === id ? "bg-primary/5" : "hover:bg-muted/60"
                    )}
                  >
                    <RadioGroupItem
                      id={`forge-scenario-${id}`}
                      value={id}
                      className="mt-1"
                    />
                    <span className="flex flex-col gap-1">
                      {/* The same type scale the setting rows below use —
                          `text-sm` title over a `text-xs` explanation — so the
                          card reads as one rhythm rather than two. */}
                      <span className="text-sm font-medium leading-none">
                        {t(SCENARIO_KEYS[id].label)}
                      </span>
                      <span className="text-xs leading-5 text-muted-foreground">
                        {t(SCENARIO_KEYS[id].hint)}
                      </span>
                    </span>
                  </label>
                ))}
              </RadioGroup>
              {/* Above the note box, not below it: the scenario picker and this
                  are the two DECISIONS this dialog takes, and the free-text box
                  is what you add after them. The house settings-row shape
                  (title, one line of explanation, switch on the right) rather
                  than a fourth card-with-a-tick — it is not another scenario. */}
              <SettingRow
                icon={MessageSquare}
                title={t("writebackLabel")}
                description={t("writebackHint")}
                htmlFor="forge-writeback"
                control={
                  <Switch
                    id="forge-writeback"
                    checked={writeback}
                    onCheckedChange={setWriteback}
                  />
                }
              />
              {/* A field on the card's own surface, in the card's padding —
                  the same shape the settings dialogs give a free-text box.
                  Labelled by its placeholder: a visible title over a box whose
                  placeholder already says the same thing is one line of the
                  dialog's height spent twice. */}
              <div className="p-3">
                <Textarea
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  placeholder={t("instructionPlaceholder")}
                  aria-label={t("instructionPlaceholder")}
                  rows={3}
                  className="min-h-20 bg-background text-sm"
                />
              </div>
            </SettingCard>
            <Collapsible>
              <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                <ChevronDown className="h-3 w-3" />
                {t("previewToggle")}
              </CollapsibleTrigger>
              <CollapsibleContent>
                {/* Read-only: this is the DATA the server-side envelope wraps. */}
                <div className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md border border-border/60 bg-muted/40 p-2 font-mono text-[0.6875rem] text-muted-foreground">
                  {row.body?.trim() || t("previewEmpty")}
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>
        ) : (
          <div className="rounded-md border border-border/60 bg-muted/40 p-3 text-sm">
            {t("duplicateBody", {
              title: duplicate.title,
              status: duplicate.status,
            })}
          </div>
        )}

        {error != null ? (
          // Announced: the trigger can be sent from the keyboard, and a
          // mismatch or a transport failure that only renders is a dead key.
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          {duplicate == null ? (
            <>
              <Button variant="ghost" onClick={onClose} disabled={submitting}>
                {t("cancel")}
              </Button>
              <Button onClick={() => void submit(false)} disabled={submitting}>
                {submitting ? t("creating") : t("create")}
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose}>
                {t("cancel")}
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  onClose()
                  setRoute("tasks")
                }}
              >
                {t("viewExisting")}
              </Button>
              <Button
                variant="secondary"
                onClick={() => void submit(true)}
                disabled={submitting}
              >
                {submitting ? t("creating") : t("createAnyway")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
