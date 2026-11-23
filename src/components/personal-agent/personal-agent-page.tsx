"use client"

/**
 * The personal agent's page: the conversation across the whole page — no
 * card inside the page, the column of messages centered — with the input box
 * at its foot, and the side panel (who it is, what it is about, what it made
 * and handed out, its numbers) beside it behind a line, or as a drawer on a
 * narrow screen. Under the window's top band, as the other full pages are:
 * the band's title is its avatar and name — a capsule that lists the
 * assistants to switch to — and its state a word after them; the settings
 * every assistant shares are a button in the window chrome, by the panel's
 * toggle, and what acts on the assistant itself — the session underneath,
 * compacting, a new session — is in the "⋯" by its face on the panel. The
 * assistants are listed on the workspace's sidebar ("Personal assistants");
 * the capsule lists them too, for a collapsed sidebar or a phone. The
 * sessions it reaches — its own, and those of the work it handed out —
 * open in a drawer on the right, over the page.
 *
 * In place of the conversation, two pages, the side panel standing aside
 * while either is open: the assistant's own page, and the preferences every
 * assistant shares, across the whole page.
 *
 * Switching assistants: the capsule names the one picked at once, a
 * spinner for its chevron, while the page goes on showing the last one —
 * not to act on, faded a little and a thin bar running along its top once
 * the read takes a moment (`SwitchVeil`); then the new one's conversation
 * comes in at its bottom. One read ahead (the pointer resting on its row)
 * or shown lately switches at once. Before an assistant's conversation is
 * read at all, the page is its shape (`ConversationSkeleton`).
 *
 * A workbench route, so the workspace's providers (the live connection store,
 * the assistants) are all there.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react"
import { useTranslations } from "next-intl"
import { ChevronDown } from "lucide-react"
import { toast } from "sonner"

import { SessionLinkOpenerContext } from "@/components/ai-elements/session-link-opener"
import { LiveTranscriptView } from "@/components/message/live-transcript-view"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { SyncedSpinner } from "@/components/ui/synced-spinner"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
  SIDE_PANEL_CONTENT_CLASS,
} from "@/components/ui/drawer"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { WorkbenchPageTitle } from "@/components/workbench/workbench-page-title"
import {
  usePersonalAgent,
  usePersonalAgentSwitch,
} from "@/contexts/personal-agent-context"
import { useAcpAgents } from "@/hooks/use-acp-agents"
import { useIsMobile } from "@/hooks/use-mobile"
import { personalAgentKeepalive, personalAgentNewSession } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type { TimelineRow } from "@/lib/types"
import { cn } from "@/lib/utils"
import { usePersonalAgentRoster } from "@/stores/personal-agent-roster-store"
import { usePaAccent } from "@/lib/personal-agent-accent"
import {
  PERSONAL_AGENT_EVENTS,
  usePersonalAgentUi,
} from "@/stores/personal-agent-ui-store"

import { BotAvatar } from "./bot-avatar"
import {
  HistorySearchButton,
  PersonalAgentHistorySearch,
} from "./history-search"
import { PersonalAgentAuxPanel } from "./aux-panel"
import {
  PersonalAgentRoster,
  useRosterDialogs,
  useRosterUpkeep,
  type RosterDialogs,
} from "./roster"
import { PersonalAgentComposer } from "./composer"
import { usePersonalAgentAttachment } from "./live-turn"
import { MessageList } from "./message-list"
import { replyState } from "./message-items"
import { BotPage } from "./settings/bot-page"
import { IdentityPage } from "./settings/identity-page"
import { SettingsView } from "./settings/settings-view"
import {
  PageScopeContext,
  useBotLook,
  useBotName,
  useStatusWord,
  type PageScope,
} from "./shared"
import { useSessionLinkOpener } from "./session-link"
import { PersonalAgentWorkDrawer } from "./work-drawer"
import { RoutineEditor } from "./routine-editor"
import { StatusLine } from "./status-line"
import { useAssistantShortcuts } from "./use-assistant-shortcuts"

export { PersonalAgentChromeActions } from "./chrome-actions"

/** While the page is open the agent's session is kept warm: the idle sweep
 *  would otherwise end it between messages, and the next one would wait for
 *  a resume. */
const KEEPALIVE_MS = 30_000

/** The size of the agent's avatar in the title's capsule, in px at 100%
 *  zoom (10.6). */
const TITLE_AVATAR_SIZE = 18

/**
 * What the page draws while another assistant is read: the one it showed,
 * not to act on, faded a little once the read takes a moment (a quick one
 * never flickers), with a thin bar running along its top (`bar`). Its own
 * component, reading the switch alone: marking it re-renders this, the page
 * passed in as it was drawn.
 */
function SwitchVeil({
  bar = false,
  className,
  children,
  ...rest
}: ComponentProps<"div"> & { bar?: boolean }) {
  const { switching } = usePersonalAgentSwitch()
  return (
    <div
      {...rest}
      data-pa-switch-veil
      data-pa-switching={switching || undefined}
      inert={switching || undefined}
      className={cn("relative", className)}
    >
      {bar && switching ? (
        <div aria-hidden data-pa-switch-bar>
          <span />
        </div>
      ) : null}
      {children}
    </div>
  )
}

/** Bubbles' shapes, the newest at the foot: a conversation, waiting. */
const SKELETON_BUBBLES: readonly { end: boolean; w: string; h: string }[] = [
  { end: false, w: "62%", h: "4.5rem" },
  { end: true, w: "38%", h: "2.5rem" },
  { end: false, w: "74%", h: "6rem" },
  { end: true, w: "30%", h: "2.5rem" },
  { end: false, w: "56%", h: "3.5rem" },
]

/** The page before an assistant's conversation is read: its column, the
 *  shapes of a few bubbles breathing, coming in only once the read takes
 *  a moment. */
function ConversationSkeleton() {
  const t = useTranslations("PersonalAgent.timeline")
  return (
    <div
      role="status"
      aria-label={t("loading")}
      data-pa-skeleton
      className="pa-delayed-in flex h-full min-h-0 flex-col"
    >
      <div className="mx-auto flex w-full min-h-0 chat-content-w flex-1 flex-col justify-end gap-4 overflow-hidden px-4 pb-8">
        {SKELETON_BUBBLES.map((b, i) => (
          <div
            key={i}
            className={cn(
              "shrink-0 rounded-2xl bg-muted motion-safe:animate-pulse",
              b.end ? "self-end" : "self-start"
            )}
            style={{ width: b.w, height: b.h }}
          />
        ))}
      </div>
      <div className="mx-auto w-full shrink-0 chat-content-w px-4 pb-4">
        <div className="h-24 rounded-3xl border border-border/70 bg-muted/40" />
      </div>
    </div>
  )
}

export function PersonalAgentPageTitle() {
  const t = useTranslations("PersonalAgent")
  const { snapshot, botId } = usePersonalAgent()
  const showAux = usePersonalAgentUi((s) => s.showAux)
  const word = useStatusWord()
  const botName = useBotName()
  // Switching, or shown before it is read: the one picked, at once — its
  // face and name from the roster — with a spinner for the chevron while it
  // is read.
  const { switching, to } = usePersonalAgentSwitch()
  const reading = switching || snapshot == null
  const pickedId = switching ? to : botId
  const picked = usePersonalAgentRoster((s) =>
    reading
      ? (s.entries?.find((e) =>
          pickedId == null ? e.kind === "primary" : e.id === pickedId
        ) ?? null)
      : null
  )
  const shown = snapshot?.agent ?? null
  const agent = picked ?? shown
  const title = picked ? botName(picked) : shown?.name?.trim() || t("title")
  const look = useBotLook(agent?.id ?? null)
  const readOnly = snapshot?.status.engine !== "here"
  // The roster in a popover under the capsule. Its dialogs are kept here,
  // the popover closing as one opens.
  const [rosterOpen, setRosterOpen] = useState(false)
  const rosterDialogs = useRosterDialogs()
  const dialogs = useMemo<RosterDialogs>(() => {
    const closing =
      <A extends unknown[]>(open: (...args: A) => void) =>
      (...args: A) => {
        setRosterOpen(false)
        open(...args)
      }
    const api = rosterDialogs.api
    return {
      add: closing(api.add),
      remove: closing(api.remove),
      group: closing(api.group),
    }
  }, [rosterDialogs.api])
  return (
    <WorkbenchPageTitle
      title=""
      // The messages carry no avatar of the agent's own: it is here, once,
      // with its name, as a capsule that lists the assistants to switch to.
      leading={
        agent ? (
          <>
            <Popover open={rosterOpen} onOpenChange={setRosterOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  data-pa-title-capsule
                  data-pa-face-host
                  aria-busy={picked != null || undefined}
                  title={
                    picked
                      ? t("bots.roster.opening", { name: title })
                      : t("bots.roster.switch")
                  }
                  className="flex min-w-0 items-center gap-1.5 rounded-full border border-border/70 bg-background/60 py-0.5 ps-1 pe-2 text-[0.8125rem] font-semibold transition-colors hover:bg-foreground/10 aria-expanded:bg-foreground/10"
                >
                  <BotAvatar
                    avatar={agent.avatar}
                    name={title}
                    size={TITLE_AVATAR_SIZE}
                    look={look}
                  />
                  <span className="min-w-0 truncate">{title}</span>
                  {picked ? (
                    <span data-pa-title-opening className="flex shrink-0">
                      <SyncedSpinner
                        small
                        className="size-3.5 text-muted-foreground"
                      />
                    </span>
                  ) : (
                    <ChevronDown
                      aria-hidden
                      className="size-3.5 shrink-0 text-muted-foreground"
                    />
                  )}
                </button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                sideOffset={6}
                data-pa-roster-pop
                className="max-h-[min(34rem,var(--radix-popover-content-available-height))] w-72 gap-0 overflow-hidden p-0"
              >
                <PersonalAgentRoster
                  variant="popover"
                  readOnly={readOnly}
                  dialogs={dialogs}
                  onPick={() => setRosterOpen(false)}
                />
              </PopoverContent>
            </Popover>
            {rosterDialogs.node}
          </>
        ) : (
          <span className="truncate text-[0.8125rem] font-semibold">
            {title}
          </span>
        )
      }
      trail={
        <>
          {/* Its state, a word: how it runs is in the panel's numbers. */}
          {word ? (
            <button
              type="button"
              className="ms-1 shrink-0 rounded-md px-1.5 py-0.5 text-xs leading-none text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
              onClick={() => showAux("stats")}
              title={t("statusWord.open")}
              aria-live="polite"
            >
              {word}
            </button>
          ) : null}
          {/* The time machine (8.2). */}
          {agent ? <HistorySearchButton /> : null}
        </>
      }
    />
  )
}

/** The reply row the turn in flight writes into. */
function liveRowOf(
  rows: readonly TimelineRow[],
  snapshotRow: number | null
): number | null {
  if (snapshotRow != null) return snapshotRow
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]
    if (r.kind === "reply" && replyState(r) === "running") return r.id
  }
  return null
}

export function PersonalAgentPage() {
  const t = useTranslations("PersonalAgent")
  // ⌘1–9, ⌥↑/⌥↓, Ctrl+Tab switch assistants while this page is current.
  useAssistantShortcuts()
  // Session links in its replies open their conversations.
  const openSession = useSessionLinkOpener()
  const { botId, snapshot, rows, loading } = usePersonalAgent()
  const { agents: acpAgents } = useAcpAgents()
  const isMobile = useIsMobile()
  const auxOpen = usePersonalAgentUi((s) => s.auxOpen)
  const setAuxOpen = usePersonalAgentUi((s) => s.setAuxOpen)
  const setWorkOpen = usePersonalAgentUi((s) => s.setWorkOpen)
  const settingsOpen = usePersonalAgentUi((s) => s.settings != null)
  const botPageOpen = usePersonalAgentUi((s) => s.botPage != null)
  const openBotPage = usePersonalAgentUi((s) => s.openBotPage)
  // A page over the conversation: the panel stands aside for it.
  const pageOver = settingsOpen || botPageOpen
  const [sessionOpen, setSessionOpen] = useState(false)
  const [confirmNew, setConfirmNew] = useState(false)
  const [quoting, setQuoting] = useState<number | null>(null)
  // A card's message the owner wants to edit first (9.2): into the
  // composer, quoting the card.
  const [draft, setDraft] = useState<{ text: string; n: number } | null>(null)
  const onDraft = useCallback((rowId: number, text: string) => {
    setQuoting(rowId)
    setDraft((d) => ({ text, n: (d?.n ?? 0) + 1 }))
  }, [])
  const jumpRef = useRef<((rowId: number) => void) | null>(null)
  const sentRef = useRef<(() => void) | null>(null)
  // Another assistant shown in the same frame: a quote or a draft meant for
  // the last one is not this one's.
  const [shownBot, setShownBot] = useState(botId)
  if (shownBot !== botId) {
    setShownBot(botId)
    setQuoting(null)
    setDraft(null)
  }

  // A narrow screen opens on the conversation, its panel a drawer away.
  useEffect(() => {
    if (isMobile) setAuxOpen(false)
  }, [isMobile, setAuxOpen])

  // The work drawer is the page's: coming back opens the page, not it.
  useEffect(() => () => setWorkOpen(false), [setWorkOpen])

  useEffect(() => {
    const openSession = () => setSessionOpen(true)
    const newSession = () => setConfirmNew(true)
    window.addEventListener(PERSONAL_AGENT_EVENTS.openSession, openSession)
    window.addEventListener(PERSONAL_AGENT_EVENTS.newSession, newSession)
    return () => {
      window.removeEventListener(PERSONAL_AGENT_EVENTS.openSession, openSession)
      window.removeEventListener(PERSONAL_AGENT_EVENTS.newSession, newSession)
    }
  }, [])

  const status = snapshot?.status ?? null
  const agent = snapshot?.agent ?? null
  const connectionId = status?.connection_id ?? null
  const segment = status?.segment ?? null
  const agentType = segment?.agent_type ?? agent?.agent_type ?? null
  usePersonalAgentAttachment(connectionId, agentType)

  useEffect(() => {
    if (status?.engine !== "here") return
    void personalAgentKeepalive(botId).catch(() => {})
    const timer = setInterval(() => {
      void personalAgentKeepalive(botId).catch(() => {})
    }, KEEPALIVE_MS)
    return () => clearInterval(timer)
  }, [status?.engine, botId])

  const readOnly = status?.engine !== "here"
  // The roster's upkeep, drawn or not; drawn as a column only when the
  // owner keeps it shown (the title's capsule lists them either way).
  useRosterUpkeep(readOnly)
  const agentName = agent?.name?.trim() || t("title")
  // Its face's colour, which the owner's bubbles take; with "follow the
  // assistant's colour" on, the theme's colour in its conversation too
  // (10.7).
  const [accent] = usePaAccent()
  const faceColor = agent?.avatar?.kind === "face" ? agent.avatar.color : null
  const liveRowId = liveRowOf(rows, status?.live_reply?.row_id ?? null)
  const rowsById = useMemo(() => {
    const m = new Map<number, TimelineRow>()
    for (const r of rows) m.set(r.id, r)
    return m
  }, [rows])
  const jumpTo = useCallback((id: number) => jumpRef.current?.(id), [])
  const scope = useMemo<PageScope>(
    () => ({
      readOnly,
      agentName,
      liveRowId,
      connectionId,
      agentType,
      onQuote: setQuoting,
      onDraft,
      jumpTo,
      rowsById,
    }),
    [
      readOnly,
      agentName,
      liveRowId,
      connectionId,
      agentType,
      onDraft,
      jumpTo,
      rowsById,
    ]
  )

  // Whose conversation this window shows the owner: the presence beat
  // says so, and that assistant is not notified (1.13).
  const setViewing = usePersonalAgentUi((s) => s.setViewing)
  const viewingId = !pageOver && !loading ? (agent?.id ?? null) : null
  useEffect(() => {
    setViewing(viewingId)
  }, [viewingId, setViewing])
  useEffect(() => () => setViewing(null), [setViewing])

  // A notification followed here: its row, once the page is on its
  // assistant and its conversation is drawn.
  const pendingJump = usePersonalAgentUi((s) => s.pendingJump)
  const agentId = agent?.id ?? null
  useEffect(() => {
    if (!pendingJump || loading || pageOver) return
    if (agentId == null || pendingJump.bot !== agentId) return
    usePersonalAgentUi.getState().setPendingJump(null)
    jumpTo(pendingJump.row)
  }, [pendingJump, agentId, loading, pageOver, jumpTo])

  // Read for the first time, or switched to before it was read: the shape of
  // a conversation, waiting.
  if (!snapshot || loading) return <ConversationSkeleton />

  if (!agent && settingsOpen) return <SettingsView />
  // The first setup: its own screen, whatever page was asked for — its face,
  // its name and its agent, and on to its conversation.
  if (!agent) {
    return (
      <IdentityPage
        key="setup"
        agent={null}
        bot={null}
        disabled={snapshot.status.engine !== "here"}
      />
    )
  }

  // One converted from the collaboration settings before there was a
  // primary: it can be @-mentioned in conversations, not talked to, until
  // the primary is set up and its brain copied to it (D3).
  if (agent.agent_type === null && !settingsOpen && !botPageOpen) {
    return <NoBrainYet name={agentName} />
  }

  // The agent its own work runs on cannot run — not there any more, not
  // installed, or turned off: it cannot do work itself until another is
  // picked.
  const workInfo = agent.work
    ? acpAgents.find((a) => a.agent_type === agent.work?.agent_type)
    : undefined
  const workOff =
    acpAgents.length > 0 &&
    (agent.work == null ||
      !(
        workInfo?.enabled &&
        workInfo.available &&
        workInfo.installed_version != null
      ))
  const conversation = settingsOpen ? (
    <SettingsView />
  ) : (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1">
        {botPageOpen ? (
          <div className="flex min-w-0 flex-1 flex-col">
            <BotPage />
          </div>
        ) : (
          <SwitchVeil
            bar
            className="flex min-w-0 flex-1 flex-col"
            data-pa-face={faceColor ?? undefined}
            data-pa-accent={
              (accent === "bot" && faceColor != null) || undefined
            }
          >
            {readOnly || workOff ? (
              <div className="mx-auto flex w-full chat-content-w shrink-0 flex-col gap-1 px-4 pt-2">
                {readOnly ? (
                  <p className="rounded-lg bg-amber-500/10 px-3 py-1.5 text-xs text-amber-800 dark:text-amber-200">
                    {t("readOnly")}
                  </p>
                ) : null}
                {workOff ? (
                  <p
                    className="flex items-center justify-between gap-2 rounded-lg bg-muted px-3 py-1.5 text-xs text-muted-foreground"
                    data-pa-work-off
                  >
                    <span>
                      {t("workOff", {
                        agent: agent.work?.label_snapshot.agent ?? "",
                      })}
                    </span>
                    <Button
                      size="xs"
                      variant="outline"
                      className="shrink-0 bg-background"
                      data-pa-set-work
                      onClick={() => openBotPage("identity")}
                    >
                      {t("setWork")}
                    </Button>
                  </p>
                ) : null}
              </div>
            ) : null}
            <MessageList jumpRef={jumpRef} sentRef={sentRef} />
            <StatusLine botId={agent.id} name={agentName} />
            <PersonalAgentComposer
              // Each assistant's own box: what is being written, sent or
              // uploaded for one never lands in another's.
              key={agent.id}
              agent={agent}
              agentName={agentName}
              status={snapshot.status}
              quoting={quoting}
              draft={draft}
              onClearQuote={() => setQuoting(null)}
              onSent={() => sentRef.current?.()}
            />
          </SwitchVeil>
        )}
      </div>
    </div>
  )
  const aux = (
    <SwitchVeil className="h-full">
      <PersonalAgentAuxPanel snapshot={snapshot} inDrawer={isMobile} />
    </SwitchVeil>
  )

  return (
    <PageScopeContext.Provider value={scope}>
      <SessionLinkOpenerContext.Provider value={openSession}>
        <div data-pa-page className="flex h-full min-h-0">
          {isMobile ? (
            <div className="min-w-0 flex-1">{conversation}</div>
          ) : (
            <ResizablePanelGroup
              direction="horizontal"
              className="min-h-0 flex-1"
            >
              <ResizablePanel
                id="personal-agent-main"
                order={1}
                // Alone — the panel closed, or a page over the
                // conversation — the whole width: the group warns of a
                // layout short of 100%.
                defaultSize={auxOpen && !pageOver ? 70 : 100}
                minSize={45}
              >
                {conversation}
              </ResizablePanel>
              {auxOpen && !pageOver ? (
                <>
                  <ResizableHandle />
                  <ResizablePanel
                    id="personal-agent-aux"
                    order={2}
                    defaultSize={30}
                    minSize={22}
                  >
                    {aux}
                  </ResizablePanel>
                </>
              ) : null}
            </ResizablePanelGroup>
          )}
        </div>
        {isMobile ? (
          <Drawer
            open={auxOpen && !pageOver}
            onOpenChange={setAuxOpen}
            swipeDirection="right"
          >
            <DrawerContent
              closeButtonClassName="top-2.5 right-3"
              className={SIDE_PANEL_CONTENT_CLASS}
            >
              <DrawerTitle className="sr-only">{t("aux.title")}</DrawerTitle>
              <DrawerDescription className="sr-only">
                {t("aux.title")}
              </DrawerDescription>
              {aux}
            </DrawerContent>
          </Drawer>
        ) : null}
        <PersonalAgentWorkDrawer />
        <RoutineEditor />
        <PersonalAgentHistorySearch />
        <AlertDialog open={confirmNew} onOpenChange={setConfirmNew}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("newSession.title")}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("newSession.description")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("newSession.cancel")}</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  personalAgentNewSession(botId)
                    .then(() => toast.message(t("newSession.queued")))
                    .catch((e) => toast.error(toErrorMessage(e)))
                }}
              >
                {t("newSession.confirm")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        {segment?.conversation_id != null && agentType ? (
          <Drawer
            open={sessionOpen}
            onOpenChange={setSessionOpen}
            swipeDirection="right"
          >
            <DrawerContent
              closeButtonClassName="top-2.5 right-3"
              className={SIDE_PANEL_CONTENT_CLASS}
            >
              <DrawerTitle className="sr-only">{t("viewSession")}</DrawerTitle>
              <DrawerDescription className="sr-only">
                {t("viewSessionHint")}
              </DrawerDescription>
              {sessionOpen ? (
                <div className="flex h-full min-h-0 flex-col">
                  <div className="border-b border-border px-4 py-2.5 pr-12 text-sm font-semibold">
                    {t("sessionTitle", { seq: segment.seq })}
                  </div>
                  <LiveTranscriptView
                    conversationId={segment.conversation_id}
                    connectionId={connectionId}
                    agentType={agentType}
                  />
                </div>
              ) : null}
            </DrawerContent>
          </Drawer>
        ) : null}
      </SessionLinkOpenerContext.Provider>
    </PageScopeContext.Provider>
  )
}

/** The page of an assistant with no brain yet (D3): what it is, and the
 *  way to the primary's first setup — which gives it a brain. */
function NoBrainYet({ name }: { name: string }) {
  const t = useTranslations("PersonalAgent.noBrain")
  const setViewBot = usePersonalAgentUi((s) => s.setViewBot)
  return (
    <div
      className="flex h-full min-h-0 flex-col items-center justify-center gap-3 px-6 text-center"
      data-pa-no-brain
    >
      <p className="text-base font-medium">{t("title", { name })}</p>
      <p className="max-w-md text-sm leading-6 text-muted-foreground">
        {t("body")}
      </p>
      <Button
        size="sm"
        onClick={() => {
          // The primary's page is its first setup while there is none.
          setViewBot(null)
          usePersonalAgentUi.getState().showConversation()
        }}
        data-pa-no-brain-setup
      >
        {t("setUp")}
      </Button>
    </div>
  )
}
