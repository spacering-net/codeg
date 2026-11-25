import { afterEach, describe, expect, it, vi } from "vitest"

import {
  CATALOG_TRANSLATION_CACHE,
  CatalogTranslator,
  catalogTextParts,
  catalogTextSources,
  requestCatalogTranslation,
  translatedCatalogText,
  type CatalogTranslationRequest,
} from "./catalog-translation"

afterEach(() => vi.useRealTimers())

const tick = async () => {
  await vi.advanceTimersByTimeAsync(1)
}

describe("public catalog translation requests", () => {
  it("deduplicates consumers and keeps a request until its last view leaves", async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const request = vi.fn<CatalogTranslationRequest>(
      (_text, _target, nextSignal) => {
        signal = nextSignal
        return new Promise((_resolve, reject) =>
          nextSignal.addEventListener("abort", () => reject(new Error("abort")))
        )
      }
    )
    const translator = new CatalogTranslator(null, request)
    const first = translator.watch(["Public prose", "Public prose"], "zh-CN")
    const second = translator.watch(["Public prose"], "zh-CN")
    await tick()
    expect(request).toHaveBeenCalledTimes(1)
    first()
    expect(signal?.aborted).toBe(false)
    second()
    expect(signal?.aborted).toBe(true)
    await tick()
    expect(translator.pending).toBe(0)
    translator.cancel()
  })

  it("limits concurrency and does not start abandoned queued work", async () => {
    vi.useFakeTimers()
    const request = vi.fn<CatalogTranslationRequest>(
      (_text, _target, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("abort")))
        )
    )
    const translator = new CatalogTranslator(null, request)
    const stop = translator.watch(
      Array.from({ length: 8 }, (_, n) => `Prose ${n}`),
      "fr"
    )
    await tick()
    expect(request).toHaveBeenCalledTimes(4)
    stop()
    await tick()
    expect(request).toHaveBeenCalledTimes(4)
    expect(translator.pending).toBe(0)
    translator.cancel()
  })

  it("persists only successful translations and separates target languages", async () => {
    vi.useFakeTimers()
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value)
      },
    }
    const request = vi.fn<CatalogTranslationRequest>(async (_text, target) =>
      target === "fr" ? "Texte public" : "公开文本"
    )
    const first = new CatalogTranslator(storage, request)
    first.watch(["Public text"], "zh-CN")
    await vi.advanceTimersByTimeAsync(300)
    expect(first.lookup("Public text", "zh-CN")).toBe("公开文本")
    expect(values.get(CATALOG_TRANSLATION_CACHE)).toContain("公开文本")
    const second = new CatalogTranslator(storage, request)
    second.watch(["Public text"], "zh-CN")
    await tick()
    expect(request).toHaveBeenCalledTimes(1)
    second.watch(["Public text"], "fr")
    await tick()
    expect(second.lookup("Public text", "fr")).toBe("Texte public")
    expect(second.lookup("Different public text", "zh-CN")).toBeUndefined()
    first.cancel()
    second.cancel()
  })

  it("leaves failed text uncached and recovers on explicit retry", async () => {
    vi.useFakeTimers()
    const request = vi
      .fn<CatalogTranslationRequest>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue("公开介绍")
    const translator = new CatalogTranslator(null, request)
    translator.watch(["Public description"], "zh-CN")
    await tick()
    expect(translator.lookup("Public description", "zh-CN")).toBeUndefined()
    expect(translator.failed).toBe(1)
    translator.retry()
    await tick()
    expect(translator.lookup("Public description", "zh-CN")).toBe("公开介绍")
    expect(translator.failed).toBe(0)
    translator.cancel()
  })

  it("handles a provider which throws before returning a promise", async () => {
    vi.useFakeTimers()
    const translator = new CatalogTranslator(null, () => {
      throw new Error("unavailable")
    })
    translator.watch(["Visible description"], "zh-CN")
    await tick()
    expect(translator.failed).toBe(1)
    expect(translator.pending).toBe(0)
    translator.cancel()
  })

  it("does not cache a late response from a closed view", async () => {
    vi.useFakeTimers()
    let resolve: (text: string) => void = () => {}
    const translator = new CatalogTranslator(
      null,
      () =>
        new Promise((next) => {
          resolve = next
        })
    )
    const stop = translator.watch(["Old item"], "zh-CN")
    await tick()
    stop()
    resolve("旧条目")
    await tick()
    expect(translator.lookup("Old item", "zh-CN")).toBeUndefined()
    translator.cancel()
  })

  it("continues in memory when browser storage is unavailable", async () => {
    vi.useFakeTimers()
    const storage = {
      getItem: () => {
        throw new Error("blocked")
      },
      setItem: () => {
        throw new Error("quota")
      },
    }
    const translator = new CatalogTranslator(storage, async () => "已翻译")
    translator.watch(["Visible prose"], "zh-CN")
    await vi.advanceTimersByTimeAsync(300)
    expect(translator.lookup("Visible prose", "zh-CN")).toBe("已翻译")
    translator.cancel()
  })

  it("rejects malformed provider output and sends no browser credentials", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => [null] })
    vi.stubGlobal("fetch", fetcher)
    await expect(
      requestCatalogTranslation(
        "Public prose",
        "zh-CN",
        new AbortController().signal
      )
    ).rejects.toThrow("Invalid")
    const [url, options] = fetcher.mock.calls[0]
    expect(new URL(url).searchParams.get("q")).toBe("Public prose")
    expect(options.credentials).toBe("omit")
    expect(options.headers).toBeUndefined()
    vi.unstubAllGlobals()
  })
})

describe("catalog prose boundaries", () => {
  it("keeps inline code, unclosed code and link destinations out of requests", () => {
    const text =
      "Read `SKILL.md` at https://example.com/a?key=value then `unfinished code"
    expect(
      catalogTextParts(text)
        .map((part) => part.text)
        .join("")
    ).toBe(text)
    const sources = catalogTextSources(text, "zh-CN").join(" ")
    expect(sources).not.toContain("SKILL.md")
    expect(sources).not.toContain("example.com")
    expect(sources).not.toContain("unfinished code")
    const translated = translatedCatalogText(text, "zh-CN", {
      lookup: () => "中文",
    })
    expect(translated).toContain("`SKILL.md`")
    expect(translated).toContain("https://example.com/a?key=value")
    expect(translated).toContain("`unfinished code")
  })

  it("preserves prose whitespace and splits long descriptions into bounded requests", () => {
    const text = "  A public description  "
    expect(
      translatedCatalogText(text, "fr", {
        lookup: () => "Une description publique",
      })
    ).toBe("  Une description publique  ")
    const long = "Public prose ".repeat(400)
    expect(
      catalogTextParts(long)
        .map((part) => part.text)
        .join("")
    ).toBe(long)
    expect(
      catalogTextSources(long, "fr").every((part) => part.length <= 1500)
    ).toBe(true)
    expect(catalogTextSources("已经提供中文介绍。", "zh-CN")).toEqual([])
  })
})
