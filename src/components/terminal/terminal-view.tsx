"use client"

import { useEffect, useRef, useState } from "react"
import { subscribe } from "@/lib/platform"
import {
  terminalSpawn,
  terminalSnapshot,
  terminalWrite,
  terminalResize,
  terminalKill,
} from "@/lib/api"
import { createWriteQueue, type WriteQueue } from "@/lib/terminal/write-queue"
import { getTerminalTheme } from "@/lib/terminal/theme"
import {
  copyTerminalSelection,
  isTerminalCopyShortcut,
} from "@/lib/terminal/shortcuts"
import {
  applyTermMods,
  kbdLiftPx,
  termKeySeq,
  type TermKeyBarKey,
  type TermMods,
} from "@/lib/terminal/keybar"
import { TermKeybar } from "@/components/terminal/term-keybar"
import {
  TerminalLinkMenu,
  terminalLinkClickOpensMenu,
  type TerminalLinkClick,
} from "@/components/terminal/terminal-link-menu"
import { getBrowserPrefs } from "@/lib/browser/browser-prefs"
import { useZoomLevel, useTerminalFont } from "@/hooks/use-appearance"
import {
  isPrimaryModifier,
  useOpenUrlTarget,
} from "@/hooks/use-open-url-target"
import { detectPlatform } from "@/hooks/use-platform"
import type { TerminalEvent } from "@/lib/types"
import type { ITerminalAddon, Terminal as XTermTerminal } from "@xterm/xterm"

function computeTerminalFontSize(base: number, zoomLevel: number): number {
  return Math.round((base * zoomLevel) / 100)
}

type DisposableAddon = ITerminalAddon & { dispose: () => void }

/** 惰性加载 @xterm/addon-ligatures（仅终端连字需要，且对系统字体可能无效）。 */
async function enableTerminalLigatures(
  term: XTermTerminal,
  ref: { current: DisposableAddon | null },
  isCurrent: () => boolean
) {
  if (ref.current) return
  try {
    const { LigaturesAddon } = await import("@xterm/addon-ligatures")
    // 动态 import resolve 后重新校验三件事，否则会有竞态：
    // 1) isCurrent()：终端仍是当前实例且连字仍需开启（覆盖「import 期间被销毁/重建」
    //    以及「import 期间用户又关掉连字」两种情况）；
    // 2) ref.current 仍为空：覆盖「并发两次 enable 都通过了 await 前检查」——
    //    校验到赋值之间无 await，先到者占位后，后到者在此返回，避免重复挂载。
    if (!isCurrent() || ref.current) return
    const addon = new LigaturesAddon() as unknown as DisposableAddon
    term.loadAddon(addon)
    ref.current = addon
  } catch {
    // 加载失败时静默降级
  }
}

function disableTerminalLigatures(ref: { current: DisposableAddon | null }) {
  try {
    ref.current?.dispose()
  } catch {
    // ignore
  }
  ref.current = null
}

interface TerminalViewProps {
  terminalId: string
  workingDir: string
  shell?: string
  initialCommand?: string
  isActive: boolean
  isVisible: boolean
  /**
   * 移动端虚拟键栏可见性。父级基于 `useIsMobile()` + 折叠开关判定；桌面端
   * 永远为 false。
   */
  keybarVisible?: boolean
  /**
   * 重新接管一个可能已经存在的 PTY，而不是「必然新建」。
   *
   * 终端面板的 tab 与它的 xterm 同生共死，所以那条路径永远是新建；而画布上的
   * 终端卡片不是——整个画布路由在切到别的页面时会真卸载，PTY 却应该继续跑
   * （`pnpm dev` 不该因为用户瞄了一眼待办看板就被杀掉）。此模式下先问后端要
   * 快照：拿到就把最近输出重放进新开的 xterm 并跳过 spawn，没拿到才新建。
   *
   * 一并改掉卸载语义：attach 模式下**永不**在卸载/取消时 kill——PTY 属于卡片，
   * 不属于这一次挂载。
   */
  attach?: boolean
  /**
   * 让字号无视应用缩放（`useZoomLevel`）。画布用自己的一套缩放，卡片内容一律
   * 以「board units」绘制，再乘一次应用缩放就会和它所在的盒子对不上。
   */
  ignoreAppZoom?: boolean
  onProcessExited?: (terminalId: string) => void
}

export function TerminalView({
  terminalId,
  workingDir,
  shell,
  initialCommand,
  isActive,
  isVisible,
  keybarVisible = false,
  attach = false,
  ignoreAppZoom = false,
  onProcessExited,
}: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const fitAddonRef = useRef<{ fit: () => void } | null>(null)
  const termRef = useRef<XTermTerminal | null>(null)
  const lastResizeRef = useRef<{ cols: number; rows: number } | null>(null)
  const isActiveRef = useRef(isActive)
  const isVisibleRef = useRef(isVisible)
  const onProcessExitedRef = useRef(onProcessExited)
  // Link clicks route through the app's link decision (built-in browser vs
  // system browser, ⌘/Ctrl inverts). xterm's default handler is a bare
  // `window.open`, which the desktop webview turns into a dead click.
  const openUrlTarget = useOpenUrlTarget()
  const openUrlTargetRef = useRef(openUrlTarget)
  // A link click held for the action menu (optional, off by default): the
  // user picks the destination instead of the per-source preference.
  const [linkClick, setLinkClick] = useState<TerminalLinkClick | null>(null)
  const { zoomLevel: appZoomLevel } = useZoomLevel()
  // 100 = 「不缩放」。画布卡片走这条：它已经在自己那套缩放里了。
  const zoomLevel = ignoreAppZoom ? 100 : appZoomLevel
  const { terminalFontStack, terminalFontSize, terminalLigatures } =
    useTerminalFont()
  const zoomLevelRef = useRef(zoomLevel)
  const terminalFontRef = useRef(terminalFontStack)
  const terminalSizeRef = useRef(terminalFontSize)
  const terminalLigaturesRef = useRef(terminalLigatures)
  const ligaturesAddonRef = useRef<DisposableAddon | null>(null)
  const [loading, setLoading] = useState(true)

  // ---- 移动端虚拟键栏（CTRL/ALT 闩锁 + 软键盘跟随）----
  // modsRef 是编码真值（xterm.onData 闭包里读它不会过期）；modsUi 只驱动按钮
  // 高亮。两者经 setMods() 同步，避免 setMods 引用漂移。
  const [modsUi, setModsUi] = useState<TermMods>({ ctrl: false, alt: false })
  const modsRef = useRef<TermMods>({ ctrl: false, alt: false })
  const setMods = (next: TermMods) => {
    modsRef.current = next
    setModsUi(next)
  }
  // writeQueue 在 init() 里创建，键栏按键也必须走这条队列——否则与软键盘
  // onData 抢着调 terminalWrite 会让顺序变成不可预期的乱序（FIFO 不再成立）。
  const writeQueueRef = useRef<WriteQueue | null>(null)

  const toggleMod = (m: "ctrl" | "alt") => {
    const cur = modsRef.current
    setMods(
      m === "ctrl"
        ? { ctrl: !cur.ctrl, alt: false }
        : { ctrl: false, alt: !cur.alt }
    )
    termRef.current?.focus()
  }

  const pressKey = (key: TermKeyBarKey) => {
    const cur = modsRef.current
    // DECCKM：应用光标键模式下方向键/Home/End 必须发 ESC O X，否则 vim/htop
    // 之类按 terminfo 匹配的程序会把 ESC [ A 拆成三个键。
    const appCursorKeys =
      termRef.current?.modes.applicationCursorKeysMode ?? false
    const data = termKeySeq(key, cur, appCursorKeys)
    if (cur.ctrl || cur.alt) setMods({ ctrl: false, alt: false }) // 闩锁被消费
    writeQueueRef.current?.enqueue(data)
    termRef.current?.focus()
  }

  // 键栏收敛三个条件：移动端命中 + 父级未折叠（都由 keybarVisible 带下来）+
  // 当前 tab 是活动 tab（否则隐藏 tab 上挂着的死按钮会浪费 DOM 与焦点环）。
  const showKeybar = keybarVisible && isActive && isVisible

  // 键栏一旦不可见就复位闩锁。armed 状态只由键栏按钮高亮呈现，收起键栏（切走
  // tab、收起面板、折叠键栏）后闩锁仍然生效的话，下一个软键盘字符会被无声地
  // 包装成控制码，而屏幕上没有任何东西提示它 armed 过。
  useEffect(() => {
    if (!showKeybar) setMods({ ctrl: false, alt: false })
  }, [showKeybar])

  // ---- 软键盘弹起跟随 ----
  // 键盘打开时 visualViewport 被压缩：算出底部被遮住的像素数 kbdLift，
  // 用 max-height 钳制 xterm + 键栏所在的 flex 容器 —— 键栏作为最后一个
  // flex 子项自然抬到键盘上方；xterm 随容器变小，原有 ResizeObserver 自动
  // refit + 发 terminal_resize。
  const [kbdLift, setKbdLift] = useState(0)
  useEffect(() => {
    if (!keybarVisible) {
      setKbdLift(0)
      return
    }
    const vv = window.visualViewport
    if (!vv) return
    let raf = 0
    let last = -1
    const update = () => {
      raf = 0
      const lift = kbdLiftPx(window.innerHeight, vv.height, vv.offsetTop)
      if (lift !== last) {
        last = lift
        setKbdLift(lift)
      }
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(update)
    }
    vv.addEventListener("resize", schedule)
    vv.addEventListener("scroll", schedule)
    window.addEventListener("resize", schedule)
    update()
    return () => {
      if (raf) cancelAnimationFrame(raf)
      vv.removeEventListener("resize", schedule)
      vv.removeEventListener("scroll", schedule)
      window.removeEventListener("resize", schedule)
    }
  }, [keybarVisible])

  useEffect(() => {
    isActiveRef.current = isActive
    isVisibleRef.current = isVisible
  }, [isActive, isVisible])

  useEffect(() => {
    onProcessExitedRef.current = onProcessExited
  }, [onProcessExited])

  useEffect(() => {
    openUrlTargetRef.current = openUrlTarget
  }, [openUrlTarget])

  useEffect(() => {
    let cancelled = false
    let cleanup: (() => void) | undefined

    async function init() {
      const { Terminal } = await import("@xterm/xterm")
      const { FitAddon } = await import("@xterm/addon-fit")
      const { WebLinksAddon } = await import("@xterm/addon-web-links")

      if (cancelled || !containerRef.current) return

      const fitAddon = new FitAddon()
      const webLinksAddon = new WebLinksAddon((event, uri) => {
        const modifier = isPrimaryModifier(event)
        if (terminalLinkClickOpensMenu(getBrowserPrefs(), modifier, uri)) {
          setLinkClick({ url: uri, x: event.clientX, y: event.clientY })
          return
        }
        openUrlTargetRef.current(uri, { source: "terminal", modifier })
      })

      const term = new Terminal({
        cursorBlink: true,
        fontSize: computeTerminalFontSize(
          terminalSizeRef.current,
          zoomLevelRef.current
        ),
        fontFamily: terminalFontRef.current,
        theme: getTerminalTheme(containerRef.current),
        // 允许透明背景：背景图开启时 getTerminalTheme 返回 alpha 0 的背景色，透出下方磨砂
        // 面板。当前 DOM 渲染器本就按 CSS 应用背景色（透明即生效，不消费此项）；显式设置是
        // 为将来若改用 canvas/webgl 渲染器时仍保持透明，不致回退成不透明黑块。
        allowTransparency: true,
        allowProposedApi: true,
      })

      term.loadAddon(fitAddon)
      term.loadAddon(webLinksAddon)
      term.open(containerRef.current)

      fitAddonRef.current = fitAddon
      termRef.current = term

      if (terminalLigaturesRef.current) {
        enableTerminalLigatures(
          term,
          ligaturesAddonRef,
          () => termRef.current === term && terminalLigaturesRef.current
        )
      }

      // Ordered single-flight pump for terminal input. Both onData (typed
      // bytes) and the custom-key escape sequences below feed this one queue,
      // so input reaches the PTY in exact type order regardless of transport
      // reordering, and fast bursts coalesce into fewer round-trips. A failed
      // send is dropped, not retried — re-sending an ambiguous write could
      // duplicate already-delivered bytes, worse than a drop in a shell. See
      // lib/terminal/write-queue.ts.
      const writeQueue = createWriteQueue((d) => terminalWrite(terminalId, d))
      // 暴露给键栏按键——必须走这条队列，否则与软键盘输入抢着发会乱序。
      writeQueueRef.current = writeQueue

      // Shell line-editing shortcuts. Sends readline/zle bindings so they
      // work regardless of terminfo.
      //   Alt/Option + ←/→ / Backspace: word-level moves & delete
      //   macOS Cmd + ←/→ / Backspace : line-level moves & clear
      // Uses `e.code` (physical key) to be robust against dead-key layouts on
      // macOS where Option can turn some keys into `key: "Dead"`.
      // AltGr on Windows/Linux is reported as ctrlKey+altKey and is excluded
      // by the `!ctrlKey` guard below.
      const isMac = detectPlatform() === "macos"
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== "keydown") return true
        // Skip during IME composition to avoid corrupting candidate buffer.
        if (e.isComposing) return true

        const { code, altKey, metaKey, ctrlKey, shiftKey } = e

        const writeSeq = (seq: string) => {
          writeQueue.enqueue(seq)
          e.preventDefault()
          return false
        }

        // Swallowed whether or not anything is selected, so an empty-selection
        // Ctrl+Shift+C never falls through to the PTY.
        if (isTerminalCopyShortcut(e, isMac)) {
          void copyTerminalSelection(term)
          e.preventDefault()
          return false
        }

        if (altKey && !ctrlKey && !metaKey && !shiftKey) {
          if (code === "ArrowLeft") return writeSeq("\x1bb")
          if (code === "ArrowRight") return writeSeq("\x1bf")
          if (code === "Backspace") return writeSeq("\x1b\x7f")
        }

        if (isMac && metaKey && !altKey && !ctrlKey && !shiftKey) {
          if (code === "ArrowLeft") return writeSeq("\x01")
          if (code === "ArrowRight") return writeSeq("\x05")
          if (code === "Backspace") return writeSeq("\x15")
        }

        return true
      })

      // Watch <html> for theme (class) and workspace-background (data-workspace-bg)
      // switching — both change what getTerminalTheme returns (dark/light palette,
      // and transparent-vs-opaque background), so re-push the theme on either.
      const themeObserver = new MutationObserver(() => {
        term.options.theme = getTerminalTheme(containerRef.current)
      })
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "data-workspace-bg"],
      })

      // Send input to PTY
      const onDataDisposable = term.onData((data: string) => {
        // Some apps toggle focus reporting; don't leak focus in/out sequences
        // into the shell prompt when tabs are switched.
        if (data === "\x1b[I" || data === "\x1b[O") return
        // 虚拟键栏闩锁 armed 时包装软键盘输入（CTRL+字母→控制码、ALT→ESC 前缀）
        const cur = modsRef.current
        if (cur.ctrl || cur.alt) {
          const { out, consumed } = applyTermMods(data, cur)
          if (consumed) setMods({ ctrl: false, alt: false })
          writeQueue.enqueue(out)
        } else {
          writeQueue.enqueue(data)
        }
      })

      // Debounced resize — avoid flooding IPC during drag
      let resizeTimer: ReturnType<typeof setTimeout> | null = null
      const onResizeDisposable = term.onResize(
        ({ cols, rows }: { cols: number; rows: number }) => {
          const last = lastResizeRef.current
          if (last && last.cols === cols && last.rows === rows) return
          lastResizeRef.current = { cols, rows }
          if (resizeTimer) clearTimeout(resizeTimer)
          resizeTimer = setTimeout(() => {
            terminalResize(terminalId, cols, rows).catch(() => {})
          }, 50)
        }
      )

      // attach 模式下，订阅到「快照应用完」之间到达的输出先攒着：快照是一次
      // 往返，中间到的 chunk 既可能已经在快照里（重复），也可能不在（丢失）。
      // 两者靠 seq 区分——见下面的 writeEvent 与 `TerminalEvent.seq`。
      let replayBuffer: TerminalEvent[] | null = attach ? [] : null

      // 已被快照画进这块屏幕的最高游标。缓冲**不足以**当闸门：事件走的通道
      // （Tauri IPC / WebSocket）和快照那次请求-响应之间没有任何顺序保证，
      // 所以一个已经被快照收录的 chunk 完全可能在快照应用之后才到达回调，
      // 那时缓冲已经放行、拦不住它。地板因此是永久的：seq 在一个终端内单调，
      // 所以「不高于快照游标」在这块 xterm 的整个生命周期都成立。
      // 只由快照抬高，不由实时事件抬高——实时事件本来就有序且各到一次，拿它们
      // 抬地板只会在万一乱序时白白吞掉输出。
      let snapshotSeqFloor = 0

      /** 写一个输出事件，丢弃已经画过的那一段。 */
      const writeEvent = (event: TerminalEvent) => {
        // seq 为 0/缺失 = 后端没能给出可比较的游标（旧后端、锁中毒）。此时
        // 宁可重复也不能丢：多打一行远比吞掉一行输出容易发现和容忍。
        const seq = event.seq ?? 0
        if (seq > 0 && seq <= snapshotSeqFloor) return
        term.write(event.data)
      }

      // Subscribe to events BEFORE spawning so no initial output is lost
      const unlisten = await subscribe<TerminalEvent>(
        `terminal://output/${terminalId}`,
        (payload) => {
          if (replayBuffer) {
            replayBuffer.push(payload)
            return
          }
          writeEvent(payload)
        }
      )

      /** 放行攒着的事件，跳过快照里已经有的那一段。 */
      const flushReplay = (snapshotSeq: number | null) => {
        const buffered = replayBuffer ?? []
        replayBuffer = null
        if (snapshotSeq != null && snapshotSeq > snapshotSeqFloor) {
          snapshotSeqFloor = snapshotSeq
        }
        for (const event of buffered) writeEvent(event)
      }

      const unlistenExit = await subscribe<TerminalEvent>(
        `terminal://exit/${terminalId}`,
        () => {
          // PTY is gone — stop the input pump (the reliable terminal-gone
          // signal; the queue's error-string match is only a fast-path).
          writeQueue.dispose()
          onProcessExitedRef.current?.(terminalId)
          term.write("\r\n\x1b[90m[Process exited]\x1b[0m\r\n")
        }
      )

      if (cancelled) {
        writeQueue.dispose()
        themeObserver.disconnect()
        onDataDisposable.dispose()
        onResizeDisposable.dispose()
        unlisten()
        unlistenExit()
        term.dispose()
        return
      }

      /** 把快照写进这个全新的 xterm，并放行不在快照里的那段缓冲输出。 */
      const applySnapshot = (snapshot: { data: string; seq: number }) => {
        if (snapshot.data) term.write(snapshot.data)
        flushReplay(snapshot.seq)
        setLoading(false)
      }

      /** 卸载已经发生：拆掉这次挂载建立的一切。attach 模式下 PTY 不归这次挂载，
       *  所以调用方各自决定要不要 kill。 */
      const teardown = () => {
        writeQueue.dispose()
        themeObserver.disconnect()
        onDataDisposable.dispose()
        onResizeDisposable.dispose()
        unlisten()
        unlistenExit()
        term.dispose()
      }

      // attach 模式：先看这个 id 上有没有活着的 PTY。有就把最近输出重放进这个
      // 全新的 xterm 并跳过 spawn（spawn 会因 id 重复而失败，而那个失败恰好长得
      // 像「终端起不来」——实际上进程好好的，只是屏幕是空的）。
      let attached = false
      if (attach) {
        const snapshot = await terminalSnapshot(terminalId).catch(() => null)
        if (cancelled) {
          teardown()
          return
        }
        if (snapshot?.alive) {
          attached = true
          applySnapshot(snapshot)
        }
        // 没活着时**不**在这里放行缓冲：spawn 还有一次往返，而那段窗口里到达的
        // 输出可能属于「别的窗口刚 spawn 成功的那个 PTY」。现在写进屏幕，等下面
        // 的重试快照再把同一段重放一遍，就会重复且顺序错乱（控制序列尤其致命）。
        // 缓冲一直留到 spawn 有了结果为止。
      }

      // Spawn the terminal AFTER subscribing to events
      if (!attached) {
        try {
          await terminalSpawn(workingDir, shell, initialCommand, terminalId)
          // spawn 成功 ⇒ 这个 id 上此前没有 PTY，缓冲里只可能是我们刚起的这个
          // 进程的头几个字节，没有任何东西需要去重。
          flushReplay(null)
        } catch (err) {
          // 在 attach 模式下，「这个 id 已存在」不是失败而是竞态：两个窗口（或
          // StrictMode 的双跑 effect）同时看到「没活着」并同时 spawn，只有一个
          // 会赢。输者此刻其实有一个健康的终端可以接管——再问一次快照，拿到就
          // 当作 attach 走完，而不是在一个正常运行的 shell 上打红字并把卡片
          // 切到「已退出」。只有再问也没有时才是真失败。
          const retry = attach
            ? await terminalSnapshot(terminalId).catch(() => null)
            : null
          if (cancelled) {
            teardown()
            return
          }
          if (retry?.alive) {
            attached = true
            applySnapshot(retry)
          } else {
            flushReplay(null)
            onProcessExitedRef.current?.(terminalId)
            term.write(
              `\r\n\x1b[31m[Failed to start terminal: ${err}]\x1b[0m\r\n`
            )
          }
        } finally {
          if (!cancelled) setLoading(false)
        }
      }

      // If unmounted while spawn was in flight, clean up the spawned PTY.
      // NOT in attach mode: there the PTY belongs to the card that placed it,
      // not to this mount — that is the whole point of attaching, and killing
      // here would take a running command down with a view switch.
      if (cancelled) {
        if (!attach) terminalKill(terminalId).catch(() => {})
        teardown()
        return
      }

      const fitIfReady = () => {
        const el = containerRef.current
        if (!el) return
        if (!isActiveRef.current || !isVisibleRef.current) return
        if (el.clientWidth <= 0 || el.clientHeight <= 0) return
        fitAddon.fit()
      }

      // Only fit when terminal is actually visible/active.
      requestAnimationFrame(() => {
        if (!cancelled) fitIfReady()
      })

      // Debounced fit on container resize while active
      let fitTimer: ReturnType<typeof setTimeout> | null = null
      const resizeObserver = new ResizeObserver(() => {
        if (fitTimer) clearTimeout(fitTimer)
        fitTimer = setTimeout(() => {
          fitIfReady()
        }, 30)
      })
      resizeObserver.observe(containerRef.current)

      cleanup = () => {
        writeQueue.dispose()
        writeQueueRef.current = null
        if (resizeTimer) clearTimeout(resizeTimer)
        if (fitTimer) clearTimeout(fitTimer)
        themeObserver.disconnect()
        onDataDisposable.dispose()
        onResizeDisposable.dispose()
        unlisten()
        unlistenExit()
        resizeObserver.disconnect()
        term.dispose()
        fitAddonRef.current = null
        termRef.current = null
        ligaturesAddonRef.current = null
        lastResizeRef.current = null
      }
    }

    init()

    return () => {
      cancelled = true
      cleanup?.()
      // A click held for the menu belongs to the terminal that was clicked;
      // when this effect re-runs for another terminal (or unmounts) the
      // menu must not outlive it and open the old terminal's link.
      setLinkClick(null)
    }
  }, [terminalId, workingDir, shell, initialCommand, attach])

  // Refit and focus when becoming active or panel becomes visible
  useEffect(() => {
    if (isActive && isVisible) {
      requestAnimationFrame(() => {
        const el = containerRef.current
        if (el && el.clientWidth > 0 && el.clientHeight > 0) {
          fitAddonRef.current?.fit()
        }
        termRef.current?.focus()
      })
    }
  }, [isActive, isVisible])

  // React to zoom / font-family / font-size changes. Updates refs synchronously so
  // async init() always reads the latest values, and pushes them to already-mounted
  // terminals. Double rAF ensures xterm's renderer has recomputed cell metrics
  // before we refit.
  useEffect(() => {
    zoomLevelRef.current = zoomLevel
    terminalFontRef.current = terminalFontStack
    terminalSizeRef.current = terminalFontSize
    const term = termRef.current
    if (!term) return
    term.options.fontFamily = terminalFontStack
    term.options.fontSize = computeTerminalFontSize(terminalFontSize, zoomLevel)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = containerRef.current
        if (el && el.clientWidth > 0 && el.clientHeight > 0) {
          fitAddonRef.current?.fit()
        }
      })
    })
  }, [zoomLevel, terminalFontStack, terminalFontSize])

  // React to the ligature toggle. Lazily loads @xterm/addon-ligatures on enable,
  // disposes it on disable.
  useEffect(() => {
    terminalLigaturesRef.current = terminalLigatures
    const term = termRef.current
    if (!term) return
    if (terminalLigatures) {
      enableTerminalLigatures(
        term,
        ligaturesAddonRef,
        () => termRef.current === term && terminalLigaturesRef.current
      )
    } else {
      disableTerminalLigatures(ligaturesAddonRef)
    }
  }, [terminalLigatures])

  return (
    <div
      className="absolute inset-0 h-full w-full p-2"
      style={{
        visibility: isActive ? "visible" : "hidden",
        pointerEvents: isActive ? "auto" : "none",
      }}
      aria-hidden={!isActive}
    >
      {/* xterm + 键栏所在的 flex 列：kbdLift 收缩外层高度，让键栏抬到软键盘上方。
          键盘收起时改让底部安全区（刘海屏 home indicator）——移动端终端走的是
          Drawer，portal 到 body，拿不到外壳那层 pb-[env(safe-area-inset-bottom)]，
          不减这一块最后一行按钮就压在 home indicator 上。键盘弹起时 home
          indicator 本来就被键盘盖住，再减一次只会多出一条空隙。 */}
      <div
        className="flex h-full w-full min-h-0 flex-col gap-1"
        style={
          showKeybar
            ? {
                maxHeight:
                  kbdLift > 0
                    ? `calc(100% - ${kbdLift}px)`
                    : "calc(100% - env(safe-area-inset-bottom))",
              }
            : undefined
        }
      >
        <div ref={containerRef} className="min-h-0 flex-1" />
        {showKeybar && (
          <TermKeybar
            mods={modsUi}
            onToggleMod={toggleMod}
            onPressKey={pressKey}
          />
        )}
      </div>
      <TerminalLinkMenu
        click={linkClick}
        onChoose={(url, target) => {
          setLinkClick(null)
          openUrlTargetRef.current(url, {
            source: "terminal",
            forceTarget: target,
          })
        }}
        onClose={() => {
          setLinkClick(null)
          termRef.current?.focus()
        }}
      />
      {loading && isActive && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/80">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <svg
              className="h-4 w-4 animate-spin"
              viewBox="0 0 24 24"
              fill="none"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
            <span>Starting terminal...</span>
          </div>
        </div>
      )}
    </div>
  )
}
