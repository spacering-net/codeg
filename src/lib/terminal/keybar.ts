/**
 * 终端虚拟键栏（移动端）纯函数：键栏按键 → PTY 字节序列 + CTRL/ALT 闩锁包装。
 *
 * 序列规则对齐 xterm.js 自己的键盘编码器（`evaluateKeyboardEvent`），因为渲染
 * 端就是 xterm.js，硬件键盘与虚拟键栏必须发出同一串字节：
 *   · 方向键/Home/End 带修饰符 → ESC[1;<m>X（Ctrl+↑=ESC[1;5A）
 *   · 方向键/Home/End 无修饰符 → 受 DECCKM（应用光标键模式）影响：
 *     开启时 ESC O X，关闭时 ESC [ X。vim/htop 这类 ncurses 程序会
 *     `smkx` 打开 DECCKM，只按 terminfo 的 ESC O X 匹配；固定发 ESC [ X
 *     会被解析成「ESC + [ + A」三个键。
 *   · PgUp/PgDn 带修饰符      → ESC[5;<m>~ / ESC[6;<m>~（不受 DECCKM 影响）
 *   · 修饰参数 m = 1 + (alt?2:0) + (ctrl?4:0)
 *
 * 闩锁语义：CTRL/ALT 是一次性粘滞键——点一下 armed（按钮高亮，互斥），下一个
 * 输入（软键盘 onData 或键栏按键）被包装后自动弹起：
 *   · CTRL + 软键盘字母 → 控制码（a→\x01 … z→\x1a，覆盖 Ctrl+C/D/L/R…）
 *   · ALT  + 软键盘输入 → 前缀 ESC（meta）
 */

export type TermKeyBarKey =
  | "esc"
  | "tab"
  | "slash"
  | "dash"
  | "home"
  | "end"
  | "pgup"
  | "pgdn"
  | "up"
  | "down"
  | "left"
  | "right"

/** CTRL/ALT 闩锁状态（键栏按钮高亮与编码共用）。 */
export interface TermMods {
  ctrl: boolean
  alt: boolean
}

/** 无修饰符时的基础序列。 */
export const TERM_KEYBAR_SEQ: Record<TermKeyBarKey, string> = {
  esc: "\x1b",
  tab: "\t",
  slash: "/",
  dash: "-",
  home: "\x1b[H",
  end: "\x1b[F",
  pgup: "\x1b[5~",
  pgdn: "\x1b[6~",
  up: "\x1b[A",
  down: "\x1b[B",
  left: "\x1b[D",
  right: "\x1b[C",
}

function modParam(mods: TermMods): number {
  return 1 + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0)
}

/** 光标键族（方向键 + Home/End）的 CSI/SS3 终结符。 */
const CURSOR_KEY_FINALS: Partial<Record<TermKeyBarKey, string>> = {
  up: "A",
  down: "B",
  right: "C",
  left: "D",
  home: "H",
  end: "F",
}

/**
 * 键栏按键编码（不消费闩锁——由调用方在发送后复位）。
 *
 * `appCursorKeys` 传当前终端的 DECCKM 状态（xterm.js:
 * `term.modes.applicationCursorKeysMode`）——无修饰符的光标键要跟着它在
 * ESC[X / ESC O X 之间切换，否则 vim/htop 等 ncurses 程序收不到方向键。
 */
export function termKeySeq(
  key: TermKeyBarKey,
  mods: TermMods,
  appCursorKeys = false
): string {
  const plain = TERM_KEYBAR_SEQ[key]
  if (!mods.ctrl && !mods.alt) {
    const final = appCursorKeys ? CURSOR_KEY_FINALS[key] : undefined
    return final ? `\x1bO${final}` : plain
  }
  // CSI 1;<m>X 族：方向键 + Home/End（带修饰符时 DECCKM 不参与）
  const final = CURSOR_KEY_FINALS[key]
  if (final) return `\x1b[1;${modParam(mods)}${final}`
  // ~ 族：PgUp/PgDn
  if (key === "pgup") return `\x1b[5;${modParam(mods)}~`
  if (key === "pgdn") return `\x1b[6;${modParam(mods)}~`
  // esc/tab/slash/dash 没有通用 ctrl 形态：alt 仍走 meta 前缀，ctrl 原样
  if (mods.alt) return `\x1b${plain}`
  return plain
}

/**
 * Ctrl+<字符> 的控制码映射，与 xterm.js 的键盘编码器一致：
 *   · a–z (0x61–0x7a) → code-0x60（Ctrl+C=\x03 …）
 *   · @A-Z[\]^_ (0x40–0x5f) → code-0x40（Ctrl+[=ESC、Ctrl+\=SIGQUIT、Ctrl+_=undo）
 *   · 空格 → NUL（set-mark）、`?` → DEL
 * 不在表内的字符（数字、CJK 等）没有控制码形态，原样返回 null。
 */
function ctrlCode(ch: string): string | null {
  const code = ch.charCodeAt(0)
  if (code >= 0x61 && code <= 0x7a) return String.fromCharCode(code - 0x60)
  if (code >= 0x40 && code <= 0x5f) return String.fromCharCode(code - 0x40)
  if (ch === " ") return "\x00"
  if (ch === "?") return "\x7f"
  return null
}

/**
 * 用闩锁包装一段软键盘输入。只处理首字符，返回要发送的字节与闩锁是否被消费。
 * `consumed=true` 时调用方应复位 mods 状态。
 */
export function applyTermMods(
  data: string,
  mods: TermMods
): { out: string; consumed: boolean } {
  if (!data || (!mods.ctrl && !mods.alt)) {
    return { out: data, consumed: false }
  }
  const { ctrl, alt } = mods
  let out = data
  if (ctrl) {
    const ctl = ctrlCode(data[0])
    if (ctl !== null) out = ctl + data.slice(1)
  }
  // ctrl 与 alt 叠加时是 meta+控制码（Ctrl+Alt+A = ESC \x01）。键栏当前把两者
  // 做成互斥闩锁，走不到这条组合，但编码不该因此写成非此即彼。
  if (alt) out = `\x1b${out}`
  return { out, consumed: true }
}

/**
 * 软键盘遮挡估算：布局视口高 - 可视视口高 - 可视视口下移量 = 底部被键盘遮住的像素。
 * overlap < minOpen（默认 80px）视为地址栏收起/缩放等抖动，返回 0。
 */
export function kbdLiftPx(
  innerHeight: number,
  vvHeight: number,
  vvOffsetTop: number,
  minOpen = 80
): number {
  const overlap = Math.max(0, Math.round(innerHeight - vvHeight - vvOffsetTop))
  return overlap >= minOpen ? overlap : 0
}
