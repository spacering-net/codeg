"use client"

import { useTranslations } from "next-intl"
import { useMemo, useRef, useState, type KeyboardEvent } from "react"

import { useOptionalWorkspaceActions } from "@/contexts/workspace-context"
import {
  browserDeviceKind,
  clampCustomLength,
  emulatedViewport,
  type EmulatedBrowserDevice,
  type ViewportSize,
} from "@/lib/browser/browser-device"
import { setBrowserCustomDevice } from "@/lib/browser/browser-prefs"

import { BROWSER_DEVICE_ICONS, viewportLabel } from "./browser-device-menu"

/** Digits enough for the largest size a custom device can have (8192). */
const MAX_DIGITS = 4

/**
 * What changes a tab's custom size: the tab takes it, and it becomes the size
 * the next tab picked as "Custom" starts at. `undefined` outside a workspace,
 * where there is no record to change.
 */
export function useBrowserTabCustomSize(
  tabId: string
): ((size: ViewportSize) => void) | undefined {
  const setDevice = useOptionalWorkspaceActions()?.setBrowserTabDevice
  return useMemo(
    () =>
      setDevice
        ? (size: ViewportSize) => {
            setDevice(tabId, size)
            setBrowserCustomDevice(size)
          }
        : undefined,
    [setDevice, tabId]
  )
}

/**
 * A device's glyph and size, as the line above its frame shows them (and the
 * card of a page in a window of its own). A custom device's size is two
 * fields to change it with, whenever there is a way to (`onCustomSize`).
 */
export function BrowserDeviceSize({
  device,
  onCustomSize,
}: {
  device: EmulatedBrowserDevice
  onCustomSize?: (size: ViewportSize) => void
}) {
  const kind = browserDeviceKind(device)
  const viewport = emulatedViewport(device)
  if (kind === "desktop" || !viewport) return null
  const Icon = BROWSER_DEVICE_ICONS[kind]
  return (
    <>
      <Icon className="h-3 w-3 shrink-0" />
      {kind === "custom" && onCustomSize ? (
        <BrowserDeviceSizeFields size={viewport} onChange={onCustomSize} />
      ) : (
        <span>{viewportLabel(viewport)}</span>
      )}
    </>
  )
}

/**
 * A custom device's width and height as two fields. What is typed is kept
 * with Enter or by leaving the field, and put back with Escape; the arrow
 * keys step the size by one (ten with Shift) and keep it at once. A length
 * out of range is held to it, and one that is not a number is dropped.
 */
export function BrowserDeviceSizeFields({
  size,
  onChange,
}: {
  size: ViewportSize
  onChange: (size: ViewportSize) => void
}) {
  const t = useTranslations("Browser.toolbar")
  return (
    <span className="flex items-center gap-1">
      <SizeField
        value={size.width}
        label={t("deviceWidth")}
        onCommit={(width) => onChange({ width, height: size.height })}
        data-browser-device-width=""
      />
      <span aria-hidden="true">×</span>
      <SizeField
        value={size.height}
        label={t("deviceHeight")}
        onCommit={(height) => onChange({ width: size.width, height })}
        data-browser-device-height=""
      />
    </span>
  )
}

function SizeField({
  value,
  label,
  onCommit,
  ...attributes
}: {
  value: number
  label: string
  onCommit: (value: number) => void
} & Record<`data-${string}`, string>) {
  // What is being typed; `null` while the field shows the size as it is.
  const [draft, setDraft] = useState<string | null>(null)
  // Escape leaves the field with the size as it was; the blur that follows
  // must not keep what was typed after all.
  const discardRef = useRef(false)
  // A click that focuses the field would put the caret where it landed on
  // release, undoing the select-all the focus did. A click in a field that
  // already has the focus places the caret as usual.
  const clickFocusRef = useRef(false)

  const keep = (next: number) => {
    const clamped = clampCustomLength(next)
    if (clamped !== value) onCommit(clamped)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault()
      event.currentTarget.blur()
    } else if (event.key === "Escape") {
      event.preventDefault()
      discardRef.current = true
      event.currentTarget.blur()
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault()
      const step =
        (event.key === "ArrowUp" ? 1 : -1) * (event.shiftKey ? 10 : 1)
      setDraft(null)
      keep((draft ? Number(draft) : value) + step)
    }
  }

  return (
    <input
      {...attributes}
      type="text"
      inputMode="numeric"
      autoComplete="off"
      spellCheck={false}
      maxLength={MAX_DIGITS}
      aria-label={label}
      title={label}
      value={draft ?? String(value)}
      onChange={(event) =>
        setDraft(
          event.currentTarget.value.replace(/\D/g, "").slice(0, MAX_DIGITS)
        )
      }
      onMouseDown={(event) => {
        clickFocusRef.current = document.activeElement !== event.currentTarget
      }}
      onFocus={(event) => event.currentTarget.select()}
      onMouseUp={(event) => {
        if (!clickFocusRef.current) return
        clickFocusRef.current = false
        event.preventDefault()
      }}
      onKeyDown={onKeyDown}
      onBlur={() => {
        const typed = draft
        setDraft(null)
        if (discardRef.current) {
          discardRef.current = false
          return
        }
        if (typed) keep(Number(typed))
      }}
      // Pixels, as everything on the line above a frame: the stage fits the
      // frame under a line of exactly this height.
      className="h-[20px] w-[44px] rounded-md border border-border bg-background px-1 text-center text-[11px] text-foreground tabular-nums outline-none select-text focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
    />
  )
}
