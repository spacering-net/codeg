import { describe, expect, it } from "vitest"

import {
  applyTermMods,
  kbdLiftPx,
  TERM_KEYBAR_SEQ,
  termKeySeq,
  type TermMods,
} from "./keybar"

const OFF: TermMods = { ctrl: false, alt: false }

describe("termKeySeq 基础序列", () => {
  it("无修饰符时返回原样转义序列", () => {
    expect(termKeySeq("esc", OFF)).toBe("\x1b")
    expect(termKeySeq("tab", OFF)).toBe("\t")
    expect(termKeySeq("slash", OFF)).toBe("/")
    expect(termKeySeq("dash", OFF)).toBe("-")
    expect(termKeySeq("home", OFF)).toBe("\x1b[H")
    expect(termKeySeq("end", OFF)).toBe("\x1b[F")
    expect(termKeySeq("pgup", OFF)).toBe("\x1b[5~")
    expect(termKeySeq("pgdn", OFF)).toBe("\x1b[6~")
    expect(termKeySeq("up", OFF)).toBe("\x1b[A")
    expect(termKeySeq("down", OFF)).toBe("\x1b[B")
    expect(termKeySeq("left", OFF)).toBe("\x1b[D")
    expect(termKeySeq("right", OFF)).toBe("\x1b[C")
  })

  it("序列表完整覆盖 12 个键", () => {
    expect(Object.keys(TERM_KEYBAR_SEQ).sort()).toEqual(
      [
        "dash",
        "down",
        "end",
        "esc",
        "home",
        "left",
        "pgdn",
        "pgup",
        "right",
        "slash",
        "tab",
        "up",
      ].sort()
    )
  })
})

describe("termKeySeq 应用光标键模式（DECCKM）", () => {
  it("DECCKM 开启：无修饰符的方向键/Home/End 走 SS3（ESC O X）", () => {
    expect(termKeySeq("up", OFF, true)).toBe("\x1bOA")
    expect(termKeySeq("down", OFF, true)).toBe("\x1bOB")
    expect(termKeySeq("right", OFF, true)).toBe("\x1bOC")
    expect(termKeySeq("left", OFF, true)).toBe("\x1bOD")
    expect(termKeySeq("home", OFF, true)).toBe("\x1bOH")
    expect(termKeySeq("end", OFF, true)).toBe("\x1bOF")
  })

  it("DECCKM 不影响非光标键", () => {
    expect(termKeySeq("pgup", OFF, true)).toBe("\x1b[5~")
    expect(termKeySeq("pgdn", OFF, true)).toBe("\x1b[6~")
    expect(termKeySeq("esc", OFF, true)).toBe("\x1b")
    expect(termKeySeq("tab", OFF, true)).toBe("\t")
  })

  it("带修饰符时 DECCKM 让位给 CSI 1;<m>X", () => {
    expect(termKeySeq("up", { ctrl: true, alt: false }, true)).toBe("\x1b[1;5A")
    expect(termKeySeq("home", { ctrl: false, alt: true }, true)).toBe(
      "\x1b[1;3H"
    )
  })

  it("默认参数保持 DECCKM 关闭的历史行为", () => {
    expect(termKeySeq("up", OFF)).toBe(termKeySeq("up", OFF, false))
  })
})

describe("termKeySeq 闩锁修饰", () => {
  it("Ctrl+方向键 = ESC[1;5X", () => {
    expect(termKeySeq("up", { ctrl: true, alt: false })).toBe("\x1b[1;5A")
    expect(termKeySeq("down", { ctrl: true, alt: false })).toBe("\x1b[1;5B")
    expect(termKeySeq("right", { ctrl: true, alt: false })).toBe("\x1b[1;5C")
    expect(termKeySeq("left", { ctrl: true, alt: false })).toBe("\x1b[1;5D")
  })

  it("Alt+方向键 = ESC[1;3X；Ctrl+Alt = ESC[1;7X", () => {
    expect(termKeySeq("left", { ctrl: false, alt: true })).toBe("\x1b[1;3D")
    expect(termKeySeq("up", { ctrl: true, alt: true })).toBe("\x1b[1;7A")
  })

  it("Home/End 带修饰符走 CSI 1;<m>H/F", () => {
    expect(termKeySeq("home", { ctrl: true, alt: false })).toBe("\x1b[1;5H")
    expect(termKeySeq("end", { ctrl: false, alt: true })).toBe("\x1b[1;3F")
  })

  it("PgUp/PgDn 带修饰符走 ~ 族", () => {
    expect(termKeySeq("pgup", { ctrl: true, alt: false })).toBe("\x1b[5;5~")
    expect(termKeySeq("pgdn", { ctrl: false, alt: true })).toBe("\x1b[6;3~")
    expect(termKeySeq("pgdn", { ctrl: true, alt: true })).toBe("\x1b[6;7~")
  })

  it("esc/tab/slash/dash 无通用 ctrl 形态：ctrl 原样、alt 走 meta 前缀", () => {
    expect(termKeySeq("esc", { ctrl: true, alt: false })).toBe("\x1b")
    expect(termKeySeq("slash", { ctrl: true, alt: false })).toBe("/")
    expect(termKeySeq("dash", { ctrl: true, alt: false })).toBe("-")
    expect(termKeySeq("tab", { ctrl: false, alt: true })).toBe("\x1b\t")
    expect(termKeySeq("esc", { ctrl: false, alt: true })).toBe("\x1b\x1b")
  })
})

describe("applyTermMods 软键盘闩锁包装", () => {
  it("未 armed 时原样透传、不消费", () => {
    const r = applyTermMods("abc", OFF)
    expect(r.out).toBe("abc")
    expect(r.consumed).toBe(false)
  })

  it("CTRL+小写字母 → 控制码（a→0x01 … z→0x1a）", () => {
    expect(applyTermMods("c", { ctrl: true, alt: false }).out).toBe("\x03")
    expect(applyTermMods("d", { ctrl: true, alt: false }).out).toBe("\x04")
    expect(applyTermMods("l", { ctrl: true, alt: false }).out).toBe("\x0c")
    expect(applyTermMods("z", { ctrl: true, alt: false }).out).toBe("\x1a")
  })

  it("CTRL+大写字母同样按字母处理", () => {
    expect(applyTermMods("C", { ctrl: true, alt: false }).out).toBe("\x03")
  })

  it("CTRL 只包装首字符，其余保持原样（粘贴串）", () => {
    expect(applyTermMods("abc", { ctrl: true, alt: false }).out).toBe("\x01bc")
  })

  it("CTRL+@A-Z[\\]^_ → 0x00–0x1f（Ctrl+[=ESC、Ctrl+\\=SIGQUIT、Ctrl+_=undo）", () => {
    const ctrl = { ctrl: true, alt: false }
    expect(applyTermMods("[", ctrl).out).toBe("\x1b")
    expect(applyTermMods("\\", ctrl).out).toBe("\x1c")
    expect(applyTermMods("]", ctrl).out).toBe("\x1d")
    expect(applyTermMods("_", ctrl).out).toBe("\x1f")
    expect(applyTermMods("@", ctrl).out).toBe("\x00")
  })

  it("CTRL+空格 → NUL；CTRL+? → DEL", () => {
    expect(applyTermMods(" ", { ctrl: true, alt: false }).out).toBe("\x00")
    expect(applyTermMods("?", { ctrl: true, alt: false }).out).toBe("\x7f")
  })

  it("CTRL+无控制码形态的字符原样透传（仍消费闩锁）", () => {
    const r = applyTermMods("1", { ctrl: true, alt: false })
    expect(r.out).toBe("1")
    expect(r.consumed).toBe(true)
  })

  it("CTRL+ALT 叠加 = meta + 控制码", () => {
    expect(applyTermMods("a", { ctrl: true, alt: true }).out).toBe("\x1b\x01")
  })

  it("ALT+输入 → 前缀 ESC", () => {
    const r = applyTermMods("b", { ctrl: false, alt: true })
    expect(r.out).toBe("\x1bb")
    expect(r.consumed).toBe(true)
  })

  it("空输入不消费闩锁", () => {
    const r = applyTermMods("", { ctrl: true, alt: false })
    expect(r.out).toBe("")
    expect(r.consumed).toBe(false)
  })
})

describe("kbdLiftPx 软键盘遮挡估算", () => {
  it("键盘弹出：overlap = innerHeight - vv.height - offsetTop", () => {
    // 844 屏，键盘 300px，无页面平移
    expect(kbdLiftPx(844, 544, 0)).toBe(300)
    // iOS 把页面上推（offsetTop>0）：遮挡减少相应的量
    expect(kbdLiftPx(844, 544, 100)).toBe(200)
  })

  it("键盘收起：overlap ≈ 0 → 返回 0", () => {
    expect(kbdLiftPx(844, 844, 0)).toBe(0)
    expect(kbdLiftPx(844, 850, 0)).toBe(0) // 反向异常也夹到 0
  })

  it("小于 80px 的抖动（地址栏收起等）不算键盘，返回 0", () => {
    expect(kbdLiftPx(844, 814, 0)).toBe(0)
    expect(kbdLiftPx(844, 764, 0)).toBe(80) // 恰好 80px 达标
  })

  it("小数四舍五入", () => {
    expect(kbdLiftPx(844.4, 514.2, 0.2)).toBe(330)
  })
})
