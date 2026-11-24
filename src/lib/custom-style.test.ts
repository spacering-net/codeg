import { afterEach, describe, expect, it, vi } from "vitest"
import {
  ADVANCED_THEME_TOKENS,
  BASIC_THEME_TOKENS,
  CUSTOM_THEME_TOKENS,
  MAX_CUSTOM_CSS_BYTES,
  applyTokenOverrides,
  isValidTokenValue,
  parseStoredCustomTheme,
  parseThemeRegistryItem,
  sanitizeCustomCss,
  sanitizeCustomTheme,
  toHexColor,
  toThemeRegistryItem,
} from "./custom-style"

describe("token whitelist", () => {
  it("covers exactly shadcn's 31 semantic colors plus radius", () => {
    // 与 https://ui.shadcn.com/docs/theming 的 Theme Tokens 表格对齐。多一个少一个
    // 都意味着我们和 shadcn 的 cssVars 形状分叉了，粘贴互通就会有洞。
    expect(CUSTOM_THEME_TOKENS).toHaveLength(32)
    expect(new Set(CUSTOM_THEME_TOKENS).size).toBe(32)
    expect(CUSTOM_THEME_TOKENS).toContain("radius")
    expect(BASIC_THEME_TOKENS).toHaveLength(8)
    expect(ADVANCED_THEME_TOKENS).toHaveLength(24)
  })
})

describe("isValidTokenValue", () => {
  it("accepts the color and length forms shadcn themes actually use", () => {
    expect(isValidTokenValue("primary", "oklch(0.646 0.222 41.116)")).toBe(true)
    expect(isValidTokenValue("primary", "#7c5cff")).toBe(true)
    expect(isValidTokenValue("primary", "#fff")).toBe(true)
    expect(isValidTokenValue("border", "oklch(1 0 0 / 10%)")).toBe(true)
    expect(isValidTokenValue("radius", "0.625rem")).toBe(true)
    expect(isValidTokenValue("primary", "  #123456  ")).toBe(true)
  })

  it("rejects declaration-escape attempts", () => {
    // 结构上这类值也逃不出去（我们只经 style.setProperty 落地，从不拼接样式表
    // 文本），但白名单是纵深防御的第一道，必须真的挡住。
    expect(
      isValidTokenValue("primary", "red; } body { display:none } .x {")
    ).toBe(false)
    expect(isValidTokenValue("primary", "red;")).toBe(false)
    expect(isValidTokenValue("primary", "}")).toBe(false)
    expect(isValidTokenValue("primary", "<script>")).toBe(false)
  })

  it("rejects remote references and over-long values", () => {
    // `:` 不在字符集里，所以 url(https://…) 天然出局。
    expect(
      isValidTokenValue("primary", "url(https://evil.example/x.png)")
    ).toBe(false)
    expect(isValidTokenValue("primary", "@import")).toBe(false)
    expect(isValidTokenValue("primary", "a".repeat(65))).toBe(false)
    expect(isValidTokenValue("primary", "")).toBe(false)
    expect(isValidTokenValue("primary", "   ")).toBe(false)
    expect(isValidTokenValue("primary", 42)).toBe(false)
  })
})

describe("sanitizeCustomTheme", () => {
  it("keeps known tokens, drops unknown keys and bad values", () => {
    const theme = sanitizeCustomTheme({
      light: {
        primary: "#111111",
        nope: "#222222",
        border: "red; }",
      },
      dark: { background: "oklch(0.145 0 0)" },
    })
    expect(theme.light).toEqual({ primary: "#111111" })
    expect(theme.dark).toEqual({ background: "oklch(0.145 0 0)" })
  })

  it("normalizes keys written with the -- prefix", () => {
    const theme = sanitizeCustomTheme({ light: { "--primary": "#111111" } })
    expect(theme.light).toEqual({ primary: "#111111" })
  })

  it("never throws on garbage input", () => {
    expect(sanitizeCustomTheme(null)).toEqual({ light: {}, dark: {} })
    expect(sanitizeCustomTheme("nope")).toEqual({ light: {}, dark: {} })
    expect(parseStoredCustomTheme("{not json")).toEqual({ light: {}, dark: {} })
    expect(parseStoredCustomTheme(null)).toEqual({ light: {}, dark: {} })
  })
})

describe("shadcn registry:theme interop", () => {
  it("round-trips through the official item shape", () => {
    const theme = {
      light: { primary: "#111111" },
      dark: { primary: "#eeeeee" },
    }
    const json = toThemeRegistryItem(theme)
    const parsedItem = JSON.parse(json)
    expect(parsedItem.type).toBe("registry:theme")
    expect(parsedItem.$schema).toBe(
      "https://ui.shadcn.com/schema/registry-item.json"
    )
    expect(parsedItem.cssVars.light.primary).toBe("#111111")
    expect(parseThemeRegistryItem(json)).toEqual(theme)
  })

  it("accepts a full registry item pasted from shadcn", () => {
    const pasted = JSON.stringify({
      $schema: "https://ui.shadcn.com/schema/registry-item.json",
      name: "custom-theme",
      type: "registry:theme",
      cssVars: {
        light: { primary: "oklch(0.546 0.245 262.881)" },
        dark: { primary: "oklch(0.707 0.165 254.624)" },
      },
    })
    expect(parseThemeRegistryItem(pasted)).toEqual({
      light: { primary: "oklch(0.546 0.245 262.881)" },
      dark: { primary: "oklch(0.707 0.165 254.624)" },
    })
  })

  it("accepts a bare light/dark object", () => {
    const parsed = parseThemeRegistryItem(
      JSON.stringify({ light: { border: "#cccccc" }, dark: {} })
    )
    expect(parsed).toEqual({ light: { border: "#cccccc" }, dark: {} })
  })

  it("treats a flat token map as applying to both modes", () => {
    expect(
      parseThemeRegistryItem(JSON.stringify({ primary: "#123456" }))
    ).toEqual({ light: { primary: "#123456" }, dark: { primary: "#123456" } })
  })

  it("returns null when nothing usable is present, rather than wiping the theme", () => {
    expect(parseThemeRegistryItem("not json")).toBeNull()
    expect(parseThemeRegistryItem("[]")).toBeNull()
    expect(
      parseThemeRegistryItem(JSON.stringify({ unknown: "#fff" }))
    ).toBeNull()
    expect(
      parseThemeRegistryItem(JSON.stringify({ light: { primary: "red; }" } }))
    ).toBeNull()
  })
})

describe("sanitizeCustomCss", () => {
  it("passes ordinary CSS through untouched", () => {
    const css = ".foo { color: red }\n.bar { color: blue }"
    const result = sanitizeCustomCss(css)
    expect(result.issue).toBeNull()
    expect(result.css).toBe(css)
    expect(result.removedImports).toBe(0)
    expect(result.ruleCount).toBe(2)
  })

  it("strips @import rules and reports how many", () => {
    const result = sanitizeCustomCss(
      '@import url("https://evil.example/x.css");\n.foo { color: red }'
    )
    expect(result.removedImports).toBe(1)
    expect(result.css).not.toMatch(/@import/i)
    expect(result.css).toContain(".foo")
    expect(result.issue).toBeNull()
  })

  it("strips the bare-string and media-qualified @import forms too", () => {
    const result = sanitizeCustomCss(
      "@import 'a.css';\n@import url(b.css) screen and (min-width: 400px);\n.x{color:red}"
    )
    expect(result.removedImports).toBe(2)
    expect(result.css).not.toMatch(/@import/i)
  })

  it("refuses payloads over the cap instead of truncating them", () => {
    const result = sanitizeCustomCss("a".repeat(MAX_CUSTOM_CSS_BYTES + 1))
    expect(result.issue).toBe("too-large")
    expect(result.css).toBeNull()
  })

  it("counts bytes, not UTF-16 units, against the cap", () => {
    // 3 字节/字符 —— 按 .length 判定的话这段会被误放行。
    const css = `.a{content:"${"中".repeat(MAX_CUSTOM_CSS_BYTES / 3)}"}`
    expect(sanitizeCustomCss(css).issue).toBe("too-large")
  })

  it("flags CSS that parses to no rules", () => {
    const result = sanitizeCustomCss("this is not css at all")
    expect(result.issue).toBe("no-rules")
  })

  it("treats empty input as valid and empty", () => {
    const result = sanitizeCustomCss("   ")
    expect(result.issue).toBeNull()
    expect(result.css).toBe("")
  })

  it("notices remote url() without blocking it", () => {
    const result = sanitizeCustomCss(
      ".a { background-image: url(https://example.com/a.png) }"
    )
    expect(result.hasRemoteUrl).toBe(true)
    expect(result.issue).toBeNull()
    expect(result.css).toContain("example.com")
  })
})

describe("applyTokenOverrides", () => {
  it("sets the given tokens and removes every other known token", () => {
    const root = document.createElement("div")
    root.style.setProperty("--primary", "#111111")
    root.style.setProperty("--border", "#222222")
    // 非 token 的自定义属性不归我们管，必须原样留下（--font-sans 等由字体系统写入）。
    root.style.setProperty("--font-sans", "Inter")

    applyTokenOverrides(root, { background: "#333333" })

    expect(root.style.getPropertyValue("--background")).toBe("#333333")
    expect(root.style.getPropertyValue("--primary")).toBe("")
    expect(root.style.getPropertyValue("--border")).toBe("")
    expect(root.style.getPropertyValue("--font-sans")).toBe("Inter")
  })

  it("clears everything when handed an empty set", () => {
    const root = document.createElement("div")
    root.style.setProperty("--primary", "#111111")
    applyTokenOverrides(root, {})
    expect(root.style.getPropertyValue("--primary")).toBe("")
  })
})

describe("toHexColor", () => {
  it("passes through and expands hex forms without needing a canvas", () => {
    expect(toHexColor("#AABBCC")).toBe("#aabbcc")
    expect(toHexColor("  #abc ")).toBe("#aabbcc")
  })

  it("returns null for values it cannot resolve", () => {
    expect(toHexColor("")).toBeNull()
    expect(toHexColor("definitely-not-a-color")).toBeNull()
  })
})

/**
 * 现代色彩语法（本仓库 token 用的 `oklch()`、`color-mix()` 出来的 `color(srgb …)`）回读
 * `fillStyle` 时保持原语法、拿不到十六进制，只有光栅化读回像素才能转换 —— 少了这一步，
 * 所有默认 token 都会转失败，调用方只能退回硬编码值（终端主题因此变纯黑，见 issue #363）。
 */
describe("toHexColor 的光栅化兜底", () => {
  /** 只实现 toHexColor 用到的那几件事的 2D 上下文替身。 */
  function fakeContext(pixel: [number, number, number, number] | null) {
    let fillStyle = "#000000"
    return {
      globalCompositeOperation: "source-over",
      get fillStyle() {
        return fillStyle
      },
      // 浏览器行为：不认识的语法赋值被忽略（fillStyle 原封不动），认识的原样回读。
      set fillStyle(value: string) {
        if (pixel || /^#[0-9a-f]{6}$/i.test(value)) fillStyle = value
      },
      fillRect() {},
      getImageData() {
        return { data: Uint8ClampedArray.from(pixel ?? [0, 0, 0, 0]) }
      },
    }
  }

  /** 每个用例都重新 import：模块作用域里缓存了 2D 上下文。 */
  async function load(pixel: [number, number, number, number] | null) {
    vi.resetModules()
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => fakeContext(pixel) as unknown as CanvasRenderingContext2D
    )
    return (await import("./custom-style")).toHexColor
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("把 oklch() 光栅化成 #rrggbb", async () => {
    const convert = await load([247, 247, 247, 255])
    expect(convert("oklch(0.98 0 0)")).toBe("#f7f7f7")
  })

  it("补零到六位", async () => {
    const convert = await load([1, 2, 3, 255])
    expect(convert("color(srgb 0.004 0.008 0.012)")).toBe("#010203")
  })

  it("半透明判失败（getImageData 去预乘后会失真）", async () => {
    const convert = await load([255, 255, 255, 77])
    expect(convert("oklch(1 0 0 / 0.3)")).toBeNull()
  })

  it("引擎不认这个语法时判失败，不会误报成黑色", async () => {
    const convert = await load(null)
    expect(convert("oklch(0.98 0 0)")).toBeNull()
  })
})
