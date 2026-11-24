"use client"

import { useCallback, useEffect, useState } from "react"

import { Code2, ShieldAlert } from "lucide-react"
import { useTranslations } from "next-intl"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { browserEvalDecide } from "@/lib/browser/browser-api"
import { readBrowserEvalApprovalNow } from "@/lib/browser/browser-prefs"
import { displayHostPort } from "@/lib/browser/browser-url"
import {
  BROWSER_EVAL_REQUEST_EVENT,
  type BrowserEvalRequestPayload,
} from "@/lib/browser/types"
import { getCurrentWindowLabel } from "@/lib/browser/window-label"
import { getShellTransport, isDesktop } from "@/lib/transport"

/**
 * The question `browser_eval` puts to a person: this code, on this site, once.
 *
 * Mounted next to the browser event bridge rather than inside a tab, because
 * the tab the question is about is very often not the one on screen — an agent
 * works on a page while its user reads the conversation.
 *
 * It is raised only for someone who asked for it: `evalApproval` in Settings →
 * Built-in browser is `silent` by default, and this component answers "yes" for
 * them without showing anything. The decision it stands in for is made on the
 * `browser_eval` tool switch, which ships off and whose own text says that
 * turning it on means code runs without asking. What this component does NOT
 * decide is whether anything may run at all: that switch and the tab's
 * `control` grant are enforced in the backend and are not reachable from here,
 * and a silent run is still recorded on that tab's activity strip.
 *
 * What the dialog is for, when there is one, is that the person reads the code.
 * So it shows all of it, verbatim, unhighlighted and unsummarised, and the
 * backend has already refused anything longer than someone could reasonably
 * read. Nothing here abbreviates, and no answer is ever carried from one
 * snippet to the next: somebody who turned this dialog ON wants each snippet,
 * so an "always allow" button beside the code would undo the only thing they
 * asked for.
 *
 * Refusing is the default in every direction — Escape, the focused button
 * (Radix focuses Cancel in an alert dialog), the window going away, and simply
 * running out of time.
 */

/** One question, plus the local timer that turns it into a refusal. */
interface Pending extends BrowserEvalRequestPayload {
  /** When to stop waiting. `expiresAt` as sent, except that one already past
   *  — a request that sat in a queue, a clock that moved — lapses now rather
   *  than never. */
  lapsesAt: number
}

/** How often the countdown is checked. The lapse only has to be about right —
 *  the backend refuses on its own a moment later either way. */
const TICK_MS = 1000

export function BrowserEvalConfirm() {
  const t = useTranslations("Browser.agent.eval")
  const [pending, setPending] = useState<Pending | null>(null)
  const [answering, setAnswering] = useState(false)

  const answer = useCallback((requestId: string, allow: boolean) => {
    setAnswering(true)
    // The dialog goes as soon as the answer is on its way. There is nothing
    // to wait for: the backend has the question, and a second press cannot
    // change an answer it has already been given.
    setPending((current) => (current?.requestId === requestId ? null : current))
    void browserEvalDecide(requestId, allow).catch(() => {
      // Nothing to report and nothing to retry. An answer that did not arrive
      // leaves the backend waiting, and what it does when nobody answers is
      // refuse — which is what the failed call was trying to say in the "no"
      // case, and the safe reading of it in the "yes" case.
    })
  }, [])

  useEffect(() => {
    // Server mode has no native tabs, so nothing can ask.
    if (!isDesktop()) return
    let cancelled = false
    let unsubscribe: (() => void) | undefined
    void (async () => {
      // This app's own backend, as for every browser event (see
      // `browser-api.ts`): the tabs an agent asks about are of this computer.
      const sub =
        await getShellTransport().subscribe<BrowserEvalRequestPayload>(
          BROWSER_EVAL_REQUEST_EVENT,
          (request) => {
            // Broadcast to every window; shown by the one that owns the tab.
            // The standing answer is applied AFTER this test, not before: every
            // window would otherwise race to approve, and the backend would
            // count whichever arrived first as the answer to a question its
            // owner never saw.
            if (request.ownerWindow !== getCurrentWindowLabel()) return
            // Straight from storage, here, rather than from a rendered value or
            // the cached snapshot. Both of those are updated by something that
            // happens AFTER the person changed the setting — a commit and a
            // passive effect for one, a delivered `storage` event for the
            // other — and the lag is in the unsafe direction: somebody who has
            // just asked to be shown each snippet would have the next one run
            // without being asked. `localStorage` is written by the settings
            // window before it notifies anyone.
            if (readBrowserEvalApprovalNow() === "silent") {
              answer(request.requestId, true)
              return
            }
            setPending({
              ...request,
              lapsesAt: Math.max(Date.now(), request.expiresAt),
            })
            setAnswering(false)
          }
        )
      if (cancelled) sub()
      else unsubscribe = sub
    })()
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [answer])

  // Running out of time is a refusal here as well as in the backend, which
  // holds the same deadline — measured on a real machine, the two land within
  // a few hundred milliseconds of each other, so this is not about answering
  // sooner. It is about the dialog: if the backend's side of the call went
  // away (its broker connection died), nothing there is left to take the
  // question down, and a dialog standing over a question nobody is waiting on
  // is one somebody eventually answers.
  useEffect(() => {
    if (!pending) return
    const timer = window.setInterval(() => {
      if (Date.now() < pending.lapsesAt) return
      answer(pending.requestId, false)
    }, TICK_MS)
    return () => window.clearInterval(timer)
  }, [pending, answer])

  if (!pending) return null
  const site = displayHostPort(pending.origin) ?? pending.origin
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        // Escape, or anything else that closes it: a refusal.
        if (!open && !answering) answer(pending.requestId, false)
      }}
    >
      <AlertDialogContent className="max-w-2xl">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 shrink-0 text-amber-600" />
            {t("title", { site })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {pending.title
              ? t("descriptionWithTitle", { site, title: pending.title })
              : t("description", { site })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Code2 className="h-3.5 w-3.5 shrink-0" />
            <span>{t("codeLabel")}</span>
          </div>
          {/* Scrolls rather than truncates: the person is agreeing to all of
              it, so all of it has to be reachable. */}
          <pre className="max-h-64 overflow-auto rounded border border-border/60 bg-muted/50 p-3 text-xs leading-relaxed whitespace-pre-wrap break-words">
            <code>{pending.code}</code>
          </pre>
          <p className="text-xs text-muted-foreground">{t("everyTime")}</p>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={answering}>
            {t("deny")}
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={answering}
            onClick={(event) => {
              event.preventDefault()
              answer(pending.requestId, true)
            }}
          >
            {t("allow")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
