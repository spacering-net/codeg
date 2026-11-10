// src/lib/theme-color.ts

/**
 * `<meta name="theme-color">` values. Browsers tint their own UI with it, and
 * on Android an installed web app takes its status and navigation bar colors
 * from it.
 *
 * The root layout emits one tag per `prefers-color-scheme`, so "follow the
 * system" needs no script. When the user picks light or dark inside the app,
 * the pre-paint script and ThemeProvider rewrite both tags to that mode's
 * color, or the OS preference would win over the in-app choice.
 *
 * `public/manifest.json` repeats the dark value as the splash and title-bar
 * color. JSON cannot import it, so keep the two in step by hand.
 */
export const THEME_COLOR_LIGHT = "#ffffff"
export const THEME_COLOR_DARK = "#09090b"

export const THEME_COLOR_MEDIA_LIGHT = "(prefers-color-scheme: light)"
export const THEME_COLOR_MEDIA_DARK = "(prefers-color-scheme: dark)"
