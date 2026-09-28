"use client"

import { useRef, type KeyboardEvent } from "react"

import {
  Bot,
  Eye,
  History,
  MousePointerClick,
  ShieldOff,
  TriangleAlert,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import type { BrowserWorkspaceTab } from "@/contexts/workspace-context"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { shareableOrigin } from "@/lib/browser/browser-agent-grant"
import { browserAgentGrant } from "@/lib/browser/browser-api"
import { useBrowserPrefs } from "@/lib/browser/browser-prefs"
import {
  useBrowserAgentActivity,
  type BrowserAgentActivity,
} from "@/lib/browser/browser-tab-store"
import { displayHostPort } from "@/lib/browser/browser-url"
import type {
  AgentAction,
  AgentGrant,
  AgentOutcome,
  BrowserTabState,
  GrantLevel,
} from "@/lib/browser/types"
import { browserTabBackendId } from "@/lib/file-tab-id"
import { isRemoteDesktopMode } from "@/lib/transport"
import { cn } from "@/lib/utils"

import { FIELD_BTN, FIELD_PILL } from "./browser-toolbar-buttons"

/**
 * The one place a person hands a page to an agent, and the running account of
 * what agents did with it. Both live inside the address field — the left end
 * for the decision, the right end for the record of what it let happen.
 *
 * Two levels are offered, `read` and `control`, as two entries of one menu:
 * reading a page cannot change it, acting on it can, and they are different
 * decisions for the person to make. A shared tab can be moved between the two
 * without being taken back first.
 *
 * The settings' default (`defaultAgentGrant` in `browser-prefs`) has usually
 * answered this already — `browser-agent-grant.ts` applies it to every site a
 * tab arrives at — so the unshared menu below is what a person sees on a site
 * they took the grant back on, or with the default set to share nothing. It
 * still opens onto that default, and says which entry it is.
 */

/** One arrow press down the activity list: about two of its lines. */
const LIST_SCROLL_STEP_PX = 48

/**
 * The colour of "an agent can read this", everywhere it appears: the chip in
 * the toolbar and the glyph in the tab strip. Nothing is drawn on the page
 * itself.
 *
 * A fixed hue rather than the theme's `primary`, which is what this started
 * as. Every stock theme in the app sets `--primary` to a neutral (chroma 0),
 * so a primary-tinted mark is a slightly darker grey — lost among the chrome
 * around it. A mark that says a page is exposed should not be something the
 * theme picker can tune down.
 */
export const AGENT_MARK = "text-violet-600 dark:text-violet-400"

/** The pinned program's file name — what the person would have typed —
 *  rather than the path they never look at. Null when this grant has no pin,
 *  which is every address but a loopback one. */
function pinnedProgram(grant: AgentGrant | null): string | null {
  const program = grant?.listener?.program
  if (!program) return null
  return program.split(/[/\\]/).filter(Boolean).pop() ?? null
}

/** The share control in a browser tab's toolbar. */
export function BrowserAgentShareControl({
  tab,
  state,
}: {
  tab: BrowserWorkspaceTab
  state: BrowserTabState | null
}) {
  const t = useTranslations("Browser.agent")
  const backendId = browserTabBackendId(tab.id)
  const grant = state?.agentGrant ?? null
  const origin = shareableOrigin(state)
  const defaultLevel = useBrowserPrefs().defaultAgentGrant

  const share = (level: GrantLevel) => {
    if (!backendId) return
    void browserAgentGrant(backendId, level)
      .then(() => {
        if (level === "none" || !origin) return
        toast.success(
          t(level === "control" ? "sharedControlToast" : "sharedToast", {
            origin: displayOrigin(origin),
          })
        )
      })
      .catch((error: unknown) => {
        toast.error(t("shareFailed"), { description: String(error) })
      })
  }

  if (!grant) {
    // The agents of a remote workspace run on its host, and their browser
    // tools reach that host's codeg — which has no browser. Sharing a page
    // of this window would hand it to nobody who works here.
    const remoteWindow = isRemoteDesktopMode()
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={FIELD_BTN}
            title={
              remoteWindow
                ? t("remoteWindow")
                : origin
                  ? t("share", { origin: displayOrigin(origin) })
                  : t("notShareable")
            }
            aria-label={t("shareLabel")}
            disabled={remoteWindow || !backendId || !origin}
          >
            <Bot className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-56">
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
            {origin ? t("share", { origin: displayOrigin(origin) }) : null}
          </DropdownMenuLabel>
          {/* The default goes first, which is what being the default amounts
              to in a menu: it is the entry the pointer is already next to and
              the one a keyboard lands on when the menu opens. The tag says so
              out loud, because "read and act" arriving above "read" inverts
              the usual narrowest-first order and should not look like an
              accident. A default of `none` marks neither and leaves the
              narrowest first: this menu is then the only way anything is
              shared at all. */}
          {(defaultLevel === "control"
            ? (["control", "read"] as const)
            : (["read", "control"] as const)
          ).map((level) => (
            <DropdownMenuItem key={level} onSelect={() => share(level)}>
              {level === "read" ? (
                <Eye className="h-3.5 w-3.5" />
              ) : (
                <MousePointerClick className="h-3.5 w-3.5" />
              )}
              <span>{t(level === "read" ? "shareRead" : "shareControl")}</span>
              {/* `ms-auto`, not `ml-auto`: Arabic is a live locale here. */}
              {level === defaultLevel ? (
                <span className="ms-auto shrink-0 text-[10px] text-muted-foreground">
                  {t("levelDefault")}
                </span>
              ) : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  const acting = grant.level === "control"
  const sharedWith = t(acting ? "sharedWithControl" : "sharedWith", {
    origin: displayOrigin(grant.origin),
  })
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            FIELD_PILL,
            "bg-violet-500/12 hover:bg-violet-500/20",
            AGENT_MARK
          )}
          title={sharedWith}
          aria-label={sharedWith}
        >
          <Bot className="h-3.5 w-3.5 shrink-0" />
          {/* Capped like the profile chip's name: this pill is inside the
              address field now, and "Shared · can act" runs to twice the
              length in some locales — enough to leave a narrow pane with an
              address bar that has no room for an address. */}
          <span className="max-w-24 truncate">
            {t(acting ? "sharedControl" : "shared")}
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          {sharedWith}
        </DropdownMenuLabel>
        {/* What the grant is actually bound to, in the words that matter: it
            outlives this page and ends at the edge of this site. */}
        <DropdownMenuLabel className="pt-0 text-xs font-normal text-muted-foreground/80">
          {t("sharedScope")}
        </DropdownMenuLabel>
        {/* And for a loopback address, the edge of the site is not the whole
            boundary: `localhost:3000` is a port number, so the grant is also
            bound to the program behind it. Saying which one here is what
            keeps the notice from arriving out of nowhere later. */}
        {pinnedProgram(grant) ? (
          <DropdownMenuLabel className="pt-0 text-xs font-normal text-muted-foreground/80">
            {t("sharedScopeProgram", { program: pinnedProgram(grant)! })}
          </DropdownMenuLabel>
        ) : null}
        <DropdownMenuSeparator />
        {/* The other level, whichever that is: a person who shared for
            reading is asked whether agents may act; one who allowed actions
            can pull back to reading without ending the share. */}
        {acting ? (
          <DropdownMenuItem onSelect={() => share("read")}>
            <Eye className="h-3.5 w-3.5" />
            <span>{t("readOnly")}</span>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem onSelect={() => share("control")}>
            <MousePointerClick className="h-3.5 w-3.5" />
            <span>{t("allowActions")}</span>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => share("none")}>
          <ShieldOff className="h-3.5 w-3.5" />
          <span>{t("stopSharing")}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** `https://example.com:8443` → `example.com:8443`; anything unparseable as
 *  it stands. */
function displayOrigin(origin: string): string {
  return displayHostPort(origin) ?? origin
}

// One line per (action, outcome), spelled out rather than composed: "Refused
// to click" and "Couldn't click" are different sentences in most languages,
// not one template with a verb dropped in.
const ACTIVITY_KEYS = {
  read: {
    done: "activity.read.done",
    refused: "activity.read.refused",
    failed: "activity.read.failed",
  },
  click: {
    done: "activity.click.done",
    refused: "activity.click.refused",
    failed: "activity.click.failed",
  },
  hover: {
    done: "activity.hover.done",
    refused: "activity.hover.refused",
    failed: "activity.hover.failed",
  },
  type: {
    done: "activity.type.done",
    refused: "activity.type.refused",
    failed: "activity.type.failed",
  },
  press: {
    done: "activity.press.done",
    refused: "activity.press.refused",
    failed: "activity.press.failed",
  },
  select: {
    done: "activity.select.done",
    refused: "activity.select.refused",
    failed: "activity.select.failed",
  },
  capture: {
    done: "activity.capture.done",
    refused: "activity.capture.refused",
    failed: "activity.capture.failed",
  },
  console: {
    done: "activity.console.done",
    refused: "activity.console.refused",
    failed: "activity.console.failed",
  },
  eval: {
    done: "activity.eval.done",
    refused: "activity.eval.refused",
    failed: "activity.eval.failed",
  },
  open: {
    done: "activity.open.done",
    refused: "activity.open.refused",
    failed: "activity.open.failed",
  },
  navigate: {
    done: "activity.navigate.done",
    refused: "activity.navigate.refused",
    failed: "activity.navigate.failed",
  },
  close: {
    done: "activity.close.done",
    refused: "activity.close.refused",
    failed: "activity.close.failed",
  },
} as const satisfies Record<AgentAction, Record<AgentOutcome, string>>

function activityLabel(
  t: ReturnType<typeof useTranslations<"Browser.agent">>,
  entry: BrowserAgentActivity
): string {
  return t(ACTIVITY_KEYS[entry.action][entry.outcome])
}

/**
 * What agents have done to this tab, newest first, behind a button at the
 * right end of the address field.
 *
 * It used to be a band stacked between the toolbar and the page. That put a
 * record of what happened in the way of the thing it happened to — it pushed
 * every page down by 28px the moment an agent first touched the tab (so a
 * viewport an agent had just measured stopped being true), and it stayed
 * there afterwards with nothing but old lines on it. A button that appears
 * when there is something to show says the same thing without taking the
 * page's room, and the whole list is one click away rather than the top line
 * plus a disclosure.
 *
 * Shown whenever there is anything to show — including on a tab nobody
 * shared, where every line is a refusal. That is the case worth surfacing
 * most: an agent reaching for a page it was never given is invisible
 * otherwise, since the only party told about it is the agent. Which is why
 * the closed button carries the same three glyphs the band did, and why the
 * one it shows is the newest line that did NOT go as asked rather than the
 * newest line: from the closed state that mark is all there is, and a refusal
 * followed by one successful read would otherwise take it back off while the
 * refusal was still in the list. The cost of that choice is that the closed
 * control stops naming the newest attempt once anything is flagged — which is
 * the right way round, since "an agent was refused here" outranks "and then it
 * read the page thirty more times", and the list says both.
 */
export function BrowserAgentActivityControl({
  tab,
}: {
  tab: BrowserWorkspaceTab
}) {
  const t = useTranslations("Browser.agent")
  const activity = useBrowserAgentActivity(tab.id)
  const listRef = useRef<HTMLDivElement | null>(null)
  const latest = activity[0]
  if (!latest) return null
  // Newest first, so the first non-`done` line is the newest one.
  const flagged = activity.find((entry) => entry.outcome !== "done") ?? null
  const shown = flagged ?? latest
  // With the count, because a line stands for a run: one refused click and a
  // retry loop of forty would otherwise produce the same glyph, the same
  // colour and the same sentence, and the loop is the case this control is
  // for.
  const label = t("activityLabel", {
    entry:
      shown.count > 1
        ? `${activityLabel(t, shown)} ${t("activityCount", { count: shown.count })}`
        : activityLabel(t, shown),
  })
  const Glyph = flagged
    ? flagged.outcome === "refused"
      ? ShieldOff
      : TriangleAlert
    : History
  // Radix keeps focus on the menu's content and steers the vertical keys at
  // menu items — this menu has none (its lines are a record, not choices), so
  // it swallows them and the list would not scroll for anyone on a keyboard.
  // Scroll it here instead: Radix's own handler is composed AFTER this one
  // and skipped once this one has called `preventDefault`. Which also means
  // the day this menu gains a real `DropdownMenuItem`, arrow-to-focus will
  // stop working for it unless these keys are handed back.
  const scrollList = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = listRef.current
    if (!list) return
    const step =
      event.key === "ArrowDown"
        ? LIST_SCROLL_STEP_PX
        : event.key === "ArrowUp"
          ? -LIST_SCROLL_STEP_PX
          : event.key === "PageDown"
            ? list.clientHeight
            : event.key === "PageUp"
              ? -list.clientHeight
              : event.key === "Home"
                ? -list.scrollHeight
                : event.key === "End"
                  ? list.scrollHeight
                  : null
    if (step === null) return
    event.preventDefault()
    list.scrollTop += step
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(FIELD_BTN, flagged && "text-amber-600")}
          // The same sentence either way round: a tooltip nobody hovers and
          // an accessible name nobody sees would otherwise each carry half.
          title={label}
          aria-label={label}
        >
          <Glyph className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-80 max-w-[90vw] p-0"
        onKeyDown={scrollList}
      >
        <div className="px-2 py-1.5 text-xs font-normal text-muted-foreground">
          {t("activityTitle")}
        </div>
        {/* Deep enough for a working session's worth of lines, and scrolled
            past that rather than grown into a menu taller than the window. */}
        <div
          ref={listRef}
          role="group"
          aria-label={t("activityTitle")}
          className="max-h-64 overflow-y-auto border-t border-border/40 py-1"
        >
          {activity.map((entry, index) => (
            <ActivityLine
              // Entries are append-only at the head and collapse in place, so
              // an index names the same attempt for as long as the list lives.
              key={`${entry.at}-${index}`}
              t={t}
              entry={entry}
            />
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ActivityLine({
  t,
  entry,
}: {
  t: ReturnType<typeof useTranslations<"Browser.agent">>
  entry: BrowserAgentActivity
}) {
  // Clock time, not "3s ago": no ticking to keep it honest, and "when
  // exactly" is the question a record of what touched your page is for.
  const when = new Date(entry.at).toLocaleTimeString()
  return (
    <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
      {entry.outcome === "refused" ? (
        <ShieldOff className="h-3.5 w-3.5 shrink-0 text-amber-600" />
      ) : entry.outcome === "failed" ? (
        <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-amber-600" />
      ) : (
        <Bot className={cn("h-3.5 w-3.5 shrink-0", AGENT_MARK)} />
      )}
      <span className="min-w-0 flex-1 truncate">
        {activityLabel(t, entry)}
        {entry.count > 1 ? (
          <span className="ms-1.5 tabular-nums">
            {t("activityCount", { count: entry.count })}
          </span>
        ) : null}
      </span>
      <span className="shrink-0 text-muted-foreground/70 tabular-nums">
        {when}
      </span>
    </div>
  )
}
