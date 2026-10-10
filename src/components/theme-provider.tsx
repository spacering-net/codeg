"use client"

import { useEffect } from "react"
import type { ThemeProviderProps } from "next-themes"
import { ThemeProvider as NextThemesProvider, useTheme } from "next-themes"
import {
  THEME_COLOR_DARK,
  THEME_COLOR_LIGHT,
  THEME_COLOR_MEDIA_DARK,
  THEME_COLOR_MEDIA_LIGHT,
} from "@/lib/theme-color"

function colorForMedia(media: string | null): string | null {
  if (media === THEME_COLOR_MEDIA_DARK) return THEME_COLOR_DARK
  if (media === THEME_COLOR_MEDIA_LIGHT) return THEME_COLOR_LIGHT
  return null
}

/**
 * Keeps `<meta name="theme-color">` in step with the in-app light/dark choice.
 *
 * The tags come from `viewport.themeColor` in the root layout, one per
 * `prefers-color-scheme`, so "system" only has to restore them. An explicit
 * choice must beat the OS preference, so every tag gets that mode's color.
 *
 * Next owns those elements and recreates them from props whenever its head
 * remounts: on every client-side navigation, including the `/` → `/workspace`
 * redirect an installed app launches through. A one-shot write would revert
 * to the OS colors there, so the write is repeated whenever `<head>` gains or
 * loses children. Observer callbacks run as microtasks, before the next paint.
 *
 * Every theme-color tag is written, not only the ones React tracks. React
 * matches hoisted `<meta>` tags to the server HTML by `content`, which the
 * pre-paint script has already rewritten, so hydration can leave an extra,
 * untracked tag behind.
 */
function ThemeColorMetaSync() {
  const { theme } = useTheme()

  useEffect(() => {
    const explicit =
      theme === "dark"
        ? THEME_COLOR_DARK
        : theme === "light"
          ? THEME_COLOR_LIGHT
          : null
    const apply = () => {
      document
        .querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')
        .forEach((tag) => {
          const color = explicit ?? colorForMedia(tag.getAttribute("media"))
          if (color !== null && tag.getAttribute("content") !== color) {
            tag.setAttribute("content", color)
          }
        })
    }
    apply()
    // Attribute writes are not childList mutations, so `apply` cannot retrigger
    // itself.
    const observer = new MutationObserver(apply)
    observer.observe(document.head, { childList: true })
    return () => observer.disconnect()
  }, [theme])

  return null
}

export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  return (
    <NextThemesProvider {...props}>
      <ThemeColorMetaSync />
      {children}
    </NextThemesProvider>
  )
}
