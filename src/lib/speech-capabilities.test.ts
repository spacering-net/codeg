import { describe, expect, it } from "vitest"

import {
  detectSpeechCapabilities,
  resolveInputEngine,
  resolveSpeechLanguage,
  type SpeechCapabilities,
} from "./speech-capabilities"

describe("speech capabilities detection", () => {
  it("detects browser STT and media capture in a standard browser", () => {
    const caps = detectSpeechCapabilities({
      isDesktop: false,
      platform: "macos",
      hasSpeechRecognition: true,
      hasMediaDevices: true,
      isSecureContext: true,
    })
    expect(caps).toEqual({
      browserStt: true,
      mediaCapture: true,
      secureContext: true,
    })
  })

  it("supports webkitSpeechRecognition prefix", () => {
    const caps = detectSpeechCapabilities({
      isDesktop: false,
      platform: "macos",
      webkitSpeechRecognition: function () {},
      hasMediaDevices: true,
      isSecureContext: true,
    })
    expect(caps.browserStt).toBe(true)
  })

  it("permits browser STT on desktop macOS", () => {
    const caps = detectSpeechCapabilities({
      isDesktop: true,
      platform: "macos",
      hasSpeechRecognition: true,
      hasMediaDevices: true,
      isSecureContext: true,
    })
    expect(caps.browserStt).toBe(true)
  })

  it("excludes browser STT on desktop Windows due to WebView2 limitations", () => {
    const caps = detectSpeechCapabilities({
      isDesktop: true,
      platform: "windows",
      hasSpeechRecognition: true,
      hasMediaDevices: true,
      isSecureContext: true,
    })
    expect(caps.browserStt).toBe(false)
  })

  it("excludes browser STT on desktop Linux due to WebKitGTK limitations", () => {
    const caps = detectSpeechCapabilities({
      isDesktop: true,
      platform: "linux",
      hasSpeechRecognition: true,
      hasMediaDevices: true,
      isSecureContext: true,
    })
    expect(caps.browserStt).toBe(false)
  })

  it("disables mediaCapture when not in a secure context", () => {
    const caps = detectSpeechCapabilities({
      isDesktop: false,
      platform: "macos",
      hasSpeechRecognition: true,
      hasMediaDevices: true,
      isSecureContext: false,
    })
    expect(caps.browserStt).toBe(false)
    expect(caps.mediaCapture).toBe(false)
    expect(caps.secureContext).toBe(false)
  })

  it("disables mediaCapture when getUserMedia is missing", () => {
    const caps = detectSpeechCapabilities({
      isDesktop: false,
      platform: "macos",
      hasSpeechRecognition: true,
      hasMediaDevices: false,
      isSecureContext: true,
    })
    expect(caps.mediaCapture).toBe(false)
    expect(caps.secureContext).toBe(true)
  })
})

describe("resolveInputEngine decision table", () => {
  const fullCaps: SpeechCapabilities = {
    browserStt: true,
    mediaCapture: true,
    secureContext: true,
  }

  const noBrowserCaps: SpeechCapabilities = {
    browserStt: false,
    mediaCapture: true,
    secureContext: true,
  }

  const noMicCaps: SpeechCapabilities = {
    browserStt: false,
    mediaCapture: false,
    secureContext: true,
  }

  const insecureCaps: SpeechCapabilities = {
    browserStt: false,
    mediaCapture: false,
    secureContext: false,
  }

  it("resolves explicit browser preference when available", () => {
    expect(resolveInputEngine({ engine: "browser" }, fullCaps, false)).toEqual({
      engine: "browser",
    })
  })

  it("returns no-engine when explicit browser preference is unavailable", () => {
    expect(
      resolveInputEngine({ engine: "browser" }, noBrowserCaps, true)
    ).toEqual({
      engine: null,
      reason: "no-engine",
    })
  })

  it("resolves explicit cloud preference when media capture and cloud config exist", () => {
    expect(
      resolveInputEngine({ engine: "cloud" }, noBrowserCaps, true)
    ).toEqual({
      engine: "cloud",
    })
  })

  it("returns insecure-context for explicit cloud preference when insecure", () => {
    expect(resolveInputEngine({ engine: "cloud" }, insecureCaps, true)).toEqual(
      {
        engine: null,
        reason: "insecure-context",
      }
    )
  })

  it("returns no-mic for explicit cloud preference when mic is missing", () => {
    expect(resolveInputEngine({ engine: "cloud" }, noMicCaps, true)).toEqual({
      engine: null,
      reason: "no-mic",
    })
  })

  it("returns cloud-not-configured for explicit cloud preference when unconfigured", () => {
    expect(
      resolveInputEngine({ engine: "cloud" }, noBrowserCaps, false)
    ).toEqual({
      engine: null,
      reason: "cloud-not-configured",
    })
  })

  it("resolves auto preference to browser when browser STT is available", () => {
    expect(resolveInputEngine({ engine: "auto" }, fullCaps, false)).toEqual({
      engine: "browser",
    })
  })

  it("resolves auto preference to cloud when browser is unavailable but cloud is ready", () => {
    expect(resolveInputEngine({ engine: "auto" }, noBrowserCaps, true)).toEqual(
      {
        engine: "cloud",
      }
    )
  })

  it("prioritizes insecure-context for auto fallback", () => {
    expect(resolveInputEngine({ engine: "auto" }, insecureCaps, false)).toEqual(
      {
        engine: null,
        reason: "insecure-context",
      }
    )
  })

  it("prioritizes cloud-not-configured over no-engine for auto fallback", () => {
    expect(
      resolveInputEngine({ engine: "auto" }, noBrowserCaps, false)
    ).toEqual({
      engine: null,
      reason: "cloud-not-configured",
    })
  })

  it("returns no-mic for auto fallback when cloud is configured but mic missing", () => {
    expect(resolveInputEngine({ engine: "auto" }, noMicCaps, true)).toEqual({
      engine: null,
      reason: "no-mic",
    })
  })
})

describe("resolveSpeechLanguage mapping", () => {
  it("uses custom preference language when non-empty", () => {
    expect(resolveSpeechLanguage({ language: "fr-CA" }, "en")).toBe("fr-CA")
    expect(resolveSpeechLanguage("de-AT", "zh-CN")).toBe("de-AT")
  })

  it("maps next-intl UI locales to BCP-47 tags when preference language is empty", () => {
    expect(resolveSpeechLanguage({ language: "" }, "en")).toBe("en-US")
    expect(resolveSpeechLanguage("", "zh-CN")).toBe("zh-CN")
    expect(resolveSpeechLanguage("", "zh-TW")).toBe("zh-TW")
    expect(resolveSpeechLanguage("", "ja")).toBe("ja-JP")
    expect(resolveSpeechLanguage("", "ko")).toBe("ko-KR")
    expect(resolveSpeechLanguage("", "es")).toBe("es-ES")
    expect(resolveSpeechLanguage("", "de")).toBe("de-DE")
    expect(resolveSpeechLanguage("", "fr")).toBe("fr-FR")
    expect(resolveSpeechLanguage("", "pt")).toBe("pt-BR")
    expect(resolveSpeechLanguage("", "ar")).toBe("ar-SA")
  })

  it("falls back to raw non-empty locale or en-US for unmapped or empty locales", () => {
    expect(resolveSpeechLanguage("", "it")).toBe("it")
    expect(resolveSpeechLanguage("", "")).toBe("en-US")
  })
})
