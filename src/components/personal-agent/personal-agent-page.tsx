"use client"

/**
 * The personal agent's page: the conversation across the whole page — no
 * card inside the page, the column of messages centered — with the input box
 * at its foot, and the side panel (the agent's status, what is open and what
 * was handed out, its numbers) beside it behind a line, or as a drawer on a
 * narrow screen. On the desktop the page draws the window's top band itself
 * (`WorkbenchBand`): the title over the conversation, and the panel, as the
 * workspace's aux panel does, up to the window's top edge with its strip at
 * the band's end. Its
 * actions — settings, the session underneath, compacting, a new session —
 * are in the window chrome's "⋯" menu; the title is its avatar and name,
 * and its state a word after them. The sessions it reaches — its own, and
 * those of the work it handed out — open in a drawer on the right, over the
 * page.
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
  type ReactNode,
} from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { AssistantAvatar } from "@/components/assistants/assistant-avatar"
import { UserRoundStar } from "@/components/icons/user-round-star"
import { ChromeReserve } from "@/components/layout/chrome-reserve"
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
  useWorkbenchBand,
  type WorkbenchBand,
} from "@/components/workbench/workbench-band"
import { WorkbenchPageTitle } from "@/components/workbench/workbench-page-title"
import { usePersonalAgent } from "@/contexts/personal-agent-context"
import { useIsMobile } from "@/hooks/use-mobile"
import { personalAgentKeepalive, personalAgentNewSession } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type { TimelineRow } from "@/lib/types"
import { useAssistants } from "@/stores/assistants-store"
import {
  PERSONAL_AGENT_EVENTS,
  usePersonalAgentUi,
} from "@/stores/personal-agent-ui-store"

import { PersonalAgentAuxPanel } from "./aux-panel"
import { PersonalAgentComposer } from "./composer"
import { usePersonalAgentAttachment } from "./live-turn"
import { MessageList } from "./message-list"
import { replyState } from "./message-items"
import { SettingsView } from "./settings/settings-view"
import { PageScopeContext, useStatusWord, type PageScope } from "./shared"
import { PersonalAgentWorkDrawer } from "./work-drawer"

export { PersonalAgentChromeActions } from "./chrome-actions"

/** While the page is open the agent's session is kept warm: the idle sweep
 *  would otherwise end it between messages, and the next one would wait for
 *  a resume. */
const KEEPALIVE_MS = 30_000

/** The size of the agent's avatar in the title, in px at 100% zoom. */
const TITLE_AVATAR_SIZE = 24

export function PersonalAgentPageTitle() {
  const t = useTranslations("PersonalAgent")
  const { snapshot } = usePersonalAgent()
  const showAux = usePersonalAgentUi((s) => s.showAux)
  const word = useStatusWord()
  const agent = snapshot?.agent ?? null
  const title = agent?.name?.trim() || t("title")
  return (
    <WorkbenchPageTitle
      title={title}
      // The messages carry no avatar of the agent's own: it is here, once.
      leading={
        agent ? (
          <AssistantAvatar
            avatar={agent.avatar}
            name={title}
            size={TITLE_AVATAR_SIZE}
          />
        ) : null
      }
      trail={
        word ? (
          <button
            type="button"
            className="ms-1 shrink-0 rounded-md px-1.5 py-0.5 text-xs leading-none text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
            onClick={() => showAux("status")}
            title={t("statusWord.open")}
            aria-live="polite"
          >
            {word}
          </button>
        ) : null
      }
    />
  )
}

/** The window's top band, when the page draws it (the desktop): the left
 *  corner's slot, the title, and the rest a drag region, as the shell draws
 *  the band for the other pages — over the conversation alone while the
 *  side panel is open, whose strip takes the band's end. */
function PageBand({ band }: { band: WorkbenchBand }) {
  return (
    <div className="flex h-10 shrink-0 items-stretch border-b border-border/50 ws-chrome-border">
      <ChromeReserve width={band.leftCornerWidth} line={false} />
      <PersonalAgentPageTitle />
      <div data-tauri-drag-region className="h-full min-w-0 flex-1" />
    </div>
  )
}

/** A state of the page without its panel (loading, the first setup) under
 *  the band, when the page draws it. */
function UnderBand({
  band,
  children,
}: {
  band: WorkbenchBand | null
  children: ReactNode
}) {
  if (!band) return <>{children}</>
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageBand band={band} />
      <div className="min-h-0 flex-1">{children}</div>
    </div>
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
  const { botId, snapshot, rows, loading } = usePersonalAgent()
  const assistants = useAssistants()
  const isMobile = useIsMobile()
  const band = useWorkbenchBand()
  const auxOpen = usePersonalAgentUi((s) => s.auxOpen)
  const setAuxOpen = usePersonalAgentUi((s) => s.setAuxOpen)
  const setWorkOpen = usePersonalAgentUi((s) => s.setWorkOpen)
  const settingsOpen = usePersonalAgentUi((s) => s.settings != null)
  const openSettings = usePersonalAgentUi((s) => s.openSettings)
  const [sessionOpen, setSessionOpen] = useState(false)
  const [confirmNew, setConfirmNew] = useState(false)
  const [quoting, setQuoting] = useState<number | null>(null)
  const jumpRef = useRef<((rowId: number) => void) | null>(null)
  const sentRef = useRef<(() => void) | null>(null)

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
  const agentName = agent?.name?.trim() || t("title")
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
      jumpTo,
      rowsById,
    }),
    [readOnly, agentName, liveRowId, connectionId, agentType, jumpTo, rowsById]
  )

  if (!snapshot || loading) {
    return (
      <UnderBand band={band}>
        <div className="h-full" />
      </UnderBand>
    )
  }

  if (!agent && settingsOpen) {
    return (
      <UnderBand band={band}>
        <SettingsView />
      </UnderBand>
    )
  }

  if (!agent) {
    return (
      <UnderBand band={band}>
        <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
          <UserRoundStar className="size-8 text-muted-foreground" aria-hidden />
          <h2 className="text-base font-semibold text-foreground">
            {t("setup.title")}
          </h2>
          <p className="max-w-md text-sm text-muted-foreground">
            {t("setup.description")}
          </p>
          {snapshot.status.engine === "here" ? (
            <Button onClick={() => openSettings("identity")}>
              {t("setup.action")}
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground">{t("readOnly")}</p>
          )}
          {/* Executor configs are not the assistant's: someone who only
              @-delegates manages them here too. */}
          <Button
            variant="ghost"
            size="sm"
            data-pa-manage-executors
            onClick={() => openSettings("executors")}
          >
            {t("setup.manageExecutors")}
          </Button>
        </div>
      </UnderBand>
    )
  }

  // Only those the assistants may dispatch to count.
  const noAssistants =
    assistants.filter(
      (a) =>
        a.enabled && snapshot.account?.team.usage[a.uid]?.dispatch !== false
    ).length === 0
  const conversation = settingsOpen ? (
    <div className="flex h-full min-h-0 flex-col">
      {band ? <PageBand band={band} /> : null}
      <div className="min-h-0 flex-1">
        <SettingsView />
      </div>
    </div>
  ) : (
    <div className="flex h-full min-h-0 flex-col">
      {band ? <PageBand band={band} /> : null}
      {readOnly || noAssistants ? (
        <div className="mx-auto flex w-full chat-content-w shrink-0 flex-col gap-1 px-4 pt-2">
          {readOnly ? (
            <p className="rounded-lg bg-amber-500/10 px-3 py-1.5 text-xs text-amber-800 dark:text-amber-200">
              {t("readOnly")}
            </p>
          ) : null}
          {noAssistants ? (
            <p className="flex items-center justify-between gap-2 rounded-lg bg-muted px-3 py-1.5 text-xs text-muted-foreground">
              <span>{t("noAssistants")}</span>
              <Button
                size="xs"
                variant="outline"
                className="shrink-0 bg-background"
                data-pa-add-executor
                onClick={() => openSettings("executors")}
              >
                {t("addExecutor")}
              </Button>
            </p>
          ) : null}
        </div>
      ) : null}
      <MessageList jumpRef={jumpRef} sentRef={sentRef} />
      <PersonalAgentComposer
        agent={agent}
        agentName={agentName}
        status={snapshot.status}
        quoting={quoting}
        onClearQuote={() => setQuoting(null)}
        onSent={() => sentRef.current?.()}
      />
    </div>
  )
  const aux = (
    <PersonalAgentAuxPanel
      snapshot={snapshot}
      inDrawer={isMobile}
      reserve={band?.rightReserve ?? null}
    />
  )

  return (
    <PageScopeContext.Provider value={scope}>
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
              defaultSize={70}
              minSize={45}
            >
              {conversation}
            </ResizablePanel>
            {auxOpen ? (
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
        <Drawer open={auxOpen} onOpenChange={setAuxOpen} swipeDirection="right">
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
    </PageScopeContext.Provider>
  )
}
