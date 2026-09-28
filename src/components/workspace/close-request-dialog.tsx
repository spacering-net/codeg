"use client"

/**
 * Answers the main window's close button when the backend cannot decide alone.
 *
 * The backend prevents the close, then emits `app://close-request` to the main
 * window and waits. Nothing else will act on that press: until
 * `resolve_close_request` is called the window stays open and the backend's
 * "a prompt is up" flag suppresses further presses. Every exit from this
 * component therefore has to reach that call — including Esc, which is why the
 * dialog is controlled rather than left to close itself.
 *
 * Mounted in the ROOT layout, not the workspace one: the main window also
 * shows `/login` and the redirecting `/`, and on those routes a workspace-only
 * mount would leave the press unanswered and the close button dead. The root
 * layout is shared with the pet / settings / pet-panel webviews, so the
 * listener is gated on the window label instead.
 *
 * Two prompts, one listener, because they share that single-flag protocol:
 * - `ask` — the first close ever. Offer both actions plus "remember", which is
 *   what turns the preference from a settings page nobody visits into
 *   something the user actually sets.
 * - `confirm_terminals` — the choice is already pinned to exit, but live
 *   terminals would die with it. Confirm the loss, do not re-ask the pref.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
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
} from "@/components/ui/alert-dialog"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { listenCloseRequest, resolveCloseRequest } from "@/lib/api"
import { getCurrentWindow, isDesktop } from "@/lib/platform"
import { toErrorMessage } from "@/lib/app-error"
import type { CloseRequestPayload } from "@/lib/types"

type CloseAction = "minimize" | "exit" | "cancel"

/** The only window whose close button routes through this prompt. */
const MAIN_WINDOW_LABEL = "main"

// Retry backoff for the window-spin-up case, same shape `usePetSessions` uses
// and for the same reason: `main` makes its first Tauri IPC calls while the
// window is still coming up, where the first one can reject or stall once
// before the bridge is ready. Both halves of the arming sequence retry, because
// neither is re-attempted from anywhere else for the rest of the session —
// losing the subscription loses every prompt, and losing the handshake leaves
// the backend acting as if no dialog exists.
const RETRY_BASE_MS = 150
const RETRY_MAX_MS = 2000
const backoffMs = (attempt: number) =>
  Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS)

export function CloseRequestDialog() {
  const t = useTranslations("CloseRequestDialog")
  const [request, setRequest] = useState<CloseRequestPayload | null>(null)
  const [remember, setRemember] = useState(false)
  const [busy, setBusy] = useState(false)
  // Read inside the async responder, which is created once per render but may
  // fire after a state change; a ref keeps it reading the live value.
  const rememberRef = useRef(false)
  rememberRef.current = remember

  useEffect(() => {
    if (!isDesktop()) return

    let disposed = false
    let unsubscribe: (() => void) | null = null
    let warnedSubscribe = false
    let warnedHandshake = false
    const timers = new Set<ReturnType<typeof setTimeout>>()

    const retry = (fn: () => void, attempt: number) => {
      if (disposed) return
      const id = setTimeout(() => {
        timers.delete(id)
        fn()
      }, backoffMs(attempt))
      timers.add(id)
    }

    // The prompt flag lives in the backend process, the dialog in this webview.
    // A reload (dev hot-reload, F5, a webview crash-restart) destroys the
    // dialog without resolving it, and the flag then suppresses every later
    // close press for the rest of the session. A freshly mounted listener means
    // no dialog is on screen, so any flag still set is stale: cancel it.
    //
    // This is also how the backend learns a dialog exists at all: `main` is
    // visible from the first frame, long before React gets here, and an emit
    // into that gap would be reported as delivered while nothing was listening.
    // Until this call lands the close button keeps its pre-preference
    // behavior — so a failure here degrades to "hide to tray", never to a
    // press that vanishes.
    const announceListening = (attempt = 0) => {
      if (disposed) return
      void resolveCloseRequest("cancel", false).catch((err) => {
        if (disposed) return
        if (!warnedHandshake) {
          warnedHandshake = true
          console.warn("[close] close-prompt handshake failed (retrying):", err)
        }
        retry(() => announceListening(attempt + 1), attempt)
      })
    }

    // Subscribe first, so a press landing in this window is still delivered,
    // and announce only once the listener is armed.
    const subscribe = (attempt = 0) => {
      if (disposed) return
      void listenCloseRequest((payload) => {
        // Fresh prompt, fresh checkbox: "remember" is a decision about this
        // press, not a sticky UI preference.
        setRemember(false)
        setBusy(false)
        setRequest(payload)
      })
        .then((fn) => {
          if (disposed) {
            fn()
            return
          }
          unsubscribe = fn
          announceListening()
        })
        .catch((err) => {
          if (disposed) return
          if (!warnedSubscribe) {
            warnedSubscribe = true
            console.warn(
              "[close] close-request subscription failed (retrying):",
              err
            )
          }
          retry(() => subscribe(attempt + 1), attempt)
        })
    }

    void getCurrentWindow()
      .then((win) => {
        if (disposed || win?.label !== MAIN_WINDOW_LABEL) return
        subscribe()
      })
      .catch((err) => {
        console.error("[close] failed to resolve the current window:", err)
      })

    return () => {
      disposed = true
      for (const id of timers) clearTimeout(id)
      timers.clear()
      unsubscribe?.()
    }
  }, [])

  const respond = useCallback(
    async (action: CloseAction) => {
      setBusy(true)
      try {
        await resolveCloseRequest(
          action,
          action !== "cancel" && rememberRef.current
        )
        // On `exit` the process is already tearing down and this never runs —
        // harmless, and leaving the dialog up during teardown is preferable to
        // a window that blanks its own prompt before it goes.
        setRequest(null)
      } catch (err) {
        // The backend released its prompt flag before it could fail, so the
        // close button still works. Keep the dialog up and say why.
        toast.error(t("actionFailed", { message: toErrorMessage(err) }))
      } finally {
        setBusy(false)
      }
    },
    [t]
  )

  if (!request) return null

  const isAsk = request.mode === "ask"
  const terminals = request.running_terminals

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        // Esc. The backend is still holding the press, so dismissing without
        // telling it would wedge the close button for the rest of the session.
        if (!open && !busy) void respond("cancel")
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {isAsk ? t("askTitle") : t("confirmExitTitle")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {isAsk ? t("askDescription") : t("confirmExitDescription")}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {terminals > 0 && (
          <p className="text-2xs text-amber-500">
            {t("runningTerminals", { count: terminals })}
          </p>
        )}

        {isAsk && (
          <div className="flex items-center gap-2">
            <Checkbox
              id="close-request-remember"
              checked={remember}
              disabled={busy}
              onCheckedChange={(checked) => setRemember(checked === true)}
            />
            <Label
              htmlFor="close-request-remember"
              className="text-xs font-normal text-muted-foreground"
            >
              {t("remember")}
            </Label>
          </div>
        )}

        {/* Recommended action first, escape hatch last. */}
        <AlertDialogFooter>
          {isAsk && (
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                event.preventDefault()
                void respond("minimize")
              }}
            >
              {t("minimize")}
            </AlertDialogAction>
          )}
          <AlertDialogAction
            variant={isAsk ? "outline" : "destructive"}
            disabled={busy}
            onClick={(event) => {
              event.preventDefault()
              void respond("exit")
            }}
          >
            {t("exit")}
          </AlertDialogAction>
          <AlertDialogCancel
            disabled={busy}
            onClick={(event) => {
              event.preventDefault()
              void respond("cancel")
            }}
          >
            {t("cancel")}
          </AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
