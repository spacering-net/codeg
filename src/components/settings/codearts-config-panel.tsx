"use client"

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import { Eye, EyeOff, Loader2, Save } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { AcpAgentInfo } from "@/lib/types"

/** Env keys Huawei's CLI reads. Only non-interactive `codearts run` needs them;
 *  the settings page is the first place the bridge looks, before the OS-level
 *  environment. */
export const CODEARTS_AK_ENV = "CODEARTS_CLI_AK"
export const CODEARTS_SK_ENV = "CODEARTS_CLI_SK"

/** Keep unrelated env entries, write/clear only the AK/SK pair. An empty field
 *  removes the key so the bridge falls back to the OS user/machine variables
 *  rather than persisting an empty credential that would shadow them. */
export function buildCodeArtsEnv(
  prevEnv: Record<string, string>,
  ak: string,
  sk: string
): Record<string, string> {
  const env: Record<string, string> = { ...prevEnv }
  for (const [key, value] of [
    [CODEARTS_AK_ENV, ak],
    [CODEARTS_SK_ENV, sk],
  ] as const) {
    const trimmed = value.trim()
    if (trimmed) env[key] = trimmed
    else delete env[key]
  }
  return env
}

/** Dedicated settings panel for Huawei Cloud CodeArts. The vendor CLI has no
 *  ACP server; codeg bridges it, but the bridge still needs the account's
 *  AK/SK to run `codearts run`. These are written through the generic per-agent
 *  env path and injected into the bridge process at launch — no bespoke
 *  backend command, no credential copy outside the agent's own env. */
export function CodeArtsConfigPanel({
  agent,
  saving,
  onSave,
}: {
  agent: AcpAgentInfo
  saving: boolean
  onSave: (env: Record<string, string>, enabled: boolean) => Promise<unknown>
}) {
  const t = useTranslations("AcpAgentSettings")
  const [ak, setAk] = useState(() => agent.env[CODEARTS_AK_ENV] ?? "")
  const [sk, setSk] = useState(() => agent.env[CODEARTS_SK_ENV] ?? "")
  const [showAk, setShowAk] = useState(false)
  const [showSk, setShowSk] = useState(false)

  const handleSave = useCallback(async () => {
    const env = buildCodeArtsEnv(agent.env, ak, sk)
    try {
      await onSave(env, agent.enabled)
      toast.success(t("toasts.codeArtsSaved"))
    } catch (error) {
      console.error("[CodeArts] save config failed", error)
      toast.error(t("toasts.saveCodeArtsFailed"))
    }
  }, [agent.env, agent.enabled, ak, sk, onSave, t])

  const field = (
    label: string,
    value: string,
    onChange: (next: string) => void,
    shown: boolean,
    setShown: (next: boolean) => void,
    placeholder: string
  ) => (
    <div className="space-y-1.5">
      <label className="text-2xs text-muted-foreground">{label}</label>
      <div className="flex items-center gap-2">
        <Input
          type={shown ? "text" : "password"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          disabled={saving}
          autoComplete="off"
          spellCheck={false}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setShown(!shown)}
          title={shown ? t("actions.hideApiKey") : t("actions.showApiKey")}
        >
          {shown ? (
            <EyeOff className="h-3.5 w-3.5" />
          ) : (
            <Eye className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>
    </div>
  )

  return (
    <div className="space-y-3 rounded-md border bg-muted/10 p-3">
      <div>
        <label className="text-xs font-medium">
          {t("codearts.configManagement")}
        </label>
        <p className="mt-1 text-2xs text-muted-foreground">
          {t("codearts.configDescription")}
        </p>
      </div>

      {field(
        t("codearts.akLabel"),
        ak,
        setAk,
        showAk,
        setShowAk,
        t("codearts.akPlaceholder")
      )}
      {field(
        t("codearts.skLabel"),
        sk,
        setSk,
        showSk,
        setShowSk,
        t("codearts.skPlaceholder")
      )}

      <p className="text-2xs text-muted-foreground">{t("codearts.envHint")}</p>

      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          onClick={handleSave}
          disabled={saving}
          className="gap-1.5"
        >
          {saving ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t("actions.saving")}
            </>
          ) : (
            <>
              <Save className="h-3.5 w-3.5" />
              {t("actions.saveCodeArtsConfig")}
            </>
          )}
        </Button>
      </div>
    </div>
  )
}
