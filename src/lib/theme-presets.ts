// src/lib/theme-presets.ts

import type { CSSProperties } from "react"

/**
 * 12 个 shadcn 官方主题预设的标识符。
 * 实际 CSS 变量值定义在 src/app/globals.css 的 [data-theme="..."] 选择器中。
 */
export const THEME_COLORS = [
  "neutral",
  "zinc",
  "slate",
  "stone",
  "gray",
  "red",
  "rose",
  "orange",
  "green",
  "blue",
  "yellow",
  "violet",
] as const

export type ThemeColor = (typeof THEME_COLORS)[number]

export const FOLDER_THEME_COLOR_INHERIT = "inherit" as const

export type FolderThemeColor = ThemeColor | typeof FOLDER_THEME_COLOR_INHERIT

const THEME_COLOR_SET = new Set<string>(THEME_COLORS)

/**
 * 早期版本的文件夹颜色存储的是十六进制值；迁移映射到最接近的主题预设。
 */
const LEGACY_FOLDER_COLOR_MAP: Record<string, FolderThemeColor> = {
  foreground: FOLDER_THEME_COLOR_INHERIT,
  "#ef4444": "red",
  "#f97316": "orange",
  "#eab308": "yellow",
  "#84cc16": "green",
  "#22c55e": "green",
  "#06b6d4": "blue",
  "#8b5cf6": "violet",
  "#d946ef": "rose",
  "#ec4899": "rose",
}

/**
 * 把 FolderDetail.color 的原始存储值（预设名或遗留十六进制）规约成
 * FolderThemeColor。未知值回退 inherit。
 */
export function normalizeFolderThemeColor(
  color: string | null | undefined
): FolderThemeColor {
  if (!color) return FOLDER_THEME_COLOR_INHERIT
  const normalized = color.toLowerCase()
  if (normalized === FOLDER_THEME_COLOR_INHERIT) {
    return FOLDER_THEME_COLOR_INHERIT
  }
  if (THEME_COLOR_SET.has(normalized)) return normalized as ThemeColor
  return LEGACY_FOLDER_COLOR_MAP[normalized] ?? FOLDER_THEME_COLOR_INHERIT
}

/**
 * 默认主题色。选用 "neutral" 是因为它对应当前 globals.css 的现存 :root 值
 * （所有 chroma=0 的纯灰阶），可保证升级后视觉零差异。
 */
export const DEFAULT_THEME_COLOR: ThemeColor = "neutral"

/**
 * UI 预览用的代表色（OKLch 字符串，对应各预设的 primary 色 light 版本）。
 * 仅用于 Appearance 页面的"色盘圆点"按钮渲染，不会被写入真实样式。
 *
 * 选择 light primary 而非其他变量，是因为 primary 是各预设视觉差异最大的部分。
 * 这些值必须硬编码（不能通过 var(--primary) 读取），因为每个圆点要永远显示
 * 自己对应预设的代表色，不能跟随当前激活的主题色。
 */
export const THEME_COLOR_PREVIEW: Record<ThemeColor, string> = {
  neutral: "oklch(0.205 0 0)",
  zinc: "oklch(0.21 0.006 285.885)",
  slate: "oklch(0.208 0.042 265.755)",
  stone: "oklch(0.216 0.006 56.043)",
  gray: "oklch(0.21 0.034 264.665)",
  red: "oklch(0.637 0.237 25.331)",
  rose: "oklch(0.645 0.246 16.439)",
  orange: "oklch(0.705 0.213 47.604)",
  green: "oklch(0.723 0.219 149.579)",
  blue: "oklch(0.546 0.245 262.881)",
  yellow: "oklch(0.795 0.184 86.047)",
  violet: "oklch(0.606 0.25 292.717)",
}

/**
 * 侧边栏「文件夹 / 分组标题」的着色表。文件夹和分组的自定义颜色**只染标题文字**，
 * 不再给整行套 data-theme（那会把它下面所有会话卡片的主题一起换掉）。
 *
 * 取值规则：拿该预设 primary 的**色相与彩度**，把明度推到侧边栏底色上可读的档位 ——
 * light 取 min(L_primary, 0.50)，dark 取 max(L_dark_primary, 0.80)，彩度再按 sRGB
 * 色域二分收敛（否则 L=0.5 的红/紫会掉出色域被浏览器裁成另一个颜色）。灰阶五兄弟
 * （neutral/zinc/slate/stone/gray）的 primary 本来就在档位之外，于是原样保留近黑/近白。
 *
 * 实测对比度（Y=L³ 换算，对 light --sidebar 0.985 与悬停底 0.94；dark 0.205 与 0.22）
 * 最低一档是 green light 的 5.4:1 / 悬停 4.7:1，全部过 14px 正文的 AA 4.5:1。
 * 改任何一个值都要重算一遍，别只挑好看的色号
 * （见 memory: sidebar 对比度下限）。
 *
 * 会话时间线的主题色（globals.css 的 --activity-accent：运行中圆环的弧、运行中
 * 标题的流光、MCP 徽标）逐预设抄的就是这张表，改值两边一起改
 * （globals-activity-accent.test.ts 对账）；自定义主色按同一规则现算
 * （readable-accent.ts）。
 */
export const THEME_COLOR_TITLE: Record<
  ThemeColor,
  { light: string; dark: string }
> = {
  neutral: { light: "oklch(0.205 0 0)", dark: "oklch(0.87 0 0)" },
  zinc: {
    light: "oklch(0.21 0.006 285.885)",
    dark: "oklch(0.92 0.004 286.32)",
  },
  slate: {
    light: "oklch(0.208 0.042 265.755)",
    dark: "oklch(0.929 0.013 255.508)",
  },
  stone: {
    light: "oklch(0.216 0.006 56.043)",
    dark: "oklch(0.923 0.003 48.717)",
  },
  gray: {
    light: "oklch(0.21 0.034 264.665)",
    dark: "oklch(0.928 0.006 264.531)",
  },
  red: { light: "oklch(0.5 0.203 25.331)", dark: "oklch(0.8 0.114 25.331)" },
  rose: { light: "oklch(0.5 0.2 16.439)", dark: "oklch(0.8 0.115 16.439)" },
  orange: { light: "oklch(0.5 0.137 47.604)", dark: "oklch(0.8 0.119 41.116)" },
  green: { light: "oklch(0.5 0.139 149.579)", dark: "oklch(0.8 0.17 162.48)" },
  blue: { light: "oklch(0.5 0.245 262.881)", dark: "oklch(0.8 0.1 259.815)" },
  yellow: { light: "oklch(0.5 0.102 86.047)", dark: "oklch(0.8 0.163 86.047)" },
  violet: {
    light: "oklch(0.5 0.25 292.717)",
    dark: "oklch(0.8 0.111 293.009)",
  },
}

/**
 * 标题着色要写的两个 CSS 变量，配合 globals.css 的 `.folder-title-tint` 使用
 * （明暗两条规则在 CSS 里选，因此不需要在 JS 里知道当前是不是暗色 —— 首屏水合前
 * 也不会闪一下浅色）。
 *
 * `inherit` 返回 undefined：调用方据此保留默认的 `text-sidebar-foreground/75`，
 * 而不是把默认色也硬编码进这张表。
 */
export function folderTitleTintVars(
  color: FolderThemeColor
): CSSProperties | undefined {
  if (color === FOLDER_THEME_COLOR_INHERIT) return undefined
  const pair = THEME_COLOR_TITLE[color]
  return {
    "--folder-title-light": pair.light,
    "--folder-title-dark": pair.dark,
  } as CSSProperties
}

/**
 * 缩放档位（百分比）。100 是默认。
 * 选用离散档位而非连续滑块，是为了与现有 ThemeMode 选择器保持视觉一致。
 */
export const ZOOM_LEVELS = [
  80, 90, 100, 110, 125, 150, 175, 200, 250, 300,
] as const

export type ZoomLevel = (typeof ZOOM_LEVELS)[number]

export const DEFAULT_ZOOM_LEVEL: ZoomLevel = 100

/** Next discrete Settings zoom step. Stops at the first / last rung. */
export function stepZoom(current: ZoomLevel, direction: 1 | -1): ZoomLevel {
  const index = ZOOM_LEVELS.indexOf(current)
  const from = index >= 0 ? index : ZOOM_LEVELS.indexOf(DEFAULT_ZOOM_LEVEL)
  const next = Math.min(ZOOM_LEVELS.length - 1, Math.max(0, from + direction))
  return ZOOM_LEVELS[next]
}
