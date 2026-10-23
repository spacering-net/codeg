// src/lib/font-presets.ts

/**
 * 字体自定义的字体目录（catalog）。
 *
 * 三个目标（界面 / 编辑器 / 终端）共用同一份 FontDef 列表：
 * - "system" 项：无字体文件，stack 为系统字体栈，任意平台可用。
 * - "bundled" 项：自托管，通过 @fontsource-variable/* 注册 @font-face（真实族名，
 *   形如 "Inter Variable"），声明惰性、被选中/预览时才下载 woff2。
 * - "custom"：不在列表里，是一个 sentinel id，由 resolveFontStack 用用户输入的族名拼栈。
 *
 * 真实族名既可用于界面字体的 CSS 变量 --font-sans，也可直接作为 Monaco/xterm
 * 的 fontFamily 字符串选项，各处共享同一份 stack。
 */

export type FontCategory = "sans" | "mono"
export type FontSource = "system" | "bundled"

export type FontDef = {
  /** 稳定标识，写入 localStorage */
  id: string
  /** 显示名（专有名词，不参与 i18n 翻译） */
  label: string
  category: FontCategory
  source: FontSource
  /** 完整的 CSS font-family 值（含回退栈） */
  stack: string
  /** 该字体是否带编程连字（ligatures） */
  ligatures: boolean
}

/** 自定义字体的 sentinel id（不在 FONTS 列表中） */
export const CUSTOM_FONT_ID = "custom"

/** 系统无衬线 / 等宽回退栈，所有 bundled 字体也以它收尾，CJK 由系统字体兜底。 */
export const SANS_FALLBACK =
  'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
export const MONO_FALLBACK =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'

const bundled = (
  id: string,
  label: string,
  family: string,
  category: FontCategory,
  ligatures: boolean
): FontDef => ({
  id,
  label,
  category,
  source: "bundled",
  stack: `"${family}", ${category === "mono" ? MONO_FALLBACK : SANS_FALLBACK}`,
  ligatures,
})

export const FONTS: readonly FontDef[] = [
  // ===== 系统默认 =====
  {
    id: "system-ui",
    label: "System UI",
    category: "sans",
    source: "system",
    stack: SANS_FALLBACK,
    ligatures: false,
  },
  {
    id: "system-mono",
    label: "System Monospace",
    category: "mono",
    source: "system",
    stack: MONO_FALLBACK,
    ligatures: false,
  },
  // ===== 内置无衬线 =====
  bundled("inter", "Inter", "Inter Variable", "sans", false),
  bundled("geist", "Geist", "Geist Variable", "sans", false),
  // ===== 内置等宽 =====
  bundled(
    "jetbrains-mono",
    "JetBrains Mono",
    "JetBrains Mono Variable",
    "mono",
    true
  ),
  bundled("fira-code", "Fira Code", "Fira Code Variable", "mono", true),
  bundled("geist-mono", "Geist Mono", "Geist Mono Variable", "mono", false),
] as const

export const FONT_BY_ID: Record<string, FontDef> = Object.fromEntries(
  FONTS.map((f) => [f.id, f])
)

/** 界面字体可选项：无衬线 + 等宽全部允许（当前默认 Inter 为无衬线）。 */
export const UI_FONTS: readonly FontDef[] = FONTS
/** 编辑器 / 终端字体可选项：仅等宽。 */
export const MONO_FONTS: readonly FontDef[] = FONTS.filter(
  (f) => f.category === "mono"
)

/**
 * 默认：界面为 Inter（无衬线），编辑器 / 终端为系统等宽字体。
 * 界面字体驱动 --font-sans（会话正文）。编辑器字体驱动 --font-mono（对话代码块、
 * font-mono）并作为 Monaco 的 fontFamily。终端字体只走 xterm。
 * 注意：界面默认改动须与 globals.css 的 :root --font-sans 兜底栈保持一致
 * （兜底栈须等于 resolveFontStack(DEFAULT_UI_FONT_ID, "", "sans")），
 * 否则首屏到水合之间会闪字（inline 脚本无存储值时回退到该 CSS 兜底）。
 */
export const DEFAULT_UI_FONT_ID = "inter"
export const DEFAULT_EDITOR_FONT_ID = "system-mono"
export const DEFAULT_TERMINAL_FONT_ID = "system-mono"

/** 编辑器 / 终端基础字号（px）。最终字号 = base × zoom% / 100，与现有缩放叠加。 */
export const FONT_SIZES = [10, 11, 12, 13, 14, 15, 16, 18, 20] as const
export type FontSize = (typeof FONT_SIZES)[number]
export const DEFAULT_EDITOR_FONT_SIZE: FontSize = 13
export const DEFAULT_TERMINAL_FONT_SIZE: FontSize = 13

export function isValidFontId(id: string | null | undefined): boolean {
  return id === CUSTOM_FONT_ID || (!!id && id in FONT_BY_ID)
}

export function isValidFontSize(n: number): n is FontSize {
  return (FONT_SIZES as readonly number[]).includes(n)
}

/**
 * 清洗自定义族名：剔除可能破坏 CSS 值语法的字符，限制长度。
 * - 先按字符码过滤掉所有控制字符（含换行/制表），避免在正则里写控制字符触发 lint；
 * - 再去掉引号、反斜杠、分号、花括号、尖括号。
 */
export function sanitizeFontFamily(input: string): string {
  return Array.from(input)
    .filter((ch) => ch.charCodeAt(0) >= 0x20)
    .join("")
    .replace(/["'\\;{}<>]/g, "")
    .trim()
    .slice(0, 64)
}

/**
 * 把 (id, 自定义族名, 分类) 解析为完整的 CSS font-family 栈。
 * - custom：清洗后用双引号包裹 + 分类回退栈；空输入回退到系统栈。
 * - 已知 id：返回其 stack。
 * - 未知 id：回退到分类系统栈。
 */
export function resolveFontStack(
  id: string,
  customFamily: string,
  category: FontCategory
): string {
  const fallback = category === "mono" ? MONO_FALLBACK : SANS_FALLBACK
  if (id === CUSTOM_FONT_ID) {
    const fam = sanitizeFontFamily(customFamily)
    return fam ? `"${fam}", ${fallback}` : fallback
  }
  return FONT_BY_ID[id]?.stack ?? fallback
}

/** 该 id 对应的字体是否支持连字（自定义/未知按支持处理，交给用户判断）。 */
export function fontSupportsLigatures(id: string): boolean {
  if (id === CUSTOM_FONT_ID) return true
  return FONT_BY_ID[id]?.ligatures ?? false
}
