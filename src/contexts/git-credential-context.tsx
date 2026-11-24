"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { randomUUID } from "@/lib/utils"
import {
  ExternalLink,
  Eye,
  EyeOff,
  Github,
  KeyRound,
  Loader2,
} from "lucide-react"
import { openUrl } from "@/lib/platform"
import { useTranslations } from "next-intl"
import { useImeGuard } from "@/hooks/use-ime-guard"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { extractAppCommandError, toErrorMessage } from "@/lib/app-error"
import type { GitCredentials } from "@/lib/types"
import {
  gitListRemotes,
  validateGitHubToken,
  getGitHubAccounts,
  updateGitHubAccounts,
  saveAccountToken,
} from "@/lib/api"

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * Context for identifying the remote when credentials are needed.
 * - `folderPath`: detect remote from an existing repo's origin URL.
 * - `remoteUrl`: use this URL directly (e.g. for clone operations).
 */
export type GitRemoteHint = { folderPath: string } | { remoteUrl: string }

interface GitCredentialContextValue {
  /**
   * Wrap an async git operation with automatic credential retry.
   *
   * - For GitHub remotes: shows a token dialog, validates via API,
   *   saves as a GitHub account, then retries the operation.
   * - For other remotes: shows a generic username/password dialog.
   */
  withCredentialRetry: <T>(
    operation: (credentials?: GitCredentials) => Promise<T>,
    hint: GitRemoteHint
  ) => Promise<T>
}

const GitCredentialContext = createContext<GitCredentialContextValue | null>(
  null
)

export function useGitCredential(): GitCredentialContextValue {
  const ctx = useContext(GitCredentialContext)
  if (!ctx) {
    throw new Error(
      "useGitCredential must be used within GitCredentialProvider"
    )
  }
  return ctx
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAuthError(error: unknown): boolean {
  const appError = extractAppCommandError(error)
  if (appError?.code === "authentication_failed") return true

  const msg = appError?.detail ?? appError?.message ?? String(error)
  const lower = msg.toLowerCase()
  return (
    lower.includes("authentication failed") ||
    lower.includes("could not read username") ||
    lower.includes("could not read password") ||
    lower.includes("logon failed")
  )
}

function extractHost(url: string): string | null {
  const trimmed = url.trim()
  // https://github.com/...
  const httpsMatch = trimmed.match(/^https?:\/\/(?:[^@]+@)?([^/:]+)/)
  if (httpsMatch) return httpsMatch[1].toLowerCase()
  // git@github.com:...
  const sshMatch = trimmed.match(/@([^/:]+)[:/]/)
  if (sshMatch) return sshMatch[1].toLowerCase()
  return null
}

function isGitHubHost(host: string | null): boolean {
  return host === "github.com"
}

async function resolveRemoteHost(hint: GitRemoteHint): Promise<string | null> {
  if ("remoteUrl" in hint) {
    return extractHost(hint.remoteUrl)
  }
  try {
    const remotes = await gitListRemotes(hint.folderPath)
    const origin = remotes.find((r) => r.name === "origin") ?? remotes[0]
    if (!origin) return null
    return extractHost(origin.url)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

type DialogMode = "github" | "generic"

interface PendingRequest {
  resolve: (credentials: GitCredentials | null) => void
}

/** Save generic credentials as a git account for future operations. */
async function saveGenericAccount(
  host: string | null,
  creds: GitCredentials
): Promise<void> {
  const serverUrl = host ? `https://${host}` : "https://unknown"
  try {
    const existing = await getGitHubAccounts()
    const isDuplicate = existing.accounts.some(
      (a) => a.username === creds.username && extractHost(a.server_url) === host
    )
    if (!isDuplicate) {
      const newId = randomUUID()
      await saveAccountToken(newId, creds.password)
      await updateGitHubAccounts({
        accounts: [
          ...existing.accounts,
          {
            id: newId,
            server_url: serverUrl,
            username: creds.username,
            scopes: [],
            avatar_url: null,
            is_default: existing.accounts.length === 0,
            created_at: new Date().toISOString(),
          },
        ],
      })
    }
  } catch {
    // Non-critical — just skip saving
  }
}

export function GitCredentialProvider({ children }: { children: ReactNode }) {
  const t = useTranslations("GitCredentialDialog")
  const ime = useImeGuard()

  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<DialogMode>("generic")
  const [remoteHost, setRemoteHost] = useState<string | null>(null)

  // Generic mode fields
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)

  // GitHub mode field
  const [token, setToken] = useState("")
  const [showToken, setShowToken] = useState(false)

  // Save credentials checkbox (generic mode)
  const [saveCredentials, setSaveCredentials] = useState(true)

  const handleGenerateToken = useCallback(async () => {
    const host = remoteHost || "github.com"
    const base = `https://${host}`
    const params = new URLSearchParams({
      description: "codeg",
      scopes: "repo,read:org,workflow,gist,read:user,user:email",
    })
    try {
      await openUrl(`${base}/settings/tokens/new?${params.toString()}`)
    } catch {
      // ignore
    }
  }, [remoteHost])

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const pendingRef = useRef<PendingRequest | null>(null)
  const saveCredentialsRef = useRef(saveCredentials)
  const remoteHostRef = useRef(remoteHost)
  const modeRef = useRef(mode)

  useEffect(() => {
    saveCredentialsRef.current = saveCredentials
  }, [saveCredentials])
  useEffect(() => {
    remoteHostRef.current = remoteHost
  }, [remoteHost])
  useEffect(() => {
    modeRef.current = mode
  }, [mode])

  const resetForm = useCallback(() => {
    setUsername("")
    setPassword("")
    setShowPassword(false)
    setToken("")
    setShowToken(false)
    setSaveCredentials(true)
    setError(null)
    setSubmitting(false)
  }, [])

  const requestCredentials = useCallback(
    (
      dialogMode: DialogMode,
      host: string | null
    ): Promise<GitCredentials | null> => {
      return new Promise((resolve) => {
        pendingRef.current = { resolve }
        resetForm()
        setMode(dialogMode)
        setRemoteHost(host)
        setOpen(true)
      })
    },
    [resetForm]
  )

  const handleCancel = useCallback(() => {
    setOpen(false)
    pendingRef.current?.resolve(null)
    pendingRef.current = null
  }, [])

  // GitHub mode: validate token → save account → return credentials
  const handleGitHubSubmit = useCallback(async () => {
    const trimmedToken = token.trim()
    if (!trimmedToken) return

    setSubmitting(true)
    setError(null)

    try {
      const serverUrl = remoteHost
        ? `https://${remoteHost}`
        : "https://github.com"

      const result = await validateGitHubToken(serverUrl, trimmedToken)
      if (!result.success) {
        setError(result.message ?? t("invalidCredentials"))
        setSubmitting(false)
        return
      }

      // Save as GitHub account
      try {
        const existing = await getGitHubAccounts()
        const isDuplicate = existing.accounts.some(
          (a) =>
            a.username === result.username &&
            extractHost(a.server_url) === remoteHost
        )
        if (!isDuplicate) {
          const newAccount = {
            id: randomUUID(),
            server_url: serverUrl,
            username: result.username ?? "unknown",
            scopes: result.scopes,
            avatar_url: result.avatar_url,
            is_default: existing.accounts.length === 0,
            created_at: new Date().toISOString(),
          }
          await saveAccountToken(newAccount.id, trimmedToken)
          await updateGitHubAccounts({
            accounts: [...existing.accounts, newAccount],
          })
        }
      } catch {
        // Saving account failed — not critical, continue with auth
      }

      const creds: GitCredentials = {
        username: result.username ?? "unknown",
        password: trimmedToken,
      }
      pendingRef.current?.resolve(creds)
      pendingRef.current = null
    } catch (err) {
      const msg = toErrorMessage(err)
      setError(msg)
      setSubmitting(false)
    }
  }, [token, remoteHost, t])

  // Generic mode: return username + password directly
  const handleGenericSubmit = useCallback(() => {
    if (!username.trim() || !password.trim()) return
    const creds: GitCredentials = {
      username: username.trim(),
      password: password.trim(),
    }
    setSubmitting(true)
    pendingRef.current?.resolve(creds)
    pendingRef.current = null
  }, [username, password])

  const handleSubmit = useCallback(() => {
    if (mode === "github") {
      handleGitHubSubmit()
    } else {
      handleGenericSubmit()
    }
  }, [mode, handleGitHubSubmit, handleGenericSubmit])

  const withCredentialRetry = useCallback(
    async <T,>(
      operation: (credentials?: GitCredentials) => Promise<T>,
      hint: GitRemoteHint
    ): Promise<T> => {
      // First attempt — no explicit credentials
      try {
        return await operation()
      } catch (firstError) {
        if (!isAuthError(firstError)) throw firstError

        // Detect remote host to decide dialog mode
        const host = await resolveRemoteHost(hint)
        const dialogMode: DialogMode = isGitHubHost(host) ? "github" : "generic"

        // Helper: save credentials after successful operation
        const maybeSave = async (c: GitCredentials) => {
          if (modeRef.current === "generic" && saveCredentialsRef.current) {
            await saveGenericAccount(remoteHostRef.current, c)
          }
          // GitHub mode saves during handleGitHubSubmit, no extra work needed
        }

        // Show credential dialog for the first time
        let creds = await requestCredentials(dialogMode, host)
        if (!creds) {
          setOpen(false)
          throw firstError
        }

        // Retry loop — keep trying until success or user cancels
        let lastError: unknown = firstError

        while (true) {
          try {
            const result = await operation(creds)
            await maybeSave(creds)
            setOpen(false)
            return result
          } catch (retryError) {
            lastError = retryError
            if (!isAuthError(retryError)) {
              // Non-auth error — stop retrying
              setOpen(false)
              throw retryError
            }
            // Auth error — show error and let user try again
            setSubmitting(false)
            setError(t("invalidCredentials"))
            const retryCreds = await new Promise<GitCredentials | null>(
              (resolve) => {
                pendingRef.current = { resolve }
              }
            )
            if (!retryCreds) {
              setOpen(false)
              throw lastError
            }
            creds = retryCreds
          }
        }
      }
    },
    [requestCredentials, t]
  )

  const canSubmitGitHub = token.trim().length > 0
  const canSubmitGeneric =
    username.trim().length > 0 && password.trim().length > 0
  const canSubmit = mode === "github" ? canSubmitGitHub : canSubmitGeneric

  return (
    <GitCredentialContext.Provider value={{ withCredentialRetry }}>
      {children}

      <Dialog open={open} onOpenChange={(v) => !v && handleCancel()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {mode === "github" ? (
                <Github className="h-4 w-4" />
              ) : (
                <KeyRound className="h-4 w-4" />
              )}
              {mode === "github" ? t("githubTitle") : t("title")}
            </DialogTitle>
            <DialogDescription>
              {mode === "github" ? t("githubDescription") : t("description")}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {mode === "github" ? (
              /* ---- GitHub Token Mode ---- */
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-muted-foreground">
                    {t("githubToken")}
                  </label>
                  <Button
                    type="button"
                    variant="link"
                    size="xs"
                    className="h-auto p-0 text-xs"
                    onClick={handleGenerateToken}
                    disabled={submitting}
                  >
                    {t("generateToken")}
                    <ExternalLink className="ml-1 h-3 w-3" />
                  </Button>
                </div>
                <div className="relative">
                  <Input
                    type={showToken ? "text" : "password"}
                    value={token}
                    onChange={(e) => {
                      setToken(e.target.value)
                      setError(null)
                    }}
                    placeholder={t("githubTokenPlaceholder")}
                    disabled={submitting}
                    className="pr-9"
                    autoFocus
                    {...ime.props}
                    onKeyDown={(e) => {
                      if (ime.isComposing(e)) return
                      if (e.key === "Enter" && canSubmitGitHub) handleSubmit()
                    }}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="absolute right-1 top-1/2 -translate-y-1/2 h-6 w-6 p-0"
                    onClick={() => setShowToken(!showToken)}
                    tabIndex={-1}
                  >
                    {showToken ? (
                      <EyeOff className="h-3.5 w-3.5" />
                    ) : (
                      <Eye className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </div>
                <p className="text-2xs text-muted-foreground">
                  {t("githubTokenHint")}
                </p>
              </div>
            ) : (
              /* ---- Generic Mode ---- */
              <>
                <div className="space-y-2">
                  <label className="text-xs font-medium text-muted-foreground">
                    {t("username")}
                  </label>
                  <Input
                    value={username}
                    onChange={(e) => {
                      setUsername(e.target.value)
                      setError(null)
                    }}
                    placeholder={t("usernamePlaceholder")}
                    disabled={submitting}
                    autoFocus
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-medium text-muted-foreground">
                    {t("password")}
                  </label>
                  <div className="relative">
                    <Input
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(e) => {
                        setPassword(e.target.value)
                        setError(null)
                      }}
                      placeholder={t("passwordPlaceholder")}
                      disabled={submitting}
                      className="pr-9"
                      {...ime.props}
                      onKeyDown={(e) => {
                        if (ime.isComposing(e)) return
                        if (e.key === "Enter" && canSubmitGeneric)
                          handleSubmit()
                      }}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="absolute right-1 top-1/2 -translate-y-1/2 h-6 w-6 p-0"
                      onClick={() => setShowPassword(!showPassword)}
                      tabIndex={-1}
                    >
                      {showPassword ? (
                        <EyeOff className="h-3.5 w-3.5" />
                      ) : (
                        <Eye className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </div>
                  <p className="text-2xs text-muted-foreground">
                    {t("passwordHint")}
                  </p>
                </div>
                <label className="inline-flex items-center gap-2 text-xs cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={saveCredentials}
                    onChange={(e) => setSaveCredentials(e.target.checked)}
                    disabled={submitting}
                  />
                  {t("saveCredentials")}
                </label>
              </>
            )}

            {error && (
              <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-400">
                {error}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={handleCancel}
              disabled={submitting}
            >
              {t("cancel")}
            </Button>
            <Button onClick={handleSubmit} disabled={submitting || !canSubmit}>
              {submitting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {t("authenticating")}
                </>
              ) : mode === "github" ? (
                t("githubAuthenticate")
              ) : (
                t("authenticate")
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </GitCredentialContext.Provider>
  )
}
