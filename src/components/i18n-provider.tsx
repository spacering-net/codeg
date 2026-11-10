"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react"
import { NextIntlClientProvider, type AbstractIntlMessages } from "next-intl"
import { Direction } from "radix-ui"
import { getFallbackMessages, getMessagesForLocale } from "@/i18n/messages"
import {
  fromIntlLocale,
  getSystemLocaleCandidates,
  LANGUAGE_COOKIE_KEY,
  LANGUAGE_MODE_COOKIE_KEY,
  LANGUAGE_SETTINGS_STORAGE_KEY,
  normalizeLanguageSettings,
  resolveAppLocale,
  toIntlLocale,
  type IntlLocale,
} from "@/lib/i18n"
import { getSystemLanguageSettings } from "@/lib/api"
import { disposeTauriListener } from "@/lib/tauri-listener"
import { AppBootLoading } from "@/components/layout/app-boot-loading"
import type { AppLocale, SystemLanguageSettings } from "@/lib/types"

interface AppI18nContextValue {
  appLocale: AppLocale
  languageSettings: SystemLanguageSettings
  languageSettingsLoaded: boolean
  setLanguageSettings: (settings: SystemLanguageSettings) => void
}

const AppI18nContext = createContext<AppI18nContextValue | null>(null)
const LANGUAGE_SETTINGS_UPDATED_EVENT = "app://language-settings-updated"

function subscribeSystemLocale(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {}

  window.addEventListener("languagechange", onStoreChange)
  return () => {
    window.removeEventListener("languagechange", onStoreChange)
  }
}

function getSystemLocaleSnapshot(): string {
  return getSystemLocaleCandidates().join("|")
}

function getSystemLocaleServerSnapshot(): string {
  return ""
}

function persistLanguageSettings(settings: SystemLanguageSettings) {
  if (typeof window === "undefined") return

  try {
    window.localStorage.setItem(
      LANGUAGE_SETTINGS_STORAGE_KEY,
      JSON.stringify(settings)
    )
  } catch {
    // Ignore write failures (e.g. disabled storage).
  }
}

function persistLanguageCookies(
  settings: SystemLanguageSettings,
  appLocale: AppLocale
) {
  if (typeof document === "undefined") return

  const maxAge = 60 * 60 * 24 * 365
  document.cookie = `${LANGUAGE_MODE_COOKIE_KEY}=${settings.mode}; Path=/; Max-Age=${maxAge}; SameSite=Lax`
  document.cookie = `${LANGUAGE_COOKIE_KEY}=${toIntlLocale(appLocale)}; Path=/; Max-Age=${maxAge}; SameSite=Lax`
}

export function useAppI18n() {
  const context = useContext(AppI18nContext)
  if (!context) {
    throw new Error("useAppI18n must be used within AppI18nProvider")
  }
  return context
}

interface AppI18nProviderProps {
  children: React.ReactNode
  initialLocale?: IntlLocale
  initialMessages?: AbstractIntlMessages
}

export function AppI18nProvider({
  children,
  initialLocale = "en",
  initialMessages,
}: AppI18nProviderProps) {
  const initialAppLocale = fromIntlLocale(initialLocale)
  const [languageSettings, setLanguageSettingsState] =
    useState<SystemLanguageSettings>({
      mode: "manual",
      language: initialAppLocale,
    })
  const [languageSettingsLoaded, setLanguageSettingsLoaded] = useState(false)
  const [messages, setMessages] = useState<AbstractIntlMessages>(
    initialMessages ?? getFallbackMessages()
  )
  const [messagesLocale, setMessagesLocale] = useState<AppLocale>(
    initialMessages ? initialAppLocale : "en"
  )

  const systemLocaleSnapshot = useSyncExternalStore(
    subscribeSystemLocale,
    getSystemLocaleSnapshot,
    getSystemLocaleServerSnapshot
  )
  const systemLocaleCandidates = useMemo(
    () => (systemLocaleSnapshot ? systemLocaleSnapshot.split("|") : []),
    [systemLocaleSnapshot]
  )

  const setLanguageSettings = useCallback(
    (settings: SystemLanguageSettings) => {
      const normalized = normalizeLanguageSettings(settings)
      setLanguageSettingsState(normalized)
      persistLanguageSettings(normalized)
    },
    []
  )

  useEffect(() => {
    if (typeof window === "undefined") return

    const onStorage = (event: StorageEvent) => {
      if (event.key !== LANGUAGE_SETTINGS_STORAGE_KEY || !event.newValue) return

      try {
        const next = normalizeLanguageSettings(
          JSON.parse(event.newValue) as SystemLanguageSettings
        )
        setLanguageSettingsState(next)
      } catch {
        // Ignore malformed storage payloads.
      }
    }

    window.addEventListener("storage", onStorage)

    let unlisten: (() => void) | null = null
    let cancelled = false

    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<SystemLanguageSettings>(
          LANGUAGE_SETTINGS_UPDATED_EVENT,
          (event) => {
            if (cancelled) return
            setLanguageSettings(event.payload)
          }
        )
      )
      .then((dispose) => {
        if (cancelled) {
          disposeTauriListener(dispose, "I18nProvider.languageSettings")
          return
        }
        unlisten = dispose
      })
      .catch(() => {
        // Ignore when running in non-tauri environment.
      })

    return () => {
      cancelled = true
      window.removeEventListener("storage", onStorage)
      disposeTauriListener(unlisten, "I18nProvider.languageSettings")
    }
  }, [setLanguageSettings])

  useEffect(() => {
    let cancelled = false

    getSystemLanguageSettings()
      .then((settings) => {
        if (cancelled) return
        setLanguageSettings(settings)
      })
      .catch((err) => {
        console.error("[i18n] load language settings failed:", err)
      })
      .finally(() => {
        if (!cancelled) {
          setLanguageSettingsLoaded(true)
        }
      })

    return () => {
      cancelled = true
    }
  }, [setLanguageSettings])

  const appLocale = useMemo(
    () => resolveAppLocale(languageSettings, systemLocaleCandidates),
    [languageSettings, systemLocaleCandidates]
  )

  useEffect(() => {
    if (!languageSettingsLoaded) return
    persistLanguageCookies(languageSettings, appLocale)
  }, [appLocale, languageSettings, languageSettingsLoaded])

  // Push the resolved locale to the system tray menu (Tauri only). The
  // tray was built once at app startup with whatever was persisted then,
  // so without this it would stay stale after a language change.
  useEffect(() => {
    if (typeof window === "undefined") return
    if (!("__TAURI_INTERNALS__" in window)) return
    void import("@/lib/tauri")
      .then((t) => t.setTrayLocale(appLocale))
      .catch(() => {
        // Tray refresh is best-effort: the tray may not be installed
        // (Linux without a status-bar host), and a stale label is a
        // smaller problem than crashing the i18n provider.
      })
  }, [appLocale])

  useEffect(() => {
    if (appLocale === messagesLocale) {
      return
    }
    let cancelled = false

    getMessagesForLocale(appLocale)
      .then((nextMessages) => {
        if (!cancelled) {
          setMessages(nextMessages)
          setMessagesLocale(appLocale)
        }
      })
      .catch((err) => {
        console.error("[i18n] load locale messages failed:", err)
      })

    return () => {
      cancelled = true
    }
  }, [appLocale, messagesLocale])

  const localeReady = appLocale === messagesLocale
  const appReady = languageSettingsLoaded && localeReady
  const activeIntlLocale = toIntlLocale(messagesLocale)
  const dir = activeIntlLocale === "ar" ? "rtl" : "ltr"

  useEffect(() => {
    document.documentElement.lang = activeIntlLocale
    document.documentElement.dir = dir
  }, [activeIntlLocale, dir])

  const contextValue = useMemo<AppI18nContextValue>(
    () => ({
      appLocale,
      languageSettings,
      languageSettingsLoaded,
      setLanguageSettings,
    }),
    [appLocale, languageSettings, languageSettingsLoaded, setLanguageSettings]
  )

  return (
    <AppI18nContext.Provider value={contextValue}>
      <NextIntlClientProvider locale={activeIntlLocale} messages={messages}>
        {/* Radix components take their direction from context, not from the
            page: without this, every Tabs root stamps `dir="ltr"` on itself,
            so in Arabic whatever sits inside a tab (switches, rows, menus)
            stays left-to-right while the page around it is right-to-left. */}
        <Direction.DirectionProvider dir={dir}>
          {appReady ? children : <AppBootLoading />}
        </Direction.DirectionProvider>
      </NextIntlClientProvider>
    </AppI18nContext.Provider>
  )
}
