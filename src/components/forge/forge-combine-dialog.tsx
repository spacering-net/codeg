"use client"

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { MessageSquare, X } from "lucide-react"
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
import { stateGlyph } from "@/components/forge/forge-issue-row"
import { initialScenario } from "@/components/forge/forge-start-dialog"
import { statusLabelKey } from "@/components/tasks/task-card"
import { cn } from "@/lib/utils"
import { workTaskCreateFromForgeIssues } from "@/lib/api"
import {
  toLocalizedErrorMessage,
  type AppErrorTranslator,
} from "@/lib/app-error"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import type {
  ForgeCreateConflict,
  ForgeIssueRow,
  ForgePanelSettings,
  ForgeRemote,
  ForgeScenarioId,
  WorkTask,
} from "@/lib/types"

/** The two ways several issues can be handled together — the issue
 *  scenarios, with hints saying what "together" does to each. Literal keys:
 *  `t()` is typed against the message schema. */
const COMBINE_SCENARIOS = [
  { id: "fix", label: "scenarioFix", hint: "combineScenarioFixHint" },
  {
    id: "plan_first",
    label: "scenarioPlanFirst",
    hint: "combineScenarioPlanFirstHint",
  },
] as const satisfies ReadonlyArray<{
  id: ForgeScenarioId
  label: string
  hint: string
}>

/**
 * Hand several related issues to ONE task: one agent works through them in
 * one worktree, judging each report on its own and fixing (or planning) the
 * ones that hold up in one change. What the page selected arrives frozen —
 * the issues, the folder and the repository they belong to — and only ever
 * shrinks here: an issue can be taken out of the set (one already handled
 * elsewhere, say), never swapped for another.
 *
 * Same shape as the one-item trigger dialog: the prompt is composed
 * server-side from the snapshots sent, a dedup hit is an answer rather than
 * an error — here naming EVERY issue a live task already holds, with the
 * offer to drop exactly those — and nothing is created until Create.
 */
export function ForgeCombineDialog({
  items,
  remote,
  folderId,
  settings,
  onClose,
  onCreated,
}: {
  /** The selected issues, as the page held them when the dialog opened. */
  items: ForgeIssueRow[]
  remote: ForgeRemote
  folderId: number
  /** The preferences in force for this folder (see `ForgeStartDialog`). */
  settings?: ForgePanelSettings | null
  onClose: () => void
  onCreated: (task: WorkTask, count: number) => void
}) {
  const t = useTranslations("Forge")
  const tTasks = useTranslations("Tasks")
  const tRoot = useTranslations()
  const { setRoute } = useWorkbenchRoute()
  // Frozen at open, in number order — the order the task's prompt walks
  // them in and its title names them.
  const [list, setList] = useState<ForgeIssueRow[]>(() =>
    [...items].sort((a, b) => a.number - b.number)
  )
  const [scenario, setScenario] = useState<ForgeScenarioId>(() =>
    initialScenario(false, settings?.default_issue_scenario)
  )
  const [writeback, setWriteback] = useState(
    () => settings?.writeback_default ?? true
  )
  const [instruction, setInstruction] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conflicts, setConflicts] = useState<ForgeCreateConflict[] | null>(null)
  const enough = list.length >= 2
  const conflicting = useMemo(
    () => new Set((conflicts ?? []).map((c) => c.number)),
    [conflicts]
  )

  const remove = (numbers: Set<number>) => {
    setList((held) => held.filter((row) => !numbers.has(row.number)))
    setConflicts(null)
    setError(null)
  }

  const submit = async (force: boolean) => {
    if (!enough) return
    setSubmitting(true)
    setError(null)
    try {
      const result = await workTaskCreateFromForgeIssues({
        folder_id: folderId,
        source: {
          provider: remote.provider,
          server_host: remote.server_host,
          owner_repo: remote.owner_repo,
        },
        items: list.map((row) => ({
          number: row.number,
          snapshot: {
            title: row.title,
            // CNB's list rows carry no description; the server reads each
            // issue's body itself before composing the prompt.
            body: row.body,
            labels: row.labels.map((l) => l.name),
            author: row.author,
          },
        })),
        scenario,
        instruction: instruction.trim() || null,
        writeback,
        force,
      })
      switch (result.outcome) {
        case "created":
          onCreated(result.task, list.length)
          return
        case "duplicate":
          setConflicts(result.conflicts)
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
          <DialogTitle>{t("combineTitle", { count: list.length })}</DialogTitle>
          <DialogDescription>
            {t("combineDescription", {
              repo: `${remote.server_host}/${remote.owner_repo}`,
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-w-0 flex-col gap-2.5">
          {/* The set itself, capped in height: a dozen issues must not push
              the decisions below it off screen. */}
          <ul
            aria-label={t("combineItemsLabel")}
            className="max-h-44 divide-y divide-border/60 overflow-y-auto rounded-xl border border-border"
          >
            {list.map((row) => {
              const { Icon, className: glyphClass, labelKey } = stateGlyph(row)
              const clash = conflicts?.find((c) => c.number === row.number)
              return (
                <li
                  key={row.number}
                  className={cn(
                    "flex min-w-0 items-center gap-2 px-3 py-1.5 text-xs",
                    clash && "bg-amber-500/10"
                  )}
                >
                  <Icon
                    role="img"
                    aria-label={t(labelKey)}
                    className={cn("size-3.5 shrink-0", glyphClass)}
                  />
                  <span className="shrink-0 font-mono text-muted-foreground">
                    #{row.number}
                  </span>
                  <span className="min-w-0 flex-1 truncate" title={row.title}>
                    {row.title}
                  </span>
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label={t("combineRemoveItem", { number: row.number })}
                    title={t("combineRemoveItem", { number: row.number })}
                    disabled={submitting}
                    onClick={() => remove(new Set([row.number]))}
                    className="shrink-0 text-muted-foreground"
                  >
                    <X className="size-3" />
                  </Button>
                </li>
              )
            })}
          </ul>

          {conflicts == null ? (
            <SettingCard>
              <RadioGroup
                value={scenario}
                onValueChange={(v) => setScenario(v as ForgeScenarioId)}
                aria-label={t("scenarioLabel")}
                className="gap-0 divide-y divide-border/60"
              >
                {COMBINE_SCENARIOS.map((option) => (
                  <label
                    key={option.id}
                    htmlFor={`forge-combine-scenario-${option.id}`}
                    className={cn(
                      "flex cursor-pointer items-start gap-2.5 p-3 transition-colors",
                      scenario === option.id
                        ? "bg-primary/5"
                        : "hover:bg-muted/60"
                    )}
                  >
                    <RadioGroupItem
                      id={`forge-combine-scenario-${option.id}`}
                      value={option.id}
                      className="mt-1"
                    />
                    <span className="flex flex-col gap-1">
                      <span className="text-sm font-medium leading-none">
                        {t(option.label)}
                      </span>
                      <span className="text-xs leading-5 text-muted-foreground">
                        {t(option.hint)}
                      </span>
                    </span>
                  </label>
                ))}
              </RadioGroup>
              <SettingRow
                icon={MessageSquare}
                title={t("combineWritebackLabel")}
                description={t("combineWritebackHint")}
                htmlFor="forge-combine-writeback"
                control={
                  <Switch
                    id="forge-combine-writeback"
                    checked={writeback}
                    onCheckedChange={setWriteback}
                  />
                }
              />
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
          ) : (
            <div className="rounded-md border border-border/60 bg-muted/40 p-3 text-sm">
              <p>{t("combineConflictsBody")}</p>
              <ul className="mt-1.5 flex flex-col gap-1 text-xs text-muted-foreground">
                {conflicts.map((c) => (
                  <li key={c.number}>
                    {t("combineConflictItem", {
                      number: c.number,
                      title: c.existing.title,
                      status: tTasks(statusLabelKey(c.existing.status)),
                    })}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {enough ? null : (
            <p className="text-xs text-muted-foreground">
              {t("combineTooFew")}
            </p>
          )}
        </div>

        {error != null ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          {conflicts == null ? (
            <>
              <Button variant="ghost" onClick={onClose} disabled={submitting}>
                {t("cancel")}
              </Button>
              <Button
                onClick={() => void submit(false)}
                disabled={submitting || !enough}
              >
                {submitting ? t("creating") : t("create")}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                onClick={() => {
                  onClose()
                  setRoute("tasks")
                }}
              >
                {t("viewExisting")}
              </Button>
              <Button
                variant="secondary"
                onClick={() => remove(conflicting)}
                disabled={submitting}
              >
                {t("combineRemoveConflicts")}
              </Button>
              <Button
                variant="secondary"
                onClick={() => void submit(true)}
                disabled={submitting || !enough}
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
