import type { Metadata, Viewport } from "next"
import "katex/dist/katex.min.css"
import "./globals.css"
import { NextIntlClientProvider } from "next-intl"
import { AppI18nProvider } from "@/components/i18n-provider"
import { getMessagesForLocale } from "@/i18n/messages"
import { resolveRequestLocale } from "@/i18n/resolve-request-locale"
import { ThemeProvider } from "@/components/theme-provider"
import { toIntlLocale } from "@/lib/i18n"
import { APPEARANCE_INIT_SCRIPT } from "@/lib/appearance-script"
import { AppearanceProvider } from "@/components/appearance-provider"
import { OverlayScrollbarsInit } from "@/components/overlay-scrollbars-init"
import { ClipboardFallbackInit } from "@/components/clipboard-fallback-init"
import { WebConnectionGuard } from "@/components/connection/web-connection-guard"
import { WindowResizeGrips } from "@/components/layout/window-resize-grips"
import { CloseRequestDialog } from "@/components/workspace/close-request-dialog"

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
}

export const metadata: Metadata = {
  title: "codeg",
  description: "AI Coding Agent Conversation Manager",
  icons: {
    icon: [
      { url: "/icon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/icon.svg", type: "image/svg+xml" },
    ],
    apple: { url: "/icon-128x128.png", sizes: "128x128", type: "image/png" },
  },
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const appLocale = await resolveRequestLocale()
  const initialLocale = toIntlLocale(appLocale)
  const initialMessages = await getMessagesForLocale(appLocale)

  return (
    <html lang={initialLocale} suppressHydrationWarning>
      <body>
        {/* CSS-only dark background: applies before JS executes, preventing white flash in dark mode */}
        <style
          dangerouslySetInnerHTML={{
            __html: `@media(prefers-color-scheme:dark){html:not(.light){background-color:#09090b;color-scheme:dark}}`,
          }}
        />
        {/* Apply appearance preferences (theme color + zoom + dark class) before first paint to prevent FOUC */}
        <script dangerouslySetInnerHTML={{ __html: APPEARANCE_INIT_SCRIPT }} />
        {/* Suppress benign ResizeObserver loop warnings (W3C spec §3.3) */}
        <script>{`window.addEventListener("error",function(e){if(e.message&&e.message.indexOf("ResizeObserver")!==-1){e.stopImmediatePropagation();e.preventDefault()}});window.onerror=function(m){if(typeof m==="string"&&m.indexOf("ResizeObserver")!==-1)return true}`}</script>
        <NextIntlClientProvider
          locale={initialLocale}
          messages={initialMessages}
        >
          <AppI18nProvider
            initialLocale={initialLocale}
            initialMessages={initialMessages}
          >
            <ThemeProvider
              attribute="class"
              defaultTheme="system"
              enableSystem
              disableTransitionOnChange
            >
              <AppearanceProvider>
                <OverlayScrollbarsInit />
                <ClipboardFallbackInit />
                <WebConnectionGuard />
                <WindowResizeGrips />
                {/* Self-gated to the main window: every route it can show
                    (/workspace, /login, the redirecting /) must be able to
                    answer a close press. */}
                <CloseRequestDialog />
                {children}
              </AppearanceProvider>
            </ThemeProvider>
          </AppI18nProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
