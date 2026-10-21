"use client"

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { AgentSelector } from "@/components/chat/agent-selector"
import { AgentAccountSelector } from "@/components/chat/agent-account-selector"
import { AccountManagementDialog } from "@/components/settings/account-management-dialog"
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
import { useAgentAccounts } from "@/hooks/use-agent-accounts"
import { useAcpActions } from "@/contexts/acp-connections-context"
import { acpHandoff, acpHandoffPlan, type HandoffPlan } from "@/lib/api"
import { agentAccountKey, readSelectedAccount } from "@/lib/agent-accounts"
import { getAgentLabel } from "@/lib/custom-agents"
import { getSavedPrefsForConnect } from "@/lib/selector-prefs-storage"
import { toErrorMessage } from "@/lib/app-error"
import type { AgentType } from "@/lib/types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useConversationRuntimeActions } from "@/stores/conversation-runtime-store"
import { useTabStore } from "@/stores/tab-store"
import { getActiveRemoteConnectionId } from "@/lib/transport"
import { beginConversationHandoff } from "@/stores/conversation-handoff-store"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  conversationId: number
  folderId: number
  sourceAgentType: AgentType
  title?: string | null
  initialAccountId?: string | null
}

export function AgentHandoffDialog({
  open,
  onOpenChange,
  conversationId,
  sourceAgentType,
  title,
  initialAccountId,
}: Props) {
  const t = useTranslations("Folder.chat.agentHandoff")
  const acp = useAcpActions()
  const runtime = useConversationRuntimeActions()
  const [target, setTarget] = useState<AgentType>(sourceAgentType)
  const [account, setAccount] = useState<string | null>(() =>
    initialAccountId !== undefined
      ? initialAccountId
      : (useAppWorkspaceStore
          .getState()
          .conversations?.find((c) => c.id === conversationId)
          ?.agent_account_id ?? null)
  )
  const accounts = useAgentAccounts(target)
  const [manage, setManage] = useState<AgentType | null>(null)
  const [note, setNote] = useState("")
  const [plan, setPlan] = useState<HandoffPlan | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const destinationChosen = useRef(initialAccountId !== undefined)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    let current = true
    if (!open) return
    setLoading(true)
    setPlan(null)
    setError(null)
    acpHandoffPlan(conversationId, target, account)
      .then((next) => {
        if (!current) return
        if (
          !destinationChosen.current &&
          target === sourceAgentType &&
          next.sourceAgentType === target &&
          next.sourceAccountId !== account
        ) {
          setAccount(next.sourceAccountId)
          return
        }
        setPlan(next)
      })
      .catch((err: unknown) => {
        if (current) setError(toErrorMessage(err))
      })
      .finally(() => {
        if (current) setLoading(false)
      })
    return () => {
      current = false
    }
  }, [open, conversationId, target, account, retry, sourceAgentType])

  function selectAgent(next: AgentType) {
    if (next === target) return
    destinationChosen.current = true
    setTarget(next)
    setAccount(readSelectedAccount(next))
    setPlan(null)
  }

  const blocked = (() => {
    if (!plan?.blocked) return null
    switch (plan.blocked) {
      case "same_agent":
        return t("blockedSameAccount")
      case "no_session":
        return t("blockedNoSession")
      case "empty_history":
        return t("blockedEmptyHistory")
      case "child_session":
        return t("blockedChild")
      case "same_store":
        return t("blockedSameStore")
      case "remote_context":
        return t("blockedRemoteContext")
      case "not_installed":
        return t("blockedNotInstalled", { target: getAgentLabel(target) })
      case "disabled":
        return t("blockedDisabled", { target: getAgentLabel(target) })
      default:
        return t("blockedGeneric", {
          target: getAgentLabel(target),
          message: plan.blockedMessage ?? plan.blocked,
        })
    }
  })()
  const ready =
    !!plan &&
    plan.targetAgentType === target &&
    plan.targetAccountId === account &&
    !plan.blocked &&
    !!plan.sourceExternalId &&
    !loading &&
    !busy &&
    !error

  async function confirm() {
    if (!ready || !plan?.sourceExternalId || pending.current) return
    pending.current = true
    setBusy(true)
    setError(null)
    const endHandoff = beginConversationHandoff(conversationId)
    const backend = getActiveRemoteConnectionId()
    let committed = false
    try {
      const prefs = getSavedPrefsForConnect(agentAccountKey(target, account))
      const result = await acpHandoff(
        conversationId,
        target,
        note.trim() || null,
        prefs.modeId,
        prefs.configValues,
        {
          targetAccountId: account,
          sourceAgentType: plan.sourceAgentType,
          sourceAccountId: plan.sourceAccountId,
          sourceExternalId: plan.sourceExternalId,
        }
      )
      committed = true
      if (getActiveRemoteConnectionId() !== backend) return
      // The existing tab keeps its id, draft, pin and split position. Do not
      // close/reopen it: that discards live composer state and queued input.
      const tabs = useTabStore.getState()
      let tab = tabs.rawTabs.find(
        (item) => item.conversationId === conversationId
      )
      if (!tab) {
        tabs.openTab(
          result.folderId,
          conversationId,
          result.toAgentType,
          false,
          title ?? undefined
        )
        tab = useTabStore
          .getState()
          .rawTabs.find((item) => item.conversationId === conversationId)
      }
      const runtimeId = tab?.runtimeConversationId ?? conversationId
      runtime.setExternalId(runtimeId, result.externalId)
      if (tab) {
        await acp.disconnect(tab.id)
        acp.clearAcpLoadError(tab.id)
        await acp.adoptOwnedConnection({
          contextKey: tab.id,
          connectionId: result.connectionId,
          agentType: result.toAgentType,
          agentAccountId: result.agentAccountId,
          workingDir: result.workingDir,
          sessionId: result.externalId,
          conversationId,
        })
        tabs.bindConversationTab(
          tab.id,
          conversationId,
          result.toAgentType,
          title ?? tab.title,
          tab.runtimeConversationId,
          result.folderId,
          result.workingDir
        )
      }
      await useAppWorkspaceStore.getState().refreshConversations()
      runtime.refetchDetail(runtimeId)
      toast.success(t("success", { target: getAgentLabel(result.toAgentType) }))
      if ((result.path !== "native" || note.trim()) && !result.responseStarted)
        toast.info(t("continueAfterRetry"))
      onOpenChange(false)
    } catch (err: unknown) {
      if (getActiveRemoteConnectionId() !== backend) return
      if (committed) {
        // Attaching the browser can fail after the server has safely moved
        // the chat. Keep that outcome distinct from a failed server switch.
        void useAppWorkspaceStore.getState().refreshConversations()
        runtime.refetchDetail(conversationId)
        setError(t("reconnectAfterSwitch"))
      } else {
        setError(toErrorMessage(err))
      }
    } finally {
      endHandoff()
      pending.current = false
      setBusy(false)
    }
  }

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!pending.current) onOpenChange(next)
        }}
      >
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg max-sm:[&_button]:min-h-11">
          <DialogHeader>
            <DialogTitle>{t("dialogTitle")}</DialogTitle>
            <DialogDescription>{t("dialogDescription")}</DialogDescription>
            {title && (
              <p
                className="truncate text-xs text-muted-foreground"
                title={title}
              >
                {title}
              </p>
            )}
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">{t("targetLabel")}</span>
              <AgentSelector
                defaultAgentType={target}
                onSelect={selectAgent}
                onFallback={selectAgent}
                disabled={busy}
              />
              <AgentAccountSelector
                accounts={accounts.accounts}
                value={account}
                onChange={(next) => {
                  destinationChosen.current = true
                  setAccount(next)
                  setPlan(null)
                }}
                disabled={busy}
                loading={accounts.loading}
                loadError={accounts.error}
                onRetry={accounts.refresh}
                onManage={
                  accounts.capability?.supported
                    ? () => setManage(target)
                    : undefined
                }
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label
                className="text-sm font-medium"
                htmlFor="agent-handoff-note"
              >
                {t("noteLabel")}
              </label>
              <Textarea
                id="agent-handoff-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={t("notePlaceholder")}
                disabled={busy}
                rows={3}
              />
            </div>
            <p
              data-slot="agent-handoff-plan"
              role="status"
              className="text-sm text-muted-foreground"
            >
              {loading
                ? t("planLoading")
                : (blocked ??
                  (plan
                    ? t(
                        plan.path === "native"
                          ? "planNativeContext"
                          : "planPortableContext",
                        { target: getAgentLabel(target) }
                      )
                    : null))}
            </p>
            {error && (
              <div role="alert" className="text-sm text-destructive">
                <p>{error}</p>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => setRetry((n) => n + 1)}
                >
                  {t("retry")}
                </Button>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              {t("cancel")}
            </Button>
            <Button onClick={() => void confirm()} disabled={!ready}>
              {busy ? t("working") : t("confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {manage && (
        <AccountManagementDialog
          open
          agentType={manage}
          add={!accounts.accounts.some((a) => !a.removed)}
          onOpenChange={(open) => {
            if (!open) setManage(null)
          }}
        />
      )}
    </>
  )
}
