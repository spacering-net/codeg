import { detectPlatform } from "@/hooks/use-platform"
import { isDesktop as isDesktopRuntime } from "./platform"
import type { SpeechInputPrefs } from "./speech-prefs"

export interface SpeechCapabilities {
  browserStt: boolean
  mediaCapture: boolean
  secureContext: boolean
}

export type InputEngineResolution =
  | { engine: "browser" | "cloud" }
  | {
      engine: null
      reason:
        | "no-mic"
        | "insecure-context"
        | "no-engine"
        | "cloud-not-configured"
    }

export interface SpeechCapabilitiesEnv {
  isDesktop?: boolean
  platform?: "macos" | "windows" | "linux" | "unknown"
  SpeechRecognition?: unknown
  webkitSpeechRecognition?: unknown
  hasSpeechRecognition?: boolean
  hasMediaDevices?: boolean
  getUserMedia?: unknown
  isSecureContext?: boolean
}

export const LOCALE_TO_BCP47: Record<string, string> = {
  en: "en-US",
  "zh-CN": "zh-CN",
  "zh-TW": "zh-TW",
  ja: "ja-JP",
  ko: "ko-KR",
  es: "es-ES",
  de: "de-DE",
  fr: "fr-FR",
  pt: "pt-BR",
  ar: "ar-SA",
}

export function detectSpeechCapabilities(
  env?: SpeechCapabilitiesEnv
): SpeechCapabilities {
  const desktop =
    env?.isDesktop ??
    (typeof window !== "undefined" ? isDesktopRuntime() : false)
  const plat =
    env?.platform ??
    (typeof window !== "undefined" ? detectPlatform() : "unknown")

  let hasRecognizer = false
  if (typeof env?.hasSpeechRecognition === "boolean") {
    hasRecognizer = env.hasSpeechRecognition
  } else if (
    env?.SpeechRecognition !== undefined ||
    env?.webkitSpeechRecognition !== undefined
  ) {
    hasRecognizer = Boolean(
      env.SpeechRecognition || env.webkitSpeechRecognition
    )
  } else if (typeof window !== "undefined") {
    const win = window as unknown as Record<string, unknown>
    hasRecognizer = Boolean(
      win.SpeechRecognition || win.webkitSpeechRecognition
    )
  }

  const isUnsupportedDesktop =
    desktop && (plat === "windows" || plat === "linux")
  const secureContext =
    typeof env?.isSecureContext === "boolean"
      ? env.isSecureContext
      : typeof window !== "undefined"
        ? Boolean(window.isSecureContext)
        : false

  // Chromium exposes SpeechRecognition on insecure origins too, but it cannot
  // open the microphone there and fails at once with "audio-capture".
  const browserStt = hasRecognizer && !isUnsupportedDesktop && secureContext

  let hasGetUserMedia = false
  if (typeof env?.hasMediaDevices === "boolean") {
    hasGetUserMedia = env.hasMediaDevices
  } else if (env?.getUserMedia !== undefined) {
    hasGetUserMedia = Boolean(env.getUserMedia)
  } else if (typeof navigator !== "undefined") {
    hasGetUserMedia = Boolean(navigator.mediaDevices?.getUserMedia)
  }

  const mediaCapture = hasGetUserMedia && secureContext

  return {
    browserStt,
    mediaCapture,
    secureContext,
  }
}

export function resolveInputEngine(
  pref: SpeechInputPrefs | { engine: "auto" | "browser" | "cloud" },
  caps: SpeechCapabilities,
  cloudConfigured: boolean
): InputEngineResolution {
  if (pref.engine === "browser") {
    if (caps.browserStt) {
      return { engine: "browser" }
    }
    return { engine: null, reason: "no-engine" }
  }

  if (pref.engine === "cloud") {
    if (caps.mediaCapture && cloudConfigured) {
      return { engine: "cloud" }
    }
    if (!caps.secureContext) {
      return { engine: null, reason: "insecure-context" }
    }
    if (!caps.mediaCapture) {
      return { engine: null, reason: "no-mic" }
    }
    return { engine: null, reason: "cloud-not-configured" }
  }

  if (caps.browserStt) {
    return { engine: "browser" }
  }
  if (caps.mediaCapture && cloudConfigured) {
    return { engine: "cloud" }
  }

  if (!caps.secureContext) {
    return { engine: null, reason: "insecure-context" }
  }
  if (!cloudConfigured) {
    return { engine: null, reason: "cloud-not-configured" }
  }
  if (!caps.mediaCapture) {
    return { engine: null, reason: "no-mic" }
  }
  return { engine: null, reason: "no-engine" }
}

export type OutputEngineResolution =
  | { engine: "browser" | "cloud" }
  | { engine: null; reason: "no-engine" | "cloud-not-configured" }

type VoiceSource = Pick<SpeechSynthesis, "getVoices"> &
  Partial<Pick<SpeechSynthesis, "addEventListener" | "removeEventListener">>

function currentSynth(): VoiceSource | undefined {
  return typeof window !== "undefined" ? window.speechSynthesis : undefined
}

export function hasBrowserTts(synth: VoiceSource | undefined = currentSynth()) {
  return Boolean(synth) && synth!.getVoices().length > 0
}

/** Chromium fills `getVoices()` asynchronously; resolves once voices exist or the timeout passes. */
export function waitForVoices(
  synth: VoiceSource | undefined = currentSynth(),
  timeoutMs = 1500
): Promise<SpeechSynthesisVoice[]> {
  if (!synth) return Promise.resolve([])
  const voices = synth.getVoices()
  if (voices.length > 0 || !synth.addEventListener) {
    return Promise.resolve(voices)
  }
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      synth.removeEventListener?.("voiceschanged", finish)
      resolve(synth.getVoices())
    }
    const timer = setTimeout(finish, timeoutMs)
    synth.addEventListener!("voiceschanged", finish)
  })
}

export function resolveOutputEngine(
  pref: { engine: "auto" | "browser" | "cloud" },
  caps: { browserTts: boolean },
  cloudConfigured: boolean
): OutputEngineResolution {
  if (pref.engine === "browser") {
    return caps.browserTts
      ? { engine: "browser" }
      : { engine: null, reason: "no-engine" }
  }
  if (pref.engine === "cloud") {
    return cloudConfigured
      ? { engine: "cloud" }
      : { engine: null, reason: "cloud-not-configured" }
  }
  if (caps.browserTts) return { engine: "browser" }
  if (cloudConfigured) return { engine: "cloud" }
  return { engine: null, reason: "cloud-not-configured" }
}

export function resolveSpeechLanguage(
  pref: SpeechInputPrefs | { language?: string } | string,
  uiLocale: string
): string {
  const language =
    typeof pref === "string" ? pref.trim() : (pref.language ?? "").trim()

  if (language.length > 0) {
    return language
  }

  if (LOCALE_TO_BCP47[uiLocale]) {
    return LOCALE_TO_BCP47[uiLocale]
  }

  return uiLocale.trim().length > 0 ? uiLocale.trim() : "en-US"
}
