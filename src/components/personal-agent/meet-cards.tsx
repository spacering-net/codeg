"use client"

/**
 * Getting to know the owner (5.4, 1.15): the native cards the primary's
 * conversation shows once its brain is first picked.
 *
 * - **What to call each other** — a choice card of two questions, one at
 *   a time (the brain's own questions' stepper): what to call the owner and
 *   what to call the assistant. Answered, it folds to one line.
 * - **The projects** — two lines about what it does, then the projects
 *   codeg has to tick, a way to open another and to connect a forge account
 *   for one whose forge has none; [Connect] or [Skip].
 * - **One thing at once** — the first thing it can take off the owner's
 *   hands there: [Hand it to me] sends it as their message, [Another one],
 *   [Not now]; or that nothing needs them and it keeps an eye on it.
 * - **What I'll do on my own** — how much it may disturb them, the switches
 *   of what it does unasked, [Build a team], the preferences and the
 *   desktop companion.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ChevronDown,
  ChevronRight,
  Compass,
  ExternalLink,
  FolderOpenDot,
  Gauge,
  Handshake,
  KeyRound,
  Settings2,
  Sparkles,
  Users,
  type LucideIcon,
} from "lucide-react"
import { toast } from "sonner"

import { WorkspaceFolderDialog } from "@/components/layout/workspace-folder-dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Switch } from "@/components/ui/switch"
import { SyncedSpinner } from "@/components/ui/synced-spinner"
import { useBotId, usePersonalAgent } from "@/contexts/personal-agent-context"
import {
  type NoticeAction,
  openSettingsWindow,
  personalAgentChoiceAnswer,
  personalAgentMeetProjects,
  personalAgentNoticeAct,
  personalAgentStarter,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { openPetWindow } from "@/lib/pet/api"
import { openUrl } from "@/lib/platform"
import { isDesktop } from "@/lib/transport"
import type {
  PersonalAgentMeetProject,
  PersonalAgentPrefKey,
  QuestionSpec,
} from "@/lib/types"
import { cn } from "@/lib/utils"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

import type { MessageItem } from "./message-items"
import { bubbleCorners, MessageRow } from "./message-row"
import { Stepper } from "./question-choice-card"
import { DISTURB_PRESETS, disturbOf, PresetPicker } from "./settings/pref-pages"
import { useSettingsPatch } from "./settings/use-settings"
import { AGENT_SURFACE, num, str, usePageScope } from "./shared"

type NoticeItem = Extract<MessageItem, { kind: "notice" }>

/** Projects ticked to begin with: the most recent ones whose forge has an
 *  account. */
const PRESELECT = 3

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null
}

/** A native card's bubble, with its heading. */
function MeetFrame({
  item,
  icon: Icon,
  heading,
  text,
  children,
}: {
  item: NoticeItem
  icon: LucideIcon
  heading: string
  text: string
  children: React.ReactNode
}) {
  const row = item.row
  return (
    <MessageRow
      rowId={row.id}
      side="start"
      gap={item.gap}
      tail={item.tail}
      roomy
      actions={{ rowId: row.id, text, at: row.created_at }}
    >
      <div
        data-bubble
        data-pa-notice={str(row.data, "state") ?? "open"}
        data-pa-meet={str(row.data, "purpose") ?? str(row.data, "notice")}
        className={cn(
          AGENT_SURFACE,
          bubbleCorners("start", item.tail),
          "min-w-0 p-3 text-sm text-foreground"
        )}
      >
        <p className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Icon className="size-3.5 shrink-0" aria-hidden />
          <span className="font-medium">{heading}</span>
        </p>
        {children}
      </div>
    </MessageRow>
  )
}

/** Answer a card; the error to show when the answer did not go through. */
function useAct(noticeId: number) {
  const botId = useBotId()
  const [busy, setBusy] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const act = async (action: NoticeAction, text?: string) => {
    if (!Number.isFinite(noticeId) || busy) return
    setBusy(action)
    setFailed(null)
    try {
      await personalAgentNoticeAct(noticeId, action, botId, text)
    } catch (e) {
      setFailed(toErrorMessage(e))
    } finally {
      setBusy(null)
    }
  }
  return { busy, failed, act, setBusy, setFailed }
}

function Failed({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="mt-2 text-xs break-words text-destructive">
      {error}
    </p>
  ) : null
}

// ── 1. what to call each other ─────────────────────────────────────────────

export function MeetNameCard({ item }: { item: NoticeItem }) {
  const t = useTranslations("PersonalAgent.meet.name")
  const tPage = useTranslations("PersonalAgent")
  const { readOnly } = usePageScope()
  const botId = useBotId()
  const row = item.row
  const data = row.data ?? {}
  const state = str(data, "state") ?? "open"
  const owner = str(data, "owner")
  const offeredName = str(data, "name") || tPage("title")
  const noticeId = Number(row.ref_id)
  const [unfolded, setUnfolded] = useState(false)
  const questions: QuestionSpec[] = [
    {
      id: "call",
      question: t("call"),
      header: "",
      multi_select: false,
      options: owner ? [{ label: owner, description: t("systemUser") }] : [],
    },
    {
      id: "name",
      question: t("name"),
      header: "",
      multi_select: false,
      options: [{ label: offeredName, description: t("currentName") }],
    },
  ]

  if (state === "open") {
    return (
      <MeetFrame
        item={item}
        icon={Handshake}
        heading={t("heading")}
        text={row.body}
      >
        <Stepper
          questions={questions}
          disabled={readOnly}
          onAnswer={async (picks) => {
            await personalAgentChoiceAnswer(
              noticeId,
              {
                answers: picks.map((p) =>
                  p.text.trim() ? { text: p.text.trim() } : { key: p.keys[0] }
                ),
              },
              botId
            )
          }}
          onSkip={async () => {
            await personalAgentChoiceAnswer(noticeId, { answers: [] }, botId)
          }}
        />
      </MeetFrame>
    )
  }

  const answer = obj(data.answer)
  const call = str(answer, "call")
  const name = str(answer, "name") || offeredName
  const line =
    state === "skipped"
      ? t("skipped")
      : call
        ? t("answered", { call, name })
        : t("answeredName", { name })
  return (
    <MessageRow
      rowId={row.id}
      side="start"
      gap={item.gap}
      tail={item.tail}
      roomy
      actions={{ rowId: row.id, text: line, at: row.created_at }}
    >
      <div
        data-bubble
        data-pa-notice={state}
        data-pa-meet="meet"
        className={cn(
          AGENT_SURFACE,
          bubbleCorners("start", item.tail),
          "min-w-0 p-3 text-sm text-foreground"
        )}
      >
        <button
          type="button"
          onClick={() => setUnfolded((u) => !u)}
          aria-expanded={unfolded}
          className="flex w-full items-center gap-1.5 text-start text-sm"
          data-pa-choice-answered
        >
          {unfolded ? (
            <ChevronDown
              className="size-3.5 shrink-0 text-muted-foreground"
              aria-hidden
            />
          ) : (
            <ChevronRight
              className="size-3.5 shrink-0 text-muted-foreground rtl:rotate-180"
              aria-hidden
            />
          )}
          <span className="min-w-0 flex-1 break-words">{line}</span>
        </button>
        {unfolded ? (
          <dl className="mt-2 space-y-1 text-xs text-muted-foreground">
            <div>
              <dt className="inline">{t("call")} </dt>
              <dd className="inline text-foreground">{call ?? "—"}</dd>
            </div>
            <div>
              <dt className="inline">{t("name")} </dt>
              <dd className="inline text-foreground">{name}</dd>
            </div>
          </dl>
        ) : null}
      </div>
    </MessageRow>
  )
}

// ── 2. the projects ────────────────────────────────────────────────────────

/** The projects card's list, read again when codeg's folders change and
 *  when the window comes back (an account may have been connected). */
function useMeetProjects(active: boolean) {
  const [projects, setProjects] = useState<PersonalAgentMeetProject[] | null>(
    null
  )
  const folders = useAppWorkspaceStore((s) => s.folders)
  const folderKey = useMemo(
    () =>
      folders
        .filter((f) => f.parent_id == null && f.kind === "regular")
        .map((f) => f.id)
        .join(","),
    [folders]
  )
  const [asked, setAsked] = useState(0)
  useEffect(() => {
    if (!active) return
    let live = true
    personalAgentMeetProjects()
      .then((list) => {
        if (live) setProjects(list)
      })
      .catch(() => {
        if (live) setProjects((p) => p ?? [])
      })
    return () => {
      live = false
    }
  }, [active, folderKey, asked])
  useEffect(() => {
    if (!active) return
    const again = () => setAsked((n) => n + 1)
    window.addEventListener("focus", again)
    return () => window.removeEventListener("focus", again)
  }, [active])
  return projects
}

const PROVIDER_NAME: Record<string, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  gitea: "Gitea",
  cnb: "CNB",
}

export function ConnectCard({ item }: { item: NoticeItem }) {
  const t = useTranslations("PersonalAgent.meet.connect")
  const { readOnly } = usePageScope()
  const botId = useBotId()
  const row = item.row
  const data = row.data ?? {}
  const state = str(data, "state") ?? "open"
  const open = state === "open"
  const noticeId = Number(row.ref_id)
  const projects = useMeetProjects(open)
  const [picked, setPicked] = useState<Set<number> | null>(null)
  const [folderDialog, setFolderDialog] = useState(false)
  const { busy, failed, act, setBusy, setFailed } = useAct(noticeId)

  // Ticked to begin with, once the list first arrives.
  useEffect(() => {
    if (picked != null || projects == null) return
    const withAccount = projects.filter((p) => p.account).slice(0, PRESELECT)
    setPicked(
      new Set(
        (withAccount.length > 0 ? withAccount : projects.slice(0, 1)).map(
          (p) => p.id
        )
      )
    )
  }, [projects, picked])
  const chosen = picked ?? new Set<number>()
  const listed = new Set(projects?.map((p) => p.id) ?? [])
  const ids = [...chosen].filter((id) => listed.has(id))

  const connect = async () => {
    if (busy || ids.length === 0) return
    setBusy("connect")
    setFailed(null)
    try {
      await personalAgentStarter(noticeId, ids, botId)
    } catch (e) {
      setFailed(toErrorMessage(e))
    } finally {
      setBusy(null)
    }
  }
  const toggle = (id: number) =>
    setPicked((p) => {
      const next = new Set(p ?? [])
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const connected = Array.isArray(data.projects)
    ? (data.projects as Array<{ name?: unknown }>)
        .map((p) => (typeof p.name === "string" ? p.name : ""))
        .filter(Boolean)
    : []

  return (
    <MeetFrame
      item={item}
      icon={Compass}
      heading={t("heading")}
      text={[t("about1"), t("about2"), t("prompt")].join("\n")}
    >
      <div className="space-y-1.5" data-pa-meet-about>
        <p>{t("about1")}</p>
        <p>{t("about2")}</p>
      </div>
      {open ? (
        <>
          <p className="mt-3 mb-2 text-sm font-medium">{t("prompt")}</p>
          {projects == null ? (
            <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
              <SyncedSpinner small className="size-3.5" />
              {t("loading")}
            </div>
          ) : projects.length === 0 ? (
            <p className="py-1 text-xs text-muted-foreground">{t("none")}</p>
          ) : (
            <ul className="flex flex-col gap-1" data-pa-meet-projects>
              {projects.map((p) => {
                const id = `pa-meet-project-${row.id}-${p.id}`
                return (
                  <li
                    key={p.id}
                    data-pa-meet-project={p.id}
                    className="flex items-center gap-2 rounded-lg border border-border/70 bg-background px-3 py-1.5"
                  >
                    <Checkbox
                      id={id}
                      checked={chosen.has(p.id)}
                      disabled={readOnly || busy != null}
                      onCheckedChange={() => toggle(p.id)}
                    />
                    <label
                      htmlFor={id}
                      className="min-w-0 flex-1 cursor-pointer"
                    >
                      <span className="block truncate text-sm">{p.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {p.provider
                          ? p.account
                            ? t("onForge", {
                                forge: PROVIDER_NAME[p.provider] ?? p.provider,
                              })
                            : t("noAccount", {
                                forge: PROVIDER_NAME[p.provider] ?? p.provider,
                              })
                          : t("noForge")}
                      </span>
                    </label>
                    {p.provider && !p.account ? (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={readOnly}
                        data-pa-meet-connect-account
                        onClick={() =>
                          void openSettingsWindow("version-control").catch(
                            (e) => setFailed(toErrorMessage(e))
                          )
                        }
                      >
                        <KeyRound aria-hidden />
                        {t("connectAccount")}
                      </Button>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          )}
          <p className="mt-2 text-xs text-muted-foreground">{t("skipHint")}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={readOnly || busy != null || ids.length === 0}
              onClick={() => void connect()}
              data-pa-meet-connect
            >
              {busy === "connect" ? (
                <SyncedSpinner small className="size-3.5" />
              ) : null}
              {t("connect", { count: ids.length })}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={readOnly}
              onClick={() => setFolderDialog(true)}
              data-pa-meet-open-folder
            >
              <FolderOpenDot aria-hidden />
              {t("openFolder")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={readOnly || busy != null}
              onClick={() => void act("skip")}
              data-pa-meet-skip
            >
              {busy === "skip" ? (
                <SyncedSpinner small className="size-3.5" />
              ) : null}
              {t("skip")}
            </Button>
          </div>
          <WorkspaceFolderDialog
            open={folderDialog}
            onOpenChange={setFolderDialog}
          />
        </>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground" data-pa-meet-settled>
          {state === "connected"
            ? t("connected", { projects: connected.join(t("joiner")) })
            : t("skipped")}
        </p>
      )}
      <Failed error={failed} />
    </MeetFrame>
  )
}

// ── 3. one thing at once ───────────────────────────────────────────────────

type LeadWords = (
  key: string,
  values?: Record<string, string | number>
) => string

/** A lead as the card says it, and as [Hand it to me] says it. */
export function leadText(
  lead: Record<string, unknown> | null,
  t: LeadWords
): { line: string; hand: string } | null {
  if (!lead) return null
  const kind = str(lead, "kind") ?? ""
  const project = str(obj(lead.project), "name") ?? ""
  const values: Record<string, string | number> = {
    project,
    number: num(lead, "number") ?? 0,
    title: str(lead, "title") ?? "",
    url: str(lead, "url") ?? "",
    path: str(lead, "path") ?? "",
    task: num(lead, "task_id") ?? 0,
    checks: Array.isArray(lead.checks)
      ? (lead.checks as unknown[])
          .filter((c) => typeof c === "string")
          .join(", ")
      : "",
  }
  if (!["pr_ci", "review", "issue", "task", "worktree"].includes(kind)) {
    return null
  }
  return {
    line: t(`lead.${kind}`, values),
    hand: t(`hand.${kind}`, values),
  }
}

export function StarterCard({ item }: { item: NoticeItem }) {
  const t = useTranslations("PersonalAgent.meet.starter")
  const { readOnly } = usePageScope()
  const row = item.row
  const data = row.data ?? {}
  const state = str(data, "state") ?? "looking"
  const lead = obj(data.lead)
  const words = leadText(lead, t as unknown as LeadWords)
  const seen = Array.isArray(data.seen) ? data.seen.length : 0
  const url = str(lead, "url")
  const { busy, failed, act } = useAct(Number(row.ref_id))

  const heading =
    state === "looking"
      ? t("lookingHeading")
      : state === "none"
        ? t("noneHeading")
        : t("heading")
  return (
    <MeetFrame
      item={item}
      icon={Sparkles}
      heading={heading}
      text={words?.line ?? row.body}
    >
      {state === "looking" ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <SyncedSpinner small className="size-3.5" />
          {t("looking")}
        </p>
      ) : state === "none" ? (
        <p className="text-sm">{seen > 0 ? t("noMore") : t("none")}</p>
      ) : (
        <>
          <p className="text-sm break-words" data-pa-starter-lead>
            {state === "handed"
              ? t("handed", { what: words?.line ?? row.body })
              : state === "dismissed"
                ? t("dismissed", { what: words?.line ?? row.body })
                : (words?.line ?? row.body)}
          </p>
          {url ? (
            <button
              type="button"
              onClick={() => void openUrl(url)}
              className="mt-1 inline-flex max-w-full items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <ExternalLink className="size-3 shrink-0" aria-hidden />
              <span className="truncate">{url}</span>
            </button>
          ) : null}
          {state === "found" ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                disabled={readOnly || busy != null}
                onClick={() => void act("hand", words?.hand)}
                data-pa-starter-hand
              >
                {busy === "hand" ? (
                  <SyncedSpinner small className="size-3.5" />
                ) : null}
                {t("handIt")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={readOnly || busy != null}
                onClick={() => void act("next")}
                data-pa-starter-next
              >
                {busy === "next" ? (
                  <SyncedSpinner small className="size-3.5" />
                ) : null}
                {t("next")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={readOnly || busy != null}
                onClick={() => void act("dismiss")}
                data-pa-starter-dismiss
              >
                {t("notNow")}
              </Button>
            </div>
          ) : null}
        </>
      )}
      <Failed error={failed} />
    </MeetFrame>
  )
}

// ── 4. what I'll do on my own ──────────────────────────────────────────────

/** The switches of what the assistants do unasked, each a preference and
 *  its two values: on, off. */
export const PROMISES: ReadonlyArray<{
  key: PersonalAgentPrefKey
  on: string
  off: string
}> = [
  { key: "proactive", on: "on", off: "off" },
  { key: "exec_questions", on: "assistant", off: "owner" },
  { key: "exec_plans", on: "assistant", off: "owner" },
  { key: "followups", on: "auto", off: "ask" },
  { key: "interrupt_retry", on: "auto", off: "ask" },
  { key: "presence", on: "on", off: "off" },
]

export function PromisesCard({ item }: { item: NoticeItem }) {
  const t = useTranslations("PersonalAgent.meet.promises")
  const tLevel = useTranslations("PersonalAgent.settings.prefs")
  const { readOnly } = usePageScope()
  const { snapshot } = usePersonalAgent()
  const openSettings = usePersonalAgentUi((s) => s.openSettings)
  const account = snapshot?.account ?? null
  const row = item.row
  const data = row.data ?? {}
  const state = str(data, "state") ?? "open"
  const suggested = typeof data.team === "number"
  const { patch, busy: patching } = useSettingsPatch(null)
  const { busy, failed, act } = useAct(Number(row.ref_id))
  const [unfolded, setUnfolded] = useState(false)
  const desktop = isDesktop()
  const disabled = readOnly || account == null

  const summon = useCallback(() => {
    openPetWindow().catch((e) => {
      toast.error(t("petFailed"), { description: toErrorMessage(e) })
    })
  }, [t])

  const level = account ? disturbOf(account) : "standard"
  const done = state === "done"
  const body = account ? (
    <>
      <div className="-mx-3" data-pa-meet-level>
        <PresetPicker
          item="disturb_level"
          levels={["quiet", "standard", "more"] as const}
          level={level}
          presets={DISTURB_PRESETS}
          prefs={account.prefs}
          icon={Gauge}
          disabled={disabled}
          onPick={(l) => void patch([{ key: "prefs.disturb_level", value: l }])}
        />
      </div>
      <ul
        className="mt-1 flex flex-col divide-y divide-border/60"
        data-pa-meet-promises
      >
        {PROMISES.map(({ key, on, off }) => {
          const id = `pa-meet-promise-${row.id}-${key}`
          const value = account.prefs[key] as unknown as string
          return (
            <li
              key={key}
              className="flex items-start gap-3 py-2"
              data-pa-promise={key}
            >
              <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
                <span className="block text-sm">
                  {t(`items.${key}.title` as "items.proactive.title")}
                </span>
                <span className="block text-xs leading-5 text-muted-foreground">
                  {t(`items.${key}.hint` as "items.proactive.hint")}
                </span>
              </label>
              <Switch
                id={id}
                checked={value === on}
                disabled={disabled || patching != null}
                onCheckedChange={(checked) =>
                  void patch([
                    { key: `prefs.${key}`, value: checked ? on : off },
                  ])
                }
              />
            </li>
          )
        })}
      </ul>
      <p className="mt-1 text-xs text-muted-foreground">{t("later")}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={readOnly || busy != null || suggested}
          onClick={() => void act("team")}
          data-pa-meet-team
        >
          {busy === "team" ? (
            <SyncedSpinner small className="size-3.5" />
          ) : (
            <Users aria-hidden />
          )}
          {suggested ? t("teamSuggested") : t("team")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => openSettings("proactive")}
          data-pa-meet-prefs
        >
          <Settings2 aria-hidden />
          {t("prefs")}
        </Button>
        {desktop ? (
          <Button size="sm" variant="outline" onClick={summon} data-pa-meet-pet>
            {t("pet")}
          </Button>
        ) : null}
        {!done ? (
          <Button
            size="sm"
            disabled={readOnly || busy != null}
            onClick={() => void act("done")}
            data-pa-meet-done
          >
            {busy === "done" ? (
              <SyncedSpinner small className="size-3.5" />
            ) : null}
            {t("done")}
          </Button>
        ) : null}
      </div>
    </>
  ) : (
    <p className="text-xs text-muted-foreground">{t("unavailable")}</p>
  )

  return (
    <MeetFrame
      item={item}
      icon={Sparkles}
      heading={t("heading")}
      text={t("heading")}
    >
      {done && !unfolded ? (
        <button
          type="button"
          onClick={() => setUnfolded(true)}
          className="flex w-full items-center gap-1.5 text-start text-sm"
          data-pa-meet-folded
        >
          <ChevronRight
            className="size-3.5 shrink-0 text-muted-foreground rtl:rotate-180"
            aria-hidden
          />
          <span className="min-w-0 flex-1 break-words">
            {t("folded", {
              level: tLevel(
                `disturb_level.${level}` as "disturb_level.standard"
              ),
            })}
          </span>
        </button>
      ) : (
        <>
          {done ? (
            <button
              type="button"
              onClick={() => setUnfolded(false)}
              className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground"
            >
              <ChevronDown className="size-3.5" aria-hidden />
              {t("collapse")}
            </button>
          ) : (
            <p className="mb-1 text-sm">{t("intro")}</p>
          )}
          {body}
        </>
      )}
      <Failed error={failed} />
    </MeetFrame>
  )
}
