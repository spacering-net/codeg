"use client"

import { useEffect, useRef, type ReactNode } from "react"
import { X } from "lucide-react"
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
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { HarnessScroller } from "../harness-scroller"

interface McpDialogFrameProps {
  title: ReactNode
  description?: ReactNode
  /** Every way out — Escape, a press outside, the close button — goes
   *  through here, so a dialog with unsaved changes can ask first. */
  onRequestClose: () => void
  children: ReactNode
  footer: ReactNode
  /** Changes with the step, so the focus can follow it. */
  step?: string
  /** Where the focus goes when the dialog opens. */
  initialFocus?: () => HTMLElement | null
  size?: "default" | "wide"
}

/**
 * The frame every MCP dialog shares: a header that stays, a body that
 * scrolls, a footer with the buttons. On a phone it fills the screen.
 *
 * Its own close button, rather than the shared dialog's: that one's label is
 * not translated and it sits on the physical right, which in Arabic is where
 * the title starts.
 */
export function McpDialogFrame({
  title,
  description,
  onRequestClose,
  children,
  footer,
  step,
  initialFocus,
  size = "default",
}: McpDialogFrameProps) {
  const t = useTranslations("Harness.mcp.dialog")
  const bodyRef = useRef<HTMLDivElement>(null)
  const stepRef = useRef(step)

  // A new step is a new screen: the body starts at its top, and the focus
  // moves into it so a screen reader reads what the step says.
  useEffect(() => {
    if (stepRef.current === step) return
    stepRef.current = step
    const body = bodyRef.current
    if (!body) return
    body.scrollTop = 0
    body.focus({ preventScroll: true })
  }, [step])

  return (
    <Dialog open onOpenChange={(open) => !open && onRequestClose()}>
      <DialogContent
        showCloseButton={false}
        onOpenAutoFocus={(event) => {
          const target = initialFocus?.()
          if (target) {
            event.preventDefault()
            target.focus()
          }
        }}
        className={cn(
          "flex max-h-[min(calc(100dvh-2rem),56rem)] flex-col gap-0 overflow-hidden p-0",
          size === "wide" ? "sm:max-w-2xl" : "sm:max-w-lg",
          // A phone: the whole screen, edge to edge.
          "max-md:fixed max-md:inset-0 max-md:h-dvh max-md:max-h-none max-md:w-auto max-md:max-w-none max-md:rounded-none max-md:ring-0"
        )}
      >
        <div className="flex shrink-0 items-start gap-2 border-b px-5 pt-4 pb-3 max-md:px-4">
          <div className="min-w-0 flex-1 space-y-1">
            <DialogTitle className="text-base leading-snug font-semibold break-words">
              {title}
            </DialogTitle>
            {description ? (
              <DialogDescription className="text-xs">
                {description}
              </DialogDescription>
            ) : (
              // Radix warns without a description; an empty one says
              // nothing to anyone.
              <DialogDescription className="sr-only" />
            )}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("close")}
            title={t("close")}
            onClick={onRequestClose}
            className="-me-2 -mt-1 shrink-0 max-md:size-10"
          >
            <X aria-hidden="true" />
          </Button>
        </div>
        <HarnessScroller ref={bodyRef} tabIndex={-1} className="flex-1">
          <div className="px-5 py-4 max-md:px-4">{children}</div>
        </HarnessScroller>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t px-5 py-3 max-md:px-4 max-md:pb-[max(0.75rem,env(safe-area-inset-bottom))] [&_button]:max-md:h-10">
          {footer}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** "Discard your changes?" — before anything typed is thrown away. */
export function DiscardChangesDialog({
  open,
  onKeep,
  onDiscard,
}: {
  open: boolean
  onKeep: () => void
  onDiscard: () => void
}) {
  const t = useTranslations("Harness.mcp.dialog")
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onKeep()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("discardTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{t("discardBody")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onKeep}>
            {t("keepEditing")}
          </AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onDiscard}>
            {t("discard")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
