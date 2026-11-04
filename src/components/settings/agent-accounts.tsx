"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { LogIn, Pencil, Plus, Trash2, Users } from "lucide-react"
import { SettingCard, SettingRow } from "@/components/shared/setting-card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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
import { useAgentAccounts } from "@/hooks/use-agent-accounts"
import {
  removeAgentAccount,
  renameAgentAccount,
  type AgentAccount,
} from "@/lib/agent-accounts"
import { toErrorMessage } from "@/lib/app-error"
import type { AgentType } from "@/lib/types"
import { AccountSetup } from "./account-setup"

export function AgentAccounts({ agentType }: { agentType: AgentType }) {
  const t = useTranslations("AgentAccounts")
  const {
    accounts,
    capability,
    loading,
    error: loadError,
    refresh,
  } = useAgentAccounts(agentType)
  const [setup, setSetup] = useState<AgentAccount | "new" | null>(null)
  const [renaming, setRenaming] = useState<AgentAccount | null>(null)
  const [name, setName] = useState("")
  const [removing, setRemoving] = useState<AgentAccount | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const available = accounts.filter((account) => !account.removed)
  const names = new Set(available.map((account) => account.name.toLowerCase()))
  let number = 1
  while (names.has(t("suggestedName", { number }).toLowerCase())) number++
  const suggestedName = t("suggestedName", { number })

  if (loading)
    return (
      <div className="h-20 animate-pulse rounded-xl bg-muted/40" aria-busy />
    )
  if (loadError)
    return (
      <SettingCard>
        <SettingRow
          title={t("loadFailed")}
          control={
            <Button variant="outline" size="sm" onClick={refresh}>
              {t("retry")}
            </Button>
          }
        />
      </SettingCard>
    )
  if (!capability?.supported)
    return capability?.reason ? (
      <SettingCard>
        <SettingRow
          icon={Users}
          title={t("title")}
          description={
            agentType === "openclaw" ? t("gatewayAccount") : t("notSupported")
          }
        />
      </SettingCard>
    ) : null

  return (
    <>
      <SettingCard className="max-sm:[&_button]:min-h-11 max-sm:[&_button]:min-w-11 max-sm:[&_input]:min-h-11">
        <SettingRow
          icon={Users}
          title={t("title")}
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={busy || setup !== null || renaming !== null}
              onClick={() => {
                setSetup("new")
                setError(null)
              }}
            >
              <Plus className="size-3.5" />
              {t("add")}
            </Button>
          }
        />
        <SettingRow
          title={t("default")}
          description={t("defaultSetupDescription")}
        />
        {capability.isolatesToolSettings && (
          <p className="px-3 pb-3 text-xs text-muted-foreground">
            {t("toolSettingsHint")}
          </p>
        )}
        {available.length === 0 && setup === null && (
          <p className="px-3 pb-3 text-xs text-muted-foreground">
            {t("emptyHint")}
          </p>
        )}
        {available.map((account) => (
          <SettingRow
            key={account.id}
            title={<span className="break-all">{account.name}</span>}
            description={t("accountDescription")}
            control={
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || setup !== null || renaming !== null}
                  aria-label={`${t("connect")}: ${account.name}`}
                  onClick={() => {
                    setSetup(account)
                    setError(null)
                  }}
                >
                  <LogIn className="size-3.5" />
                  {t("connect")}
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={busy || setup !== null || renaming !== null}
                  aria-label={t("rename", { name: account.name })}
                  onClick={() => {
                    setRenaming(account)
                    setName(account.name)
                    setError(null)
                  }}
                >
                  <Pencil className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={busy || setup !== null || renaming !== null}
                  aria-label={t("remove", { name: account.name })}
                  onClick={() => {
                    setRemoving(account)
                    setError(null)
                  }}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            }
          >
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer py-1">
                {t("accountDetails")}
              </summary>
              <p className="break-all py-1">{account.homeDir}</p>
            </details>
          </SettingRow>
        ))}
        {setup && (
          <AccountSetup
            key={setup === "new" ? "new" : setup.id}
            agentType={agentType}
            capability={capability}
            account={setup === "new" ? undefined : setup}
            suggestedName={suggestedName}
            onCreated={refresh}
            onClose={() => setSetup(null)}
          />
        )}
        {renaming && (
          <form
            className="space-y-3 p-3"
            onSubmit={async (event) => {
              event.preventDefault()
              if (busy) return
              setBusy(true)
              setError(null)
              try {
                await renameAgentAccount(renaming.id, name)
                setRenaming(null)
                await refresh()
              } catch (err) {
                setError(toErrorMessage(err))
              } finally {
                setBusy(false)
              }
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor={`account-name-${agentType}`}>{t("name")}</Label>
              <Input
                id={`account-name-${agentType}`}
                value={name}
                maxLength={80}
                disabled={busy}
                onChange={(event) => setName(event.target.value)}
                autoFocus
              />
            </div>
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={busy || !name.trim()}>
                {t("save")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => setRenaming(null)}
              >
                {t("cancel")}
              </Button>
            </div>
          </form>
        )}
        {capability.isolatesToolSettings && (
          <p className="px-3 pb-3 text-xs text-muted-foreground">
            {t("toolSettingsHint")}
          </p>
        )}
        {error && !removing && (
          <p role="alert" className="p-3 text-sm text-destructive">
            {error}
          </p>
        )}
      </SettingCard>
      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setRemoving(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("removeTitle", { name: removing?.name ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription className="break-words">
              {t("removeDescription", { path: removing?.homeDir ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={async (event) => {
                event.preventDefault()
                if (!removing || busy) return
                setBusy(true)
                setError(null)
                try {
                  await removeAgentAccount(removing.id)
                  setRemoving(null)
                  await refresh()
                } catch (err) {
                  setError(toErrorMessage(err))
                } finally {
                  setBusy(false)
                }
              }}
            >
              {t("removeAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
