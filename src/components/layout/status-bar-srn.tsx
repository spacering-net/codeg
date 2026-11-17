"use client"

/**
 * The SRN (SpaceRing account) entry, at the status bar's leading edge: a
 * ring when nobody is signed in, the avatar and name when someone is, and a
 * popover that signs in, waits for the browser, and shows the account.
 *
 * Desktop: the account is this computer's, in every window — a remote
 * workspace window included (see `lib/srn-account/source.ts`). Codeg Web:
 * this browser's session on the server it is talking to.
 *
 * Desktop sign-in happens in the system browser. When it comes back, the
 * backend brings the main window forward; that window opens this popover by
 * itself, so the outcome — signed in, or why not — is seen without a click.
 * On the Web this tab goes to SpaceRing and comes back to the workspace with
 * the outcome in its address, and the popover opens with it the same way.
 */

import { useState, type ReactNode } from "react"
import { useLocale, useTranslations } from "next-intl"
import {
  Check,
  Copy,
  ExternalLink,
  Loader2,
  LogOut,
  RotateCw,
} from "lucide-react"

import { SrnRingIcon } from "@/components/srn-ring-icon"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { useCopiedFlag } from "@/hooks/use-copied-flag"
import { useMinuteNow } from "@/hooks/use-minute-now"
import { getCurrentWindowLabel } from "@/lib/browser/window-label"
import { isRemoteDesktopWindow } from "@/lib/platform"
import { formatTimeAgo } from "@/lib/relative-time"
import {
  srnProblemCode,
  srnProblemOf,
  srnReasonOf,
  type SrnProblem,
} from "@/lib/srn-account/problems"
import {
  useSrnAccount,
  type SrnAccountController,
  type SrnAccountView,
} from "@/lib/srn-account/use-srn-account"
import { useSrnAvatar } from "@/lib/srn-account/use-srn-avatar"
import type { SrnIdentity, SrnOnlineStatus } from "@/lib/srn-account/types"
import { copyTextToClipboard, cn } from "@/lib/utils"

/** The window the backend brings forward when the browser comes back. */
const MAIN_WINDOW_LABEL = "main"

/** Tints shared with the bar's other popovers (`status-bar-mcp.tsx`). */
const BADGE_TONE = {
  neutral: "bg-muted text-muted-foreground",
  waiting: "bg-primary/10 text-primary",
  good: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  warn: "bg-yellow-500/10 text-yellow-700 dark:text-yellow-500",
  bad: "bg-red-500/10 text-red-600 dark:text-red-400",
} as const
const DOT_TONE: Record<keyof typeof BADGE_TONE, string> = {
  neutral: "bg-muted-foreground/50",
  waiting: "bg-primary",
  good: "bg-emerald-500",
  warn: "bg-yellow-500",
  bad: "bg-red-500",
}
const ONLINE_TONE: Record<SrnOnlineStatus, keyof typeof BADGE_TONE> = {
  confirmed: "good",
  unconfirmed: "warn",
  unchecked: "neutral",
}

/** What the account is shown as: its name, or its number when it has none. */
function displayNameOf(account: SrnIdentity): string {
  return account.name.trim() || `SRN ${account.srn}`
}

/** The first letter or digit of the name, for when there is no picture. */
function initialOf(name: string): string {
  return (
    [...name].find((char) => /[\p{L}\p{N}]/u.test(char)) ?? "?"
  ).toLocaleUpperCase()
}

function SrnAvatar({
  account,
  fetch,
  className,
}: {
  account: SrnIdentity
  fetch: SrnAccountController["avatar"]
  className?: string
}) {
  const src = useSrnAvatar(account.avatarPath, fetch)
  // Bytes that are an image type but not a decodable image: the initial.
  const [broken, setBroken] = useState<string | null>(null)
  const shown = src && src !== broken ? src : null
  return (
    <span
      aria-hidden="true"
      data-srn-avatar={shown ? "image" : "initial"}
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary/15 leading-none font-semibold text-primary select-none",
        className
      )}
    >
      {shown ? (
        // A blob URL minted from proxied bytes: nothing for next/image to
        // optimise, and no network address at all.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={shown}
          alt=""
          className="size-full object-cover"
          onError={() => setBroken(shown)}
        />
      ) : (
        initialOf(displayNameOf(account))
      )}
    </span>
  )
}

function Badge({
  tone,
  pulse = false,
  children,
}: {
  tone: keyof typeof BADGE_TONE
  pulse?: boolean
  children: ReactNode
}) {
  return (
    <span
      className={cn(
        "flex min-w-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-3xs font-medium",
        BADGE_TONE[tone]
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          DOT_TONE[tone],
          pulse && "motion-safe:animate-pulse"
        )}
      />
      <span className="truncate">{children}</span>
    </span>
  )
}

/** The red block every other status-bar popover uses for a failure. */
function ProblemBlock({
  text,
  more,
  detail,
  children,
}: {
  text: string
  /** A second line: why, or what still holds. */
  more?: string | null
  detail?: string | null
  children?: ReactNode
}) {
  const t = useTranslations("SrnAccount")
  return (
    <div
      role="alert"
      className="flex flex-col gap-1 rounded-md border border-red-500/30 bg-red-500/5 px-2 py-1.5 text-2xs break-words text-red-600 dark:text-red-400"
    >
      <p>{text}</p>
      {more && <p className="opacity-85">{more}</p>}
      {children}
      {detail && (
        <details className="opacity-85">
          <summary className="cursor-pointer select-none">
            {t("details")}
          </summary>
          <p className="mt-0.5 font-mono text-3xs select-text">{detail}</p>
        </details>
      )}
    </div>
  )
}

/** A problem in the person's language: the backend's key when it named one,
 *  its own English otherwise. */
function useProblemText() {
  const t = useTranslations("SrnAccount")
  return (problem: SrnProblem): string => {
    if (!problem.name) {
      return t("unknownError", { message: problem.fallback })
    }
    const { seconds = "", status = "", url = "" } = problem.params
    // A Web sign-in's result carries no number: said without one.
    if (problem.name === "rateLimited" && !seconds) {
      return t("errorsPlain.rateLimited")
    }
    if (problem.name === "server" && !status) return t("errorsPlain.server")
    return t(`errors.${problem.name}`, { seconds, status, url })
  }
}

function ProblemView({
  problem,
  text,
  more,
  children,
}: {
  problem: SrnProblem
  /** Words for this place instead of the problem's own. */
  text?: string
  /** A second line instead of the problem's own reason. */
  more?: string
  children?: ReactNode
}) {
  const say = useProblemText()
  // A sign-out SpaceRing did not confirm says why it could not.
  const reason = srnReasonOf(problem)
  return (
    <ProblemBlock
      text={text ?? say(problem)}
      more={
        more ??
        (problem.name === "signedOutLocally" && reason
          ? say({ ...problem, name: reason })
          : null)
      }
      detail={problem.detail}
    >
      {children}
    </ProblemBlock>
  )
}

function Header({ badge }: { badge?: ReactNode }) {
  const t = useTranslations("SrnAccount")
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="flex min-w-0 items-center gap-1.5">
        <SrnRingIcon className="size-3.5 text-muted-foreground" />
        <span className="shrink-0 text-xs font-medium">{t("name")}</span>
        <span className="truncate text-2xs text-muted-foreground">
          {t("account")}
        </span>
      </span>
      {badge && (
        <span className="flex min-w-0 shrink justify-end">{badge}</span>
      )}
    </div>
  )
}

function Hint({ children }: { children: ReactNode }) {
  return <p className="text-2xs text-muted-foreground">{children}</p>
}

function Busy({ children }: { children: ReactNode }) {
  return (
    <>
      <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
      {children}
    </>
  )
}

/** When a check ended, as "5 minutes ago", the full time in its tooltip. */
function Ago({ at, label }: { at: string; label: "checked" | "confirmed" }) {
  const t = useTranslations("SrnAccount.signedIn")
  const locale = useLocale()
  const now = useMinuteNow()
  const time = Date.parse(at)
  if (Number.isNaN(time)) return null
  const ago = formatTimeAgo(time, now, locale)
  return (
    <time dateTime={at} title={new Date(time).toLocaleString(locale)}>
      {label === "checked"
        ? t("checkedAgo", { ago })
        : t("confirmedAgo", { ago })}
    </time>
  )
}

function CopyLinkButton({ url, primary }: { url: string; primary: boolean }) {
  const t = useTranslations("SrnAccount.actions")
  const [copied, markCopied] = useCopiedFlag()
  return (
    <Button
      size="sm"
      variant={primary ? "default" : "outline"}
      className="w-full"
      onClick={async () => {
        if (await copyTextToClipboard(url)) markCopied()
      }}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {copied ? t("copied") : t("copyLink")}
    </Button>
  )
}

function PopoverBody({ account }: { account: SrnAccountController }) {
  const t = useTranslations("SrnAccount")
  const ta = useTranslations("SrnAccount.actions")
  const locale = useLocale()
  const { kind, state, busy, failure, signOutNotice, resultNotice } = account
  const working = busy !== null
  const web = kind === "web"

  // How the sign-in this page came back from ended (Codeg Web), whatever
  // the state now is.
  const resultBlock = resultNotice && <ProblemView problem={resultNotice} />

  // A command's failure, in words for where it happened. Not said again
  // when the state already says it: a reopen that could not open the
  // browser is the pending sign-in's own problem.
  const failureBlock = (() => {
    if (!failure) return null
    const { action, problem } = failure
    if (
      state.status === "pending" &&
      action === "reopen" &&
      problem.name === "openBrowser"
    ) {
      return null
    }
    const text =
      action === "signOut" && problem.name === "accountChanged"
        ? t("signOut.accountChanged")
        : undefined
    return <ProblemView problem={problem} text={text} />
  })()

  const signOutButton = (label: string) => (
    <Button
      size="sm"
      variant="outline"
      className="w-full"
      disabled={working}
      onClick={account.signOut}
    >
      {busy === "signOut" ? (
        <Busy>{ta("signingOut")}</Busy>
      ) : (
        <>
          <LogOut className="size-3.5 rtl:-scale-x-100" />
          {label}
        </>
      )}
    </Button>
  )

  const manageButton = (
    <Button
      size="sm"
      variant="outline"
      className="w-full"
      disabled={working}
      onClick={account.openManageConnections}
    >
      {busy === "manage" ? (
        <Busy>{ta("manageConnections")}</Busy>
      ) : (
        <>
          <ExternalLink className="size-3.5" />
          {ta("manageConnections")}
        </>
      )}
    </Button>
  )

  switch (state.status) {
    case "notEnabled":
      return (
        <>
          <Header />
          <Hint>{t("notEnabled")}</Hint>
          {resultBlock}
        </>
      )

    case "unavailable":
      // Not signed out: the server cannot tell now. Reading again is all
      // there is to do.
      return (
        <>
          <Header badge={<Badge tone="warn">{t("unavailable.badge")}</Badge>} />
          <Hint>{t("unavailable.hint")}</Hint>
          {resultBlock}
          <ProblemView problem={srnProblemOf(state.problem)} />
          {failureBlock}
          <Button
            size="sm"
            className="w-full"
            disabled={working}
            onClick={account.checkAgain}
          >
            {busy === "check" ? (
              <Busy>{ta("tryAgain")}</Busy>
            ) : (
              <>
                <RotateCw className="size-3.5" />
                {ta("tryAgain")}
              </>
            )}
          </Button>
        </>
      )

    case "loading":
      return (
        <>
          <Header />
          <p className="flex items-center gap-1.5 text-2xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" aria-hidden="true" />
            {t("loading")}
          </p>
        </>
      )

    case "signedOut": {
      const problem = state.problem ? srnProblemOf(state.problem) : null
      const leftover = problem?.name === "keychainCleanup"
      return (
        <>
          <Header
            badge={<Badge tone="neutral">{t("signedOut.badge")}</Badge>}
          />
          <Hint>{t("signedOut.intro")}</Hint>
          {resultBlock}
          {problem && <ProblemView problem={problem} />}
          {signOutNotice && (
            <ProblemView
              problem={signOutNotice}
              // On the Web it is this browser that is signed out, not the
              // computer.
              text={
                web
                  ? t("signOut.webSignedOutLocally", {
                      url: signOutNotice.params.url ?? "",
                    })
                  : undefined
              }
            >
              {/* The way to the website's list, where the connection
                  SpaceRing did not hear end can be removed. */}
              <button
                type="button"
                disabled={working}
                onClick={account.openManageConnections}
                className="inline-flex items-center gap-1 self-start font-medium underline-offset-2 hover:underline disabled:opacity-60"
              >
                {busy === "manage" ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <ExternalLink className="size-3" />
                )}
                {ta("manageConnections")}
              </button>
            </ProblemView>
          )}
          {failureBlock}
          <Button
            size="sm"
            className="w-full"
            disabled={working}
            onClick={account.signIn}
          >
            {busy === "signIn" ? (
              <Busy>{web ? ta("goingToSpaceRing") : ta("signingIn")}</Busy>
            ) : (
              ta("signIn")
            )}
          </Button>
          {/* The sign-in that is still in the keychain goes with a sign-out,
              which keeps trying the keychain until it lets go. */}
          {leftover && signOutButton(ta("signOut"))}
        </>
      )
    }

    case "pending": {
      const expires = Date.parse(state.expiresAt)
      const until = Number.isNaN(expires)
        ? ""
        : new Intl.DateTimeFormat(locale, {
            hour: "numeric",
            minute: "2-digit",
          }).format(expires)
      const noBrowser = srnProblemCode(state.problem) === "open_browser_failed"
      return (
        <>
          <Header
            badge={
              <Badge tone="waiting" pulse>
                {state.completing
                  ? t("pending.completingBadge")
                  : t("pending.badge")}
              </Badge>
            }
          />
          {state.completing ? (
            <p className="flex items-center gap-1.5 text-2xs text-muted-foreground">
              <Loader2
                className="size-3 shrink-0 animate-spin"
                aria-hidden="true"
              />
              {t("pending.completing")}
            </p>
          ) : web ? (
            <Hint>
              {until
                ? t("pending.webHint", { time: until })
                : t("pending.webHintNoTime")}
            </Hint>
          ) : (
            <Hint>
              {until
                ? t("pending.hint", { time: until })
                : t("pending.hintNoTime")}
            </Hint>
          )}
          {resultBlock}
          {noBrowser && !state.completing && (
            <ProblemBlock text={t("pending.openBrowserFailed")} />
          )}
          {failureBlock}
          {/* Once the browser is back there is no page to go to: only the
              cancel stays. */}
          {!state.completing && (
            <>
              <Button
                size="sm"
                variant="outline"
                className="w-full"
                disabled={working}
                onClick={account.reopenSignIn}
              >
                {busy === "reopen" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <ExternalLink className="size-3.5" />
                )}
                {ta("reopen")}
              </Button>
              {/* The Web's page is this tab: there is no link to carry
                  elsewhere, and nothing to cancel — a sign-in left waiting
                  expires, and a new one replaces it. */}
              {web ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="w-full"
                  disabled={working}
                  onClick={account.signIn}
                >
                  {busy === "signIn" ? (
                    <Busy>{ta("goingToSpaceRing")}</Busy>
                  ) : (
                    ta("startOver")
                  )}
                </Button>
              ) : (
                <CopyLinkButton
                  url={state.authorizationUrl}
                  primary={noBrowser}
                />
              )}
            </>
          )}
          {!web && (
            <Button
              size="sm"
              variant="ghost"
              className="w-full"
              disabled={busy === "cancel"}
              onClick={account.cancelSignIn}
            >
              {ta("cancel")}
            </Button>
          )}
        </>
      )
    }

    case "signedIn": {
      const { account: who, online } = state
      const name = displayNameOf(who)
      // The desktop hears when a check under way ends; the Web does not, so
      // there only this page's own check counts.
      const checking = busy === "check" || (!web && online.checking)
      const problem = online.problem ? srnProblemOf(online.problem) : null
      const ago =
        online.status === "unconfirmed" && online.confirmedAt ? (
          <Ago at={online.confirmedAt} label="confirmed" />
        ) : online.checkedAt ? (
          <Ago at={online.checkedAt} label="checked" />
        ) : null
      return (
        <>
          <Header />
          <div className="divide-y overflow-hidden rounded-lg border">
            <div className="flex items-center gap-2.5 px-2.5 py-2">
              <SrnAvatar
                account={who}
                fetch={account.avatar}
                className="size-9 text-sm"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium" title={name}>
                  {name}
                </p>
                {who.name.trim() && (
                  <p className="truncate text-2xs text-muted-foreground tabular-nums">
                    {t("signedIn.srn", { srn: String(who.srn) })}
                  </p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 px-2.5 py-1.5 text-3xs text-muted-foreground">
              {/* The time goes under the badge when the two do not fit
                  side by side, rather than being cut short. */}
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
                <Badge tone={ONLINE_TONE[online.status]}>
                  {t(`signedIn.online.${online.status}`)}
                </Badge>
                {ago}
              </div>
              <button
                type="button"
                onClick={account.checkAgain}
                disabled={working || checking}
                title={checking ? ta("checking") : ta("checkAgain")}
                aria-label={checking ? ta("checking") : ta("checkAgain")}
                className="shrink-0 transition-colors hover:text-foreground disabled:pointer-events-none"
              >
                <RotateCw
                  className={cn("size-3", checking && "animate-spin")}
                />
              </button>
            </div>
          </div>
          {resultBlock}
          {online.status === "unconfirmed" && problem && (
            <ProblemView
              problem={problem}
              more={t(
                web ? "signedIn.keptSignedInWeb" : "signedIn.keptSignedIn"
              )}
            />
          )}
          {failureBlock}
          {manageButton}
          {signOutButton(ta("signOut"))}
        </>
      )
    }

    case "credentialUnreadable":
      return (
        <>
          <Header badge={<Badge tone="bad">{t("unreadable.badge")}</Badge>} />
          <Hint>{t("unreadable.hint")}</Hint>
          <ProblemView problem={srnProblemOf(state.problem)} />
          {failureBlock}
          <Button
            size="sm"
            className="w-full"
            disabled={working}
            onClick={account.checkAgain}
          >
            {busy === "check" ? (
              <Busy>{ta("tryAgain")}</Busy>
            ) : (
              <>
                <RotateCw className="size-3.5" />
                {ta("tryAgain")}
              </>
            )}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="w-full"
            disabled={working}
            onClick={account.signIn}
          >
            {busy === "signIn" ? (
              <Busy>{ta("signingIn")}</Busy>
            ) : (
              ta("signInAgain")
            )}
          </Button>
          {signOutButton(ta("signOut"))}
        </>
      )
  }
}

/** The ring's tone and the small mark on it, per state. */
function ringLook(state: SrnAccountView): {
  dim: boolean
  mark: "waiting" | "attention" | null
} {
  switch (state.status) {
    case "pending":
      return { dim: false, mark: "waiting" }
    case "credentialUnreadable":
      return { dim: false, mark: "attention" }
    // The Web's server cannot tell now: muted, as when there is no account.
    case "unavailable":
      return { dim: true, mark: null }
    case "signedOut":
      // A sign-in still in the keychain wants a sign-out: the one signed-out
      // problem that is something to do rather than something that happened.
      return {
        dim: true,
        mark:
          srnProblemCode(state.problem) === "keychain_cleanup_failed"
            ? "attention"
            : null,
      }
    default:
      return { dim: true, mark: null }
  }
}

function triggerLabelOf(
  state: SrnAccountView,
  t: ReturnType<typeof useTranslations<"SrnAccount.trigger">>
): string {
  switch (state.status) {
    case "signedIn":
      return t("signedIn", { name: displayNameOf(state.account) })
    case "pending":
      return t(state.completing ? "completing" : "pending")
    case "credentialUnreadable":
      return t("unreadable")
    case "unavailable":
      return t("unavailable")
    case "signedOut":
      return t("signedOut")
    default:
      return t("account")
  }
}

export function StatusBarSrn({ compact = false }: { compact?: boolean }) {
  const t = useTranslations("SrnAccount")
  const tTrigger = useTranslations("SrnAccount.trigger")
  const [open, setOpen] = useState(false)
  const account = useSrnAccount({
    onBrowserOutcome: () => {
      if (getCurrentWindowLabel() === MAIN_WINDOW_LABEL) setOpen(true)
    },
  })
  const { state } = account
  const remoteWindow = isRemoteDesktopWindow()

  const handleOpenChange = (next: boolean) => {
    setOpen(next)
    if (next) {
      account.clearFailure()
      account.refresh()
    } else {
      // A Web sign-in's result is said once.
      account.dismissResult()
    }
  }

  const label = triggerLabelOf(state, tTrigger)
  const signedIn = state.status === "signedIn" ? state.account : null
  const look = ringLook(state)

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          title={label}
          data-srn-status={state.status}
          className={cn(
            "flex h-6 min-w-0 items-center rounded-4xl transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
            signedIn && !compact && "pe-2"
          )}
        >
          <span
            data-srn-box=""
            className="relative flex h-6 w-6 shrink-0 items-center justify-center"
          >
            {signedIn ? (
              <SrnAvatar
                account={signedIn}
                fetch={account.avatar}
                className="size-3.5 text-[0.5rem] ring-1 ring-foreground/10"
              />
            ) : (
              <SrnRingIcon
                className={cn("size-3.5", look.dim && "opacity-70")}
              />
            )}
            {look.mark && (
              <span
                aria-hidden="true"
                data-srn-mark={look.mark}
                className={cn(
                  "absolute end-0.5 top-0.5 size-1.5 rounded-full",
                  look.mark === "waiting"
                    ? "bg-primary motion-safe:animate-pulse"
                    : "bg-red-500"
                )}
              />
            )}
          </span>
          {/* Phones: the avatar alone — the bar has no width for a name. */}
          {signedIn && !compact && (
            <span className="max-w-40 truncate text-xs">
              {displayNameOf(signedIn)}
            </span>
          )}
        </button>
      </PopoverTrigger>
      {/* `side="top"`: the trigger sits on the window's bottom edge. */}
      <PopoverContent side="top" align="start" className="w-72 gap-2 p-2.5">
        <PopoverBody account={account} />
        {remoteWindow && (
          <p className="text-3xs text-muted-foreground">{t("thisComputer")}</p>
        )}
      </PopoverContent>
    </Popover>
  )
}
