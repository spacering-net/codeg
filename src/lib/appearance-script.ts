// src/lib/appearance-script.ts

import {
  CUSTOM_CSS_ELEMENT_ID,
  CUSTOM_THEME_TOKENS,
  SAFE_STYLE_QUERY_PARAM,
  TOKEN_VALUE_PATTERN_SOURCE,
} from "./custom-style"

/**
 * Storage keys for appearance preferences.
 * 与 Provider 共享，确保 inline 脚本和 React 层读写同一份数据。
 */
export const STORAGE_KEY_THEME_COLOR = "codeg-theme-color"
export const STORAGE_KEY_ZOOM_LEVEL = "codeg-zoom-level"

// 新会话欢迎页「模式选择区域」（代码开发 / 日常办公 快捷卡片）是否显示。
// 缺省即回退为开启（保持历史行为）；仅在欢迎态客户端渲染，无需预水合。
export const STORAGE_KEY_WELCOME_QUICK_ACTIONS = "codeg-welcome-quick-actions"

// 字体偏好（界面 / 编辑器 / 终端）。
// 只有界面字体需要 *_STACK（已解析的 CSS font-family 栈），供 inline 脚本零依赖地
// 预水合写入 --font-sans；编辑器/终端字体只走各自的 Monaco/xterm 选项，水合后才挂载，
// 无需预水合，也不写任何全局 CSS 变量。*_FONT 存 id、*_CUSTOM 存自定义族名供回显。
export const STORAGE_KEY_UI_FONT = "codeg-ui-font"
export const STORAGE_KEY_UI_FONT_CUSTOM = "codeg-ui-font-custom"
export const STORAGE_KEY_UI_FONT_STACK = "codeg-ui-font-stack"
export const STORAGE_KEY_EDITOR_FONT = "codeg-editor-font"
export const STORAGE_KEY_EDITOR_FONT_CUSTOM = "codeg-editor-font-custom"
export const STORAGE_KEY_EDITOR_FONT_SIZE = "codeg-editor-font-size"
export const STORAGE_KEY_EDITOR_LIGATURES = "codeg-editor-ligatures"
export const STORAGE_KEY_EDITOR_WORD_WRAP = "codeg-editor-word-wrap"
export const STORAGE_KEY_TERMINAL_FONT = "codeg-terminal-font"
export const STORAGE_KEY_TERMINAL_FONT_CUSTOM = "codeg-terminal-font-custom"
export const STORAGE_KEY_TERMINAL_FONT_SIZE = "codeg-terminal-font-size"
export const STORAGE_KEY_TERMINAL_LIGATURES = "codeg-terminal-ligatures"

// Workspace 背景图片。图片本身存磁盘（~/.codeg/backgrounds/），localStorage 只存
// 展示配置。仅 enabled 与 panel-opacity 需要预水合（它们作用于首帧就存在的结构性
// 表面）；mask/blur/fill 水合后才有意义（图片异步到达），不进 inline 脚本。
export const STORAGE_KEY_WORKSPACE_BG_ENABLED = "codeg-workspace-bg-enabled"
export const STORAGE_KEY_WORKSPACE_BG_MASK = "codeg-workspace-bg-mask"
export const STORAGE_KEY_WORKSPACE_BG_BLUR = "codeg-workspace-bg-blur"
export const STORAGE_KEY_WORKSPACE_BG_FILL = "codeg-workspace-bg-fill"
export const STORAGE_KEY_WORKSPACE_BG_PANEL_OPACITY =
  "codeg-workspace-bg-panel-opacity"
// 图片存磁盘、写盘无跨窗口信号（外观设置是独立窗口）。用这个版本戳广播失效：
// 写/换/删图后 bump，让 workspace 窗口经 storage 事件重新读盘。不需预水合。
export const STORAGE_KEY_WORKSPACE_BG_IMAGE_VERSION =
  "codeg-workspace-bg-image-version"
// 壁纸市场：当前背景的来源页（https://wallhaven.cc/w/<id>），仅用于市场卡片的
// 「使用中」标记。本地选图 / 移除背景时清除；不参与渲染，丢了也只是标记失灵。
//
// 它和图片本身是两份状态，只在同一次操作里前后脚写，并非事务。同一个界面里
// 换图是单飞的（市场对话框全网格禁用，本地选图有 busy 闸），但两个窗口/标签页
// 同时换图时，最后落盘的图和最后写的标记可能来自不同的那一次 —— 图仍然是完整
// 的一张（后端按写者独立暂存 + 原子 rename），错的只是「使用中」指向谁。要根治
// 得把来源页跟图一起存到磁盘上，那是后端的形状改动，不在本次范围内。
export const STORAGE_KEY_WORKSPACE_BG_SOURCE_URL =
  "codeg-workspace-bg-source-url"

// 自定义样式（外观设置页）。全部需要预水合 —— 少一帧就会看到「基底预设 → 用户配色」
// 的跳变，比没有这个功能更糟。
//
// - CUSTOM_THEME：`{ light: {...}, dark: {...} }`，键名不带 `--`（= shadcn
//   registry:theme 的 cssVars 形状，可与 shadcn 生态直接互拷）。
// - CUSTOM_THEME_ENABLED：缺省即开启（空覆盖本就无副作用）。
// - CUSTOM_CSS：已剥离 `@import` 并经 CSSOM 复核的文本，inline 脚本原样注入。
// - CUSTOM_CSS_ENABLED：缺省关闭 —— 自由 CSS 是能把界面改坏的高级功能，必须显式开启。
// - CUSTOM_STYLE_SUSPENDED：逃生舱的持久开关（快捷键触发），置 1 时上面全部不生效。
export const STORAGE_KEY_CUSTOM_THEME = "codeg-custom-theme"
export const STORAGE_KEY_CUSTOM_THEME_ENABLED = "codeg-custom-theme-enabled"
export const STORAGE_KEY_CUSTOM_CSS = "codeg-custom-css"
export const STORAGE_KEY_CUSTOM_CSS_ENABLED = "codeg-custom-css-enabled"
export const STORAGE_KEY_CUSTOM_STYLE_SUSPENDED = "codeg-custom-style-suspended"

/**
 * 同步执行的 inline 脚本，由 layout.tsx 通过 dangerouslySetInnerHTML 注入。
 *
 * 必须在第一帧渲染前完成 <html> 的 data-theme 属性和 font-size 内联样式写入，
 * 否则会出现 FOUC（先看到默认主题/字号，然后切换到用户偏好的闪烁）。
 *
 * 实现要点：
 * 1. 生成出来的是纯字符串，运行时不依赖任何模块导入或外部符号 —— 避免 Next.js
 *    把它当模块编译。构建期的 `${...}` 插值（storage key、token 列表、校验正则）
 *    只是把常量嵌进字符串，不引入运行时依赖，也免掉了两处手抄同一份清单。
 * 2. 白名单校验 —— localStorage 里的值若被篡改或残留旧版本，回退到默认
 * 3. try/catch 包裹 —— 隐私模式 / 嵌入 WebView 禁用 storage 时不抛错；自定义样式
 *    两段各自再包一层，任一段损坏都不影响其余外观偏好
 * 4. 数字常量与 theme-presets.ts 保持一致 —— 任何修改必须两边同步
 */
const SCRIPT = `
(function() {
  try {
    var VALID_COLORS = ["neutral","zinc","slate","stone","gray","red","rose","orange","green","blue","yellow","violet"];
    var VALID_ZOOMS = [80, 90, 100, 110, 125, 150, 175, 200, 250, 300];

    var storedColor = localStorage.getItem("${STORAGE_KEY_THEME_COLOR}");
    var color = VALID_COLORS.indexOf(storedColor) >= 0 ? storedColor : "neutral";
    document.documentElement.setAttribute("data-theme", color);

    var storedZoom = parseInt(localStorage.getItem("${STORAGE_KEY_ZOOM_LEVEL}") || "", 10);
    var zoom = VALID_ZOOMS.indexOf(storedZoom) >= 0 ? storedZoom : 100;
    document.documentElement.style.fontSize = (16 * zoom / 100) + "px";

    // 界面字体：预水合写入 --font-sans（普通组件与会话消息区都跟随它）。
    // stack 只是「显式选择」的缓存，不是偏好本身：仅当存在显式 id（codeg-ui-font）
    // 时才应用它。无显式选择的用户（含从旧默认升级、Provider 仅缓存过 stack 的用户）
    // 跳过，落到 :root 的 --font-sans 兜底（= 当前默认界面字体 Inter 栈），避免升级首屏闪字。
    // 无需在脚本里复制字体目录；空/超长/含越界字符同样跳过走默认。
    var uiFontId = localStorage.getItem("${STORAGE_KEY_UI_FONT}");
    var uiFontStack = localStorage.getItem("${STORAGE_KEY_UI_FONT_STACK}");
    if (uiFontId && uiFontStack && uiFontStack.length < 512 && !/[;{}<>]/.test(uiFontStack)) {
      document.documentElement.style.setProperty("--font-sans", uiFontStack);
    }

    // Workspace 背景：预水合仅处理首帧就存在的结构性表面。启用时给 <html> 打
    // data-workspace-bg 属性并预置 --ws-surface-alpha，避免面板 opaque→translucent
    // 跳变。图片本身异步从磁盘读，不在此处理。
    var wsbgEnabled = localStorage.getItem("${STORAGE_KEY_WORKSPACE_BG_ENABLED}");
    if (wsbgEnabled === "1") {
      document.documentElement.setAttribute("data-workspace-bg", "on");
      var wsbgAlpha = parseFloat(localStorage.getItem("${STORAGE_KEY_WORKSPACE_BG_PANEL_OPACITY}") || "");
      if (!isNaN(wsbgAlpha) && wsbgAlpha >= 0.3 && wsbgAlpha <= 1) {
        document.documentElement.style.setProperty("--ws-surface-alpha", String(wsbgAlpha));
      }
    }

    // 在 next-themes 水合之前同步检测暗色模式，防止白色闪屏。
    // next-themes 使用 localStorage key "theme"，attribute="class"。
    var storedMode = localStorage.getItem("theme");
    var isDark = storedMode === "dark" ||
        (storedMode !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    if (isDark) {
      document.documentElement.classList.add("dark");
      document.documentElement.style.colorScheme = "dark";
      // 直接设置背景色，比等待 CSS 类匹配更快，覆盖"系统浅色 + 应用深色"场景
      document.documentElement.style.backgroundColor = "#09090b";
    } else {
      document.documentElement.style.colorScheme = "light";
      document.documentElement.style.backgroundColor = "";
    }

    // ── 自定义样式 ──────────────────────────────────────────────────────
    // 必须排在 isDark 之后：token 覆盖分明暗两套，挑哪一套取决于它。
    //
    // 逃生舱其一："?safeStyle=1" 跳过全部自定义样式。用户把界面改坏时，在 web 模式
    // 直接改地址栏即可自救（桌面模式走快捷键那条，见 AppearanceProvider）。
    var safeStyle = false;
    try {
      safeStyle = new URLSearchParams(location.search).get("${SAFE_STYLE_QUERY_PARAM}") === "1";
    } catch (e) {}
    var styleOff = safeStyle ||
      localStorage.getItem("${STORAGE_KEY_CUSTOM_STYLE_SUSPENDED}") === "1";

    // token 覆盖：写 <html> 行内样式，优先级天然高于 [data-theme="x"] 规则，
    // 所以「基底预设 + 覆盖」不需要任何新选择器。缺省开启（空覆盖无副作用）。
    if (!styleOff && localStorage.getItem("${STORAGE_KEY_CUSTOM_THEME_ENABLED}") !== "0") {
      try {
        var rawTheme = localStorage.getItem("${STORAGE_KEY_CUSTOM_THEME}");
        if (rawTheme) {
          var themeCfg = JSON.parse(rawTheme) || {};
          var overrides = (isDark ? themeCfg.dark : themeCfg.light) || {};
          var TOKENS = ${JSON.stringify(CUSTOM_THEME_TOKENS)};
          var VALUE_RE = new RegExp(${JSON.stringify(TOKEN_VALUE_PATTERN_SOURCE)});
          for (var ti = 0; ti < TOKENS.length; ti++) {
            var tv = overrides[TOKENS[ti]];
            if (typeof tv === "string" && VALUE_RE.test(tv)) {
              document.documentElement.style.setProperty("--" + TOKENS[ti], tv);
            }
          }
        }
      } catch (e) {
        // 主题 JSON 损坏时静默走基底预设
      }
    }

    // 自由 CSS：存的就是已剥离 @import 并经 CSSOM 复核的文本，这里原样注入。
    // 追加到 <head> 末尾 —— 未分层（unlayered）的作者 CSS 在级联中本就胜过
    // Tailwind 的全部分层产物，末尾位置只是为了与 globals.css 里同为未分层的
    // 规则比较时靠文档顺序取胜。缺省关闭，必须显式开启。
    if (!styleOff && localStorage.getItem("${STORAGE_KEY_CUSTOM_CSS_ENABLED}") === "1") {
      try {
        var userCss = localStorage.getItem("${STORAGE_KEY_CUSTOM_CSS}");
        if (userCss) {
          var styleEl = document.createElement("style");
          styleEl.id = "${CUSTOM_CSS_ELEMENT_ID}";
          styleEl.textContent = userCss;
          document.head.appendChild(styleEl);
        }
      } catch (e) {
        // 注入失败不影响其余外观偏好
      }
    }
  } catch (e) {
    // localStorage 不可用时静默走默认
  }
})();
`

export const APPEARANCE_INIT_SCRIPT = SCRIPT
