"use client"

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { useTranslations } from "next-intl"
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  HardDrive,
  Loader2,
  Save,
  ShieldCheck,
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
  type AntigravityLoginOutcome,
  type AntigravityLoginStart,
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

/**
 * codeg 侧记录所选认证方式的开关。`agy acp` 不会读取它，启动路径用它决定：
 * 1) 哪些凭据环境变量允许透传给子进程（`apply_antigravity_env_policy`）；
 * 2) 是否在握手阶段发送非交互式 `authenticate`（`gemini-api-key` / `agent-platform`）。
 */
const AGY_AUTH_METHOD_ENV = "AGY_AUTH_METHOD"
/** The Gemini Developer API key, read when `auth.type = gemini-api-key`. */
const GEMINI_API_KEY_ENV = "GEMINI_API_KEY"
/** Agent Platform's own key. Mutually exclusive with the project/location
 * pair: when it is set the server suppresses both (its `_vertex_config` logs
 * "project and location suppressed by the key"). */
const GOOGLE_API_KEY_ENV = "GOOGLE_API_KEY"
const GOOGLE_CLOUD_PROJECT_ENV = "GOOGLE_CLOUD_PROJECT"
const GOOGLE_CLOUD_LOCATION_ENV = "GOOGLE_CLOUD_LOCATION"
/** codeg 侧权限模式启动旋钮："1" 启动 `agy acp --dangerously-skip-permissions`
 * （Turbo 模式，自动批准所有工具权限请求），"0" 或未设置则保持默认，由会话 mode
 * 与权限规则决定。`agy` 本身不读取该环境变量，由后端启动路径转换为 CLI 参数。 */
const AGY_DANGEROUSLY_SKIP_PERMISSIONS_ENV = "AGY_DANGEROUSLY_SKIP_PERMISSIONS"

/** Every key this panel owns, so the settings page can fold the whole set into
 * the raw env draft (see `persistEnv`'s `draftEnvPatch`). */
export const ANTIGRAVITY_ENV_KEYS = [
  AGY_AUTH_METHOD_ENV,
  GEMINI_API_KEY_ENV,
  GOOGLE_API_KEY_ENV,
  GOOGLE_CLOUD_PROJECT_ENV,
  GOOGLE_CLOUD_LOCATION_ENV,
  AGY_DANGEROUSLY_SKIP_PERMISSIONS_ENV,
] as const

/**
 * The four auth method ids `agy acp` advertises at `initialize`, in its order.
 * The pre-rebrand `vertex-ai` spelling is still accepted by the CLI but never
 * written by codeg — a second name for one method would render as two buttons.
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

export type AntigravityPermissionMode = "default" | "turbo"

/** 读取下次启动将使用的权限模式（与后端 `antigravity_skip_permissions_enabled` 对齐）：
 * 仅显式 `"1"` / `"true"` 启用 Turbo 模式，其余回退为默认询问模式。 */
export function antigravityPermissionModeFromEnv(
  env: Record<string, string>
): AntigravityPermissionMode {
  const value = (env[AGY_DANGEROUSLY_SKIP_PERMISSIONS_ENV] ?? "")
    .trim()
    .toLowerCase()
  return value === "1" || value === "true" ? "turbo" : "default"
}

export interface AntigravityFormValues {
  method: AntigravityAuthMethod
  permissionMode: AntigravityPermissionMode
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
 * did not pick, and would contradict the method the panel shows. (The launch
 * path scrubs them again for the same reason; this is the half that keeps the
 * stored row honest.)
 *
 * `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_LOCATION` are kept for BOTH
 * `agent-platform` and `oauth-business`, which both read them from the
 * environment.
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
  // 与 Kiro 的 `KIRO_TRUST_ALL_TOOLS` / Cursor 的 `CURSOR_FORCE` 保持一致：
  // 两种状态都显式写入（"1" / "0"），确保原始 env 草稿同步准确。
  env[AGY_DANGEROUSLY_SKIP_PERMISSIONS_ENV] =
    values.permissionMode === "turbo" ? "1" : "0"
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

/** A sign-in that produced a link and is waiting to be completed. */
type PendingLogin = AntigravityLoginStart

/**
 * Sign in to Antigravity from a machine that has no browser.
 *
 * The Antigravity CLI's own `agy acp --login` is already the browser-free
 * flow: it prints a Google consent link and waits on stdin for the
 * authorization code (or the full address the browser lands on). This drives
 * that child from the panel — show the link, let the user consent in whatever
 * browser they do have, then write the pasted code back to the process. See
 * `src-tauri/src/acp/antigravity_login.rs`.
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
  // Synced from `pending` by the layout effect below `currentMethod`.
  const pendingRef = useRef<PendingLogin | null>(null)

  // 唯一负责放弃未完成登录的 cleanup。每个待完成登录背后都有一个等待 stdin 输入的
  // `agy acp --login` 子进程，切换认证方式或关闭设置页时必须通知后端终止该子进程。
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
  // Synced at commit rather than during render. Every reader runs later: the
  // abandon cleanup is a passive effect (layout effects run first), and
  // `stillOurs` is only called after an await.
  useLayoutEffect(() => {
    pendingRef.current = pending
    currentMethod.current = method
  })

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
        // 面板已关闭或用户切换到其他认证方式时，立即通知后端终止刚启动的
        // `agy acp --login` 子进程，避免遗留后台进程或展示旧认证方式的链接。
        void acpAntigravityLoginCancel(started.handle).catch(() => {})
        return
      }
      setPending(started)
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
        // The code went out, and `agy acp --login` consumes it and exits — so
        // the link on screen is spent whether or not the sign-in worked.
        // Leaving the paste box would invite a second attempt that could only
        // fail. `retryable` marks the one case where it is still live: codeg
        // rejected the paste before sending anything.
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
        </div>
      ) : null}
    </div>
  )
}

/**
 * Discard the account Antigravity is signed in as.
 *
 * The other half of signing in. Antigravity refreshes its cached credential by
 * itself, so once one exists every session silently reuses that account.
 * Nothing the user can reach from outside codeg fixes it either: the CLI keeps
 * it in the system keyring (or its file fallback), which survives
 * reinstalling codeg. The backend drives the CLI's own ACP `logout`.
 *
 * Only for the two OAuth methods. The API-key methods read their credential from
 * the environment on every request, so there is nothing stored to discard.
 */
function SignOut({ disabled }: { disabled: boolean }) {
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
      await acpAntigravitySignOut()
      if (!mountedRef.current) return
      toast.success(t("antigravity.signOut.done"))
    } catch (e) {
      // NOT `String(e)`: the web transport throws the backend's `{code,
      // message}` JSON verbatim, and this is the deployment where the
      // actionable text ("Google Antigravity is not installed") matters most.
      toast.error(`${t("antigravity.signOut.failed")}: ${toErrorMessage(e)}`)
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }, [t])

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
 * Google Antigravity (`agy acp`) 的专用配置面板。
 *
 * 登录凭据由 Antigravity CLI 自身管理（系统钥匙串或文件回退）；此面板负责选择
 * 认证方式、过滤/透传对应的环境变量（`GEMINI_API_KEY` / `GOOGLE_*`），并驱动
 * `agy acp --login` 与 ACP `logout`。
 *
 * 模型与会话模式不放在此处：`agy acp` 通过标准 ACP `configOptions` 上报，
 * 由输入框选择器按会话独立管理。
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
  const [permissionMode, setPermissionMode] =
    useState<AntigravityPermissionMode>(() =>
      antigravityPermissionModeFromEnv(agent.env)
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
      permissionMode: antigravityPermissionModeFromEnv(agent.env),
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
      previous.permissionMode !== persisted.permissionMode ||
      previous.geminiApiKey !== persisted.geminiApiKey ||
      previous.googleApiKey !== persisted.googleApiKey ||
      previous.gcpProject !== persisted.gcpProject ||
      previous.gcpLocation !== persisted.gcpLocation
    if (!changed) return
    seeded.current = persisted
    if (dirty.current) return
    setMethod(persisted.method)
    setPermissionMode(persisted.permissionMode)
    setGeminiApiKey(persisted.geminiApiKey)
    setGoogleApiKey(persisted.googleApiKey)
    setGcpProject(persisted.gcpProject)
    setGcpLocation(persisted.gcpLocation)
  }, [persisted])

  const values: AntigravityFormValues = {
    method,
    permissionMode,
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
  // 登录启动时后端使用的是已持久化的数据库配置，而非当前表单草稿；
  // 如果认证方式或必填项尚未保存，先提示用户保存再开始登录。
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

      // Storing the row is the whole save: `agy acp` owns its credential and
      // reads no codeg-managed settings file.
      toast.success(t("toasts.antigravitySaved"))
      onSaved()
    } catch (e) {
      toast.error(
        `${t("toasts.saveAntigravityConfigFailed")}: ${toErrorMessage(e)}`
      )
    } finally {
      if (mountedRef.current) setSavingForm(false)
    }
  }, [agent.enabled, agent.env, onSaveEnv, onSaved, t])

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

        {/* Only for personal Google sign-in: `agy acp --login`, which this
            drives, signs a personal account in and nothing else, so for Gemini
            Enterprise it would report a success that leaves the Enterprise
            method unauthenticated (the CLI signs Enterprise in at session
            start instead — see its method hint). `disabled` rather than hidden
            while the stored row is not saved yet: the section explains the
            headless problem, which is exactly what a user who cannot complete
            the flow needs to read. */}
        {method === "oauth-personal" ? (
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
        {usesBrowserSignIn(method) ? <SignOut disabled={busy} /> : null}

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
      </div>

      {/* 权限模式（Turbo 开关）：映射为 `agy acp --dangerously-skip-permissions` */}
      <div className="space-y-2 rounded-md border bg-background/60 p-2.5">
        <div className="flex items-center gap-1.5">
          <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-2xs font-medium">
            {t("antigravity.permissionsTitle")}
          </span>
        </div>
        <div className="space-y-1">
          <label
            className="text-2xs text-muted-foreground"
            htmlFor="antigravity-permission-mode"
          >
            {t("antigravity.permissionModeLabel")}
          </label>
          <Select
            disabled={busy}
            onValueChange={(value) => {
              if (value !== "default" && value !== "turbo") return
              markDirty()
              setPermissionMode(value)
            }}
            value={permissionMode}
          >
            <SelectTrigger
              aria-label={t("antigravity.permissionModeLabel")}
              className="h-7 text-xs"
              id="antigravity-permission-mode"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="start">
              <SelectItem value="default">
                {t("antigravity.permissionModeDefault")}
              </SelectItem>
              <SelectItem value="turbo">
                {t("antigravity.permissionModeTurbo")}
              </SelectItem>
            </SelectContent>
          </Select>
          <p className="text-3xs text-muted-foreground">
            {permissionMode === "turbo"
              ? t("antigravity.permissionModeTurboHint")
              : t("antigravity.permissionModeDefaultHint")}
          </p>
        </div>
      </div>

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
  )
}
