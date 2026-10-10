import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  APPEARANCE_INIT_SCRIPT,
  STORAGE_KEY_CUSTOM_CSS,
  STORAGE_KEY_CUSTOM_CSS_ENABLED,
  STORAGE_KEY_CUSTOM_STYLE_SUSPENDED,
  STORAGE_KEY_CUSTOM_THEME,
  STORAGE_KEY_CUSTOM_THEME_ENABLED,
  STORAGE_KEY_THEME_COLOR,
  STORAGE_KEY_ZOOM_LEVEL,
} from "./appearance-script"
import { CUSTOM_CSS_ELEMENT_ID } from "./custom-style"
import {
  THEME_COLOR_DARK,
  THEME_COLOR_LIGHT,
  THEME_COLOR_MEDIA_DARK,
  THEME_COLOR_MEDIA_LIGHT,
} from "./theme-color"

/**
 * 这段脚本跑在第一帧渲染之前、任何模块加载之前，是整个外观体系里最脆弱的一环：
 * 它一抛错，主题色/缩放/暗色类/自定义样式会一起丢，用户看到的是「设置全部失效」。
 * 所以这里直接把它当字符串 eval 进 jsdom 跑，而不是测某个抽出来的函数。
 */
function runInitScript() {
  // 间接 eval：在全局作用域里跑，最贴近浏览器里 <script> 标签的执行环境。
  ;(0, eval)(APPEARANCE_INIT_SCRIPT)
}

function resetDocument() {
  const root = document.documentElement
  root.removeAttribute("style")
  root.removeAttribute("data-theme")
  root.removeAttribute("data-workspace-bg")
  root.classList.remove("dark")
  document.getElementById(CUSTOM_CSS_ELEMENT_ID)?.remove()
  document
    .querySelectorAll('meta[name="theme-color"]')
    .forEach((tag) => tag.remove())
}

beforeEach(() => {
  localStorage.clear()
  resetDocument()
  window.history.replaceState({}, "", "/")
  // jsdom 不实现 matchMedia，而脚本用它探测系统暗色偏好。
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({ matches: false }) as unknown as typeof matchMedia
  )
})

describe("APPEARANCE_INIT_SCRIPT — custom theme tokens", () => {
  it("applies the light set as inline custom properties on <html>", () => {
    localStorage.setItem("theme", "light")
    localStorage.setItem(
      STORAGE_KEY_CUSTOM_THEME,
      JSON.stringify({
        light: { primary: "#111111", radius: "0.25rem" },
        dark: { primary: "#eeeeee" },
      })
    )

    runInitScript()

    const style = document.documentElement.style
    expect(style.getPropertyValue("--primary")).toBe("#111111")
    expect(style.getPropertyValue("--radius")).toBe("0.25rem")
  })

  it("picks the dark set when the resolved mode is dark", () => {
    localStorage.setItem("theme", "dark")
    localStorage.setItem(
      STORAGE_KEY_CUSTOM_THEME,
      JSON.stringify({
        light: { primary: "#111111" },
        dark: { primary: "#eeeeee" },
      })
    )

    runInitScript()

    expect(document.documentElement.classList.contains("dark")).toBe(true)
    expect(document.documentElement.style.getPropertyValue("--primary")).toBe(
      "#eeeeee"
    )
  })

  it("drops values that fail the whitelist but keeps the good ones", () => {
    localStorage.setItem("theme", "light")
    localStorage.setItem(
      STORAGE_KEY_CUSTOM_THEME,
      JSON.stringify({
        light: {
          primary: "#111111",
          border: "red; } body { display:none } .x {",
          background: "url(https://evil.example/x.png)",
        },
        dark: {},
      })
    )

    runInitScript()

    const style = document.documentElement.style
    expect(style.getPropertyValue("--primary")).toBe("#111111")
    expect(style.getPropertyValue("--border")).toBe("")
    expect(style.getPropertyValue("--background")).toBe("")
  })

  it("ignores unknown keys so a hand-edited storage value cannot inject", () => {
    localStorage.setItem("theme", "light")
    localStorage.setItem(
      STORAGE_KEY_CUSTOM_THEME,
      JSON.stringify({ light: { "not-a-token": "#111111" }, dark: {} })
    )

    runInitScript()

    expect(
      document.documentElement.style.getPropertyValue("--not-a-token")
    ).toBe("")
  })

  it("honours the enabled flag", () => {
    localStorage.setItem("theme", "light")
    localStorage.setItem(STORAGE_KEY_CUSTOM_THEME_ENABLED, "0")
    localStorage.setItem(
      STORAGE_KEY_CUSTOM_THEME,
      JSON.stringify({ light: { primary: "#111111" }, dark: {} })
    )

    runInitScript()

    expect(document.documentElement.style.getPropertyValue("--primary")).toBe(
      ""
    )
  })

  it("survives a corrupt theme payload without losing the other preferences", () => {
    localStorage.setItem(STORAGE_KEY_THEME_COLOR, "blue")
    localStorage.setItem(STORAGE_KEY_ZOOM_LEVEL, "125")
    localStorage.setItem(STORAGE_KEY_CUSTOM_THEME, "{not json")
    localStorage.setItem(STORAGE_KEY_CUSTOM_CSS_ENABLED, "1")
    localStorage.setItem(STORAGE_KEY_CUSTOM_CSS, ".x{color:red}")

    expect(() => runInitScript()).not.toThrow()

    expect(document.documentElement.getAttribute("data-theme")).toBe("blue")
    expect(document.documentElement.style.fontSize).toBe("20px")
    // 主题损坏不该连累后面的 CSS 注入 —— 两段各自包了 try/catch。
    expect(document.getElementById(CUSTOM_CSS_ELEMENT_ID)?.textContent).toBe(
      ".x{color:red}"
    )
  })
})

describe("APPEARANCE_INIT_SCRIPT — custom CSS", () => {
  it("injects the stored CSS at the end of <head> when enabled", () => {
    localStorage.setItem(STORAGE_KEY_CUSTOM_CSS_ENABLED, "1")
    localStorage.setItem(STORAGE_KEY_CUSTOM_CSS, ".foo { color: red }")

    runInitScript()

    const el = document.getElementById(CUSTOM_CSS_ELEMENT_ID)
    expect(el).not.toBeNull()
    expect(el?.textContent).toBe(".foo { color: red }")
    expect(document.head.lastChild).toBe(el)
  })

  it("stays out of the document while the toggle is off", () => {
    localStorage.setItem(STORAGE_KEY_CUSTOM_CSS, ".foo { color: red }")

    runInitScript()

    expect(document.getElementById(CUSTOM_CSS_ELEMENT_ID)).toBeNull()
  })
})

describe("APPEARANCE_INIT_SCRIPT — escape hatches", () => {
  it("skips everything custom when suspended, but keeps the base appearance", () => {
    localStorage.setItem("theme", "light")
    localStorage.setItem(STORAGE_KEY_THEME_COLOR, "violet")
    localStorage.setItem(STORAGE_KEY_CUSTOM_STYLE_SUSPENDED, "1")
    localStorage.setItem(
      STORAGE_KEY_CUSTOM_THEME,
      JSON.stringify({ light: { primary: "#111111" }, dark: {} })
    )
    localStorage.setItem(STORAGE_KEY_CUSTOM_CSS_ENABLED, "1")
    localStorage.setItem(STORAGE_KEY_CUSTOM_CSS, ".foo { color: red }")

    runInitScript()

    expect(document.documentElement.style.getPropertyValue("--primary")).toBe(
      ""
    )
    expect(document.getElementById(CUSTOM_CSS_ELEMENT_ID)).toBeNull()
    // 逃生舱只关自定义样式，基础外观偏好必须照常生效 —— 否则「安全外观」会把
    // 用户熟悉的界面也一并换掉。
    expect(document.documentElement.getAttribute("data-theme")).toBe("violet")
  })

  it("skips everything custom for a window opened with safeStyle=1", () => {
    window.history.replaceState({}, "", "/settings?safeStyle=1")
    localStorage.setItem("theme", "light")
    localStorage.setItem(
      STORAGE_KEY_CUSTOM_THEME,
      JSON.stringify({ light: { primary: "#111111" }, dark: {} })
    )
    localStorage.setItem(STORAGE_KEY_CUSTOM_CSS_ENABLED, "1")
    localStorage.setItem(STORAGE_KEY_CUSTOM_CSS, ".foo { color: red }")

    runInitScript()

    expect(document.documentElement.style.getPropertyValue("--primary")).toBe(
      ""
    )
    expect(document.getElementById(CUSTOM_CSS_ELEMENT_ID)).toBeNull()
  })

  it("does not treat other query values as safe mode", () => {
    window.history.replaceState({}, "", "/settings?safeStyle=0&section=general")
    localStorage.setItem("theme", "light")
    localStorage.setItem(
      STORAGE_KEY_CUSTOM_THEME,
      JSON.stringify({ light: { primary: "#111111" }, dark: {} })
    )

    runInitScript()

    expect(document.documentElement.style.getPropertyValue("--primary")).toBe(
      "#111111"
    )
  })
})

/**
 * 静态 HTML 里按 prefers-color-scheme 各有一个 theme-color 标签（layout 的
 * viewport.themeColor）。应用内显式选了明/暗时，首帧前就要让两个都换成该模式的
 * 颜色，否则安卓已安装应用的状态栏按系统偏好着色，和界面反着来。
 */
describe("APPEARANCE_INIT_SCRIPT — theme-color", () => {
  function addSchemeTags() {
    for (const [media, color] of [
      [THEME_COLOR_MEDIA_LIGHT, THEME_COLOR_LIGHT],
      [THEME_COLOR_MEDIA_DARK, THEME_COLOR_DARK],
    ]) {
      const tag = document.createElement("meta")
      tag.setAttribute("name", "theme-color")
      tag.setAttribute("media", media)
      tag.setAttribute("content", color)
      document.head.appendChild(tag)
    }
  }

  function contents() {
    return Array.from(
      document.querySelectorAll('meta[name="theme-color"]'),
      (tag) => tag.getAttribute("content")
    )
  }

  it("paints both tags dark for an explicit dark choice on a light OS", () => {
    addSchemeTags()
    localStorage.setItem("theme", "dark")

    runInitScript()

    expect(contents()).toEqual([THEME_COLOR_DARK, THEME_COLOR_DARK])
  })

  it("paints both tags light for an explicit light choice on a dark OS", () => {
    addSchemeTags()
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({ matches: true }) as unknown as typeof matchMedia
    )
    localStorage.setItem("theme", "light")

    runInitScript()

    expect(contents()).toEqual([THEME_COLOR_LIGHT, THEME_COLOR_LIGHT])
  })

  it("leaves the per-scheme tags to the browser when following the system", () => {
    addSchemeTags()
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({ matches: true }) as unknown as typeof matchMedia
    )
    localStorage.setItem("theme", "system")

    runInitScript()

    expect(document.documentElement.classList.contains("dark")).toBe(true)
    expect(contents()).toEqual([THEME_COLOR_LIGHT, THEME_COLOR_DARK])
  })
})
