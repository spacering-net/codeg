// src/lib/custom-style.ts
//
// 自定义样式（外观设置页）的纯逻辑层：token 白名单、取值校验、CSS 净化、
// 与 shadcn `registry:theme` 格式的互转。
//
// 设计要点
// --------
// 1. **token 列表严格对齐 shadcn 官方 theming 规范**（31 个语义色 + `radius`），
//    键名不带 `--` 前缀 —— 与 registry-item.json 的 `cssVars.light/dark` 完全一致，
//    所以用户可以把任意 shadcn 主题（tweakcn / 官方 registry / 他人分享）直接粘进来，
//    codeg 导出的主题也能被 `shadcn add ./theme.json` 装进任何 shadcn 项目。
// 2. **取值永远通过 `style.setProperty()` 落地，绝不字符串拼接进样式表文本** ——
//    CSSOM 属性值不会被重新解析回「规则上下文」，且 style 属性容纳不了选择器，
//    所以 `red; } body { display:none } .x {` 这类闭合逃逸在结构上不可能成立。
//    下面的正则与 `CSS.supports` 是纵深防御与用户反馈，不是唯一防线。
// 3. **自由 CSS 采用「文本剥离 + CSSOM 复核」的 fail-closed 策略**：先按文本移除
//    `@import`，再用 CSSOM 确认一条都没剩（挡住 `@\69mport` 这类转义写法），
//    剩了就整段拒绝。存进 localStorage 的就是剥离后的文本，预水合脚本可以原样注入，
//    无需在 inline 脚本里重跑一遍校验。

// ─── token 白名单 ───

/**
 * 基础档：默认展开的 8 个旋钮。挑选依据是「改了立刻看得见、且不容易把界面改坏」。
 * `radius` 单独点名 —— `@theme inline` 里 7 个圆角尺寸全部由它派生，一个滑块即可
 * 全局改圆角。
 */
export const BASIC_THEME_TOKENS = [
  "primary",
  "primary-foreground",
  "background",
  "foreground",
  "accent",
  "border",
  "sidebar",
  "radius",
] as const

/**
 * 高级档：其余 24 个变量，折叠收起。与基础档合并后正好是 shadcn 文档
 * 《Theme Tokens》表格里的全部 31 个语义色 + `radius`。
 */
export const ADVANCED_THEME_TOKENS = [
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent-foreground",
  "destructive",
  "input",
  "ring",
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
  "sidebar-foreground",
  "sidebar-primary",
  "sidebar-primary-foreground",
  "sidebar-accent",
  "sidebar-accent-foreground",
  "sidebar-border",
  "sidebar-ring",
] as const

export const CUSTOM_THEME_TOKENS = [
  ...BASIC_THEME_TOKENS,
  ...ADVANCED_THEME_TOKENS,
] as const

export type CustomThemeToken = (typeof CUSTOM_THEME_TOKENS)[number]

const TOKEN_SET = new Set<string>(CUSTOM_THEME_TOKENS)

export function isCustomThemeToken(name: unknown): name is CustomThemeToken {
  return typeof name === "string" && TOKEN_SET.has(name)
}

/** `radius` 之外的都是颜色，UI 用它决定渲染色板还是滑块。 */
export function isColorToken(token: string): boolean {
  return token !== "radius"
}

// ─── 取值校验 ───

/**
 * 取值字符集白名单。刻意排除 `;` `{` `}` `<` `>` `"` `'` `\` `@`，
 * 长度上限 64 —— 合法的颜色/长度表达式（`oklch(0.646 0.222 41.116)`、
 * `color-mix(in oklch, #fff 40%, transparent)`、`0.625rem`）都在射程内。
 */
const TOKEN_VALUE_RE = /^[a-zA-Z0-9#%.,()/\s+-]{1,64}$/

/** 供预水合 inline 脚本内联复用的正则源码（两边必须是同一份）。 */
export const TOKEN_VALUE_PATTERN_SOURCE = TOKEN_VALUE_RE.source

/**
 * 引擎级校验：自定义属性的 `<declaration-value>` 文法本就排除顶层 `;` 与不配对的
 * `} ) ]`，所以这一步能把用户手输的畸形值挡在持久化之前并给出即时反馈。
 * 环境不支持 `CSS.supports` 时降级为「只看正则」。
 */
function engineAcceptsValue(token: string, value: string): boolean {
  if (typeof CSS === "undefined" || typeof CSS.supports !== "function") {
    return true
  }
  try {
    return CSS.supports(`--${token}`, value)
  } catch {
    return true
  }
}

export function isValidTokenValue(token: string, value: unknown): boolean {
  if (typeof value !== "string") return false
  const trimmed = value.trim()
  if (!trimmed) return false
  if (!TOKEN_VALUE_RE.test(trimmed)) return false
  return engineAcceptsValue(token, trimmed)
}

// ─── 主题数据模型 ───

export type TokenOverrides = Partial<Record<CustomThemeToken, string>>

/**
 * 明暗两套覆盖。必须分开存 —— `.dark` 类与 `data-theme` 属性是正交的两个轴
 * （见 appearance-provider.tsx 顶部注释），同一个 token 在两种模式下取值不同。
 */
export type CustomTheme = {
  light: TokenOverrides
  dark: TokenOverrides
}

export const EMPTY_CUSTOM_THEME: CustomTheme = { light: {}, dark: {} }

export function isEmptyCustomTheme(theme: CustomTheme): boolean {
  return (
    Object.keys(theme.light).length === 0 &&
    Object.keys(theme.dark).length === 0
  )
}

/** 逐键过白名单 + 过校验，未知键与畸形值静默丢弃（不整段拒绝）。 */
function sanitizeOverrides(input: unknown): TokenOverrides {
  const out: TokenOverrides = {}
  if (!input || typeof input !== "object") return out
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    // 兼容带 `--` 前缀的写法（有些主题生成器会带上），统一归一到无前缀。
    const token = key.startsWith("--") ? key.slice(2) : key
    if (!isCustomThemeToken(token)) continue
    if (!isValidTokenValue(token, value)) continue
    out[token] = (value as string).trim()
  }
  return out
}

/**
 * 把任意来源（localStorage 残留、跨版本旧数据、用户粘贴的 JSON）规约成合法的
 * CustomTheme。永远返回一个可用对象，不抛。
 */
export function sanitizeCustomTheme(input: unknown): CustomTheme {
  if (!input || typeof input !== "object") return { light: {}, dark: {} }
  const record = input as Record<string, unknown>
  return {
    light: sanitizeOverrides(record.light),
    dark: sanitizeOverrides(record.dark),
  }
}

export function parseStoredCustomTheme(raw: string | null): CustomTheme {
  if (!raw) return { light: {}, dark: {} }
  try {
    return sanitizeCustomTheme(JSON.parse(raw))
  } catch {
    return { light: {}, dark: {} }
  }
}

// ─── shadcn registry:theme 互转 ───

const REGISTRY_ITEM_SCHEMA = "https://ui.shadcn.com/schema/registry-item.json"

/**
 * 导出成 shadcn 官方的 `registry:theme` item。字段与
 * https://ui.shadcn.com/docs/registry/registry-item-json 的 `cssVars` 一致，
 * 因此产物可直接被 `npx shadcn add ./theme.json` 消费。
 */
export function toThemeRegistryItem(
  theme: CustomTheme,
  name = "codeg-custom-theme"
): string {
  return JSON.stringify(
    {
      $schema: REGISTRY_ITEM_SCHEMA,
      name,
      type: "registry:theme",
      cssVars: { light: theme.light, dark: theme.dark },
    },
    null,
    2
  )
}

/**
 * 解析粘贴进来的主题。三种形状都吃：
 *   1. 完整的 registry item（`{ cssVars: { light, dark } }`）
 *   2. 裸的 `{ light, dark }`
 *   3. 单层 `{ primary: "...", ... }` —— 当作同时应用于明暗两套
 * 一个合法 token 都没有时返回 null（让调用方报错，而不是静默清空用户现有主题）。
 */
export function parseThemeRegistryItem(raw: string): CustomTheme | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const record = parsed as Record<string, unknown>

  const cssVars =
    record.cssVars && typeof record.cssVars === "object"
      ? (record.cssVars as Record<string, unknown>)
      : record

  let theme: CustomTheme
  if ("light" in cssVars || "dark" in cssVars) {
    theme = sanitizeCustomTheme(cssVars)
  } else {
    const flat = sanitizeOverrides(cssVars)
    theme = { light: { ...flat }, dark: { ...flat } }
  }

  return isEmptyCustomTheme(theme) ? null : theme
}

// ─── 自由 CSS 的净化与校验 ───

/** localStorage 配额约 5 MB，且 storage 事件会把全量文本广播到每个窗口。 */
export const MAX_CUSTOM_CSS_BYTES = 64 * 1024

export type CustomCssIssue =
  | "too-large"
  | "import-not-allowed"
  | "unparsable"
  | "no-rules"

export type CustomCssCheck = {
  /** 剥离 `@import` 后的文本；校验未通过时为 null。 */
  css: string | null
  /** 被剥掉的 `@import` 条数（用于提示用户"这几行被移除了"）。 */
  removedImports: number
  /** CSSOM 解析出的规则数；无法解析时为 -1。 */
  ruleCount: number
  /** 含远程 `url()` —— 不阻断，仅用于提示可能发起外部请求。 */
  hasRemoteUrl: boolean
  issue: CustomCssIssue | null
}

/**
 * `@import` 只能出现在样式表顶部，形态是 `@import <url|string> <media?>;`。
 * 这里做文本剥离；转义写法（`@\69mport`）逃得过正则，但逃不过下面的 CSSOM 复核。
 */
const IMPORT_RE = /@import\b[^;]*;/gi

const REMOTE_URL_RE = /url\(\s*['"]?(?:https?:)?\/\//i

export function byteLengthOf(text: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(text).length
  }
  // 兜底：UTF-16 长度（仅测试环境可能走到，宁可高估）
  return text.length * 2
}

/**
 * 用一张「永不生效」的 `<style media="not all">` 拿到浏览器自己的解析结果。
 *
 * 两个刻意的选择：
 * - 不用构造式 `new CSSStyleSheet()`：它的 `replaceSync` 会静默丢弃 `@import`，
 *   反而让「是否真的还剩 import」无从判断，而那正是这里要查的东西。
 * - `media="not all"` 不只是「不生效」：媒体查询不匹配的样式表里的 `@import`
 *   不会被取回，所以即便用户塞了 `@\69mport url(https://…)` 这种转义写法，
 *   校验这一步本身也不会替他发出那个远程请求（随后会被判定为拒绝）。
 */
function inspectWithCssom(
  css: string
): { rules: number; imports: number } | null {
  if (typeof document === "undefined") return null
  let el: HTMLStyleElement | null = null
  try {
    el = document.createElement("style")
    el.media = "not all"
    el.textContent = css
    document.head.appendChild(el)
    const sheet = el.sheet
    if (!sheet) return null
    const rules = sheet.cssRules
    let imports = 0
    for (let i = 0; i < rules.length; i += 1) {
      const rule = rules[i]
      // 认浏览器自己的序列化结果，而不是 instanceof（跨 realm 会失效）或已废弃的
      // `rule.type`：CSSImportRule 的 cssText 一定以 `@import` 开头，转义写法在这里
      // 已经被规范化还原。
      if (/^\s*@import\b/i.test(rule.cssText ?? "")) imports += 1
    }
    return { rules: rules.length, imports }
  } catch {
    return null
  } finally {
    el?.remove()
  }
}

/**
 * 净化 + 校验用户 CSS。返回的 `css` 才是应当持久化并注入的文本 —— 之后无论是
 * 预水合 inline 脚本还是 Provider，都可以原样使用，不必再跑一遍校验。
 */
export function sanitizeCustomCss(input: string): CustomCssCheck {
  const source = input ?? ""
  if (byteLengthOf(source) > MAX_CUSTOM_CSS_BYTES) {
    return {
      css: null,
      removedImports: 0,
      ruleCount: -1,
      hasRemoteUrl: false,
      issue: "too-large",
    }
  }

  const removedImports = source.match(IMPORT_RE)?.length ?? 0
  const stripped = source.replace(IMPORT_RE, "")
  const hasRemoteUrl = REMOTE_URL_RE.test(stripped)

  if (!stripped.trim()) {
    return {
      css: "",
      removedImports,
      ruleCount: 0,
      hasRemoteUrl: false,
      issue: null,
    }
  }

  const inspected = inspectWithCssom(stripped)
  if (!inspected) {
    // 拿不到 CSSOM（极旧引擎 / 非浏览器环境）时保持 fail-closed 的立场只对
    // import 生效：文本剥离已经跑过，此处放行但把 ruleCount 标为未知。
    return {
      css: stripped,
      removedImports,
      ruleCount: -1,
      hasRemoteUrl,
      issue: null,
    }
  }

  if (inspected.imports > 0) {
    // 文本剥离之后 CSSOM 还认得出 import —— 只可能是转义写法。整段拒绝。
    return {
      css: null,
      removedImports,
      ruleCount: inspected.rules,
      hasRemoteUrl,
      issue: "import-not-allowed",
    }
  }

  if (inspected.rules === 0) {
    // 语法错误会被浏览器静默丢规则；一条都没解析出来时告诉用户，但不阻断保存
    // （注入一段解析不出规则的 CSS 本身是无害的 no-op）。
    return {
      css: stripped,
      removedImports,
      ruleCount: 0,
      hasRemoteUrl,
      issue: "no-rules",
    }
  }

  return {
    css: stripped,
    removedImports,
    ruleCount: inspected.rules,
    hasRemoteUrl,
    issue: null,
  }
}

// ─── DOM 应用 ───

/** 注入用户 CSS 的 `<style>` 元素 id。始终位于 `<head>` 末尾。 */
export const CUSTOM_CSS_ELEMENT_ID = "codeg-custom-css"

/** 安全外观逃生参数：`?safeStyle=1` 时跳过一切自定义样式。 */
export const SAFE_STYLE_QUERY_PARAM = "safeStyle"

export function isSafeStyleRequested(): boolean {
  if (typeof window === "undefined") return false
  try {
    return (
      new URLSearchParams(window.location.search).get(
        SAFE_STYLE_QUERY_PARAM
      ) === "1"
    )
  } catch {
    return false
  }
}

/**
 * 把一组覆盖写到 `<html>` 的行内样式上，并把不在本组里的 token 移除。
 * 行内样式优先级天然高于 `[data-theme="x"]` 规则，所以「基底预设 + 覆盖」不需要
 * 任何新的选择器；移除即自动回落到基底预设的取值。
 */
export function applyTokenOverrides(
  root: HTMLElement,
  overrides: TokenOverrides
): void {
  for (const token of CUSTOM_THEME_TOKENS) {
    const value = overrides[token]
    if (value) {
      root.style.setProperty(`--${token}`, value)
    } else {
      root.style.removeProperty(`--${token}`)
    }
  }
}

/** 写入/更新/清空注入的 `<style>`。空串等价于移除内容但保留元素。 */
export function applyCustomCss(css: string): void {
  if (typeof document === "undefined") return
  let el = document.getElementById(
    CUSTOM_CSS_ELEMENT_ID
  ) as HTMLStyleElement | null
  if (!el) {
    if (!css) return
    el = document.createElement("style")
    el.id = CUSTOM_CSS_ELEMENT_ID
    document.head.appendChild(el)
  }
  if (el.textContent !== css) el.textContent = css
  // 保持在 <head> 末尾：dev 模式下 Turbopack 会在运行时追加样式表，可能排到
  // 我们后面。用户 CSS 未分层（unlayered），本就压过 Tailwind 的全部分层产物；
  // 这一步只是确保与 globals.css 里同为未分层的规则比较时靠文档顺序取胜。
  if (
    css &&
    el.parentNode === document.head &&
    document.head.lastChild !== el
  ) {
    document.head.appendChild(el)
  }
}

// ─── 颜色工具（供色板与 Monaco 使用） ───

let cachedCtx: CanvasRenderingContext2D | null | undefined

function getColorContext(): CanvasRenderingContext2D | null {
  if (cachedCtx !== undefined) return cachedCtx
  try {
    // 归一到 null：jsdom 的未实现桩返回 undefined，而 undefined 正是「尚未求值」
    // 的哨兵值，不归一的话缓存永远不命中。
    // willReadFrequently：下方 readPixelHex 要反复 getImageData 读回 1px，加这个提示
    // 让浏览器把画布留在 CPU 侧，省掉每次读回的 GPU 同步（也消掉 Chrome 的相关告警）。
    cachedCtx =
      document
        .createElement("canvas")
        .getContext("2d", { willReadFrequently: true }) ?? null
  } catch {
    cachedCtx = null
  }
  return cachedCtx
}

/**
 * 把一个**已确认合法**的 CSS 颜色画进 1px 画布再读回像素，转成 `#rrggbb`。
 *
 * 用于 `fillStyle` 回读保持原语法、拿不到十六进制的场合：浏览器对现代色彩语法
 * （本仓库 token 用的 `oklch()`、`color-mix()` 出来的 `color(srgb …)`）只做规范化，
 * 不会降级成 `#rrggbb`，只有走一遍光栅化才能取到 sRGB 值。
 *
 * 半透明一律判失败：`getImageData` 对半透明像素给的是去预乘后的近似值、会失真，
 * 而调用方（色板 / Monaco / 终端主题）要的都是不透明底色。
 */
function readPixelHex(
  ctx: CanvasRenderingContext2D,
  value: string
): string | null {
  // copy：直接覆盖上一次留下的像素，结果不受画布历史内容影响。画布是本模块私有的，
  // 但仍在 finally 里还原合成模式，免得中途抛错把 "copy" 留给后续调用方。
  const prevOp = ctx.globalCompositeOperation
  try {
    ctx.globalCompositeOperation = "copy"
    ctx.fillStyle = value
    ctx.fillRect(0, 0, 1, 1)
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
    if (a !== 255) return null
    return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`
  } catch {
    // getImageData 在画布被跨源污染时会抛（这里的画布不会，但保持与本文件其余
    // canvas 调用一致的兜底），读不到就让调用方回落到自己的预设值。
    return null
  } finally {
    ctx.globalCompositeOperation = prevOp
  }
}

/**
 * 把任意 CSS 颜色（`oklch()` / `color(srgb …)` / `hsl()` / 具名色 / hex）转成 `#rrggbb`。
 *
 * 用 canvas 的 `fillStyle` 做合法性判定：赋一个非法值时 `fillStyle` 保持不变，所以用
 * 两个不同的哨兵各试一次，结果不一致即判定为非法 —— 否则黑色输入会被误判成
 * 「解析失败」。合法但回读不是十六进制的（现代色彩语法会保持原样）再走一次
 * `readPixelHex` 光栅化取色。半透明与无法转换时返回 null，调用方回落到预设的硬编码值。
 */
export function toHexColor(value: string): string | null {
  const v = value?.trim()
  if (!v) return null
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase()
  if (/^#[0-9a-f]{3}$/i.test(v)) {
    return `#${v
      .slice(1)
      .split("")
      .map((c) => c + c)
      .join("")}`.toLowerCase()
  }
  const ctx = getColorContext()
  if (!ctx) return null
  try {
    ctx.fillStyle = "#000000"
    ctx.fillStyle = v
    const first = ctx.fillStyle
    ctx.fillStyle = "#ffffff"
    ctx.fillStyle = v
    const second = ctx.fillStyle
    if (typeof first !== "string" || first !== second) return null
    if (/^#[0-9a-f]{6}$/i.test(first)) return first.toLowerCase()
    return readPixelHex(ctx, first)
  } catch {
    return null
  }
}

/** 读取某个 token 当前的生效值（含基底预设的取值）。 */
export function readEffectiveTokenValue(token: string): string {
  if (typeof window === "undefined" || typeof document === "undefined")
    return ""
  try {
    return window
      .getComputedStyle(document.documentElement)
      .getPropertyValue(`--${token}`)
      .trim()
  } catch {
    return ""
  }
}
