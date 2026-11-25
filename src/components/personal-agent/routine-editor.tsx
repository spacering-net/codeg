"use client"

/**
 * The routine editor (6.9): a routine's name and what it is to do; whether
 * it wakes its assistant or hands out work (and which); when — on a
 * schedule, edited with the automations' cron builder and its next run
 * shown as codeg works it out, or on a coding event; and what it looks at
 * first. A new one runs once as a trial when it is saved. Opened from the
 * activity's routines, a result card's "every week", a card's offer to make
 * a request a routine, a paused routine's card.
 */

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { CronBuilderDialog } from "@/components/automations/cron-builder-dialog"
import { ScheduleLabel } from "@/components/automations/schedule-label"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  automationComputeNextRun,
  personalAgentRoutineSave,
  personalAgentRoutines,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import {
  ROUTINE_EVENT_KINDS,
  type DispatchMode,
  type RoutineDraft,
  type RoutineKind,
  type RoutinePrecheck,
} from "@/lib/types"
import { usePersonalAgent } from "@/contexts/personal-agent-context"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import {
  usePersonalAgentUi,
  type RoutineEditorRequest,
} from "@/stores/personal-agent-ui-store"

const NONE = "__none"

type PrecheckKind = RoutinePrecheck["kind"]
const PRECHECKS: PrecheckKind[] = [
  "none",
  "commits",
  "forge_new",
  "items_waiting",
  "changes",
]

/** The schedules one click away. */
const PRESETS = [
  { key: "presetDaily", cron: "0 9 * * *" },
  { key: "presetWeekdays", cron: "0 9 * * 1-5" },
  { key: "presetWeekly", cron: "0 9 * * 1" },
] as const

function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  } catch {
    return "UTC"
  }
}

interface Form {
  title: string
  what: string
  kind: RoutineKind
  trigger: "schedule" | "event"
  cron: string
  timezone: string
  eventKind: string
  eventProject: string
  eventStates: string
  eventMine: boolean
  eventLabel: string
  eventWhat: "issue" | "pr"
  mode: DispatchMode
  project: string
  deliverable: "change" | "report"
  precheck: PrecheckKind
  checkProject: string
  branch: string
  checkWhat: "issue" | "pr"
  checkLabel: string
  hours: string
}

function formOf(d: RoutineDraft | null): Form {
  const p = d?.precheck
  const projectOf = (v: number | null | undefined) =>
    v != null ? String(v) : NONE
  return {
    title: d?.title ?? "",
    what: d?.what ?? "",
    kind: d?.kind ?? "brain",
    trigger: d?.event ? "event" : "schedule",
    cron: d?.cron ?? "0 9 * * 1-5",
    timezone: d?.timezone ?? "",
    eventKind: d?.event?.kind ?? "dispatch_ended",
    eventProject: projectOf(d?.event?.project_id),
    eventStates: (d?.event?.states ?? []).join(", "),
    eventMine: d?.event?.mine ?? false,
    eventLabel: d?.event?.label ?? "",
    eventWhat: d?.event?.what === "pr" ? "pr" : "issue",
    mode: d?.dispatch?.mode ?? "task",
    project: projectOf(d?.dispatch?.project_id),
    deliverable: d?.dispatch?.deliverable === "report" ? "report" : "change",
    precheck: p?.kind ?? "none",
    checkProject: p && "project_id" in p ? String(p.project_id) : NONE,
    branch: p?.kind === "commits" ? (p.branch ?? "") : "",
    checkWhat: p?.kind === "forge_new" && p.what === "pr" ? "pr" : "issue",
    checkLabel: p?.kind === "forge_new" ? (p.label ?? "") : "",
    hours: p?.kind === "items_waiting" ? String(p.hours) : "24",
  }
}

function idOf(v: string): number | null {
  if (v === NONE || v.trim() === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function draftOf(f: Form): RoutineDraft {
  const precheck: RoutinePrecheck = (() => {
    const project = idOf(f.checkProject) ?? 0
    switch (f.precheck) {
      case "commits":
        return {
          kind: "commits",
          project_id: project,
          branch: f.branch.trim() || null,
        }
      case "forge_new":
        return {
          kind: "forge_new",
          project_id: project,
          what: f.checkWhat,
          label: f.checkLabel.trim() || null,
        }
      case "items_waiting":
        return {
          kind: "items_waiting",
          hours: Math.max(1, Number(f.hours) || 1),
        }
      case "changes":
        return { kind: "changes", project_id: project }
      default:
        return { kind: "none" }
    }
  })()
  return {
    title: f.title.trim(),
    what: f.what.trim(),
    kind: f.kind,
    cron: f.trigger === "schedule" ? f.cron.trim() : null,
    timezone: f.timezone.trim() || "owner",
    event:
      f.trigger === "event"
        ? {
            kind: f.eventKind,
            project_id: idOf(f.eventProject),
            states: f.eventStates
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
            mine: f.eventMine,
            label:
              f.eventKind === "forge_issue"
                ? f.eventLabel.trim() || null
                : null,
            what: f.eventKind === "forge_issue" ? f.eventWhat : null,
          }
        : null,
    dispatch:
      f.kind === "dispatch"
        ? {
            mode: f.mode,
            project_id: f.mode === "chat" ? null : idOf(f.project),
            deliverable: f.mode === "task" ? f.deliverable : null,
          }
        : null,
    precheck,
  }
}

/** The editor, mounted once on the page; the store opens it. */
export function RoutineEditor() {
  const req = usePersonalAgentUi((s) => s.routineEditor)
  const close = usePersonalAgentUi((s) => s.closeRoutineEditor)
  if (!req) return null
  return <EditorDialog key={req.key} req={req} onClose={close} />
}

function EditorDialog({
  req,
  onClose,
}: {
  req: RoutineEditorRequest
  onClose: () => void
}) {
  const t = useTranslations("PersonalAgent.routines.editor")
  const tr = useTranslations("PersonalAgent.routines")
  const ta = useTranslations("Automations")
  const [form, setForm] = useState<Form>(() => formOf(req.draft))
  const [loaded, setLoaded] = useState(req.routineId == null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [builder, setBuilder] = useState(false)
  const [nextRun, setNextRun] = useState<string | null>(null)
  const folders = useAppWorkspaceStore((s) => s.folders)
  const projects = useMemo(
    () => folders.filter((f) => f.kind === "regular" && f.parent_id == null),
    [folders]
  )
  const set = <K extends keyof Form>(k: K, v: Form[K]) =>
    setForm((f) => ({ ...f, [k]: v }))

  // Editing one: its fields as they are now.
  useEffect(() => {
    if (req.routineId == null) return
    let alive = true
    personalAgentRoutines(req.botId)
      .then((list) => {
        const r = list.find((x) => x.id === req.routineId)
        if (!alive) return
        if (r) {
          setForm(
            formOf({
              title: r.title,
              what: r.what,
              kind: r.kind,
              cron: r.cron,
              timezone: r.timezone,
              event: r.event,
              dispatch: r.dispatch,
              precheck: r.precheck,
              ...(req.draft ?? {}),
            })
          )
        }
        setLoaded(true)
      })
      .catch((e) => {
        if (alive) {
          setError(toErrorMessage(e))
          setLoaded(true)
        }
      })
    return () => {
      alive = false
    }
  }, [req.botId, req.routineId, req.draft])

  // The owner's zone, as their preference sets it (`system`: this one's).
  const { snapshot } = usePersonalAgent()
  const pref = snapshot?.account?.prefs?.time_zone
  const ownerZone = pref && pref !== "system" ? pref : browserZone()
  const zone = form.timezone.trim() || ownerZone
  // The next run as codeg works it out.
  useEffect(() => {
    if (form.trigger !== "schedule" || !form.cron.trim()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- cleared alongside the backend's next-run computation below
      setNextRun(null)
      return
    }
    let alive = true
    automationComputeNextRun(form.cron.trim(), zone)
      .then((n) => {
        if (alive) setNextRun(n)
      })
      .catch(() => {
        if (alive) setNextRun(null)
      })
    return () => {
      alive = false
    }
  }, [form.cron, form.trigger, zone])

  const save = async () => {
    if (!form.title.trim()) return setError(t("needTitle"))
    if (!form.what.trim()) return setError(t("needWhat"))
    if (form.trigger === "schedule" && !form.cron.trim())
      return setError(t("needCron"))
    setSaving(true)
    setError(null)
    try {
      await personalAgentRoutineSave(
        req.botId,
        req.routineId,
        draftOf(form),
        req.noticeId
      )
      toast.success(req.routineId == null ? t("made") : t("saved"))
      onClose()
    } catch (e) {
      setError(toErrorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  const projectSelect = (
    value: string,
    onChange: (v: string) => void,
    any: boolean,
    testId: string
  ) => (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-full" data-pa-routine-field={testId}>
        <SelectValue placeholder={t("pickProject")} />
      </SelectTrigger>
      <SelectContent>
        {any ? <SelectItem value={NONE}>{t("anyProject")}</SelectItem> : null}
        {projects.map((p) => (
          <SelectItem key={p.id} value={String(p.id)}>
            {p.alias ?? p.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {req.routineId == null ? t("titleNew") : t("titleEdit")}
          </DialogTitle>
          <DialogDescription>
            {req.routineId == null ? t("trialNote") : t("editNote")}
          </DialogDescription>
        </DialogHeader>
        {!loaded ? null : (
          <div className="flex flex-col gap-4" data-pa-routine-editor>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pa-routine-title">{t("name")}</Label>
              <Input
                id="pa-routine-title"
                value={form.title}
                maxLength={120}
                onChange={(e) => set("title", e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pa-routine-what">{t("what")}</Label>
              <Textarea
                id="pa-routine-what"
                value={form.what}
                rows={4}
                maxLength={4000}
                placeholder={t("whatHint")}
                onChange={(e) => set("what", e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>{t("kind")}</Label>
              <Select
                value={form.kind}
                onValueChange={(v) => set("kind", v as RoutineKind)}
              >
                <SelectTrigger className="w-full" data-pa-routine-field="kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="brain">{t("kindBrain")}</SelectItem>
                  <SelectItem value="dispatch">{t("kindDispatch")}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {form.kind === "brain"
                  ? t("kindBrainHint")
                  : t("kindDispatchHint")}
              </p>
            </div>
            {form.kind === "dispatch" ? (
              <div className="flex flex-col gap-3 rounded-lg border border-border/60 p-3">
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1.5">
                    <Label>{t("mode")}</Label>
                    <Select
                      value={form.mode}
                      onValueChange={(v) => set("mode", v as DispatchMode)}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="task">{t("modeTask")}</SelectItem>
                        <SelectItem value="session">
                          {t("modeSession")}
                        </SelectItem>
                        <SelectItem value="chat">{t("modeChat")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {form.mode === "task" ? (
                    <div className="flex flex-col gap-1.5">
                      <Label>{t("deliverable")}</Label>
                      <Select
                        value={form.deliverable}
                        onValueChange={(v) =>
                          set("deliverable", v as "change" | "report")
                        }
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="change">{t("change")}</SelectItem>
                          <SelectItem value="report">{t("report")}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  ) : null}
                </div>
                {form.mode !== "chat" ? (
                  <div className="flex flex-col gap-1.5">
                    <Label>{t("project")}</Label>
                    {projectSelect(
                      form.project,
                      (v) => set("project", v),
                      false,
                      "project"
                    )}
                  </div>
                ) : null}
              </div>
            ) : null}
            <div className="flex flex-col gap-1.5">
              <Label>{t("when")}</Label>
              <Select
                value={form.trigger}
                onValueChange={(v) => set("trigger", v as "schedule" | "event")}
              >
                <SelectTrigger
                  className="w-full"
                  data-pa-routine-field="trigger"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="schedule">{t("schedule")}</SelectItem>
                  <SelectItem value="event">{t("event")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {form.trigger === "schedule" ? (
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap gap-1.5">
                  {PRESETS.map((p) => (
                    <Button
                      key={p.key}
                      type="button"
                      size="xs"
                      variant={form.cron === p.cron ? "default" : "outline"}
                      onClick={() => set("cron", p.cron)}
                    >
                      {t(p.key)}
                    </Button>
                  ))}
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={() => setBuilder(true)}
                    data-pa-routine-cron-builder
                  >
                    {t("custom")}
                  </Button>
                </div>
                <Input
                  value={form.cron}
                  aria-label={ta("cron")}
                  className="font-mono"
                  onChange={(e) => set("cron", e.target.value)}
                  data-pa-routine-field="cron"
                />
                <p className="text-xs text-muted-foreground">
                  <ScheduleLabel cron={form.cron} />
                  {" · "}
                  {ta("nextRun")}:{" "}
                  {nextRun ? new Date(nextRun).toLocaleString() : "—"}
                </p>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="pa-routine-zone">{t("timezone")}</Label>
                  <Input
                    id="pa-routine-zone"
                    value={form.timezone}
                    placeholder={t("ownerZone", { zone: ownerZone })}
                    onChange={(e) => set("timezone", e.target.value)}
                  />
                </div>
                <CronBuilderDialog
                  open={builder}
                  onOpenChange={setBuilder}
                  cron={form.cron}
                  timezone={zone}
                  onApply={(c) => set("cron", c)}
                />
              </div>
            ) : (
              <div className="flex flex-col gap-3 rounded-lg border border-border/60 p-3">
                <div className="flex flex-col gap-1.5">
                  <Label>{t("eventKind")}</Label>
                  <Select
                    value={form.eventKind}
                    onValueChange={(v) => set("eventKind", v)}
                  >
                    <SelectTrigger
                      className="w-full"
                      data-pa-routine-field="event"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ROUTINE_EVENT_KINDS.map((k) => (
                        <SelectItem key={k} value={k}>
                          {tr(`event.${k}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>{t("project")}</Label>
                  {projectSelect(
                    form.eventProject,
                    (v) => set("eventProject", v),
                    form.eventKind !== "forge_issue",
                    "event-project"
                  )}
                </div>
                {form.eventKind === "forge_issue" ? (
                  <div className="grid grid-cols-2 gap-3">
                    <div className="flex flex-col gap-1.5">
                      <Label>{t("issueOrPr")}</Label>
                      <Select
                        value={form.eventWhat}
                        onValueChange={(v) =>
                          set("eventWhat", v as "issue" | "pr")
                        }
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="issue">{t("issues")}</SelectItem>
                          <SelectItem value="pr">{t("prs")}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="pa-routine-label">{t("label")}</Label>
                      <Input
                        id="pa-routine-label"
                        value={form.eventLabel}
                        onChange={(e) => set("eventLabel", e.target.value)}
                      />
                    </div>
                  </div>
                ) : null}
                {form.eventKind === "dispatch_ended" ||
                form.eventKind === "task_status" ? (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="pa-routine-states">{t("states")}</Label>
                    <Input
                      id="pa-routine-states"
                      value={form.eventStates}
                      placeholder={
                        form.eventKind === "task_status"
                          ? "done, failed"
                          : "completed, failed"
                      }
                      onChange={(e) => set("eventStates", e.target.value)}
                    />
                  </div>
                ) : null}
                {form.eventKind !== "forge_issue" ? (
                  <label className="flex items-center justify-between gap-3">
                    <span className="text-sm">{t("mine")}</span>
                    <Switch
                      checked={form.eventMine}
                      onCheckedChange={(v) => set("eventMine", v)}
                    />
                  </label>
                ) : null}
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <Label>{t("precheck")}</Label>
              <Select
                value={form.precheck}
                onValueChange={(v) => set("precheck", v as PrecheckKind)}
              >
                <SelectTrigger
                  className="w-full"
                  data-pa-routine-field="precheck"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRECHECKS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {t(`check.${k}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {form.precheck === "commits" ||
              form.precheck === "forge_new" ||
              form.precheck === "changes"
                ? projectSelect(
                    form.checkProject,
                    (v) => set("checkProject", v),
                    false,
                    "check-project"
                  )
                : null}
              {form.precheck === "commits" ? (
                <Input
                  value={form.branch}
                  placeholder={t("branch")}
                  aria-label={t("branch")}
                  onChange={(e) => set("branch", e.target.value)}
                />
              ) : null}
              {form.precheck === "forge_new" ? (
                <div className="grid grid-cols-2 gap-3">
                  <Select
                    value={form.checkWhat}
                    onValueChange={(v) => set("checkWhat", v as "issue" | "pr")}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="issue">{t("issues")}</SelectItem>
                      <SelectItem value="pr">{t("prs")}</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input
                    value={form.checkLabel}
                    placeholder={t("label")}
                    aria-label={t("label")}
                    onChange={(e) => set("checkLabel", e.target.value)}
                  />
                </div>
              ) : null}
              {form.precheck === "items_waiting" ? (
                <Input
                  type="number"
                  min={1}
                  value={form.hours}
                  aria-label={t("hours")}
                  onChange={(e) => set("hours", e.target.value)}
                />
              ) : null}
            </div>
            {error ? (
              <p
                className="text-xs break-words text-destructive"
                data-pa-routine-error
              >
                {error}
              </p>
            ) : null}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            disabled={saving || !loaded}
            onClick={() => void save()}
            data-pa-routine-save
          >
            {req.routineId == null ? t("saveRun") : t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
