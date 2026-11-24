import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * xterm 的 css.toColor 只用正则认十六进制和逗号式 rgb()/rgba()，其余语法（本仓库 token
 * 用的 oklch()）走它内部的 canvas 兜底解析；兜底一旦失败，ThemeService 会静默把背景色
 * 回落成 #000000 —— 亮色主题下整块终端变纯黑（issue #363）。
 *
 * 这里的断言守的就是这条契约：getTerminalTheme 交出去的 background 必须是 xterm 正则
 * 直接认得的写法，任何情况下都不能把 oklch()/color() 之类原样递给 xterm。
 */
const XTERM_PARSEABLE =
  /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$|^rgba?\(\s*\d{1,3}\s*,/i

/** 浏览器 2D 上下文的替身：只实现 toHexColor 用到的那几件事。 */
function fakeContext(known: Record<string, [number, number, number, number]>) {
  const pixelOf = (value: string): [number, number, number, number] => {
    if (known[value]) return known[value]
    const hex = /^#([0-9a-f]{6})$/i.exec(value)?.[1] ?? "000000"
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
      255,
    ]
  }
  let fillStyle = "#000000"
  let painted = "#000000"
  return {
    globalCompositeOperation: "source-over",
    get fillStyle() {
      return fillStyle
    },
    // 浏览器行为：赋一个自己不认识的语法时，fillStyle 原封不动 —— toHexColor 的双哨兵
    // 就是靠这一点判定非法。不透明的 legacy rgb() 会被规范化成 #rrggbb，而现代色彩语法
    // （oklch()/color()）只做规范化、不降级，所以原样回读。
    set fillStyle(value: string) {
      const legacy = /^rgb\((\d{1,3}),\s*(\d{1,3}),\s*(\d{1,3})\)$/.exec(value)
      if (legacy) {
        fillStyle = `#${legacy
          .slice(1)
          .map((c) => Number(c).toString(16).padStart(2, "0"))
          .join("")}`
        return
      }
      if (known[value] || /^#[0-9a-f]{6}$/i.test(value)) fillStyle = value
    },
    fillRect() {
      painted = fillStyle
    },
    getImageData() {
      return { data: Uint8ClampedArray.from(pixelOf(painted)) }
    },
  }
}

function stubCanvas(ctx: ReturnType<typeof fakeContext> | null) {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => ctx as unknown as CanvasRenderingContext2D
  )
}

/** 每个用例都重新 import：custom-style 会把 2D 上下文缓存在模块作用域里。 */
async function loadGetTerminalTheme() {
  vi.resetModules()
  return (await import("./theme")).getTerminalTheme
}

/** 造一条「终端容器 → 面板」的祖先链，面板底色用给定的 CSS 颜色。 */
function mountContainer(panelBackground: string): HTMLElement {
  const panel = document.createElement("div")
  panel.style.backgroundColor = panelBackground
  const container = document.createElement("div")
  panel.appendChild(container)
  document.body.appendChild(panel)
  return container
}

beforeEach(() => {
  document.documentElement.classList.remove("dark")
  document.documentElement.removeAttribute("data-workspace-bg")
  document.body.innerHTML = ""
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("getTerminalTheme", () => {
  it("把面板的 oklch 底色归一成十六进制再交给 xterm", async () => {
    stubCanvas(fakeContext({ "oklch(0.98 0 0)": [247, 247, 247, 255] }))
    const getTerminalTheme = await loadGetTerminalTheme()

    const theme = getTerminalTheme(mountContainer("oklch(0.98 0 0)"))

    expect(theme.background).toBe("#f7f7f7")
    // cursorAccent 跟随背景色：块状光标下的字符靠它上色，跟着一起错就会看不见。
    expect(theme.cursorAccent).toBe("#f7f7f7")
    expect(theme.background).toMatch(XTERM_PARSEABLE)
  })

  it("引擎转不动 oklch 时退回主题常量，而不是把它原样递给 xterm", async () => {
    // 模拟 CSS 认 oklch、canvas 不认的 WebView（旧 WKWebView / Safari / WebKitGTK）：
    // 上下文在，但没有任何一种现代语法能被 fillStyle 接受。
    stubCanvas(fakeContext({}))
    const getTerminalTheme = await loadGetTerminalTheme()

    const theme = getTerminalTheme(mountContainer("oklch(0.98 0 0)"))

    expect(theme.background).toBe("#ffffff")
    expect(theme.background).toMatch(XTERM_PARSEABLE)
  })

  it("完全拿不到 canvas 时同样退回主题常量（暗色）", async () => {
    stubCanvas(null)
    document.documentElement.classList.add("dark")
    const getTerminalTheme = await loadGetTerminalTheme()

    const theme = getTerminalTheme(mountContainer("oklch(0.145 0 0)"))

    expect(theme.background).toBe("#1a1a1a")
    expect(theme.foreground).toBe("#e0e0e0")
    expect(theme.background).toMatch(XTERM_PARSEABLE)
  })

  it("半透明底色不硬凑，退回主题常量", async () => {
    stubCanvas(fakeContext({ "oklch(1 0 0 / 0.3)": [255, 255, 255, 77] }))
    const getTerminalTheme = await loadGetTerminalTheme()

    const theme = getTerminalTheme(mountContainer("oklch(1 0 0 / 0.3)"))

    expect(theme.background).toBe("#ffffff")
  })

  it("legacy rgb() 底色直接可用", async () => {
    stubCanvas(fakeContext({}))
    const getTerminalTheme = await loadGetTerminalTheme()

    const theme = getTerminalTheme(mountContainer("rgb(18, 18, 18)"))

    expect(theme.background).toBe("#121212")
  })

  it("找不到不透明祖先时用主题常量", async () => {
    stubCanvas(fakeContext({}))
    const getTerminalTheme = await loadGetTerminalTheme()

    const orphan = document.createElement("div")
    expect(getTerminalTheme(orphan).background).toBe("#ffffff")
    expect(getTerminalTheme(null).background).toBe("#ffffff")
  })

  it("开启背景图时保持 alpha 0 的透明底色（xterm 正则认得的逗号式 rgba）", async () => {
    stubCanvas(fakeContext({}))
    document.documentElement.setAttribute("data-workspace-bg", "on")
    const getTerminalTheme = await loadGetTerminalTheme()

    const light = getTerminalTheme(mountContainer("oklch(1 0 0)"))
    expect(light.background).toBe("rgba(255, 255, 255, 0)")
    expect(light.background).toMatch(XTERM_PARSEABLE)
    // 透明画布下 cursorAccent 必须留在不透明主题色上，否则块状光标里的字符会一起消失。
    expect(light.cursorAccent).toBe("#ffffff")

    document.documentElement.classList.add("dark")
    const dark = getTerminalTheme(mountContainer("oklch(0.145 0 0)"))
    expect(dark.background).toBe("rgba(26, 26, 26, 0)")
    expect(dark.cursorAccent).toBe("#1a1a1a")
  })
})
