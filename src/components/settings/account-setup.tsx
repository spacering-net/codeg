"use client"

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Check, Copy, KeyRound, Loader2, LogIn } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  HeadlessSignIn,
  type AntigravityAuthMethod,
} from "./antigravity-config-panel"
import { copyTextToClipboard } from "@/lib/utils"
import { getAgentLabel } from "@/lib/custom-agents"
import {
  checkAgentAccountAuth,
  createAgentAccount,
  loginAgentAccount,
  setAgentAccountApiKey,
  type AccountAuthMethod,
  type AccountAuthStatus,
  type AgentAccount,
  type AgentAccountCapability,
} from "@/lib/agent-accounts"
import { toErrorMessage } from "@/lib/app-error"
import type { AgentType } from "@/lib/types"

export function AccountSetup({
  agentType,
  capability,
  account,
  suggestedName,
  onCreated,
  onClose,
}: {
  agentType: AgentType
  capability: AgentAccountCapability
  account?: AgentAccount
  suggestedName: string
  onCreated: () => Promise<void>
  onClose: () => void
}) {
  const t = useTranslations("AgentAccounts")
  const agentText = useTranslations("AcpAgentSettings")
  const agentLabel = getAgentLabel(agentType)
  const methods = capability.authMethods ?? ["native"]
  const [method, setMethod] = useState<AccountAuthMethod | "">(
    account && methods.length > 1 ? "" : (methods[0] ?? "native")
  )
  const [name, setName] = useState(account?.name ?? suggestedName)
  const [home, setHome] = useState("")
  const [useFolder, setUseFolder] = useState(false)
  const [apiKey, setApiKey] = useState("")
  const [created, setCreated] = useState(account)
  const createdRef = useRef(account)
  const inFlight = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [command, setCommand] = useState<string | null>(null)
  const [started, setStarted] = useState(false)
  const [keySaved, setKeySaved] = useState(false)
  const [auth, setAuth] = useState<AccountAuthStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const checkingRef = useRef(false)
  const methodChanged = useRef(false)
  const [browserMethod, setBrowserMethod] =
    useState<AntigravityAuthMethod>("oauth-personal")
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  async function checkSignIn(selectCurrentMethod = false) {
    const current = createdRef.current
    if (!current || checkingRef.current || inFlight.current) return
    checkingRef.current = true
    setChecking(true)
    setError(null)
    try {
      const result = await checkAgentAccountAuth(current.id)
      if (alive.current) {
        setAuth(result)
        if (
          selectCurrentMethod &&
          !methodChanged.current &&
          result.method &&
          methods.includes(result.method)
        ) {
          setMethod(result.method)
        }
      }
    } catch (err) {
      if (alive.current) setError(toErrorMessage(err))
    } finally {
      checkingRef.current = false
      if (alive.current) setChecking(false)
    }
  }

  useEffect(() => {
    if (account && capability.canCheckAuth) void checkSignIn(true)
    // AccountSetup is keyed by identity; read its native status once on opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.id, capability.canCheckAuth])

  useEffect(() => {
    if (!started || !capability.canCheckAuth) return
    const onFocus = () => {
      void checkSignIn()
    }
    window.addEventListener("focus", onFocus)
    return () => window.removeEventListener("focus", onFocus)
    // The check reads the current account and operation flags from refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, capability.canCheckAuth])

  async function submit() {
    if (inFlight.current || checkingRef.current || (!method && !useFolder))
      return
    inFlight.current = true
    setBusy(true)
    setError(null)
    setAuth(null)
    try {
      let current = createdRef.current
      if (!current) {
        current = await createAgentAccount(
          agentType,
          name.trim(),
          useFolder ? home : ""
        )
        // Keep the new identity if authentication fails. Retry must not create
        // another account or lose the folder that was just made.
        createdRef.current = current
        setCreated(current)
        await onCreated()
        if (useFolder) {
          toast.success(t("added"))
          onClose()
          return
        }
      }
      if (!method) return
      if (method === "api_key") {
        await setAgentAccountApiKey(current.id, apiKey.trim())
        setApiKey("")
        setKeySaved(true)
        setCommand(null)
      } else if (capability.loginKind !== "browser") {
        const result = await loginAgentAccount(current.id, method)
        setCommand(result.launched ? null : result.command)
        if (result.launched) toast.success(t("signInOpened"))
      }
      setStarted(true)
    } catch (err) {
      setError(toErrorMessage(err))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const statusText =
    auth?.state === "signed_in"
      ? t("signedInWith", {
          method:
            auth.method === "api_key"
              ? t("apiKey")
              : auth.method === "sign_in"
                ? t("accountAuth", {
                    provider: agentType === "codex" ? "ChatGPT" : "Claude",
                  })
                : t("nativeAuth"),
        })
      : auth?.state === "signed_out"
        ? t("signedOut")
        : auth?.state === "unavailable"
          ? t("authUnavailable")
          : null

  return (
    <form
      className="min-w-0 space-y-4 p-3"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <p className="text-sm font-medium break-words">
        {created ? t("setupTitle", { name: created.name }) : t("add")}
      </p>
      {!created && (
        <div className="space-y-1.5">
          <Label htmlFor={`account-name-${agentType}`}>{t("name")}</Label>
          <Input
            id={`account-name-${agentType}`}
            value={name}
            maxLength={80}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
            onFocus={(event) => event.target.select()}
            autoFocus
          />
        </div>
      )}
      {!useFolder && !started && (
        <>
          {methods.length > 1 && (
            <div className="space-y-1.5">
              <Label htmlFor={`account-method-${agentType}`}>
                {t("connectionMethod")}
              </Label>
              <Select
                value={method}
                disabled={busy}
                onValueChange={(value) => {
                  methodChanged.current = true
                  setMethod(value as AccountAuthMethod)
                  setApiKey("")
                  setError(null)
                }}
              >
                <SelectTrigger
                  id={`account-method-${agentType}`}
                  autoFocus={Boolean(account)}
                  className="w-full"
                  aria-label={t("connectionMethod")}
                >
                  <SelectValue placeholder={t("connectionMethod")} />
                </SelectTrigger>
                <SelectContent>
                  {methods.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option === "api_key"
                        ? t("apiKeyMethod")
                        : option === "sign_in"
                          ? t("accountSignIn", {
                              provider:
                                agentType === "codex"
                                  ? "ChatGPT"
                                  : agentType === "claude_code"
                                    ? "Claude"
                                    : agentLabel,
                            })
                          : t("nativeMethod", { agent: agentLabel })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {method === "api_key" ? (
            <div className="space-y-1.5">
              <Label htmlFor={`account-api-key-${agentType}`}>
                {t("apiKey")}
              </Label>
              <Input
                id={`account-api-key-${agentType}`}
                type="password"
                dir="ltr"
                autoComplete="new-password"
                spellCheck={false}
                value={apiKey}
                disabled={busy}
                onChange={(event) => setApiKey(event.target.value)}
                aria-describedby={`account-api-hint-${agentType}`}
              />
              <p
                id={`account-api-hint-${agentType}`}
                className="text-xs text-muted-foreground"
              >
                {t("apiKeyHint")}
              </p>
            </div>
          ) : method ? (
            <p className="text-xs text-muted-foreground">
              {t(method === "native" ? "nativeHint" : "signInHint", {
                agent: agentLabel,
              })}
            </p>
          ) : null}
        </>
      )}
      {!created && (
        <details open={useFolder} className="text-xs">
          <summary
            className="cursor-pointer py-1 text-muted-foreground"
            aria-disabled={busy}
            onClick={(event) => {
              event.preventDefault()
              if (!busy) setUseFolder((value) => !value)
            }}
          >
            {t("useExistingFolder")}
          </summary>
          <div className="space-y-1.5 pt-2">
            <Label htmlFor={`account-home-${agentType}`}>{t("home")}</Label>
            <Input
              id={`account-home-${agentType}`}
              dir="ltr"
              value={home}
              disabled={busy}
              onChange={(event) => setHome(event.target.value)}
              aria-describedby={`account-home-hint-${agentType}`}
            />
            <p
              id={`account-home-hint-${agentType}`}
              className="text-muted-foreground"
            >
              {t("existingFolderHint")}
              {capability.configSubdir
                ? ` ${t("homeLayout", { path: capability.configSubdir })}`
                : ""}
            </p>
          </div>
        </details>
      )}
      {started && created && (
        <div className="min-w-0 space-y-3">
          <p role="status" className="text-sm">
            {keySaved
              ? t("apiKeySaved")
              : capability.loginKind === "browser"
                ? t("finishBrowserSignIn")
                : command
                  ? t("runOnHost")
                  : t("finishSignIn")}
          </p>
          {capability.loginKind === "browser" && (
            <>
              <Select
                value={browserMethod}
                onValueChange={(value) =>
                  setBrowserMethod(value as AntigravityAuthMethod)
                }
              >
                <SelectTrigger
                  className="w-full"
                  aria-label={t("connectionMethod")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(["oauth-personal", "oauth-business"] as const).map(
                    (option) => (
                      <SelectItem key={option} value={option}>
                        {agentText(`antigravity.methods.${option}`)}
                      </SelectItem>
                    )
                  )}
                </SelectContent>
              </Select>
              <HeadlessSignIn
                key={created.id}
                method={browserMethod}
                accountId={created.id}
                disabled={busy}
                needsSave={false}
              />
            </>
          )}
          {command && (
            <>
              <pre
                dir="ltr"
                className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md border bg-background p-2 text-xs"
              >
                {command}
              </pre>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={async () => {
                  if (await copyTextToClipboard(command))
                    toast.success(t("copied"))
                }}
              >
                <Copy className="size-3.5" />
                {t("copyCommand")}
              </Button>
            </>
          )}
          <p className="text-xs text-muted-foreground">
            {t("chooseInChat", { name: created.name })}
          </p>
        </div>
      )}
      {created && capability.canCheckAuth && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={checking || busy}
            aria-busy={checking}
            onClick={() => void checkSignIn()}
          >
            {checking ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Check className="size-3.5" />
            )}
            {t("checkSignIn")}
          </Button>
          {statusText && (
            <span role="status" className="text-xs text-muted-foreground">
              {statusText}
            </span>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {!started && (
          <Button
            type="submit"
            autoFocus={Boolean(account) && methods.length === 1}
            size="sm"
            disabled={
              busy ||
              checking ||
              (!useFolder && !method) ||
              !name.trim() ||
              (useFolder && !home.trim()) ||
              (!useFolder && method === "api_key" && !apiKey.trim())
            }
            aria-busy={busy}
          >
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : method === "api_key" && !useFolder ? (
              <KeyRound className="size-3.5" />
            ) : (
              <LogIn className="size-3.5" />
            )}
            {useFolder ? t("add") : t("continue")}
          </Button>
        )}
        {started && !keySaved && capability.loginKind !== "browser" && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || checking}
            onClick={() => void submit()}
          >
            {t("openSignInAgain")}
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant={started ? "default" : "outline"}
          disabled={busy}
          onClick={onClose}
        >
          {started ? t("done") : t("cancel")}
        </Button>
      </div>
    </form>
  )
}
