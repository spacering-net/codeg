"use client"

import { useCallback, useState } from "react"
import { ExternalLink, Eye, EyeOff, Loader2 } from "lucide-react"
import { openUrl } from "@/lib/platform"
import { useTranslations } from "next-intl"
import { randomUUID } from "@/lib/utils"
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
import {
  validateGitHubToken,
  validateGitLabToken,
  validateGiteaToken,
  saveAccountToken,
} from "@/lib/api"
import type { ForgeProviderId, GitHubAccount } from "@/lib/types"
import { toErrorMessage } from "@/lib/app-error"

interface AddForgeAccountDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAccountAdded: (account: GitHubAccount) => void
  isFirstAccount: boolean
  /** Which forge the token is for. It picks the endpoint the token is checked
   *  against AND is stored on the account, which is what later tells a
   *  self-hosted host apart from a GitHub Enterprise one. */
  provider: ForgeProviderId
  /** Set to replace an existing account's token IN PLACE — same id, same
   *  server, new secret. A token expires or gets rotated as a matter of
   *  routine, and every task that was triggered by this account is pinned to
   *  its id: remove-and-re-add mints a new one and leaves those tasks with no
   *  identity that can deliver them. */
  existing?: GitHubAccount | null
}

/** Where each forge lets you mint a token, with the scopes codeg needs
 *  pre-selected where the forge's own page accepts them in the query. GitLab's
 *  single `api` scope covers reads, merge requests and notes; GitHub wants the
 *  classic-token set; Gitea takes NO query parameters at all — its token page
 *  is a form with scope checkboxes, so the link only opens it and the hint
 *  below says which boxes to tick. */
function tokenPageUrl(provider: ForgeProviderId, serverUrl: string): string {
  const base =
    serverUrl.trim().replace(/\/+$/, "") || defaultServerUrl(provider)
  if (provider === "gitlab") {
    const params = new URLSearchParams({ name: "codeg", scopes: "api" })
    return `${base}/-/user_settings/personal_access_tokens?${params.toString()}`
  }
  if (provider === "gitea") {
    return `${base}/user/settings/applications`
  }
  const params = new URLSearchParams({
    description: "codeg",
    scopes: "repo,read:org,workflow,gist,read:user,user:email",
  })
  return `${base}/settings/tokens/new?${params.toString()}`
}

function defaultServerUrl(provider: ForgeProviderId): string {
  if (provider === "gitlab") return "https://gitlab.com"
  // gitea.com is the public instance, but a Gitea is far more often somebody's
  // own — the field stays editable and the placeholder says so.
  if (provider === "gitea") return "https://gitea.com"
  return "https://github.com"
}

/** Which "who am I" endpoint checks the token. Keyed by provider rather than
 *  branched on one, so a forge added later has exactly one place to appear. */
const VALIDATORS: Record<ForgeProviderId, typeof validateGitHubToken> = {
  github: validateGitHubToken,
  gitlab: validateGitLabToken,
  gitea: validateGiteaToken,
}

/** The dialog's own copy, per forge. Same keys, same order, one lookup — which
 *  is what keeps a new forge from silently inheriting GitHub's wording.
 *
 *  `as const satisfies` rather than an annotation: the annotation would widen
 *  these to `string`, and next-intl checks message keys as literals. */
const COPY = {
  github: { description: "githubDescription", tokenHint: "tokenHint" },
  gitlab: { description: "gitlabDescription", tokenHint: "gitlabTokenHint" },
  gitea: { description: "giteaDescription", tokenHint: "giteaTokenHint" },
} as const satisfies Record<
  ForgeProviderId,
  { description: string; tokenHint: string }
>

/**
 * Add a forge credential: type a token, check it against that forge's "who am
 * I" endpoint, store the token in the keyring and the account beside it.
 *
 * One dialog for every forge because the flow is identical — only the endpoint,
 * the token page and the wording differ. Neither GitLab nor Gitea has a
 * `gh auth token` equivalent to lift a credential from, so typing a personal
 * access token is the only way in, which is exactly why it is validated here
 * rather than at delivery time on a task that already ran.
 */
export function AddForgeAccountDialog({
  open,
  onOpenChange,
  onAccountAdded,
  isFirstAccount,
  provider,
  existing,
}: AddForgeAccountDialogProps) {
  const t = useTranslations("VersionControlSettings")
  const copy = COPY[provider]
  const rotating = existing != null

  const [serverUrl, setServerUrl] = useState(
    existing?.server_url || defaultServerUrl(provider)
  )
  const [token, setToken] = useState("")
  const [showToken, setShowToken] = useState(false)
  const [validating, setValidating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleGenerateToken = useCallback(async () => {
    try {
      await openUrl(tokenPageUrl(provider, serverUrl))
    } catch {
      // fallback: ignore if opener fails
    }
  }, [provider, serverUrl])

  const resetForm = useCallback(() => {
    setServerUrl(existing?.server_url || defaultServerUrl(provider))
    setToken("")
    setShowToken(false)
    setValidating(false)
    setError(null)
  }, [existing, provider])

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        resetForm()
      }
      onOpenChange(nextOpen)
    },
    [onOpenChange, resetForm]
  )

  const handleSubmit = useCallback(async () => {
    const trimmedToken = token.trim()
    if (!trimmedToken) {
      setError(t("addFailed", { message: "Token is required" }))
      return
    }

    setValidating(true)
    setError(null)

    try {
      const result = await VALIDATORS[provider](serverUrl.trim(), trimmedToken)

      if (!result.success) {
        setError(
          t("addFailed", { message: result.message ?? "Validation failed" })
        )
        return
      }

      // Rotating keeps the id — that id is what every task triggered by this
      // account is pinned to, and it is the whole point of this path.
      const account: GitHubAccount = {
        id: existing?.id ?? randomUUID(),
        server_url: serverUrl.trim() || defaultServerUrl(provider),
        username: result.username ?? "unknown",
        scopes: result.scopes,
        avatar_url: result.avatar_url,
        is_default: existing?.is_default ?? isFirstAccount,
        created_at: existing?.created_at ?? new Date().toISOString(),
        provider,
      }

      await saveAccountToken(account.id, trimmedToken)
      onAccountAdded(account)
      handleOpenChange(false)
    } catch (err) {
      const message = toErrorMessage(err)
      setError(t("addFailed", { message }))
    } finally {
      setValidating(false)
    }
  }, [
    existing,
    provider,
    serverUrl,
    token,
    isFirstAccount,
    onAccountAdded,
    handleOpenChange,
    t,
  ])

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {rotating ? t("updateTokenTitle") : t("addAccount")}
          </DialogTitle>
          <DialogDescription>
            {rotating
              ? t("updateTokenDescription", { username: existing.username })
              : t(copy.description)}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">
              {t("serverUrl")}
            </label>
            <Input
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder={t("serverUrlPlaceholder")}
              // The server is what the account IS; changing it here would be a
              // different account wearing this one's id.
              disabled={rotating}
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-muted-foreground">
                {t("token")}
              </label>
              <Button
                type="button"
                variant="link"
                size="xs"
                className="h-auto p-0 text-xs"
                onClick={handleGenerateToken}
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
                placeholder={t("tokenPlaceholder")}
                className="pr-9"
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
              {t(copy.tokenHint)}
            </p>
          </div>

          {error && (
            <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-400">
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button onClick={handleSubmit} disabled={validating || !token.trim()}>
            {validating ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t("validating")}
              </>
            ) : rotating ? (
              t("updateTokenSubmit")
            ) : (
              t("validateAndAdd")
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
