"use client"

/**
 * The personal agent's page: the timeline with the input box on the left, the
 * status / dispatches / open matters / data panel on the right, and its
 * settings in a dialog. A workbench route, so the workspace's providers (the
 * live connection store, the assistants) are all there.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Eye, Settings2, Sparkles } from "lucide-react"

import { LiveTranscriptView } from "@/components/message/live-transcript-view"
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
import type { WorkbenchChromeActionsProps } from "@/components/workbench/workbench-content"
import { WorkbenchPageTitle } from "@/components/workbench/workbench-page-title"
import { usePersonalAgent } from "@/contexts/personal-agent-context"
import { personalAgentKeepalive } from "@/lib/api"
import { useAssistants } from "@/stores/assistants-store"

import { PersonalAgentAuxPanel, type AuxTab } from "./aux-panel"
import { PersonalAgentComposer } from "./composer"
import { LiveTurn, usePersonalAgentAttachment } from "./live-turn"
import {
  PersonalAgentSettingsDialog,
  type SettingsTab,
} from "./settings-dialog"
import { TimelineView } from "./timeline"

/** Asks the open page to show its settings (the gear lives in the window
 *  chrome, a different branch of the tree). */
export const OPEN_PERSONAL_AGENT_SETTINGS_EVENT =
  "codeg:open-personal-agent-settings"

/** While the page is open the agent's session is kept warm: the idle sweep
 *  would otherwise end it between messages, and the next one would wait for
 *  a resume. */
const KEEPALIVE_MS = 30_000

export function PersonalAgentPageTitle() {
  const t = useTranslations("PersonalAgent")
  const { snapshot } = usePersonalAgent()
  const name = snapshot?.agent?.name?.trim()
  return <WorkbenchPageTitle title={name || t("title")} />
}

export function PersonalAgentChromeActions({
  buttonClassName,
  iconClassName,
}: WorkbenchChromeActionsProps) {
  const t = useTranslations("PersonalAgent")
  return (
    <Button
      variant="ghost"
      size="icon"
      className={buttonClassName}
      title={t("settingsButton")}
      aria-label={t("settingsButton")}
      onClick={() =>
        window.dispatchEvent(new Event(OPEN_PERSONAL_AGENT_SETTINGS_EVENT))
      }
    >
      <Settings2 className={iconClassName} />
    </Button>
  )
}

export function PersonalAgentPage() {
  const t = useTranslations("PersonalAgent")
  const { snapshot, rows, hasOlder, loadOlder, loading } = usePersonalAgent()
  const assistants = useAssistants()
  const [auxTab, setAuxTab] = useState<AuxTab>("status")
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("brain")
  const [sessionOpen, setSessionOpen] = useState(false)

  useEffect(() => {
    const open = () => {
      setSettingsTab("brain")
      setSettingsOpen(true)
    }
    window.addEventListener(OPEN_PERSONAL_AGENT_SETTINGS_EVENT, open)
    return () =>
      window.removeEventListener(OPEN_PERSONAL_AGENT_SETTINGS_EVENT, open)
  }, [])

  const status = snapshot?.status ?? null
  const agent = snapshot?.agent ?? null
  const connectionId = status?.connection_id ?? null
  const segment = status?.segment ?? null
  const agentType = segment?.agent_type ?? agent?.agent_type ?? null
  usePersonalAgentAttachment(connectionId, agentType)

  useEffect(() => {
    if (status?.engine !== "here") return
    void personalAgentKeepalive().catch(() => {})
    const timer = setInterval(() => {
      void personalAgentKeepalive().catch(() => {})
    }, KEEPALIVE_MS)
    return () => clearInterval(timer)
  }, [status?.engine])

  if (!snapshot || loading) {
    return <div className="h-full" />
  }

  if (!agent) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <Sparkles className="size-8 text-muted-foreground" aria-hidden />
        <h2 className="text-base font-semibold text-foreground">
          {t("setup.title")}
        </h2>
        <p className="max-w-md text-sm text-muted-foreground">
          {t("setup.description")}
        </p>
        {snapshot.status.engine === "here" ? (
          <Button
            onClick={() => {
              setSettingsTab("brain")
              setSettingsOpen(true)
            }}
          >
            {t("setup.action")}
          </Button>
        ) : (
          <p className="text-xs text-muted-foreground">{t("readOnly")}</p>
        )}
        <PersonalAgentSettingsDialog
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          agent={null}
        />
      </div>
    )
  }

  const readOnly = snapshot.status.engine !== "here"
  const turn = snapshot.status.turn
  const live =
    turn?.kind === "delivery" && connectionId && agentType ? (
      <LiveTurn
        connectionId={connectionId}
        conversationId={segment?.conversation_id ?? null}
        agentType={agentType}
      />
    ) : null

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 px-4 pt-2 pb-4">
        <div className="flex h-full overflow-hidden rounded-2xl border border-border ws-chrome-border">
          <ResizablePanelGroup
            direction="horizontal"
            className="min-h-0 flex-1"
          >
            <ResizablePanel
              id="personal-agent-main"
              order={1}
              defaultSize={68}
              minSize={45}
            >
              <div className="flex h-full min-h-0 flex-col bg-card/50">
                {readOnly ? (
                  <p className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-1.5 text-xs text-amber-800 dark:text-amber-200">
                    {t("readOnly")}
                  </p>
                ) : null}
                {assistants.filter((a) => a.enabled).length === 0 ? (
                  <p className="border-b border-border/60 px-4 py-1.5 text-xs text-muted-foreground">
                    {t("noAssistants")}
                  </p>
                ) : null}
                <div className="flex shrink-0 items-center justify-end gap-1 px-3 pt-2">
                  {segment?.conversation_id != null ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 gap-1 px-2 text-xs text-muted-foreground"
                      onClick={() => setSessionOpen(true)}
                    >
                      <Eye className="size-3" aria-hidden />
                      {t("viewSession")}
                    </Button>
                  ) : null}
                </div>
                <TimelineView
                  rows={rows}
                  hasOlder={hasOlder}
                  onLoadOlder={loadOlder}
                  readOnly={readOnly}
                  live={live}
                />
                <PersonalAgentComposer
                  agent={agent}
                  status={snapshot.status}
                  onOpenBrain={() => {
                    setSettingsTab("brain")
                    setSettingsOpen(true)
                  }}
                />
              </div>
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel
              id="personal-agent-aux"
              order={2}
              defaultSize={32}
              minSize={22}
            >
              <div className="h-full bg-muted/50">
                <PersonalAgentAuxPanel
                  tab={auxTab}
                  onTabChange={setAuxTab}
                  snapshot={snapshot}
                />
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      </div>
      <PersonalAgentSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        agent={agent}
        initialTab={settingsTab}
      />
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
    </div>
  )
}
