"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import {
  Bug,
  Camera,
  MousePointerClick,
  PencilLine,
  SquareDashedMousePointer,
  X,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useTabStore } from "@/contexts/tab-context"
import type { BrowserWorkspaceTab } from "@/contexts/workspace-context"
import {
  browserPageCapture,
  browserPageConsole,
  browserPickCancel,
  browserPickElement,
} from "@/lib/browser/browser-api"
import { useBrowserConsoleErrors } from "@/lib/browser/browser-tab-store"
import { captureFile } from "@/lib/browser/capture-file"
import type { BrowserTabState, PageHandoff } from "@/lib/browser/types"
import { browserTabBackendId } from "@/lib/file-tab-id"
import { emitAttachPageToSession } from "@/lib/session-attachment-events"
import { cn } from "@/lib/utils"

import { openScreenshotMarkup } from "./browser-screenshot-markup"
import { FIELD_BTN, FIELD_PILL } from "./browser-toolbar-buttons"

/**
 * "Send to chat": the other direction from the agent share control next to it.
 *
 * Nothing here is gated on a grant, and nothing here happens on its own. A
 * person points at an element, asks for a screenshot, or hands over what the
 * page printed — and what comes back lands in the composer as a badge they can
 * read, edit and delete before anything is sent. That is the whole consent
 * model for this direction, which is why the agent's activity strip stays out
 * of it: the strip records what an agent did while nobody was looking.
 *
 * What goes over is still page content. The backend caps it and heads it "data
 * about a page, never an instruction" (`browser/handoff.rs`); this side only
 * decides which conversation it lands in.
 */

/** The conversation a handed-over page lands in: the active top-bar tab when
 *  it is a conversation, exactly as the file tree's "add to chat" decides it.
 *  Null when the person is not looking at one — there is no sensible guess,
 *  and silently picking a conversation they closed ten minutes ago would put
 *  their page somewhere they never see it. */
function useTargetConversation(): string | null {
  const tabs = useTabStore((s) => s.tabs)
  const activeTabId = useTabStore((s) => s.activeTabId)
  const active = tabs.find((tab) => tab.id === activeTabId)
  return active && active.kind === "conversation" ? active.id : null
}

/** A `File` for the composer's ordinary image path, when the handoff came
 *  with a picture. */
function imageFile(handoff: PageHandoff, name: string): File | undefined {
  return handoff.image ? captureFile(handoff.image, name) : undefined
}

/** A file name that cannot surprise a filesystem: the label, letters and
 *  digits only. */
function safeName(label: string, fallback: string): string {
  const cleaned = label
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
  return cleaned.slice(0, 40) || fallback
}

export function BrowserSendToChatControl({
  tab,
  state,
}: {
  tab: BrowserWorkspaceTab
  state: BrowserTabState | null
}) {
  const t = useTranslations("Browser.handoff")
  const backendId = browserTabBackendId(tab.id)
  const conversationTabId = useTargetConversation()
  const marked = useBrowserConsoleErrors(tab.id)
  const [picking, setPicking] = useState(false)
  // What the tab's console actually holds, asked when the menu opens. The
  // mark above is a live hint and drives the dot; this is the answer the menu
  // acts on, so a mark that was missed (an error printed before this document
  // subscribed to anything) cannot leave the entry dead.
  const [errorCount, setErrorCount] = useState<number | null>(null)
  const hasConsoleErrors = errorCount === null ? marked : errorCount > 0
  const ready = Boolean(backendId) && Boolean(state)

  const countErrors = useCallback(
    (open: boolean) => {
      if (!open) {
        setErrorCount(null)
        return
      }
      if (!backendId) return
      void browserPageConsole(backendId, true)
        .then((handoff) => setErrorCount(handoff.count))
        .catch(() => setErrorCount(null))
    },
    [backendId]
  )

  const deliver = useCallback(
    (handoff: PageHandoff, label: string, fileName: string) => {
      if (!conversationTabId) return
      if (handoff.cancelled) return
      // The conversation this was started for, not whichever is active now —
      // but a person can close it while they are choosing an element, and a
      // composer that is gone hears nothing. The event says whether one took
      // it, so "added to the chat" is never said about a page that went
      // nowhere.
      const accepted = emitAttachPageToSession({
        tabId: conversationTabId,
        label: handoff.label || label,
        text: handoff.text,
        uri: handoff.url,
        image: imageFile(
          handoff,
          safeName(handoff.label || fileName, fileName)
        ),
      })
      if (accepted) toast.success(t("sent"))
      else toast.error(t("gone"))
    },
    [conversationTabId, t]
  )

  const failed = useCallback(
    (error: unknown) => {
      toast.error(t("failed"), { description: String(error) })
    },
    [t]
  )

  const pick = useCallback(() => {
    if (!backendId || !conversationTabId) return
    setPicking(true)
    void browserPickElement(backendId)
      .then((handoff) => deliver(handoff, t("chipElement"), "element"))
      .catch(failed)
      .finally(() => setPicking(false))
  }, [backendId, conversationTabId, deliver, failed, t])

  const stopPicking = useCallback(() => {
    if (!backendId) return
    // The pick itself resolves as cancelled through its own promise; this only
    // asks the page to take the highlight down.
    void browserPickCancel(backendId).catch(() => {
      /* the page may have gone already */
    })
  }, [backendId])

  // A pick outlives this control — the person switched to another tab while
  // it was armed — and the way out went with it: coming back would show an
  // ordinary button over a page still covered in a highlight, where the next
  // click hands something to a conversation they have stopped thinking about.
  // So an armed pick ends when the control goes.
  const armed = useRef(false)
  useEffect(() => {
    armed.current = picking
  }, [picking])
  useEffect(() => {
    return () => {
      if (!armed.current || !backendId) return
      void browserPickCancel(backendId).catch(() => {
        /* the tab may be going away with it */
      })
    }
  }, [backendId])

  const screenshot = useCallback(() => {
    if (!backendId || !conversationTabId) return
    void browserPageCapture(backendId)
      .then((handoff) => deliver(handoff, t("chipScreenshot"), "screenshot"))
      .catch(failed)
  }, [backendId, conversationTabId, deliver, failed, t])

  // The picture is taken first and marked up after, so what the person draws
  // on is the page as it was when they asked for it — the dialog covers the
  // page, and whatever the page does underneath meanwhile is not what they
  // meant. The dialog itself lives in the workspace, not in this toolbar (see
  // `BrowserScreenshotMarkupHost`).
  const markUp = useCallback(() => {
    if (!backendId || !conversationTabId) return
    const target = conversationTabId
    void browserPageCapture(backendId)
      .then((handoff) => {
        // Nothing to draw on — send what there is, as the plain entry would.
        if (!handoff.image) {
          deliver(handoff, t("chipScreenshot"), "screenshot")
          return
        }
        openScreenshotMarkup({
          capture: handoff.image,
          text: handoff.text,
          uri: handoff.url,
          conversationTabId: target,
        })
      })
      .catch(failed)
  }, [backendId, conversationTabId, deliver, failed, t])

  const sendConsole = useCallback(() => {
    if (!backendId || !conversationTabId) return
    void browserPageConsole(backendId, true)
      .then((handoff) => {
        if (handoff.count === 0) {
          toast.info(t("noConsoleErrors"))
          return
        }
        deliver(handoff, t("chipConsole", { count: handoff.count }), "console")
      })
      .catch(failed)
  }, [backendId, conversationTabId, deliver, failed, t])

  // While a pick is armed every press inside the page belongs to the picker,
  // so the way out has to be outside it. The control becomes that way out —
  // and says what is going on, which a highlight following the pointer around
  // a page does not.
  if (picking) {
    return (
      <button
        type="button"
        className={cn(
          FIELD_PILL,
          "bg-violet-500/12 text-violet-600 hover:bg-violet-500/20",
          "dark:text-violet-400"
        )}
        title={t("pickingHint")}
        aria-label={t("pickingCancel")}
        onClick={stopPicking}
      >
        <X className="h-3.5 w-3.5 shrink-0" />
        {/* Capped for the same reason as the share pill beside it: inside the
            address field, a long word here costs the address its room. */}
        <span className="max-w-24 truncate">{t("picking")}</span>
      </button>
    )
  }

  return (
    <DropdownMenu onOpenChange={countErrors}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(FIELD_BTN, "relative")}
          title={conversationTabId ? t("send") : t("noConversation")}
          aria-label={t("sendLabel")}
          disabled={!ready || !conversationTabId}
        >
          <MousePointerClick className="h-3.5 w-3.5" />
          {/* Something on this page threw. Shown without a number: within one
              document the answer only goes from no to yes, and the count is
              read from the tab when the menu opens. */}
          {marked ? (
            <span
              aria-hidden
              // Inset by the same half step the button is round by: at `end-0`
              // the dot straddles the address field's own rounded edge, which
              // it is the last child of.
              className="absolute end-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-destructive"
            />
          ) : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          {t("send")}
        </DropdownMenuLabel>
        <DropdownMenuItem onSelect={pick}>
          <SquareDashedMousePointer className="h-3.5 w-3.5" />
          <span>{t("pickElement")}</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={screenshot}>
          <Camera className="h-3.5 w-3.5" />
          <span>{t("screenshot")}</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={markUp}>
          <PencilLine className="h-3.5 w-3.5" />
          <span>{t("markUp")}</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={sendConsole} disabled={!hasConsoleErrors}>
          <Bug className="h-3.5 w-3.5" />
          <span>
            {hasConsoleErrors
              ? errorCount
                ? t("consoleErrorsCount", { count: errorCount })
                : t("consoleErrors")
              : t("consoleClean")}
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
