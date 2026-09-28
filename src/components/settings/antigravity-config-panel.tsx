"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  HardDrive,
  Loader2,
  Save,
  ExternalLink,
} from "lucide-react"
import { toast } from "sonner"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { BrowserLink } from "@/components/ui/browser-link"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import {
  acpAntigravityLoginCancel,
  acpAntigravityLoginFinish,
  acpAntigravityLoginStart,
  acpAntigravitySignOut,
  acpReclaimLeakedTemp,
  acpScanLeakedTemp,
  acpSyncAntigravitySettings,
  type AntigravityLoginOutcome,
  type AntigravityLoginStart,
  type AntigravitySyncReport,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { copyTextToClipboard } from "@/lib/utils"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { AcpAgentInfo, LeakedTempScan } from "@/lib/types"

/** codeg-side knob recording the chosen auth method. The agent reads NOTHING
 * from it — its auth intent comes from `auth.type` in
 * `<GEMINI_HOME>/antigravity-acp/settings.json` — so the launch path uses it
 * twice: to write that file, and to scrub the credential vars the other
 * methods use (`apply_antigravity_env_policy` in `acp/connection.rs`). */
const AGY_AUTH_METHOD_ENV = "AGY_AUTH_METHOD"
/** The Gemini Developer API key, read when `auth.type = gemini-api-key`. */
const GEMINI_API_KEY_ENV = "GEMINI_API_KEY"
/** Agent Platform's own key. Mutually exclusive with the project/location
 * pair: when it is set the server suppresses both (its `_vertex_config` logs
 * "project and location suppressed by the key"). */
const GOOGLE_API_KEY_ENV = "GOOGLE_API_KEY"
const GOOGLE_CLOUD_PROJECT_ENV = "GOOGLE_CLOUD_PROJECT"
const GOOGLE_CLOUD_LOCATION_ENV = "GOOGLE_CLOUD_LOCATION"

/** Every key this panel owns, so the settings page can fold the whole set into
 * the raw env draft (see `persistEnv`'s `draftEnvPatch`). */
export const ANTIGRAVITY_ENV_KEYS = [
  AGY_AUTH_METHOD_ENV,
  GEMINI_API_KEY_ENV,
  GOOGLE_API_KEY_ENV,
  GOOGLE_CLOUD_PROJECT_ENV,
  GOOGLE_CLOUD_LOCATION_ENV,
] as const

/**
 * The four `auth.type` values Antigravity's ACP server accepts, in the order it
 * advertises them at `initialize`. The pre-rebrand `vertex-ai` spelling is
 * still accepted by the server but never written by codeg — a second name for
 * one method would render as two buttons.
 */
export type AntigravityAuthMethod =
  | "oauth-personal"
  | "oauth-business"
  | "gemini-api-key"
  | "agent-platform"

const AUTH_METHODS: AntigravityAuthMethod[] = [
  "oauth-personal",
  "oauth-business",
  "gemini-api-key",
  "agent-platform",
]

function isAuthMethod(value: string): value is AntigravityAuthMethod {
  return (AUTH_METHODS as string[]).includes(value)
}

/** The persisted method, defaulting to the browser login — the one path that
 * needs no credential of its own, and the one most users are on. */
export function inferAntigravityMethod(
  env: Record<string, string>
): AntigravityAuthMethod {
  const explicit = (env[AGY_AUTH_METHOD_ENV] ?? "").trim()
  return isAuthMethod(explicit) ? explicit : "oauth-personal"
}

export interface AntigravityFormValues {
  method: AntigravityAuthMethod
  geminiApiKey: string
  googleApiKey: string
  gcpProject: string
  gcpLocation: string
}

/**
 * Build the env map to persist.
 *
 * Only the credentials the chosen method actually consumes are written; every
 * other one is DELETED rather than left behind. That matters because the
 * method and the credential are not independent here — a `GEMINI_API_KEY` left
 * over from a previous choice would authenticate the user as something they
 * did not pick, and would contradict the `auth.type` the same launch writes to
 * `settings.json`. (The launch path scrubs them again for the same reason; this
 * is the half that keeps the stored row honest.)
 *
 * `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_LOCATION` are kept for BOTH
 * `agent-platform` (which reads them from the environment) and `oauth-business`
 * (which reads project/location from `settings.json` only — the launch path
 * copies them into the `gcp` block from these same values).
 *
 * Unrelated keys are preserved untouched.
 */
export function buildAntigravityEnv(
  prevEnv: Record<string, string>,
  values: AntigravityFormValues
): Record<string, string> {
  const env: Record<string, string> = { ...prevEnv }
  const set = (key: string, value: string) => {
    const trimmed = value.trim()
    if (trimmed) {
      env[key] = trimmed
    } else {
      delete env[key]
    }
  }

  env[AGY_AUTH_METHOD_ENV] = values.method
  for (const key of [
    GEMINI_API_KEY_ENV,
    GOOGLE_API_KEY_ENV,
    GOOGLE_CLOUD_PROJECT_ENV,
    GOOGLE_CLOUD_LOCATION_ENV,
  ]) {
    delete env[key]
  }

  if (values.method === "gemini-api-key") {
    set(GEMINI_API_KEY_ENV, values.geminiApiKey)
  }
  if (values.method === "agent-platform") {
    set(GOOGLE_API_KEY_ENV, values.googleApiKey)
    // The API key suppresses project/location server-side, so writing all
    // three would silently ignore two of them. Keep the row matching what the
    // server will actually use.
    if (!values.googleApiKey.trim()) {
      set(GOOGLE_CLOUD_PROJECT_ENV, values.gcpProject)
      set(GOOGLE_CLOUD_LOCATION_ENV, values.gcpLocation)
    }
  }
  if (values.method === "oauth-business") {
    set(GOOGLE_CLOUD_PROJECT_ENV, values.gcpProject)
    set(GOOGLE_CLOUD_LOCATION_ENV, values.gcpLocation)
  }

  return env
}

/**
 * Whether the form can produce a working session, and if not, which
 * translation key explains why.
 *
 * These mirror the server's own `auth_required` messages: `gemini-api-key`
 * needs `GEMINI_API_KEY`; `agent-platform` needs `GOOGLE_API_KEY` **or** both a
 * project and a location; Gemini Enterprise needs both `gcp.project` and
 * `gcp.location` (a partial config falls through to its no-config path).
 * `oauth-personal` needs nothing — the server opens a browser.
 */
export function antigravityIncompleteReason(
  values: AntigravityFormValues
):
  | "missingGeminiApiKey"
  | "missingAgentPlatformConfig"
  | "missingEnterpriseConfig"
  | null {
  const has = (value: string) => value.trim().length > 0
  switch (values.method) {
    case "gemini-api-key":
      return has(values.geminiApiKey) ? null : "missingGeminiApiKey"
    case "agent-platform":
      if (has(values.googleApiKey)) return null
      return has(values.gcpProject) && has(values.gcpLocation)
        ? null
        : "missingAgentPlatformConfig"
    case "oauth-business":
      return has(values.gcpProject) && has(values.gcpLocation)
        ? null
        : "missingEnterpriseConfig"
    default:
      return null
  }
}

/** The two methods that authenticate through Antigravity's own browser flow —
 *  and therefore the only two a machine with no browser cannot complete on its
 *  own. The API-key methods read their credential from the environment. */
function usesBrowserSignIn(method: AntigravityAuthMethod): boolean {
  return method === "oauth-personal" || method === "oauth-business"
}

/** A sign-in that actually produced a link and is waiting to be completed. */
type PendingLogin = Extract<AntigravityLoginStart, { alreadySignedIn: false }>

/**
 * Sign in to Antigravity from a machine that has no browser.
 *
 * Antigravity's OAuth flow is run by the AGENT: it binds a one-shot listener on
 * `127.0.0.1:<random port>`, opens a browser, and blocks for five minutes. On a
 * headless server that browser does not exist, and `webbrowser.open` returns
 * false without raising — so the first session simply hangs and then fails,
 * with no link anywhere the user could open themselves.
 *
 * This runs that same flow out of band and splits it in two: codeg shows the
 * link, the user consents in whatever browser they do have, and codeg — which
 * IS on the machine where that port is listening — performs the redirect their
 * browser could not. See `src-tauri/src/acp/antigravity_login.rs`.
 */
function HeadlessSignIn({
  method,
  disabled,
  needsSave,
}: {
  method: AntigravityAuthMethod
  disabled: boolean
  /** The form would satisfy this method but the STORED row does not yet. The
   *  backend signs in with the persisted environment, so consenting now would
   *  only fail at license resolution afterwards. */
  needsSave: boolean
}) {
  const t = useTranslations("AcpAgentSettings")
  const [pending, setPending] = useState<PendingLogin | null>(null)
  const [redirect, setRedirect] = useState("")
  const [outcome, setOutcome] = useState<AntigravityLoginOutcome | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Read by the abandon effect below, which must NOT re-run whenever the
  // pending attempt changes — only when the attempt stops being ours.
  const pendingRef = useRef<PendingLogin | null>(null)
  pendingRef.current = pending

  // The single owner of "this attempt is over". A pending sign-in belongs to
  // the method it was started for, and behind the handle is an agent process
  // holding a one-shot listener open. Switching methods — or closing the
  // settings page — has to reach the backend, because just forgetting the
  // handle leaves that child blocked for Antigravity's full five minutes.
  useEffect(() => {
    return () => {
      const abandoned = pendingRef.current
      pendingRef.current = null
      if (!abandoned) return
      void acpAntigravityLoginCancel(abandoned.handle).catch(() => {
        // Best-effort: the attempt times out on its own, and by here there is
        // no surface left to report a failed cancel to.
      })
    }
  }, [method])

  // Kept out of the cleanup above so the reset does not also run on unmount,
  // where a state update would be pointless.
  const shownMethod = useRef(method)
  useEffect(() => {
    if (shownMethod.current === method) return
    shownMethod.current = method
    setPending(null)
    setRedirect("")
    setOutcome(null)
  }, [method])

  // The live method, readable after an await. `start` can be in flight for
  // minutes (the backend spawns the agent and waits for it to print a link),
  // and the effects above only see attempts that have already landed in state
  // — so an answer that arrives late has to be checked against this rather
  // than against the `method` its closure captured.
  const currentMethod = useRef(method)
  currentMethod.current = method

  /** Whether a reply that just arrived still belongs on screen. */
  const stillOurs = useCallback(
    (startedFor: AntigravityAuthMethod) =>
      mountedRef.current && currentMethod.current === startedFor,
    []
  )

  const start = useCallback(async () => {
    const startedFor = method
    setBusy(true)
    setOutcome(null)
    setRedirect("")
    try {
      const started = await acpAntigravityLoginStart(startedFor)
      if (!stillOurs(startedFor)) {
        // The panel closed, or the user picked a different method, while the
        // agent was starting up. The handle never reached state, so neither
        // cleanup effect knows about it — cancel it here or its child sits on
        // a loopback listener for the full five minutes. Showing it would be
        // worse still: the link authenticates the OLD method while the form
        // says the new one.
        if (!started.alreadySignedIn) {
          void acpAntigravityLoginCancel(started.handle).catch(() => {})
        }
        return
      }
      if (started.alreadySignedIn) {
        // The agent still had a usable token and authenticated on the spot, so
        // this doubles as a "am I signed in?" check. Reporting it beats letting
        // the user wait out a link that is never coming.
        setOutcome({
          signedIn: true,
          message: t("antigravity.headless.alreadySignedIn"),
          retryable: false,
          credentialPath: null,
        })
      } else {
        setPending(started)
      }
    } catch (e) {
      if (!stillOurs(startedFor)) return
      // NOT `e instanceof Error`: the web transport throws the backend's
      // `{code, message}` JSON verbatim (`web-transport.ts`), so `String(e)`
      // renders "[object Object]" — and does it precisely in server mode,
      // which is the deployment this whole section exists for. Every
      // actionable message ("Google Antigravity is not installed", "no
      // sign-in is waiting") would be lost exactly where it is needed most.
      toast.error(
        `${t("antigravity.headless.startFailed")}: ${toErrorMessage(e)}`
      )
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }, [method, stillOurs, t])

  const finish = useCallback(async () => {
    if (!pending) return
    const startedFor = method
    setBusy(true)
    try {
      const result = await acpAntigravityLoginFinish(pending.handle, redirect)
      // No cancel needed on the late path, unlike `start`: the backend takes
      // and kills the attempt on every outcome, so there is nothing left to
      // strand — only a verdict that no longer describes what is on screen.
      if (!stillOurs(startedFor)) return
      setOutcome(result)
      if (result.signedIn) {
        toast.success(t("antigravity.headless.signedIn"))
      }
      if (!result.retryable) {
        // The redirect went out, and the agent's listener answers exactly one
        // request — so the link on screen is spent whether or not the sign-in
        // worked. Leaving the paste box would invite a second attempt that
        // could only fail. `retryable` marks the one case where it is still
        // live: codeg rejected the paste before sending anything.
        pendingRef.current = null
        setPending(null)
        setRedirect("")
      }
    } catch (e) {
      if (!stillOurs(startedFor)) return
      setOutcome({
        signedIn: false,
        message: toErrorMessage(e),
        // The call never reached a verdict, so nothing is known about the
        // attempt. Keeping the form is the recoverable read: a retry either
        // works, or the backend answers "no sign-in is waiting" in plain
        // words. Clearing it would strand a still-live attempt.
        retryable: true,
        credentialPath: null,
      })
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }, [method, pending, redirect, stillOurs, t])

  const cancel = useCallback(async () => {
    if (!pending) return
    const handle = pending.handle
    // Clearing `pendingRef` here is what keeps the abandon effect from
    // cancelling the same handle a second time when the panel later unmounts.
    pendingRef.current = null
    setPending(null)
    setRedirect("")
    setOutcome(null)
    await acpAntigravityLoginCancel(handle).catch(() => {})
  }, [pending])

  const copyLink = useCallback(async () => {
    if (!pending) return
    if (await copyTextToClipboard(pending.authUrl)) {
      setCopied(true)
      window.setTimeout(() => {
        if (mountedRef.current) setCopied(false)
      }, 1500)
    }
  }, [pending])

  return (
    <div className="space-y-2 rounded-md border border-dashed p-2.5">
      <div>
        <p className="text-2xs font-medium">
          {t("antigravity.headless.title")}
        </p>
        <p className="mt-0.5 text-3xs text-muted-foreground">
          {t("antigravity.headless.description")}
        </p>
      </div>

      {pending ? (
        <div className="space-y-2">
          <div className="space-y-1">
            <p className="text-3xs text-muted-foreground">
              {t("antigravity.headless.step1")}
            </p>
            <div className="flex items-start gap-1.5">
              <code className="block flex-1 overflow-x-auto rounded bg-muted px-2 py-1 font-mono text-3xs whitespace-nowrap text-muted-foreground">
                {pending.authUrl}
              </code>
              <Button
                className="h-7 w-7 shrink-0"
                onClick={() => void copyLink()}
                size="icon"
                title={t("antigravity.headless.copyLink")}
                type="button"
                variant="ghost"
              >
                {copied ? (
                  <Check className="size-3.5" />
                ) : (
                  <Copy className="size-3.5" />
                )}
              </Button>
              {/* The one case where opening it here is useful: a DESKTOP codeg
                  driving a remote agent, or a user browsing the server's panel
                  from their laptop. On the headless host itself it is inert,
                  which is what the copy button beside it is for. */}
              <Button
                asChild
                className="h-7 w-7 shrink-0"
                size="icon"
                variant="ghost"
              >
                <BrowserLink
                  href={pending.authUrl}
                  title={t("antigravity.headless.openLink")}
                >
                  <ExternalLink className="size-3.5" />
                </BrowserLink>
              </Button>
            </div>
          </div>

          <div className="space-y-1">
            <p className="text-3xs text-muted-foreground">
              {t("antigravity.headless.step2", {
                redirectUri: pending.redirectUri,
              })}
            </p>
            <Input
              className="h-7 text-xs"
              disabled={busy}
              onChange={(e) => setRedirect(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && redirect.trim() && !busy) {
                  e.preventDefault()
                  void finish()
                }
              }}
              placeholder={`${pending.redirectUri}?state=...&code=...`}
              value={redirect}
            />
          </div>

          <div className="flex items-center justify-end gap-1.5">
            <Button
              className="h-7 px-2.5 text-xs"
              disabled={busy}
              onClick={() => void cancel()}
              size="sm"
              type="button"
              variant="ghost"
            >
              {t("antigravity.headless.cancel")}
            </Button>
            <Button
              className="h-7 gap-1.5 px-2.5 text-xs"
              disabled={busy || !redirect.trim()}
              onClick={() => void finish()}
              size="sm"
              type="button"
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {t("antigravity.headless.complete")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-1.5">
          {needsSave ? (
            <p className="text-3xs text-amber-600 dark:text-amber-400">
              {t("antigravity.headless.saveFirst")}
            </p>
          ) : null}
          <Button
            className="h-7 gap-1.5 px-2.5 text-xs"
            disabled={disabled || busy}
            onClick={() => void start()}
            size="sm"
            type="button"
            variant="outline"
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {t("antigravity.headless.start")}
          </Button>
        </div>
      )}

      {outcome ? (
        <div
          className={
            outcome.signedIn
              ? "space-y-1 rounded-md border border-emerald-500/40 bg-emerald-500/5 p-2"
              : "space-y-1 rounded-md border border-amber-500/40 bg-amber-500/5 p-2"
          }
        >
          <p
            className={
              outcome.signedIn
                ? "text-2xs text-emerald-600 dark:text-emerald-400"
                : "text-2xs text-amber-600 dark:text-amber-400"
            }
          >
            {outcome.signedIn
              ? t("antigravity.headless.signedIn")
              : t("antigravity.headless.failed")}
          </p>
          {outcome.message ? (
            <p className="text-3xs text-muted-foreground">{outcome.message}</p>
          ) : null}
          {/* The credential is a portable file, so a user with several headless
              machines can sign in once here and copy it to the rest. */}
          {outcome.signedIn && outcome.credentialPath ? (
            <>
              <p className="text-3xs text-muted-foreground">
                {t("antigravity.headless.credentialHint")}
              </p>
              <code className="block overflow-x-auto rounded bg-muted px-2 py-1 font-mono text-3xs whitespace-nowrap text-muted-foreground">
                {outcome.credentialPath}
              </code>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/**
 * Discard the account Antigravity is signed in as.
 *
 * The other half of signing in, and not an optional one. Antigravity refreshes
 * its cached token by itself, so once a credential exists `authenticate` returns
 * without opening anything and the sign-in above can only report "already signed
 * in" — the first Google account a user picks is the last one they get. Nothing
 * they can reach from outside fixes it either: the credential is a login-keychain
 * item on macOS and a file under `GEMINI_HOME` elsewhere, so it survives
 * uninstalling the Antigravity CLI and reinstalling codeg.
 *
 * Only for the two OAuth methods. The API-key methods read their credential from
 * the environment on every request, so there is nothing stored to discard — and
 * the agent's `logout` would clear the saved `auth.type` for no gain.
 */
function SignOut({
  disabled,
  onSignedOut,
}: {
  disabled: boolean
  /** Hands back the settings.json report the sign-out produced, so the panel
   *  can raise its standing notice when that file could not be rewritten. */
  onSignedOut: (report: AntigravitySyncReport) => void
}) {
  const t = useTranslations("AcpAgentSettings")
  const [busy, setBusy] = useState(false)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const signOut = useCallback(async () => {
    setBusy(true)
    try {
      const report = await acpAntigravitySignOut()
      if (!mountedRef.current) return
      onSignedOut(report)
      if (report.status === "skipped") {
        toast.warning(t("toasts.antigravitySyncSkipped"))
      } else {
        toast.success(t("antigravity.signOut.done"))
      }
    } catch (e) {
      // NOT `String(e)`: the web transport throws the backend's `{code,
      // message}` JSON verbatim, and this is the deployment where the
      // actionable text ("Google Antigravity is not installed") matters most.
      toast.error(`${t("antigravity.signOut.failed")}: ${toErrorMessage(e)}`)
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }, [onSignedOut, t])

  return (
    <div className="flex items-start justify-between gap-2 rounded-md border border-dashed p-2.5">
      <div className="min-w-0">
        <p className="text-2xs font-medium">{t("antigravity.signOut.title")}</p>
        <p className="mt-0.5 text-3xs text-muted-foreground">
          {t("antigravity.signOut.description")}
        </p>
      </div>
      <Button
        className="h-7 shrink-0 gap-1.5 px-2.5 text-xs"
        disabled={disabled || busy}
        onClick={() => void signOut()}
        size="sm"
        type="button"
        variant="outline"
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
        {t("antigravity.signOut.action")}
      </Button>
    </div>
  )
}

/**
 * Dedicated settings panel for Google Antigravity (`agy_acp_server`).
 *
 * This panel is load-bearing, not cosmetic. Antigravity's `session/new` fails
 * outright with `Authentication required` unless
 * `<GEMINI_HOME>/antigravity-acp/settings.json` declares an `auth.type`
 * (upstream removed environment-based auth selection), and codeg does not
 * implement the ACP `authenticate` request that would otherwise set it. The
 * choice made here is what the launch path writes to that file — so without it
 * the agent cannot start a single session.
 *
 * Model and session mode are deliberately absent: the server reports both as
 * standard ACP config options, so the composer's own selectors own them per
 * session. A second copy here would only create two places to disagree about
 * what a session runs on.
 */
/** Human-readable byte count. Binary units — these are disk sizes. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`
}

/**
 * One-time reclamation of temp directories leaked by launches from BEFORE
 * per-launch isolation shipped.
 *
 * Scan-then-confirm rather than a silent sweep, and the copy says why: the
 * directories live in the system temp dir, which every PyInstaller application
 * shares. codeg cannot tell its own leftovers from another app's, so deleting
 * them is the user's call, not codeg's.
 */
function LeakedTempSection() {
  const t = useTranslations("AcpAgentSettings")
  const [scan, setScan] = useState<LeakedTempScan | null>(null)
  /** Paths the user has explicitly opted in. Starts empty — see the render. */
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [failed, setFailed] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const runScan = useCallback(async () => {
    setBusy(true)
    try {
      setScan(await acpScanLeakedTemp())
      // A new scan is a new set of paths; carrying ticks across would let a
      // path the user never looked at arrive pre-approved.
      setSelected(new Set())
      setFailed([])
    } catch (err) {
      toast.error(toErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }, [])

  const chosen = useMemo(
    () => scan?.entries.filter((entry) => selected.has(entry.path)) ?? [],
    [scan, selected]
  )
  const chosenBytes = chosen.reduce((total, entry) => total + entry.bytes, 0)

  const runReclaim = useCallback(async () => {
    setConfirming(false)
    if (chosen.length === 0) return
    setBusy(true)
    try {
      const result = await acpReclaimLeakedTemp(chosen.map((e) => e.path))
      toast.success(
        t("antigravity.tempReclaimed", {
          count: result.removed,
          size: formatBytes(result.freed_bytes),
        })
      )
      // Every failure, not just the first: "removed 3 of 5" with three
      // unexplained survivors is the report that wastes the next hour.
      setFailed(result.failed)
      setScan(await acpScanLeakedTemp())
      setSelected(new Set())
    } catch (err) {
      toast.error(toErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }, [chosen, t])

  const toggle = useCallback((path: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (on) next.add(path)
      else next.delete(path)
      return next
    })
  }, [])

  const allChecked: boolean | "indeterminate" =
    scan && scan.entries.length > 0 && selected.size === scan.entries.length
      ? true
      : selected.size > 0
        ? "indeterminate"
        : false

  return (
    <div className="space-y-1.5 rounded-md border bg-background/60 p-2.5">
      <div className="flex items-center gap-1.5">
        <HardDrive className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-medium">
          {t("antigravity.tempReclaimTitle")}
        </span>
      </div>
      <p className="text-3xs text-muted-foreground">
        {t("antigravity.tempReclaimHint")}
      </p>

      {scan ? (
        <div className="space-y-1">
          <p className="text-2xs">
            {scan.entries.length === 0
              ? t("antigravity.tempReclaimNone")
              : t("antigravity.tempReclaimFound", {
                  count: scan.entries.length,
                  size: formatBytes(scan.total_bytes),
                })}
          </p>
          {scan.skipped > 0 ? (
            <p className="text-3xs text-muted-foreground">
              {t("antigravity.tempReclaimSkipped", { count: scan.skipped })}
            </p>
          ) : null}
          <code className="block overflow-x-auto rounded bg-muted px-2 py-1 font-mono text-3xs whitespace-nowrap text-muted-foreground">
            {scan.root}
          </code>

          {/* Nothing is pre-ticked, and every path is shown. The hint above
              says codeg cannot tell its own leftovers from another
              application's; a single button that deleted all of them would be
              asking the user to take responsibility for a list they were never
              shown. */}
          {scan.entries.length > 0 ? (
            <div className="rounded border">
              <label className="flex items-center gap-2 border-b px-2 py-1">
                <Checkbox
                  checked={allChecked}
                  disabled={busy}
                  onCheckedChange={(value) =>
                    setSelected(
                      value === true
                        ? new Set(scan.entries.map((e) => e.path))
                        : new Set()
                    )
                  }
                />
                <span className="text-3xs text-muted-foreground">
                  {t("antigravity.tempReclaimSelectAll")}
                </span>
              </label>
              <div className="max-h-40 overflow-y-auto">
                {scan.entries.map((entry) => (
                  <label
                    className="flex items-center gap-2 px-2 py-1 hover:bg-muted/50"
                    key={entry.path}
                  >
                    <Checkbox
                      checked={selected.has(entry.path)}
                      disabled={busy}
                      onCheckedChange={(value) =>
                        toggle(entry.path, value === true)
                      }
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-3xs">
                      {entry.path}
                    </span>
                    <span className="shrink-0 text-3xs tabular-nums text-muted-foreground">
                      {formatBytes(entry.bytes)}
                    </span>
                    <span className="shrink-0 text-3xs tabular-nums text-muted-foreground">
                      {t("antigravity.tempReclaimAgeHours", {
                        hours: entry.age_hours,
                      })}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          ) : null}

          {failed.length > 0 ? (
            <ul className="space-y-0.5">
              {failed.map((message) => (
                <li className="text-3xs text-destructive" key={message}>
                  {message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="flex justify-end gap-1.5">
        <Button
          className="h-7 gap-1.5 px-2.5 text-xs"
          disabled={busy}
          onClick={() => void runScan()}
          size="sm"
          type="button"
          variant="outline"
        >
          {busy && !scan ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : null}
          {t("antigravity.tempReclaimScan")}
        </Button>
        {scan && scan.entries.length > 0 ? (
          <AlertDialog onOpenChange={setConfirming} open={confirming}>
            <AlertDialogTrigger asChild>
              <Button
                className="h-7 gap-1.5 px-2.5 text-xs"
                disabled={busy || chosen.length === 0}
                size="sm"
                type="button"
                variant="destructive"
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                {t("antigravity.tempReclaimDelete")}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t("antigravity.tempReclaimConfirmTitle", {
                    count: chosen.length,
                  })}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t("antigravity.tempReclaimConfirmBody", {
                    size: formatBytes(chosenBytes),
                  })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>
                  {t("antigravity.tempReclaimCancel")}
                </AlertDialogCancel>
                <AlertDialogAction onClick={() => void runReclaim()}>
                  {t("antigravity.tempReclaimConfirmAction")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null}
      </div>
    </div>
  )
}

export function AntigravityConfigPanel({
  agent,
  saving,
  onSaveEnv,
  onSaved,
}: {
  agent: AcpAgentInfo
  saving: boolean
  onSaveEnv: (env: Record<string, string>, enabled: boolean) => Promise<unknown>
  onSaved: () => void
}) {
  const t = useTranslations("AcpAgentSettings")

  const [method, setMethod] = useState<AntigravityAuthMethod>(() =>
    inferAntigravityMethod(agent.env)
  )
  const [geminiApiKey, setGeminiApiKey] = useState(
    () => agent.env[GEMINI_API_KEY_ENV] ?? ""
  )
  const [googleApiKey, setGoogleApiKey] = useState(
    () => agent.env[GOOGLE_API_KEY_ENV] ?? ""
  )
  const [gcpProject, setGcpProject] = useState(
    () => agent.env[GOOGLE_CLOUD_PROJECT_ENV] ?? ""
  )
  const [gcpLocation, setGcpLocation] = useState(
    () => agent.env[GOOGLE_CLOUD_LOCATION_ENV] ?? ""
  )
  const [showKey, setShowKey] = useState(false)
  const [savingForm, setSavingForm] = useState(false)
  /** The last save whose settings.json write was REFUSED, or null. Held rather
   *  than left to the toast: this is a standing disagreement between the form
   *  and the file the agent reads, and it stays true until someone edits that
   *  file — a notice that scrolls away after four seconds would not say so. */
  const [syncSkip, setSyncSkip] = useState<AntigravitySyncReport | null>(null)

  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Re-seed when the persisted row changes UNDER the panel (the settings page
  // refetches after every save, and another window can rewrite it). Edits in
  // progress win: `dirty` is a ref set by the change handlers rather than a
  // comparison against current state, because that state must NOT be a
  // dependency — between a save completing and the refresh it triggers, the
  // form already holds what was stored while `agent` still holds the pre-save
  // values, and a re-run would revert the save on screen.
  const persisted = useMemo(
    () => ({
      method: inferAntigravityMethod(agent.env),
      geminiApiKey: agent.env[GEMINI_API_KEY_ENV] ?? "",
      googleApiKey: agent.env[GOOGLE_API_KEY_ENV] ?? "",
      gcpProject: agent.env[GOOGLE_CLOUD_PROJECT_ENV] ?? "",
      gcpLocation: agent.env[GOOGLE_CLOUD_LOCATION_ENV] ?? "",
    }),
    [agent.env]
  )
  const seeded = useRef(persisted)
  const dirty = useRef(false)
  useEffect(() => {
    const previous = seeded.current
    const changed =
      previous.method !== persisted.method ||
      previous.geminiApiKey !== persisted.geminiApiKey ||
      previous.googleApiKey !== persisted.googleApiKey ||
      previous.gcpProject !== persisted.gcpProject ||
      previous.gcpLocation !== persisted.gcpLocation
    if (!changed) return
    seeded.current = persisted
    if (dirty.current) return
    setMethod(persisted.method)
    setGeminiApiKey(persisted.geminiApiKey)
    setGoogleApiKey(persisted.googleApiKey)
    setGcpProject(persisted.gcpProject)
    setGcpLocation(persisted.gcpLocation)
  }, [persisted])

  const values: AntigravityFormValues = {
    method,
    geminiApiKey,
    googleApiKey,
    gcpProject,
    gcpLocation,
  }
  const valuesRef = useRef(values)
  useEffect(() => {
    valuesRef.current = values
  })

  const incomplete = antigravityIncompleteReason(values)
  // The sign-in runs against the STORED row, not this form: the backend builds
  // the agent's environment from the database, so a project typed but not saved
  // is a project the sign-in will not see. Gating on the draft would let a user
  // spend a whole Google consent round trip and only then fail license
  // resolution — the exact friction this section exists to remove.
  //
  // The METHOD counts as one of those values, and it is the sharper half. An
  // unsaved switch to `oauth-personal` needs no credential, so the field check
  // alone passes it: the sign-in then genuinely succeeds and the panel says
  // "new sessions will use this account" — while the next launch reads the OLD
  // method from the database and rewrites `auth.type` back to it
  // (`sync_antigravity_settings_file`), scrubbing this method's credentials on
  // the way. The user is returned to the five-minute failure they came here to
  // escape, having been told they were signed in.
  const persistedIncomplete =
    method !== persisted.method
      ? "unsavedMethod"
      : antigravityIncompleteReason({ ...persisted, method })

  const save = useCallback(async () => {
    setSavingForm(true)
    const submitted = valuesRef.current
    try {
      await onSaveEnv(buildAntigravityEnv(agent.env, submitted), agent.enabled)
      // Only the exact values that just landed stop counting as an unsaved
      // edit: the form stays editable while the request is in flight, so
      // anything changed since is NEWER than what was stored.
      if (valuesRef.current === submitted) dirty.current = false

      // Storing the row is only half of a save. What actually authenticates
      // Antigravity is `auth.type` in the server's settings.json, and that file
      // is the user's — it can legitimately be Hjson with comments, or hold an
      // `auth` key of a shape codeg refuses to overwrite — in which case the
      // launch leaves it alone and only writes a log line. Saying "saved"
      // regardless was claiming something that had not happened, and the
      // consequence lands later and elsewhere: switching methods scrubs the
      // credentials for the NEW method while the server still reads the OLD
      // auth.type, so the next session fails with no credential for the method
      // it believes it is using. Ask, and say so while the user is still here.
      let report: AntigravitySyncReport | null = null
      try {
        report = await acpSyncAntigravitySettings()
      } catch {
        // The sync is a report, not the save. A transport failure leaves the
        // row stored and the launch-time sync still to come, so it must not
        // turn a successful save into a failed one.
      }
      if (mountedRef.current)
        setSyncSkip(report?.status === "skipped" ? report : null)
      if (report?.status === "skipped") {
        toast.warning(t("toasts.antigravitySyncSkipped"))
      } else {
        toast.success(t("toasts.antigravitySaved"))
      }
      onSaved()
    } catch (e) {
      toast.error(
        `${t("toasts.saveAntigravityConfigFailed")}: ${toErrorMessage(e)}`
      )
    } finally {
      if (mountedRef.current) setSavingForm(false)
    }
  }, [agent.enabled, agent.env, onSaveEnv, onSaved, t])

  // A sign-out clears `auth.type` on its way out and the backend writes the
  // saved method straight back, so its report lands in the same standing notice
  // a save's does — and matters more here: if that write was refused the file
  // now names no method at all, and every session fails until someone edits it.
  const onSignedOut = useCallback((report: AntigravitySyncReport) => {
    setSyncSkip(report.status === "skipped" ? report : null)
  }, [])

  const busy = saving || savingForm
  const markDirty = () => {
    dirty.current = true
  }

  return (
    <div className="space-y-3 rounded-md border bg-muted/10 p-3">
      <div>
        <label className="text-xs font-medium">{t("configManagement")}</label>
        <p className="mt-1 text-2xs text-muted-foreground">
          {t("antigravity.configDescription")}
        </p>
      </div>

      <div className="space-y-2 rounded-md border bg-background/60 p-2.5">
        <div className="space-y-1">
          <label
            className="text-2xs text-muted-foreground"
            htmlFor="antigravity-auth-method"
          >
            {t("antigravity.methodLabel")}
          </label>
          <Select
            onValueChange={(value) => {
              if (!isAuthMethod(value)) return
              markDirty()
              setMethod(value)
            }}
            value={method}
          >
            <SelectTrigger className="h-7 text-xs" id="antigravity-auth-method">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AUTH_METHODS.map((value) => (
                <SelectItem key={value} value={value}>
                  {t(`antigravity.methods.${value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-3xs text-muted-foreground">
            {t(`antigravity.methodHints.${method}`)}
          </p>
        </div>

        {method === "gemini-api-key" ? (
          <div className="space-y-1">
            <label
              className="text-2xs text-muted-foreground"
              htmlFor="antigravity-gemini-key"
            >
              {t("antigravity.geminiApiKeyLabel")}
            </label>
            <div className="flex items-center gap-1.5">
              <Input
                className="h-7 flex-1 text-xs"
                id="antigravity-gemini-key"
                onChange={(e) => {
                  markDirty()
                  setGeminiApiKey(e.target.value)
                }}
                placeholder="AIza..."
                type={showKey ? "text" : "password"}
                value={geminiApiKey}
              />
              <Button
                className="h-7 w-7 shrink-0"
                onClick={() => setShowKey((v) => !v)}
                size="icon"
                title={
                  showKey ? t("actions.hideApiKey") : t("actions.showApiKey")
                }
                type="button"
                variant="ghost"
              >
                {showKey ? (
                  <EyeOff className="h-3.5 w-3.5" />
                ) : (
                  <Eye className="h-3.5 w-3.5" />
                )}
              </Button>
            </div>
          </div>
        ) : null}

        {method === "agent-platform" ? (
          <div className="space-y-1">
            <label
              className="text-2xs text-muted-foreground"
              htmlFor="antigravity-google-key"
            >
              {t("antigravity.googleApiKeyLabel")}
            </label>
            <div className="flex items-center gap-1.5">
              <Input
                className="h-7 flex-1 text-xs"
                id="antigravity-google-key"
                onChange={(e) => {
                  markDirty()
                  setGoogleApiKey(e.target.value)
                }}
                placeholder="AIza..."
                type={showKey ? "text" : "password"}
                value={googleApiKey}
              />
              <Button
                className="h-7 w-7 shrink-0"
                onClick={() => setShowKey((v) => !v)}
                size="icon"
                title={
                  showKey ? t("actions.hideApiKey") : t("actions.showApiKey")
                }
                type="button"
                variant="ghost"
              >
                {showKey ? (
                  <EyeOff className="h-3.5 w-3.5" />
                ) : (
                  <Eye className="h-3.5 w-3.5" />
                )}
              </Button>
            </div>
            <p className="text-3xs text-muted-foreground">
              {t("antigravity.googleApiKeyHint")}
            </p>
          </div>
        ) : null}

        {method === "oauth-business" ||
        (method === "agent-platform" && !googleApiKey.trim()) ? (
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label
                className="text-2xs text-muted-foreground"
                htmlFor="antigravity-gcp-project"
              >
                {t("antigravity.gcpProjectLabel")}
              </label>
              <Input
                className="h-7 text-xs"
                id="antigravity-gcp-project"
                onChange={(e) => {
                  markDirty()
                  setGcpProject(e.target.value)
                }}
                placeholder="my-project"
                value={gcpProject}
              />
            </div>
            <div className="space-y-1">
              <label
                className="text-2xs text-muted-foreground"
                htmlFor="antigravity-gcp-location"
              >
                {t("antigravity.gcpLocationLabel")}
              </label>
              <Input
                className="h-7 text-xs"
                id="antigravity-gcp-location"
                onChange={(e) => {
                  markDirty()
                  setGcpLocation(e.target.value)
                }}
                placeholder="global"
                value={gcpLocation}
              />
            </div>
          </div>
        ) : null}

        {incomplete ? (
          <p className="text-2xs text-amber-600 dark:text-amber-400">
            {t(`antigravity.${incomplete}`)}
          </p>
        ) : null}

        {/* Only for the browser-driven methods, and only once the form can
            actually produce a working session — Gemini Enterprise resolves a
            license against gcp.project/location during sign-in, so starting one
            without them just burns an attempt. `disabled` rather than hidden:
            the section explains the headless problem, which is exactly what a
            user who cannot complete the flow needs to read. */}
        {usesBrowserSignIn(method) ? (
          <HeadlessSignIn
            disabled={busy || persistedIncomplete !== null}
            method={method}
            needsSave={persistedIncomplete !== null && incomplete === null}
          />
        ) : null}

        {/* Not gated on `persistedIncomplete`, unlike the sign-in beside it:
            discarding a credential needs no project, no location and no key,
            and a user whose stored row is half-filled is exactly the one who
            may need to get out of the account it belongs to. */}
        {usesBrowserSignIn(method) ? (
          <SignOut disabled={busy} onSignedOut={onSignedOut} />
        ) : null}

        {/* The save landed in the database but not in the file the server
            reads, so the choice above is NOT what the next session will
            authenticate with. Names the file and the reason, because the fix
            is to edit that file by hand — codeg will not touch it again. */}
        {syncSkip ? (
          <div className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/5 p-2">
            <p className="text-2xs text-amber-600 dark:text-amber-400">
              {t("antigravity.syncSkipped")}
            </p>
            {syncSkip.reason ? (
              <p className="text-3xs text-muted-foreground">
                {syncSkip.reason}
              </p>
            ) : null}
            <code className="block overflow-x-auto rounded bg-muted px-2 py-1 font-mono text-3xs whitespace-nowrap text-muted-foreground">
              {syncSkip.path}
            </code>
          </div>
        ) : null}

        {agent.config_file_path ? (
          <div className="space-y-1">
            <p className="text-3xs text-muted-foreground">
              {t("antigravity.settingsFileHint")}
            </p>
            <code className="block overflow-x-auto rounded bg-muted px-2 py-1 font-mono text-3xs whitespace-nowrap text-muted-foreground">
              {agent.config_file_path}
            </code>
          </div>
        ) : null}

        <LeakedTempSection />

        <div className="flex justify-end">
          <Button
            className="h-7 gap-1.5 px-2.5 text-xs"
            disabled={busy}
            onClick={() => void save()}
            size="sm"
            type="button"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            {t("antigravity.save")}
          </Button>
        </div>
      </div>
    </div>
  )
}
