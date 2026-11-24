"use client"

import {
  Monitor,
  RulerDimensionLine,
  Smartphone,
  Tablet,
  type LucideIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { useRef } from "react"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  useOptionalWorkspaceActions,
  type BrowserWorkspaceTab,
} from "@/contexts/workspace-context"
import {
  BROWSER_DEVICES,
  DEVICE_VIEWPORTS,
  browserTabDevice,
  emulatedViewport,
  isBrowserDevice,
  type BrowserDevice,
} from "@/lib/browser/browser-device"
import { useBrowserPrefs } from "@/lib/browser/browser-prefs"
import { cn } from "@/lib/utils"

import { ICON_BTN } from "./browser-toolbar-buttons"

export const BROWSER_DEVICE_ICONS: Readonly<Record<BrowserDevice, LucideIcon>> =
  {
    desktop: Monitor,
    tablet: Tablet,
    phone: Smartphone,
    custom: RulerDimensionLine,
  }

const DEVICE_NAME_KEYS = {
  desktop: "deviceDesktop",
  tablet: "deviceTablet",
  phone: "devicePhone",
  custom: "deviceCustom",
} as const satisfies Record<BrowserDevice, string>

/** `390 × 844`. Digits and the sign read the same in every language, and are
 *  kept left-to-right where they are shown inside right-to-left text. */
export function viewportLabel(viewport: { width: number; height: number }) {
  return `${viewport.width} × ${viewport.height}`
}

/**
 * The device control beside the address field: which device the tab shows
 * its page as, and a menu to pick another — the desktop (the page fills the
 * pane, as a tab always has), a tablet, a phone, or a custom device of the
 * person's own size (the page is laid out in that device's viewport, in a
 * frame of its proportions; see `BrowserDeviceStage`). The glyph is the
 * device's own, so the row says which one is on without opening anything,
 * and it is tinted while a device is being emulated: the page under it is
 * not the size it would be anywhere else.
 *
 * A custom device starts at the size typed last (`customDevice`), and is
 * given its size on the line above its frame: picking "Custom" — again, too —
 * puts the keyboard in the width field there.
 */
export function BrowserDeviceMenu({ tab }: { tab: BrowserWorkspaceTab }) {
  const t = useTranslations("Browser.toolbar")
  const setDevice = useOptionalWorkspaceActions()?.setBrowserTabDevice ?? null
  const { customDevice } = useBrowserPrefs()
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  // "Custom" was picked in the menu that is closing.
  const pickedCustomRef = useRef(false)
  const device = browserTabDevice(tab.browser)
  const Icon = BROWSER_DEVICE_ICONS[device]
  const label = t("device", { name: t(DEVICE_NAME_KEYS[device]) })
  const customSize =
    device === "custom" ? emulatedViewport(tab.browser.device) : customDevice
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        // Opened again before the last close finished: that close never
        // hands anything over, and this one has picked nothing yet.
        if (open) pickedCustomRef.current = false
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          className={cn(
            ICON_BTN,
            device !== "desktop" && "bg-primary/8 text-foreground"
          )}
          title={label}
          aria-label={label}
          data-browser-device={device}
          disabled={!setDevice}
        >
          <Icon className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        // As wide as its rows: a custom size is as long as eleven characters
        // ("8192 × 8192"), and a device's name as long as its language makes
        // it.
        className="w-auto min-w-52"
        onCloseAutoFocus={(event) => {
          if (!pickedCustomRef.current) return
          pickedCustomRef.current = false
          // The field in this control's own tab view (the view marks its
          // root): a tab shown in two places — the side panel and the file
          // column — has a field in each. None while there is nothing to
          // type into (a page that failed, a frame still opening): the
          // keyboard goes back to this button, as after any other pick.
          const field = triggerRef.current
            ?.closest("[data-browser-tab-view]")
            ?.querySelector<HTMLInputElement>(
              "input[data-browser-device-width]"
            )
          if (!field) return
          event.preventDefault()
          field.focus()
        }}
      >
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          {t("deviceMenuLabel")}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={device}
          onValueChange={(next) => {
            if (!isBrowserDevice(next)) return
            if (next === "custom") pickedCustomRef.current = true
            if (next === device) return
            setDevice?.(
              tab.id,
              next === "custom" ? (customSize ?? customDevice) : next
            )
          }}
        >
          {BROWSER_DEVICES.map((id) => {
            const ItemIcon = BROWSER_DEVICE_ICONS[id]
            const viewport =
              id === "desktop"
                ? null
                : id === "custom"
                  ? customSize
                  : DEVICE_VIEWPORTS[id]
            return (
              <DropdownMenuRadioItem key={id} value={id}>
                <ItemIcon />
                <span className="truncate">{t(DEVICE_NAME_KEYS[id])}</span>
                <span
                  dir={viewport ? "ltr" : undefined}
                  className="ml-auto shrink-0 whitespace-nowrap pl-4 text-xs text-muted-foreground tabular-nums"
                >
                  {viewport ? viewportLabel(viewport) : t("deviceFill")}
                </span>
              </DropdownMenuRadioItem>
            )
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
