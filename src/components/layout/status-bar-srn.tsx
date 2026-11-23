"use client"

/**
 * The status bar's one entry at its leading edge: the SRN (SpaceRing
 * account), and with it the app's quick actions, in a single menu.
 *
 * The trigger is the account: a ring when nobody is signed in, the avatar and
 * the name in one capsule when someone is.
 *
 * The menu, top to bottom, on one grid (`status-bar-menu-rows.tsx`):
 *  - the account's head — the avatar, or SpaceRing's ring in its place, the
 *    name ("SRN" when nobody is signed in) and one line under it — and,
 *    only in a state with a problem, one compact note. Signed in, the head
 *    is itself the way to SRN's console, so the account needs no row of its
 *    own up there;
 *  - the rows: the quick actions (`quick-actions-menu.tsx`) — the workbench
 *    routes, then the launch group (open a project, the remote and local
 *    workspaces, the browser tab and the pet);
 *  - at the foot, the one account action that moves the state forward, or
 *    none. Whatever else a state can do is a small link in its note, and
 *    only where that is the way out: opening the menu re-reads the state,
 *    which is "try again" for most problems.
 *
 * Desktop: the account is this computer's, in every window — a remote
 * workspace window included (see `lib/srn-account/source.ts`). Codeg Web:
 * this browser's session on the server it is talking to.
 *
 * Desktop sign-in happens in the system browser. When it comes back, the
 * backend brings the main window forward; that window opens this menu by
 * itself, so the outcome — signed in, or why not — is seen without a click.
 * On the Web this tab goes to SpaceRing and comes back to the workspace with
 * the outcome in its address, and the menu opens with it the same way.
 */

import { useId, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import {
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleAlert,
  Loader2,
  LogIn,
  LogOut,
  RotateCcw,
  RotateCw,
  X,
} from "lucide-react"
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui"

import {
  QuickActionsDialogs,
  QuickActionsItems,
  useQuickActions,
} from "@/components/layout/quick-actions-menu"
import {
  ExternalMark,
  MENU_AVATAR,
  MENU_FADES_UNDER_SUBMENU,
  MENU_HEAD_GRID,
  MENU_ICON,
  MENU_ICON_COLUMN,
  MENU_SMALL_TEXT,
  MenuRow,
} from "@/components/layout/status-bar-menu-rows"
import { SrnRingIcon } from "@/components/srn-ring-icon"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useCopiedFlag } from "@/hooks/use-copied-flag"
import { getCurrentWindowLabel } from "@/lib/browser/window-label"
import { isRemoteDesktopWindow } from "@/lib/platform"
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
import type { SrnIdentity } from "@/lib/srn-account/types"
import { copyTextToClipboard, cn } from "@/lib/utils"

/** The window the backend brings forward when the browser comes back. */
const MAIN_WINDOW_LABEL = "main"

type Tone = "neutral" | "waiting" | "warn" | "bad"

/** The dot before a state's words. */
const DOT_TONE: Record<Tone, string> = {
  neutral: "bg-muted-foreground/50",
  waiting: "bg-primary",
  warn: "bg-amber-500",
  bad: "bg-red-500",
}
/** The words themselves: muted while all is well, coloured when it is not. */
const TEXT_TONE: Record<Tone, string> = {
  neutral: "text-muted-foreground",
  waiting: "text-muted-foreground",
  warn: "text-amber-700 dark:text-amber-400",
  bad: "text-red-600 dark:text-red-400",
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

/** A state in a few words after its dot — or after a spinner while it is
 *  under way: the head's second line. */
function StateLine({
  tone,
  pulse = false,
  working = false,
  children,
}: {
  tone: Tone
  pulse?: boolean
  working?: boolean
  children: ReactNode
}) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {working ? (
        // As wide as the dot, so the words do not move between the two.
        <Loader2
          aria-hidden="true"
          className="-mx-[3px] size-3 shrink-0 animate-spin"
        />
      ) : (
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            DOT_TONE[tone],
            pulse && "motion-safe:animate-pulse"
          )}
        />
      )}
      <span className={cn("truncate", TEXT_TONE[tone])}>{children}</span>
    </span>
  )
}

/** The head's box: its picture first on the grid, its words on the label
 *  edge. */
const HEAD_BOX = `flex items-center ${MENU_HEAD_GRID}`

/**
 * The account's words in its head, the same in every state: a name, and one
 * line under it — the number when signed in, the state otherwise. In a
 * remote workspace window a quiet line under them says whose account this
 * is. They start on the label edge, after the head's round 32px picture.
 * The name is the strongest line in the menu: a pixel above the rows'
 * labels, and heavier; the line under it is the menu's quieter size.
 */
function IdentityWords({
  title,
  sub,
  foot,
  titleId,
  subId,
}: {
  title: string
  sub?: ReactNode
  foot?: string | null
  titleId?: string
  subId?: string
}) {
  return (
    <div className="min-w-0 flex-1">
      <p id={titleId} className="truncate text-base leading-5.5 font-medium">
        {title}
      </p>
      {sub && (
        <div
          id={subId}
          className={cn("flex min-w-0 text-muted-foreground", MENU_SMALL_TEXT)}
        >
          {sub}
        </div>
      )}
      {foot && (
        <p className="mt-1 text-2xs leading-3.5 text-muted-foreground">
          {foot}
        </p>
      )}
    </div>
  )
}

/**
 * The head when signed in: the avatar, the name and the number — and the way
 * to SRN's console, as one item of the menu, lit on hover and focus as a row
 * is, within the menu's padding. A quiet ↗ on the rows' end edge says it
 * leads out, where there is no hover to find that by (a phone), and turns up
 * when lit; a spinner takes its place while the console opens. Named by what
 * it shows and what it does, and its tooltip says the same, line by line:
 * the name in the head may be cut short. While another of the account's
 * commands is at work it is out of reach, as the rows are, but stays at full
 * strength: it is still who is signed in.
 */
function ConsoleHead({
  glyph,
  title,
  sub,
  subText,
  foot,
  busy,
  disabled,
  onSelect,
}: {
  glyph: ReactNode
  title: string
  sub?: ReactNode
  /** The line under the name, as words, for the tooltip. */
  subText?: string
  foot?: string | null
  busy: boolean
  disabled: boolean
  onSelect: () => void
}) {
  const ta = useTranslations("SrnAccount.actions")
  const id = useId()
  const [titleId, subId, actionId] = ["name", "sub", "action"].map(
    (part) => `${id}-${part}`
  )
  const action = ta("openConsole")
  return (
    <DropdownMenuPrimitive.Item
      data-srn-head=""
      aria-labelledby={[titleId, sub ? subId : null, actionId]
        .filter(Boolean)
        .join(" ")}
      aria-busy={busy || undefined}
      title={[title, subText, action].filter(Boolean).join("\n")}
      // Typed letters find it by the name, as they find a row by its label.
      textValue={title}
      disabled={disabled}
      onSelect={(event) => {
        event.preventDefault()
        onSelect()
      }}
      className={cn(
        HEAD_BOX,
        "group/srn-head relative cursor-default rounded-xl outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-disabled:pointer-events-none"
      )}
    >
      {glyph}
      <IdentityWords
        title={title}
        sub={sub}
        foot={foot}
        titleId={titleId}
        subId={subId}
      />
      {busy ? (
        <Loader2
          aria-hidden="true"
          className="-me-1 size-3.5 shrink-0 animate-spin text-muted-foreground"
        />
      ) : (
        <ExternalMark className="shrink-0 transition-colors group-focus/srn-head:text-accent-foreground group-data-disabled/srn-head:opacity-50" />
      )}
      <span id={actionId} hidden>
        {action}
      </span>
    </DropdownMenuPrimitive.Item>
  )
}

/** The head in every state but signed in: SpaceRing's ring in the avatar's
 *  place, "SRN", and the state. Nothing to open: it only says. */
function RingIdentity({
  sub,
  foot,
}: {
  sub?: ReactNode
  foot?: string | null
}) {
  const t = useTranslations("SrnAccount")
  return (
    <div className={HEAD_BOX}>
      <span
        aria-hidden="true"
        className={cn(
          MENU_AVATAR,
          "flex shrink-0 items-center justify-center rounded-full bg-muted text-foreground/70 ring-1 ring-foreground/5"
        )}
      >
        {/* Half the circle: any larger, it crowds the circle's edge. */}
        <SrnRingIcon className="size-4" />
      </span>
      <IdentityWords title={t("name")} sub={sub} foot={foot} />
    </div>
  )
}

/** The note's small controls: a link, and the details' toggle. Menu items,
 *  so the keyboard reaches them as it reaches every row; they keep the menu
 *  open. In the note's own colour, their text on its text's edge. */
const NOTE_CONTROL = `-mx-1 w-fit gap-1 rounded-md px-1 py-0.5 ${MENU_SMALL_TEXT} text-current focus:bg-current/10 focus:text-current not-data-[variant=destructive]:focus:**:text-current data-disabled:opacity-60`

/** The one way out a note offers, when it is the only one. */
function NoteLink({
  label,
  onSelect,
  disabled = false,
  busy = false,
  external = false,
  done = false,
}: {
  label: string
  onSelect: () => void
  disabled?: boolean
  busy?: boolean
  /** A page of SpaceRing's: the ↗ says it opens in the browser. */
  external?: boolean
  /** Done, for a moment: a tick before the words. */
  done?: boolean
}) {
  return (
    <DropdownMenuItem
      disabled={disabled}
      aria-busy={busy || undefined}
      onSelect={(event) => {
        event.preventDefault()
        onSelect()
      }}
      className={cn(
        NOTE_CONTROL,
        "font-medium underline decoration-current/35 underline-offset-[3px] hover:decoration-current",
        busy && "data-disabled:opacity-100"
      )}
    >
      {busy && <Loader2 aria-hidden="true" className="size-3 animate-spin" />}
      {done && <Check aria-hidden="true" className="size-3" />}
      {label}
      {external && (
        <ArrowUpRight aria-hidden="true" className="size-3 rtl:-scale-x-100" />
      )}
    </DropdownMenuItem>
  )
}

/**
 * A problem, as one compact note under the head: its icon on the rows' icon
 * axis, its words on their label edge, in red — amber for a warning that
 * leaves things as they were. At most one link, and the "Details" toggle
 * where there is more to say: why (a reason the words leave out) and the
 * platform's own words.
 */
function Note({
  text,
  reason,
  detail,
  link,
  tone = "bad",
}: {
  text: string
  reason?: string | null
  detail?: string | null
  link?: ReactNode
  tone?: "bad" | "warn"
}) {
  const t = useTranslations("SrnAccount")
  const [shown, setShown] = useState(false)
  const more = Boolean(reason || detail)
  return (
    <div
      className={cn(
        "flex rounded-xl py-2 pe-2",
        MENU_SMALL_TEXT,
        MENU_ICON_COLUMN,
        tone === "bad"
          ? "bg-red-500/[0.07] text-red-700 dark:bg-red-500/10 dark:text-red-300"
          : "bg-amber-500/10 text-amber-800 dark:text-amber-300"
      )}
    >
      <CircleAlert aria-hidden="true" className={cn(MENU_ICON, "shrink-0")} />
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
        <p role="alert" className="break-words">
          {text}
        </p>
        {(link || more) && (
          <div className="flex flex-wrap items-center gap-x-3">
            {link}
            {more && (
              <DropdownMenuItem
                aria-expanded={shown}
                onSelect={(event) => {
                  event.preventDefault()
                  setShown((was) => !was)
                }}
                className={cn(NOTE_CONTROL, "gap-0.5 opacity-80")}
              >
                <ChevronRight
                  aria-hidden="true"
                  className={cn(
                    "size-3 transition-transform rtl:-scale-x-100",
                    shown && "rotate-90 rtl:scale-x-100"
                  )}
                />
                {t("details")}
              </DropdownMenuItem>
            )}
          </div>
        )}
        {shown && (
          <div className="flex flex-col gap-1 opacity-80 select-text">
            {reason && <p className="break-words">{reason}</p>}
            {detail && <p className="font-mono text-3xs break-all">{detail}</p>}
          </div>
        )}
      </div>
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

function ProblemNote({
  problem,
  text,
  link,
}: {
  problem: SrnProblem
  /** Words for this place instead of the problem's own. */
  text?: string
  link?: ReactNode
}) {
  const say = useProblemText()
  // A sign-out SpaceRing did not confirm keeps why it could not under
  // "Details": the note itself says what happened, and where to go.
  const reason = srnReasonOf(problem)
  return (
    <Note
      text={text ?? say(problem)}
      reason={
        problem.name === "signedOutLocally" && reason
          ? say({ ...problem, name: reason })
          : null
      }
      detail={problem.detail}
      link={link}
    />
  )
}

/** The problems a state has to say, under its head. */
function Notes({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-1 empty:hidden">{children}</div>
}

/**
 * The account's row at the foot, drawn as the menu's other rows are. It keeps the menu open: the outcome —
 * a spinner, the next state, or why it failed — is shown where it was asked
 * for. One at work keeps its full colour while the others fade.
 */
function SrnItem({
  icon,
  label,
  onSelect,
  disabled = false,
  busy = false,
}: {
  icon: ReactNode
  label: string
  onSelect: () => void
  disabled?: boolean
  busy?: boolean
}) {
  return (
    <MenuRow
      icon={
        busy ? <Loader2 aria-hidden="true" className="animate-spin" /> : icon
      }
      label={label}
      disabled={disabled}
      aria-busy={busy || undefined}
      onSelect={(event) => {
        event.preventDefault()
        onSelect()
      }}
      className={cn(busy && "data-disabled:opacity-100")}
    />
  )
}

function CopyLinkLink({ url, disabled }: { url: string; disabled: boolean }) {
  const t = useTranslations("SrnAccount.actions")
  const [copied, markCopied] = useCopiedFlag()
  return (
    <NoteLink
      label={copied ? t("copied") : t("copyLink")}
      done={copied}
      disabled={disabled}
      onSelect={async () => {
        if (await copyTextToClipboard(url)) markCopied()
      }}
    />
  )
}

/** The account's parts of the menu, laid out by {@link StatusBarSrn}. */
interface AccountParts {
  /** The head, and the notes under it. */
  head: ReactNode
  /** The one account action at the foot, or none. */
  footRow: ReactNode
}

/** The account's parts, per state. `close` closes the menu. */
function useAccountParts(
  account: SrnAccountController,
  close: () => void,
  remoteWindow: boolean
): AccountParts {
  const t = useTranslations("SrnAccount")
  const ta = useTranslations("SrnAccount.actions")
  const { kind, state, busy, failure, signOutNotice, resultNotice } = account
  const working = busy !== null
  const web = kind === "web"
  const foot = remoteWindow ? t("thisComputer") : null

  // How the sign-in this page came back from ended (Codeg Web), whatever
  // the state now is.
  const resultNote = resultNotice && <ProblemNote problem={resultNotice} />

  // A command's failure, in words for where it happened.
  const failureNote = failure && (
    <ProblemNote
      problem={failure.problem}
      text={
        failure.action === "signOut" &&
        failure.problem.name === "accountChanged"
          ? t("signOut.accountChanged")
          : undefined
      }
    />
  )

  // A page of the website opens in the browser; the menu closes once it
  // has, and stays to say why when it could not.
  const openPage = (open: () => Promise<boolean>) => () => {
    void open().then((opened) => {
      if (opened) close()
    })
  }

  const signInItem = (label: string) => (
    <SrnItem
      icon={<LogIn aria-hidden="true" className="rtl:-scale-x-100" />}
      label={
        busy === "signIn" ? (web ? ta("goingToSrn") : ta("signingIn")) : label
      }
      busy={busy === "signIn"}
      disabled={working}
      onSelect={account.signIn}
    />
  )

  const signOutItem = (
    <SrnItem
      icon={<LogOut aria-hidden="true" className="rtl:-scale-x-100" />}
      label={busy === "signOut" ? ta("signingOut") : ta("signOut")}
      busy={busy === "signOut"}
      disabled={working}
      onSelect={account.signOut}
    />
  )

  const none = { footRow: null }

  switch (state.status) {
    case "notEnabled":
      return {
        ...none,
        head: (
          <>
            <RingIdentity
              sub={<StateLine tone="neutral">{t("notEnabled")}</StateLine>}
              foot={foot}
            />
            <Notes>{resultNote}</Notes>
          </>
        ),
      }

    case "unavailable":
      // Not signed out: the server cannot tell now. Reading again is all
      // there is to do.
      return {
        head: (
          <>
            <RingIdentity
              sub={<StateLine tone="warn">{t("unavailable.badge")}</StateLine>}
              foot={foot}
            />
            <Notes>
              {resultNote}
              <ProblemNote problem={srnProblemOf(state.problem)} />
              {failureNote}
            </Notes>
          </>
        ),
        footRow: (
          <SrnItem
            icon={<RotateCw aria-hidden="true" />}
            label={ta("tryAgain")}
            busy={busy === "check"}
            disabled={working}
            onSelect={account.checkAgain}
          />
        ),
      }

    case "loading":
      return {
        ...none,
        head: (
          <RingIdentity
            sub={
              <StateLine tone="neutral" working>
                {t("loading")}
              </StateLine>
            }
            foot={foot}
          />
        ),
      }

    case "signedOut": {
      const problem = state.problem ? srnProblemOf(state.problem) : null
      // The sign-in that is still in the keychain goes with a sign-out,
      // which keeps trying the keychain until it lets go; then the state
      // has no problem, and the row is the sign-in again.
      const leftover = problem?.name === "keychainCleanup"
      return {
        head: (
          <>
            <RingIdentity
              sub={<StateLine tone="neutral">{t("signedOut.badge")}</StateLine>}
              foot={foot}
            />
            <Notes>
              {resultNote}
              {problem && <ProblemNote problem={problem} />}
              {signOutNotice && (
                <ProblemNote
                  problem={signOutNotice}
                  // On the Web it is this browser that is signed out, not
                  // the computer.
                  text={web ? t("signOut.webSignedOutLocally") : undefined}
                  // The way to the website's list, where the connection
                  // SpaceRing did not hear end can be removed by hand.
                  link={
                    <NoteLink
                      label={ta("manageConnections")}
                      external
                      busy={busy === "manage"}
                      disabled={working}
                      onSelect={openPage(account.openManageConnections)}
                    />
                  }
                />
              )}
              {failureNote}
            </Notes>
          </>
        ),
        footRow: leftover ? signOutItem : signInItem(ta("signIn")),
      }
    }

    case "pending": {
      const noBrowser =
        srnProblemCode(state.problem) === "open_browser_failed" &&
        !state.completing
      return {
        head: (
          <>
            {/* One line, as other apps wait for a browser: what to do, and
                a spinner while the desktop listens for its return. The
                Web's page is this tab, so nothing is under way here. */}
            <RingIdentity
              sub={
                web ? (
                  <StateLine tone="waiting" pulse>
                    {t("pending.webLine")}
                  </StateLine>
                ) : (
                  <StateLine tone="waiting" working>
                    {state.completing
                      ? t("pending.completingLine")
                      : t("pending.line")}
                  </StateLine>
                )
              }
              foot={foot}
            />
            <Notes>
              {resultNote}
              {/* The link is the way when the browser would not open: it
                  is copied, never shown. */}
              {noBrowser && (
                <Note
                  text={t("pending.openBrowserFailed")}
                  link={
                    !web && (
                      <CopyLinkLink
                        url={state.authorizationUrl}
                        disabled={working}
                      />
                    )
                  }
                />
              )}
              {failureNote}
            </Notes>
          </>
        ),
        // The Web has nothing to cancel — a sign-in left waiting expires,
        // and a new one replaces it. The desktop's cancel stays while the
        // sign-in completes.
        footRow: web ? (
          !state.completing && (
            <SrnItem
              icon={<RotateCcw aria-hidden="true" />}
              label={busy === "signIn" ? ta("goingToSrn") : ta("startOver")}
              busy={busy === "signIn"}
              disabled={working}
              onSelect={account.signIn}
            />
          )
        ) : (
          <SrnItem
            icon={<X aria-hidden="true" />}
            label={ta("cancel")}
            disabled={busy === "cancel"}
            onSelect={account.cancelSignIn}
          />
        ),
      }
    }

    case "signedIn": {
      const { account: who, online } = state
      const name = displayNameOf(who)
      // The desktop hears when a check under way ends; the Web does not, so
      // there only this page's own check counts.
      const checking = busy === "check" || (!web && online.checking)
      const problem = online.problem ? srnProblemOf(online.problem) : null
      // With no name, the name in the head is the number already.
      const number = who.name.trim()
        ? t("signedIn.srn", { srn: String(who.srn) })
        : undefined
      return {
        head: (
          <>
            <ConsoleHead
              glyph={
                <SrnAvatar
                  account={who}
                  fetch={account.avatar}
                  // An initial a little under half the circle: any larger,
                  // it reads as a badge rather than a picture.
                  className={cn(
                    MENU_AVATAR,
                    "text-sm ring-1 ring-foreground/10"
                  )}
                />
              }
              title={name}
              sub={
                number && (
                  <span className="truncate tabular-nums">{number}</span>
                )
              }
              subText={number}
              foot={foot}
              busy={busy === "console"}
              disabled={working}
              onSelect={openPage(account.openConsole)}
            />
            <Notes>
              {resultNote}
              {/* Confirmed or not checked yet, there is nothing to say. Not
                  confirmed, the person is still signed in, and why is under
                  "Details". */}
              {online.status === "unconfirmed" && (
                <UnconfirmedNote
                  problem={problem}
                  link={
                    <NoteLink
                      label={checking ? ta("checking") : ta("checkAgain")}
                      busy={checking}
                      disabled={working || checking}
                      onSelect={account.checkAgain}
                    />
                  }
                />
              )}
              {failureNote}
            </Notes>
          </>
        ),
        footRow: signOutItem,
      }
    }

    case "credentialUnreadable":
      // Not signed out: reading the keychain again may work (it may have
      // been locked), and a new sign-in replaces what it holds.
      return {
        head: (
          <>
            <RingIdentity
              sub={<StateLine tone="bad">{t("unreadable.badge")}</StateLine>}
              foot={foot}
            />
            <Notes>
              <ProblemNote
                problem={srnProblemOf(state.problem)}
                link={
                  <NoteLink
                    label={ta("tryAgain")}
                    busy={busy === "check"}
                    disabled={working}
                    onSelect={account.checkAgain}
                  />
                }
              />
              {failureNote}
            </Notes>
          </>
        ),
        footRow: signInItem(ta("signInAgain")),
      }
  }
}

/** Signed in, but SpaceRing could not confirm it online: one amber line. */
function UnconfirmedNote({
  problem,
  link,
}: {
  problem: SrnProblem | null
  link: ReactNode
}) {
  const t = useTranslations("SrnAccount")
  const say = useProblemText()
  return (
    <Note
      tone="warn"
      text={t("signedIn.unconfirmed")}
      reason={problem && say(problem)}
      detail={problem?.detail}
      link={link}
    />
  )
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
  const tTrigger = useTranslations("SrnAccount.trigger")
  const tQuick = useTranslations("Folder.statusBar.quickActions")
  const [open, setOpen] = useState(false)
  const account = useSrnAccount({
    onBrowserOutcome: () => {
      if (getCurrentWindowLabel() === MAIN_WINDOW_LABEL) setOpen(true)
    },
  })
  const quick = useQuickActions()
  const { state } = account
  const remoteWindow = isRemoteDesktopWindow()
  const descriptionId = useId()

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
  const parts = useAccountParts(
    account,
    () => handleOpenChange(false),
    remoteWindow
  )

  const label = triggerLabelOf(state, tTrigger)
  const signedIn = state.status === "signedIn" ? state.account : null
  const look = ringLook(state)
  // Signed in, the avatar and the name share one capsule, drawn as the
  // command capsule at the bar's other end is: no fill at rest, a
  // translucent one on hover and while open (`bg-muted` would vanish on the
  // bar's own muted surface). On phones, and for the ring, the same
  // capsule shrinks to a circle around the glyph.
  const withName = signedIn !== null && !compact

  return (
    <>
      <DropdownMenu open={open} onOpenChange={handleOpenChange}>
        <DropdownMenuTrigger asChild>
          {/* Named by the account, as it reads now; described as the quick
              actions too, which the same menu holds. */}
          <button
            type="button"
            aria-label={label}
            aria-describedby={descriptionId}
            title={label}
            data-srn-status={state.status}
            className={cn(
              "flex h-6 min-w-0 items-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-foreground/10 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-expanded:bg-foreground/10 aria-expanded:text-foreground",
              withName && "pe-2"
            )}
          >
            {/* The glyph's box stays 1.5rem square and first in the capsule:
                it is what holds the bar's leading rail (see
                `status-bar.tsx`), and it centres a 0.875rem glyph in the
                capsule's round end. */}
            <span
              data-srn-box=""
              className="relative flex size-6 shrink-0 items-center justify-center"
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
            {withName && (
              <span className="max-w-40 truncate text-xs leading-4">
                {displayNameOf(signedIn)}
              </span>
            )}
          </button>
        </DropdownMenuTrigger>
        {/* `side="top"`: the trigger sits on the window's bottom edge, so
            the menu grows upward, and scrolls where the window is short. A
            fixed width, not the trigger's, so the head, its notes and the
            rows keep one measure: 19rem, the same on a 320px phone as on a
            desktop, and the longest rows' translations are worded to fit it
            (the remote workspaces' submenu row the longest). Never wider
            than the window, less a margin. */}
        <DropdownMenuContent
          side="top"
          align="start"
          className={cn(
            "w-76 max-w-[calc(100vw-1rem)]",
            MENU_FADES_UNDER_SUBMENU
          )}
        >
          {/* A group named after the account: a screen reader says whose
              notes and links these are on the way into them. */}
          <DropdownMenuGroup aria-label={label}>{parts.head}</DropdownMenuGroup>
          <DropdownMenuSeparator />
          <QuickActionsItems actions={quick} />
          {parts.footRow && (
            <>
              <DropdownMenuSeparator />
              {parts.footRow}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <span id={descriptionId} hidden>
        {tQuick("title")}
      </span>
      <QuickActionsDialogs actions={quick} />
    </>
  )
}
