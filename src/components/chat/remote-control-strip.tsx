"use client"

/**
 * Claude Code's Remote Control, pinned above the transcript in
 * `conversation-shell` while it is on (claude-agent-acp 0.93.0's
 * `/remote-control`).
 *
 * The adapter answers the command itself and nothing of the exchange reaches
 * the transcript, so the reply that carries the session's link is gone once
 * the conversation reloads. This strip keeps the link in reach for as long as
 * the remote session lives: it reads the connection's `remoteControl`, which
 * the snapshot carries and which goes with the agent CLI. It sits with the
 * async-task strip because both are the state of something running right now,
 * and both keep the connection out of the idle sweeps.
 *
 * The QR code is how the link reaches a phone, as on Claude Code's own Remote
 * Control screen. Turning it off sends `/remote-control off`, exactly what the
 * user would type, so the adapter's reply shows up in the transcript the same
 * way. The adapter refuses the command while Claude is working, so the button
 * waits for the turn to end.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Check, Copy, Power, QrCode, Smartphone } from "lucide-react"
import { QRCodeSVG } from "qrcode.react"

import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { openInSystemBrowser } from "@/lib/link-open"
import { copyTextToClipboard } from "@/lib/utils"
import type { RemoteControlInfo } from "@/lib/types"

/** How long the copy button reads "Copied". */
const COPIED_FEEDBACK_MS = 1500

export function RemoteControlStrip({
  remoteControl,
  onTurnOff,
  canTurnOff,
}: {
  remoteControl: RemoteControlInfo
  /** Sends `/remote-control off`. Undefined hides the button, for a surface
   *  that has no connection of its own to send it on (a viewer). */
  onTurnOff?: () => void
  /** False while a turn runs: the adapter would refuse the command. */
  canTurnOff: boolean
}) {
  const t = useTranslations("Folder.chat.remoteControl")
  const url = remoteControl.session_url
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
    },
    []
  )

  const handleCopy = useCallback(async () => {
    if (!url) return
    if (!(await copyTextToClipboard(url))) return
    setCopied(true)
    if (copiedTimer.current) clearTimeout(copiedTimer.current)
    copiedTimer.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS)
  }, [url])

  const handleOpen = useCallback(() => {
    if (url) void openInSystemBrowser(url)
  }, [url])

  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b border-border bg-muted/30 px-4 py-1.5 text-xs"
    >
      <Smartphone
        aria-hidden="true"
        className="size-3.5 shrink-0 text-primary"
      />
      <span className="shrink-0 font-medium text-foreground">{t("title")}</span>
      {url ? (
        <button
          type="button"
          className="min-w-0 truncate text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          title={t("open")}
          onClick={handleOpen}
        >
          {url}
        </button>
      ) : (
        <span className="min-w-0 truncate text-muted-foreground/70">
          {t("noUrl")}
        </span>
      )}
      <span className="ms-auto flex shrink-0 items-center gap-1">
        {url && (
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-2 text-xs"
              >
                <QrCode aria-hidden="true" className="size-3" />
                {t("qr")}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-60 items-center gap-3">
              <div className="rounded-lg bg-white p-3">
                <QRCodeSVG
                  value={url}
                  size={176}
                  marginSize={0}
                  title={t("qrLabel")}
                />
              </div>
              <p className="text-center text-xs text-muted-foreground">
                {t("qrHint")}
              </p>
            </PopoverContent>
          </Popover>
        )}
        {url && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-2 text-xs"
            onClick={() => void handleCopy()}
          >
            {copied ? (
              <Check aria-hidden="true" className="size-3" />
            ) : (
              <Copy aria-hidden="true" className="size-3" />
            )}
            {copied ? t("copied") : t("copy")}
          </Button>
        )}
        {onTurnOff && (
          // The hint rides a wrapper: a disabled button gets no pointer
          // events, so a title on the button itself would never show.
          <span title={canTurnOff ? undefined : t("turnOffBusy")}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!canTurnOff}
              className="h-6 gap-1 px-2 text-xs text-muted-foreground hover:text-destructive"
              onClick={onTurnOff}
            >
              <Power aria-hidden="true" className="size-3" />
              {t("turnOff")}
            </Button>
          </span>
        )}
      </span>
    </div>
  )
}
