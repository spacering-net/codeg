"use client"

/**
 * Getting to know the owner (5.4, 1.15): the native cards the primary's
 * conversation shows once its brain is first picked.
 *
 * - **What to call each other** — a choice card of two questions, one at
 *   a time (the brain's own questions' stepper): what to call the owner and
 *   what to call the assistant. Answered, it folds to one line.
 * - **One thing right away?** — that the assistants keep an eye on the
 *   owner's projects (which ones, the settings say), and whether to find
 *   one thing to help with now: [Find one now] or [Not now]. Nothing to
 *   pick; an account to connect, a project folder to open when there is
 *   none.
 * - **One thing at once** — the first thing it can take off the owner's
 *   hands there: [Hand it to me] sends it as their message, [Another one],
 *   [Not now]; or that nothing needs them and it keeps an eye on it.
 * - **What I'll do on my own** — how much it may disturb them, the switches
 *   of what it does unasked, the preferences and the desktop companion.
 */

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleSlash,
  Compass,
  ExternalLink,
  FolderOpenDot,
  Gauge,
  Handshake,
  KeyRound,
  ListChecks,
  PawPrint,
  Settings2,
  Sparkles,
  type LucideIcon,
} from "lucide-react"
import { toast } from "sonner"

import { WorkspaceFolderDialog } from "@/components/layout/workspace-folder-dialog"
import { SettingCard, SettingRow } from "@/components/shared/setting-card"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { SyncedSpinner } from "@/components/ui/synced-spinner"
import { useBotId, usePersonalAgent } from "@/contexts/personal-agent-context"
import {
  type NoticeAction,
  openSettingsWindow,
  personalAgentChoiceAnswer,
  personalAgentNoticeAct,
  personalAgentStarter,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { openPetWindow } from "@/lib/pet/api"
import { openUrl } from "@/lib/platform"
import { isDesktop } from "@/lib/transport"
import type { PersonalAgentPrefKey, QuestionSpec } from "@/lib/types"
import { cn } from "@/lib/utils"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

import type { MessageItem } from "./message-items"
import { MessageRow } from "./message-row"
import { OutcomeLine } from "./outcome-line"
import { Stepper } from "./question-choice-card"
import {
  DISTURB_PRESETS,
  disturbOf,
  PREF_ICONS,
  PresetPicker,
} from "./settings/pref-pages"
import {
  connectable,
  forgeName,
  useWatchableProjects,
} from "./settings/use-projects"
import { useSettingsPatch } from "./settings/use-settings"
import {
  CardMessage,
  num,
  SheetActions,
  SheetField,
  SheetFields,
  SheetNote,
  SheetPart,
  str,
  usePageScope,
} from "./shared"

type NoticeItem = Extract<MessageItem, { kind: "notice" }>

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null
}

/** A native card of its own — no bubble round it — its heading the top
 *  line of its first band; an answer that did not go through its last. */
function MeetFrame({
  item,
  icon: Icon,
  heading,
  text,
  error = null,
  children,
}: {
  item: NoticeItem
  icon: LucideIcon
  heading: string
  text: string
  /** An answer that did not go through: the card's last band. */
  error?: string | null
  /** Its parts (`SheetPart`, `SheetActions`). */
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
      <CardMessage
        data-pa-notice={str(row.data, "state") ?? "open"}
        data-pa-meet={str(row.data, "purpose") ?? str(row.data, "notice")}
        head={
          <>
            <Icon aria-hidden />
            <span className="font-medium">{heading}</span>
          </>
        }
      >
        {children}
        <Failed error={error} />
      </CardMessage>
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
    <SheetNote>
      <p role="alert" className="break-words text-destructive">
        {error}
      </p>
    </SheetNote>
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
        <SheetPart>
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
        </SheetPart>
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
      <CardMessage
        data-pa-notice={state}
        data-pa-meet="meet"
        head={
          <>
            <Handshake aria-hidden />
            <span className="font-medium">{t("heading")}</span>
          </>
        }
      >
        <SheetPart className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => setUnfolded((u) => !u)}
            aria-expanded={unfolded}
            className="flex w-full items-start gap-1.5 rounded-sm text-start text-sm leading-5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            data-pa-choice-answered
          >
            {state === "skipped" ? (
              <CircleSlash
                className="mt-[0.1875rem] size-3.5 shrink-0 text-muted-foreground"
                aria-hidden
              />
            ) : (
              <CircleCheck
                className="mt-[0.1875rem] size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
                aria-hidden
              />
            )}
            <span className="min-w-0 flex-1 break-words">{line}</span>
            {unfolded ? (
              <ChevronDown
                className="mt-[0.1875rem] size-3.5 shrink-0 text-muted-foreground"
                aria-hidden
              />
            ) : (
              <ChevronRight
                className="mt-[0.1875rem] size-3.5 shrink-0 text-muted-foreground rtl:rotate-180"
                aria-hidden
              />
            )}
          </button>
          {unfolded ? (
            <SheetFields className="ps-5">
              <SheetField label={t("call")}>{call ?? "—"}</SheetField>
              <SheetField label={t("name")}>{name}</SheetField>
            </SheetFields>
          ) : null}
        </SheetPart>
      </CardMessage>
    </MessageRow>
  )
}

// ── 2. one thing right away? ───────────────────────────────────────────────

/** "Shall I find one thing right away?" — nothing to pick: the assistants
 *  watch the owner's projects (every one, unless they picked some in the
 *  settings), with a way there, an account to connect for a public forge
 *  with none, and a project folder to open when there is none. */
export function ConnectCard({ item }: { item: NoticeItem }) {
  const t = useTranslations("PersonalAgent.meet.connect")
  const { readOnly } = usePageScope()
  const botId = useBotId()
  const { snapshot } = usePersonalAgent()
  const openSettings = usePersonalAgentUi((s) => s.openSettings)
  const row = item.row
  const data = row.data ?? {}
  const state = str(data, "state") ?? "open"
  const open = state === "open"
  const noticeId = Number(row.ref_id)
  const projects = useWatchableProjects(open)
  const [folderDialog, setFolderDialog] = useState(false)
  const { busy, failed, act, setBusy, setFailed } = useAct(noticeId)
  const scope = snapshot?.account?.prefs.projects ?? "all"
  const watched =
    projects?.filter((p) => scope === "all" || scope.includes(p.id)) ?? []
  const none = projects != null && projects.length === 0
  // The first project watched on a public forge with no account: its forge
  // names the hint.
  const unconnected = watched.map((p) => p.forge).find(connectable)
  const about = none
    ? t("noProjects")
    : scope === "all"
      ? t("about")
      : t("aboutOnly")

  const go = async () => {
    if (busy) return
    setBusy("go")
    setFailed(null)
    try {
      await personalAgentStarter(noticeId, botId)
    } catch (e) {
      setFailed(toErrorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  // A card answered when the projects were still picked on it.
  const connected = Array.isArray(data.projects)
    ? (data.projects as Array<{ name?: unknown }>)
        .map((p) => (typeof p.name === "string" ? p.name : ""))
        .filter(Boolean)
    : []
  const settled =
    state === "connected"
      ? connected.length > 0
        ? t("connected", { projects: connected.join(t("joiner")) })
        : t("went")
      : t("skipped")

  return (
    <MeetFrame
      item={item}
      icon={Compass}
      heading={t("heading")}
      text={[about, t("ask")].join("\n")}
      error={failed}
    >
      <SheetPart className="flex flex-col gap-1.5">
        <div className="space-y-1.5" data-pa-meet-about>
          <p>{about}</p>
          {open ? <p className="font-medium">{t("ask")}</p> : null}
        </div>
        {open ? null : (
          <OutcomeLine
            tone={state === "connected" ? "done" : "off"}
            data-pa-meet-settled
          >
            {settled}
          </OutcomeLine>
        )}
      </SheetPart>
      {open ? (
        <>
          <SheetPart className="flex flex-col gap-1.5 text-xs text-muted-foreground">
            <p data-pa-meet-settings-hint>
              {t("settingsHint")}{" "}
              <button
                type="button"
                className="rounded-sm font-medium text-foreground underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                onClick={() => openSettings("projects")}
                data-pa-meet-settings
              >
                {t("settings")}
              </button>
            </p>
            {unconnected ? (
              <div
                className="flex items-center justify-between gap-2"
                data-pa-meet-account-hint
              >
                <span className="min-w-0">
                  {t("accountHint", { forge: forgeName(unconnected.provider) })}
                </span>
                <Button
                  size="xs"
                  variant="secondary"
                  disabled={readOnly}
                  data-pa-meet-connect-account
                  onClick={() =>
                    void openSettingsWindow("version-control").catch((e) =>
                      setFailed(toErrorMessage(e))
                    )
                  }
                >
                  <KeyRound aria-hidden />
                  {t("connectAccount")}
                </Button>
              </div>
            ) : null}
          </SheetPart>
          <SheetActions>
            <Button
              size="sm"
              disabled={readOnly || busy != null}
              onClick={() => void go()}
              data-pa-meet-go
            >
              {busy === "go" ? (
                <SyncedSpinner small className="size-3.5" />
              ) : null}
              {t("go")}
            </Button>
            {none ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={readOnly}
                onClick={() => setFolderDialog(true)}
                data-pa-meet-open-folder
              >
                <FolderOpenDot aria-hidden />
                {t("openFolder")}
              </Button>
            ) : null}
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
              {t("notNow")}
            </Button>
            <WorkspaceFolderDialog
              open={folderDialog}
              onOpenChange={setFolderDialog}
            />
          </SheetActions>
        </>
      ) : null}
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
      error={failed}
    >
      {state === "looking" ? (
        <SheetPart>
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <SyncedSpinner small className="size-3.5" />
            {t("looking")}
          </p>
        </SheetPart>
      ) : state === "none" ? (
        <SheetPart>
          <p className="text-sm">{seen > 0 ? t("noMore") : t("none")}</p>
        </SheetPart>
      ) : (
        <>
          {/* The lead, and where it is. */}
          <SheetPart className="flex flex-col items-start gap-1">
            {state === "handed" || state === "dismissed" ? (
              <OutcomeLine
                tone={state === "handed" ? "done" : "off"}
                className="text-sm"
                data-pa-starter-lead
              >
                {state === "handed"
                  ? t("handed", { what: words?.line ?? row.body })
                  : t("dismissed", { what: words?.line ?? row.body })}
              </OutcomeLine>
            ) : (
              <p
                className="text-sm leading-5 font-medium break-words"
                data-pa-starter-lead
              >
                {words?.line ?? row.body}
              </p>
            )}
            {url ? (
              <button
                type="button"
                onClick={() => void openUrl(url)}
                className="inline-flex max-w-full items-center gap-1 rounded-sm font-mono text-[0.6875rem] text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                dir="ltr"
              >
                <ExternalLink className="size-3 shrink-0" aria-hidden />
                <span className="truncate">{url}</span>
              </button>
            ) : null}
          </SheetPart>
          {state === "found" ? (
            <SheetActions>
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
                variant="secondary"
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
            </SheetActions>
          ) : null}
        </>
      )}
    </MeetFrame>
  )
}

// ── 4. what I'll do on my own ──────────────────────────────────────────────

/** The switches of what the assistants do unasked, each a preference and
 *  the values it is turned on and off by. Anything but off is on: a wrap-up
 *  that asks first is still a wrap-up. */
export const PROMISES: ReadonlyArray<{
  key: PersonalAgentPrefKey
  on: string
  off: string
}> = [
  { key: "proactive", on: "on", off: "off" },
  { key: "brief", on: "on", off: "off" },
  { key: "wrap", on: "auto", off: "off" },
  { key: "exec_questions", on: "assistant", off: "owner" },
  { key: "exec_plans", on: "assistant", off: "owner" },
  { key: "followups", on: "auto", off: "ask" },
  { key: "ci_failure", on: "fix", off: "tell" },
  { key: "auto_accept", on: "on", off: "off" },
  { key: "interrupt_retry", on: "auto", off: "ask" },
  { key: "presence", on: "on", off: "off" },
]

/** A settings group as a band of the card: no frame or wash of its own,
 *  its rows the card's room from its edge, a hairline between them. */
const FLAT_GROUP = "rounded-none border-0 bg-transparent"

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
  const { patch, busy: patching } = useSettingsPatch(null)
  const { busy, failed, act } = useAct(Number(row.ref_id))
  const [unfolded, setUnfolded] = useState(false)
  // The switches, folded till asked for: ten rows is a long card.
  const [listOpen, setListOpen] = useState(false)
  const desktop = isDesktop()
  const disabled = readOnly || account == null

  const summon = useCallback(() => {
    openPetWindow().catch((e) => {
      toast.error(t("petFailed"), { description: toErrorMessage(e) })
    })
  }, [t])

  const level = account ? disturbOf(account) : "standard"
  const promisesOn = account
    ? PROMISES.filter(
        ({ key, off }) => (account.prefs[key] as unknown as string) !== off
      ).length
    : 0
  const done = state === "done"
  // One card, as the settings write it — how much it may disturb, then the
  // switches of what it does unasked (each a row, a hairline between, the
  // switch at its end), then its buttons: the ways on — the preferences,
  // the desktop companion — secondary, [Done] at the end.
  const groups = account ? (
    <>
      <SettingCard
        className={cn(FLAT_GROUP, "[&>*]:px-3.5")}
        data-pa-surface
        data-pa-meet-level
      >
        <PresetPicker
          item="disturb_level"
          levels={["quiet", "standard", "more"] as const}
          level={level}
          presets={DISTURB_PRESETS}
          prefs={account.prefs}
          icon={Gauge}
          disabled={disabled}
          stacked
          onPick={(l) => void patch([{ key: "prefs.disturb_level", value: l }])}
        />
      </SettingCard>
      <SettingCard className={FLAT_GROUP} data-pa-surface data-pa-meet-promises>
        {/* The switches folded under a line of how many are on: the same
            line, in the same place, open or not. */}
        <button
          type="button"
          onClick={() => setListOpen((o) => !o)}
          aria-expanded={listOpen}
          className="flex w-full items-center gap-2 px-3.5 py-3 text-start text-sm leading-5 transition-colors outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          data-pa-meet-promises-toggle
        >
          <ListChecks
            className="size-4 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <span className="min-w-0 flex-1">
            {t("list", { on: promisesOn, total: PROMISES.length })}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {listOpen ? t("listHide") : t("listShow")}
          </span>
          <ChevronDown
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              !listOpen && "-rotate-90 rtl:rotate-90"
            )}
            aria-hidden
          />
        </button>
        {listOpen
          ? PROMISES.map(({ key, on, off }) => {
              const id = `pa-meet-promise-${row.id}-${key}`
              const value = account.prefs[key] as unknown as string
              return (
                <div key={key} data-pa-promise={key}>
                  <SettingRow
                    className="px-3.5"
                    icon={PREF_ICONS[key]}
                    title={t(`items.${key}.title` as "items.proactive.title")}
                    description={t(
                      `items.${key}.hint` as "items.proactive.hint"
                    )}
                    htmlFor={id}
                    control={
                      <Switch
                        id={id}
                        checked={value !== off}
                        disabled={disabled || patching != null}
                        onCheckedChange={(checked) =>
                          void patch([
                            { key: `prefs.${key}`, value: checked ? on : off },
                          ])
                        }
                      />
                    }
                  />
                </div>
              )
            })
          : null}
      </SettingCard>
      <SheetActions data-pa-meet-actions>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => openSettings("proactive")}
          data-pa-meet-prefs
        >
          <Settings2 aria-hidden />
          {t("prefs")}
        </Button>
        {desktop ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={summon}
            data-pa-meet-pet
          >
            <PawPrint aria-hidden />
            {t("pet")}
          </Button>
        ) : null}
        {!done ? (
          <Button
            size="sm"
            className="ms-auto min-w-20"
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
      </SheetActions>
    </>
  ) : (
    <SheetPart>
      <p className="text-xs text-muted-foreground">{t("unavailable")}</p>
    </SheetPart>
  )

  return (
    <MeetFrame
      item={item}
      icon={Sparkles}
      heading={t("heading")}
      text={t("heading")}
      error={failed}
    >
      {done && !unfolded ? (
        <SheetPart>
          <button
            type="button"
            onClick={() => setUnfolded(true)}
            className="flex w-full items-start gap-1.5 rounded-sm text-start text-sm leading-5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            data-pa-meet-folded
          >
            <CircleCheck
              className="mt-[0.1875rem] size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
              aria-hidden
            />
            <span className="min-w-0 flex-1 break-words">
              {t("folded", {
                level: tLevel(
                  `disturb_level.${level}` as "disturb_level.standard"
                ),
              })}
            </span>
            <ChevronRight
              className="mt-[0.1875rem] size-3.5 shrink-0 text-muted-foreground rtl:rotate-180"
              aria-hidden
            />
          </button>
        </SheetPart>
      ) : (
        <>
          <SheetPart>
            {done ? (
              <button
                type="button"
                onClick={() => setUnfolded(false)}
                className="flex items-center gap-1.5 rounded-sm text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <ChevronDown className="size-3.5" aria-hidden />
                {t("collapse")}
              </button>
            ) : (
              <p className="text-sm leading-5">{t("intro")}</p>
            )}
          </SheetPart>
          {groups}
        </>
      )}
    </MeetFrame>
  )
}
