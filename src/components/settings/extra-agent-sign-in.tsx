"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Copy, Loader2, LogIn, Users } from "lucide-react"
import { toast } from "sonner"

import { SettingCard, SettingRow } from "@/components/shared/setting-card"
import { Button } from "@/components/ui/button"
import { acpLoginExtraAgent } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { AGENT_LABELS, type BuiltinAgentType } from "@/lib/types"
import { copyTextToClipboard } from "@/lib/utils"

export function ExtraAgentSignIn({
  registryId,
  family,
  builtinAgent,
  home,
}: {
  registryId: string
  family: string
  /** The built-in agent this slot runs a second account of. Its own
   * accounts do the same and keep the built-in agent's features. */
  builtinAgent?: BuiltinAgentType | null
  /** The slot's isolated home, the folder its sign-in writes to. */
  home?: string
}) {
  const t = useTranslations("AcpAgentSettings")
  const agent = builtinAgent ? AGENT_LABELS[builtinAgent] : null
  // A native account folder has the same layout as this slot's home, except
  // OpenCode's: its slot names only the config folder, while an account keeps
  // config, data and state under one folder.
  const accountFolder = builtinAgent !== "open_code" ? home : undefined
  const [pending, setPending] = useState(false)
  const [command, setCommand] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function signIn() {
    setPending(true)
    setError(null)
    setCommand(null)
    try {
      const result = await acpLoginExtraAgent(registryId)
      if (result.launched) {
        toast.success(t("customAgentSignInLaunched", { home: result.home }))
      } else {
        setCommand(result.command)
      }
    } catch (err) {
      setError(toErrorMessage(err))
    } finally {
      setPending(false)
    }
  }

  return (
    <SettingCard>
      <SettingRow
        icon={LogIn}
        title={t("customAgentSignIn")}
        description={t("customAgentSignInHint", { family })}
        control={
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={signIn}
          >
            {pending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <LogIn className="h-3.5 w-3.5" />
            )}
            {t("customAgentSignIn")}
          </Button>
        }
      />
      {agent && (
        <SettingRow
          icon={Users}
          title={t("customAgentUseAccounts", { agent })}
          description={
            accountFolder
              ? t("customAgentUseAccountsFolderHint", {
                  agent,
                  home: accountFolder,
                })
              : t("customAgentUseAccountsHint", { agent })
          }
        />
      )}
      {error && (
        <p role="alert" className="px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {command && (
        <div className="min-w-0 space-y-2 p-3">
          <pre className="whitespace-pre-wrap break-all text-xs">
            {t("customAgentSignInCommand", { command })}
          </pre>
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              if (await copyTextToClipboard(command)) {
                toast.success(t("customAgentSignInCopied"))
              }
            }}
          >
            <Copy className="h-3.5 w-3.5" />
            {t("customAgentSignInCopy")}
          </Button>
        </div>
      )}
    </SettingCard>
  )
}
