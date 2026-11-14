"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Copy, Loader2, LogIn } from "lucide-react"
import { toast } from "sonner"

import { SettingCard, SettingRow } from "@/components/shared/setting-card"
import { Button } from "@/components/ui/button"
import { acpLoginExtraAgent } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { copyTextToClipboard } from "@/lib/utils"

export function ExtraAgentSignIn({
  registryId,
  family,
}: {
  registryId: string
  family: string
}) {
  const t = useTranslations("AcpAgentSettings")
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
