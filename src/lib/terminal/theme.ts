import type { ITheme } from "@xterm/xterm"
import { toHexColor } from "@/lib/custom-style"

const DARK_THEME: ITheme = {
  background: "#1a1a1a",
  foreground: "#e0e0e0",
  cursor: "#e0e0e0",
  cursorAccent: "#1a1a1a",
  selectionBackground: "#444444",
  black: "#1a1a1a",
  red: "#f87171",
  green: "#4ade80",
  yellow: "#facc15",
  blue: "#60a5fa",
  magenta: "#c084fc",
  cyan: "#22d3ee",
  white: "#e0e0e0",
  brightBlack: "#737373",
  brightRed: "#fca5a5",
  brightGreen: "#86efac",
  brightYellow: "#fde68a",
  brightBlue: "#93c5fd",
  brightMagenta: "#d8b4fe",
  brightCyan: "#67e8f9",
  brightWhite: "#ffffff",
}

const LIGHT_THEME: ITheme = {
  background: "#ffffff",
  foreground: "#1a1a1a",
  cursor: "#1a1a1a",
  cursorAccent: "#ffffff",
  selectionBackground: "#b4d5fe",
  black: "#1a1a1a",
  red: "#dc2626",
  green: "#16a34a",
  yellow: "#ca8a04",
  blue: "#2563eb",
  magenta: "#9333ea",
  cyan: "#0891b2",
  white: "#e5e5e5",
  brightBlack: "#a3a3a3",
  brightRed: "#ef4444",
  brightGreen: "#22c55e",
  brightYellow: "#eab308",
  brightBlue: "#3b82f6",
  brightMagenta: "#a855f7",
  brightCyan: "#06b6d4",
  brightWhite: "#ffffff",
}

// #1a1a1a / #ffffff 的 alpha 0 版本。工作区背景图开启时用它替换终端背景色，让画布透出
// 所属 ws-surface 面板的磨砂表面。RGB 保持与对应主题背景色一致，故 xterm 由背景色派生
// 的反显（inverse video）字色 color.opaque(bg) 仍是原主题背景色，不会随透明背景变黑。
// 逗号式 rgba() 是 xterm 正则直接认的两种写法之一（另一种是十六进制），见下方 ★。
const DARK_TRANSPARENT_BACKGROUND = "rgba(26, 26, 26, 0)"
const LIGHT_TRANSPARENT_BACKGROUND = "rgba(255, 255, 255, 0)"

function isDarkMode() {
  return document.documentElement.classList.contains("dark")
}

// 工作区背景图是否开启（<html data-workspace-bg="on">，由 AppearanceProvider 设置）。
function isWorkspaceBgOn() {
  return document.documentElement.getAttribute("data-workspace-bg") === "on"
}

/** 自 element 起逐级上溯，取第一个不透明祖先的 computed 背景色（找不到返回 null）。 */
function resolveBackgroundColor(
  element: HTMLElement | null | undefined
): string | null {
  let current = element
  while (current) {
    const color = getComputedStyle(current).backgroundColor
    if (color && color !== "transparent" && color !== "rgba(0, 0, 0, 0)") {
      return color
    }
    current = current.parentElement
  }
  return null
}

/**
 * 解析终端应当使用的 xterm 主题。
 *
 * ★ 交给 xterm 的背景色必须是它自己解析得动的写法。xterm 的 css.toColor 只用正则认
 * 十六进制和逗号式 rgb()/rgba()，其余语法一律走内部的 canvas 兜底解析；而那条兜底在
 * 部分 WebView 上会抛错（WebKit 的 CSS 层支持 oklch 早于 canvas 层，中间那段版本窗口
 * 表现为「界面全对、只有终端全黑」），alpha≠255 时也会抛错。xterm 的 ThemeService 吞掉
 * 异常后把背景色回落成 #000000 且不发任何警告 —— 于是亮色主题下整块终端变纯黑，
 * 见 issue #363。本仓库的 token 恰恰都是 oklch()（Tailwind v4），getComputedStyle 回读
 * 的就是 "oklch(1 0 0)" 这种字符串，正中这条坑。
 *
 * 所以这里先把上溯到的颜色归一成 #rrggbb 再交给 xterm；归一不动（老引擎的 canvas 也
 * 不认）就退回主题自带的十六进制常量：颜色可能与面板底色略有出入，但绝不会变成纯黑。
 */
export function getTerminalTheme(container: HTMLElement | null): ITheme {
  const dark = isDarkMode()
  const baseTheme = dark ? DARK_THEME : LIGHT_THEME

  // 背景图开启：终端画布透明，透出所属 ws-surface 面板的磨砂表面（跟随面板不透明度滑块），
  // 而非用不透明色盖住背景图。只改 background；cursorAccent 保留主题不透明色，块状光标下的
  // 字符才不会随透明背景一起消失。
  if (isWorkspaceBgOn()) {
    return {
      ...baseTheme,
      background: dark
        ? DARK_TRANSPARENT_BACKGROUND
        : LIGHT_TRANSPARENT_BACKGROUND,
    }
  }

  const resolved = resolveBackgroundColor(container)
  const background = resolved ? toHexColor(resolved) : null
  if (!background) return baseTheme

  return {
    ...baseTheme,
    background,
    cursorAccent: background,
  }
}
