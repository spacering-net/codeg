import { act, render, waitFor } from "@testing-library/react"
import { useState } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { TerminalView } from "./terminal-view"
import type { TerminalEvent, TerminalSnapshot } from "@/lib/types"

const h = vi.hoisted(() => ({
  writes: [] as string[],
  resets: 0,
  fits: 0,
  emulators: 0,
  disposed: 0,
  snapshot: vi.fn(),
  spawn: vi.fn(),
  kill: vi.fn(async () => {}),
  write: vi.fn(async () => {}),
  resize: vi.fn(async () => {}),
  // The pane size a fit lands on; null leaves the emulator's size alone.
  pane: null as { cols: number; rows: number } | null,
  // While set, xterm "has not drawn" what was written: parse callbacks wait.
  holdParse: false,
  parsed: [] as (() => void)[],
  fontSize: 12,
  onData: null as ((data: string) => void) | null,
  onResize: null as ((size: { cols: number; rows: number }) => void) | null,
  handlers: new Map<string, (event: TerminalEvent) => void>(),
  ready: null as (() => void) | null,
}))

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, args?: { code: number }) =>
    key === "processExitedWithCode"
      ? `Process exited (code ${args?.code})`
      : key,
}))
vi.mock("@/lib/api", () => ({
  terminalSnapshot: h.snapshot,
  terminalSpawn: h.spawn,
  terminalWrite: h.write,
  terminalResize: h.resize,
  terminalKill: h.kill,
}))
vi.mock("@/lib/platform", () => ({
  subscribe: async (channel: string, cb: (event: TerminalEvent) => void) => {
    h.handlers.set(channel, cb)
    return () => {
      h.handlers.delete(channel)
    }
  },
  onTransportReady: (cb: () => void) => {
    h.ready = cb
    return () => {
      h.ready = null
    }
  },
}))
vi.mock("@/hooks/use-appearance", () => ({
  useZoomLevel: () => ({ zoomLevel: 100 }),
  useTerminalFont: () => ({
    terminalFontStack: "monospace",
    terminalFontSize: h.fontSize,
    terminalLigatures: false,
  }),
}))
vi.mock("@/hooks/use-open-url-target", () => ({
  useOpenUrlTarget: () => vi.fn(),
  isPrimaryModifier: () => false,
}))
vi.mock("@/hooks/use-platform", () => ({ detectPlatform: () => "linux" }))
vi.mock("@/lib/terminal/theme", () => ({ getTerminalTheme: () => ({}) }))
vi.mock("@/lib/browser/browser-prefs", () => ({ getBrowserPrefs: () => ({}) }))
vi.mock("@/components/terminal/terminal-link-menu", () => ({
  TerminalLinkMenu: () => null,
  terminalLinkClickOpensMenu: () => false,
}))
vi.mock("@/components/terminal/term-keybar", () => ({ TermKeybar: () => null }))
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    constructor() {
      h.emulators++
    }
    options = { fontFamily: "", fontSize: 12, theme: {} }
    modes = { applicationCursorKeysMode: false }
    loadAddon(addon: { activate?: (term: unknown) => void }) {
      addon.activate?.(this)
    }
    open() {}
    attachCustomKeyEventHandler() {}
    onData(cb: (data: string) => void) {
      h.onData = cb
      return {
        dispose() {
          h.onData = null
        },
      }
    }
    cols = 80
    rows = 24
    resize(cols: number, rows: number) {
      if (cols === this.cols && rows === this.rows) return
      this.cols = cols
      this.rows = rows
      h.writes.push(`<resize ${cols}x${rows}>`)
      h.onResize?.({ cols, rows })
    }
    onResize(cb: (size: { cols: number; rows: number }) => void) {
      h.onResize = cb
      return {
        dispose() {
          h.onResize = null
        },
      }
    }
    write(data: string, parsed?: () => void) {
      if (data) h.writes.push(data)
      if (!parsed) return
      if (h.holdParse) h.parsed.push(parsed)
      else parsed()
    }
    reset() {
      h.resets++
      h.writes.push("<reset>")
    }
    dispose() {
      h.disposed++
    }
    focus() {}
  },
}))
vi.mock("@xterm/addon-ligatures", () => ({ LigaturesAddon: class {} }))
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    term: { resize: (cols: number, rows: number) => void } | null = null
    activate(term: { resize: (cols: number, rows: number) => void }) {
      this.term = term
    }
    fit() {
      h.fits++
      if (h.pane) this.term?.resize(h.pane.cols, h.pane.rows)
    }
  },
}))
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }))

const props = {
  terminalId: "terminal-1",
  workingDir: "/tmp",
  isActive: true,
  isVisible: true,
}

function snapshot(data: string, seq: number, alive = true): TerminalSnapshot {
  return {
    exists: true,
    alive,
    data,
    seq,
    exit_code: null,
    generation: "new-generation",
  }
}

describe("TerminalView recovery", () => {
  beforeEach(() => {
    h.writes.length = 0
    h.resets = 0
    h.fits = 0
    h.emulators = 0
    h.disposed = 0
    h.snapshot.mockReset()
    h.snapshot.mockResolvedValue({
      exists: false,
      alive: false,
      data: "",
      seq: 0,
      exit_code: null,
      generation: null,
    })
    h.spawn.mockReset()
    h.spawn.mockResolvedValue("terminal-1")
    h.kill.mockClear()
    h.write.mockClear()
    h.resize.mockClear()
    h.onData = null
    h.onResize = null
    h.pane = null
    h.holdParse = false
    h.parsed.length = 0
    h.fontSize = 12
    h.handlers.clear()
    h.ready = null
  })

  it("restores a live PTY, filters old-generation events, and fills WS gaps from a snapshot", async () => {
    h.snapshot.mockResolvedValueOnce(snapshot("before", 2))
    const view = render(
      <TerminalView {...props} attach spawnOnMissing={false} reuseCompleted />
    )
    await waitFor(() => expect(h.writes).toContain("before"))
    expect(h.spawn).not.toHaveBeenCalled()

    act(() => {
      h.handlers.get("terminal://output/terminal-1")?.({
        terminal_id: "terminal-1",
        data: "old",
        seq: 99,
        generation: "old-generation",
      })
      h.handlers.get("terminal://exit/terminal-1")?.({
        terminal_id: "terminal-1",
        data: "",
        seq: 0,
        generation: "old-generation",
      })
      h.handlers.get("terminal://output/terminal-1")?.({
        terminal_id: "terminal-1",
        data: "after",
        seq: 3,
        generation: "new-generation",
      })
    })
    expect(h.writes.join("")).toContain("beforeafter")
    expect(h.writes.join("")).not.toContain("old")
    expect(h.writes.join("")).not.toContain("processExited")

    let finishSnapshot!: (value: TerminalSnapshot) => void
    h.snapshot.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSnapshot = resolve
        })
    )
    act(() => {
      h.ready?.()
    })
    act(() => {
      h.handlers.get("terminal://output/terminal-1")?.({
        terminal_id: "terminal-1",
        data: "duplicate",
        seq: 4,
        generation: "new-generation",
      })
      h.handlers.get("terminal://output/terminal-1")?.({
        terminal_id: "terminal-1",
        data: "newest",
        seq: 5,
        generation: "new-generation",
      })
    })
    await act(async () => {
      finishSnapshot(snapshot("beforeafterlost", 4))
    })
    expect(h.resets).toBe(1)
    expect(h.writes.slice(h.writes.indexOf("<reset>") + 1).join("")).toBe(
      "beforeafterlostnewest"
    )
    expect(h.spawn).not.toHaveBeenCalled()
    view.unmount()
    expect(h.kill).not.toHaveBeenCalled()
  })

  it("keeps canvas output buffered through a lost concurrent spawn race", async () => {
    h.snapshot.mockResolvedValueOnce({
      exists: false,
      alive: false,
      data: "",
      seq: 0,
      exit_code: null,
      generation: null,
    })
    let rejectSpawn!: (reason: Error) => void
    h.spawn.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectSpawn = reject
        })
    )
    let finishRetry!: (value: TerminalSnapshot) => void
    h.snapshot.mockResolvedValueOnce({
      exists: false,
      alive: false,
      data: "",
      seq: 0,
      exit_code: null,
      generation: null,
    })
    h.snapshot.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRetry = resolve
        })
    )

    const view = render(<TerminalView {...props} attach />)
    await waitFor(() => expect(h.spawn).toHaveBeenCalledTimes(1))
    act(() => {
      h.handlers.get("terminal://output/terminal-1")?.({
        terminal_id: "terminal-1",
        data: "duplicate",
        seq: 1,
        generation: "new-generation",
      })
    })
    expect(h.writes).not.toContain("duplicate")
    await act(async () => {
      rejectSpawn(new Error("terminal id already exists"))
    })
    await waitFor(() => expect(h.snapshot).toHaveBeenCalledTimes(3))
    act(() => {
      h.handlers.get("terminal://output/terminal-1")?.({
        terminal_id: "terminal-1",
        data: "newer",
        seq: 2,
        generation: "new-generation",
      })
    })
    await act(async () => {
      finishRetry(snapshot("duplicate", 1))
    })
    expect(h.writes.join("")).toContain("duplicatenewer")
    expect(h.writes.join("").match(/duplicate/g)).toHaveLength(1)
    view.unmount()
  })

  it("does not attach an old completed canvas PTY while another mount restarts the same ID", async () => {
    const old = {
      ...snapshot("old completed output", 3, false),
      exit_code: 6,
      generation: "old-generation",
    }
    let newProcessStarted = false
    h.snapshot.mockImplementation(async () =>
      newProcessStarted ? snapshot("new live output", 1) : old
    )
    let finishFirstSpawn!: (id: string) => void
    h.spawn.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirstSpawn = resolve
        })
    )
    h.spawn.mockRejectedValueOnce(new Error("terminal id already exists"))
    const secondSpawned = vi.fn()

    const first = render(<TerminalView {...props} attach />)
    await waitFor(() => expect(h.spawn).toHaveBeenCalledTimes(1))
    const second = render(
      <TerminalView {...props} attach onSpawned={secondSpawned} />
    )
    await waitFor(() => expect(h.spawn).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(h.snapshot.mock.calls.length).toBeGreaterThanOrEqual(3)
    )
    expect(h.writes.join("")).not.toContain("old completed output")
    expect(secondSpawned).not.toHaveBeenCalled()

    newProcessStarted = true
    await act(async () => {
      finishFirstSpawn("terminal-1")
    })
    await waitFor(() =>
      expect(secondSpawned).toHaveBeenCalledWith("terminal-1")
    )
    expect(h.writes.join("")).toContain("new live output")
    expect(h.writes.join("")).not.toContain("old completed output")
    first.unmount()
    second.unmount()
  })

  it("does not trust an old completed PTY after the competing mount's first snapshot fails", async () => {
    const old = {
      ...snapshot("old completed output", 3, false),
      exit_code: 6,
      generation: "old-generation",
    }
    let probes = 0
    let newProcessStarted = false
    h.snapshot.mockImplementation(async () => {
      probes++
      if (probes === 2) throw new Error("snapshot temporarily unavailable")
      return newProcessStarted ? snapshot("new live output", 1) : old
    })
    let finishFirstSpawn!: (id: string) => void
    h.spawn.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirstSpawn = resolve
        })
    )
    h.spawn.mockRejectedValueOnce(new Error("terminal id already exists"))
    const secondSpawned = vi.fn()

    const first = render(<TerminalView {...props} attach />)
    await waitFor(() => expect(h.spawn).toHaveBeenCalledTimes(1))
    const second = render(
      <TerminalView {...props} attach onSpawned={secondSpawned} />
    )
    await waitFor(() => expect(h.spawn).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(probes).toBeGreaterThanOrEqual(3))
    expect(h.writes.join("")).not.toContain("old completed output")
    expect(secondSpawned).not.toHaveBeenCalled()

    newProcessStarted = true
    await act(async () => {
      finishFirstSpawn("terminal-1")
    })
    await waitFor(() =>
      expect(secondSpawned).toHaveBeenCalledWith("terminal-1")
    )
    expect(h.writes.join("")).toContain("new live output")
    expect(h.writes.join("")).not.toContain("old completed output")
    first.unmount()
    second.unmount()
  })

  it("surfaces a canvas launch error instead of resurrecting its old completed PTY", async () => {
    h.snapshot.mockResolvedValue({
      ...snapshot("old completed output", 3, false),
      exit_code: 6,
      generation: "old-generation",
    })
    h.spawn.mockRejectedValueOnce(new Error("shell missing"))
    const view = render(<TerminalView {...props} attach />)
    await waitFor(() =>
      expect(h.writes.join("")).toContain("Failed to start terminal")
    )
    expect(h.writes.join("")).not.toContain("old completed output")
    view.unmount()
  })

  it("accepts a completed winner when duplicate spawn loses after it exits", async () => {
    h.snapshot.mockResolvedValueOnce({
      exists: false,
      alive: false,
      data: "",
      seq: 0,
      exit_code: null,
      generation: null,
    })
    h.spawn.mockRejectedValueOnce(new Error("terminal id already exists"))
    h.snapshot.mockResolvedValueOnce({
      ...snapshot("short command finished", 2, false),
      exit_code: 4,
    })
    const view = render(<TerminalView {...props} attach />)
    await waitFor(() =>
      expect(h.writes.join("")).toContain("Process exited (code 4)")
    )
    expect(h.writes.join("")).toContain("short command finished")
    expect(h.writes.join("")).not.toContain("Failed to start terminal")
    view.unmount()
  })

  it("accepts a newly completed canvas winner after ignoring the old generation", async () => {
    const old = {
      ...snapshot("old completed output", 3, false),
      exit_code: 6,
      generation: "old-generation",
    }
    const winner = {
      ...snapshot("new completed output", 2, false),
      exit_code: 4,
    }
    let probes = 0
    h.snapshot.mockImplementation(async () => (++probes <= 2 ? old : winner))
    h.spawn.mockRejectedValueOnce(new Error("terminal id already exists"))

    const view = render(<TerminalView {...props} attach />)
    await waitFor(() =>
      expect(h.writes.join("")).toContain("Process exited (code 4)")
    )
    expect(probes).toBeGreaterThanOrEqual(3)
    expect(h.writes.join("")).toContain("new completed output")
    expect(h.writes.join("")).not.toContain("old completed output")
    view.unmount()
  })

  it("reports a genuine launch failure without waiting for another PTY", async () => {
    h.snapshot.mockResolvedValueOnce({
      exists: false,
      alive: false,
      data: "",
      seq: 0,
      exit_code: null,
      generation: null,
    })
    h.spawn.mockRejectedValueOnce(new Error("shell missing"))
    const view = render(<TerminalView {...props} attach />)
    await waitFor(() =>
      expect(h.writes.join("")).toContain("Failed to start terminal")
    )
    expect(h.snapshot).toHaveBeenCalledTimes(2)
    view.unmount()
  })

  it("retains completed output and its exit code", async () => {
    h.snapshot.mockResolvedValueOnce({
      ...snapshot("final output", 3, false),
      exit_code: 7,
    })
    const view = render(
      <TerminalView {...props} attach spawnOnMissing={false} reuseCompleted />
    )
    await waitFor(() =>
      expect(h.writes.join("")).toContain("Process exited (code 7)")
    )
    expect(h.writes.join("")).toContain("final output")
    expect(h.spawn).not.toHaveBeenCalled()
    view.unmount()
  })

  it("does not replay a command after a backend restart, and accepts old servers' live snapshots", async () => {
    h.snapshot.mockResolvedValueOnce({
      alive: true,
      data: "legacy live",
      seq: 2,
    })
    const view = render(
      <TerminalView {...props} attach spawnOnMissing={false} reuseCompleted />
    )
    await waitFor(() => expect(h.writes).toContain("legacy live"))
    expect(h.spawn).not.toHaveBeenCalled()

    h.snapshot.mockResolvedValueOnce({
      exists: false,
      alive: false,
      data: "",
      seq: 0,
      exit_code: null,
      generation: null,
    })
    act(() => {
      h.ready?.()
    })
    await waitFor(() => expect(h.writes.join("")).toContain("unavailable"))
    expect(h.spawn).not.toHaveBeenCalled()

    // A delayed in-flight spawn can still appear after the first missing
    // snapshot. The recovered pane must accept Ctrl-C/input again.
    h.snapshot.mockResolvedValueOnce(snapshot("late process", 1))
    act(() => {
      h.ready?.()
    })
    await waitFor(() => expect(h.writes.join("")).toContain("late process"))
    act(() => {
      h.onData?.("\x03")
    })
    await waitFor(() =>
      expect(h.write).toHaveBeenCalledWith("terminal-1", "\x03")
    )
    view.unmount()
  })

  it("recovers input when the first server ready arrives after an offline startup", async () => {
    let now = 0
    const clock = vi.spyOn(Date, "now").mockImplementation(() => {
      now += 20_000
      return now
    })
    h.snapshot.mockRejectedValueOnce(new Error("temporarily offline"))
    const view = render(
      <TerminalView {...props} attach spawnOnMissing={false} reuseCompleted />
    )
    await waitFor(() => expect(h.writes.join("")).toContain("unavailable"))
    clock.mockRestore()

    // This is the transport's first __ready__, not an onReconnect event.
    h.snapshot.mockResolvedValueOnce(snapshot("restored after offline", 4))
    act(() => {
      h.ready?.()
    })
    await waitFor(() =>
      expect(h.writes.join("")).toContain("restored after offline")
    )
    act(() => {
      h.onData?.("\x03")
    })
    await waitFor(() =>
      expect(h.write).toHaveBeenCalledWith("terminal-1", "\x03")
    )
    expect(h.spawn).not.toHaveBeenCalled()
    view.unmount()
  })

  it("resamples after the first ready frame races with its startup probe", async () => {
    let finishFirst!: (value: TerminalSnapshot) => void
    h.snapshot.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = resolve
        })
    )
    h.snapshot.mockResolvedValueOnce(snapshot("ready after probe", 3))
    let now = 0
    const clock = vi.spyOn(Date, "now").mockImplementation(() => {
      now += 20_000
      return now
    })
    const view = render(
      <TerminalView {...props} attach spawnOnMissing={false} reuseCompleted />
    )
    await waitFor(() => expect(h.ready).not.toBeNull())

    // The Web socket becomes ready while the HTTP snapshot is still in flight.
    act(() => {
      h.ready?.()
    })
    await act(async () => {
      finishFirst({
        exists: false,
        alive: false,
        data: "",
        seq: 0,
        exit_code: null,
        generation: null,
      })
    })
    clock.mockRestore()
    await waitFor(() =>
      expect(h.writes.join("")).toContain("ready after probe")
    )
    expect(h.spawn).not.toHaveBeenCalled()
    view.unmount()
  })

  it("keeps an in-flight spawn alive through a view unmount and does not replay the command", async () => {
    h.snapshot.mockResolvedValueOnce({
      exists: false,
      alive: false,
      data: "",
      seq: 0,
      exit_code: null,
      generation: null,
    })
    let finishSpawn!: (id: string) => void
    h.spawn.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSpawn = resolve
        })
    )
    const view = render(
      <TerminalView {...props} attach initialCommand="sleep 120" />
    )
    await waitFor(() => expect(h.spawn).toHaveBeenCalledTimes(1))
    view.unmount()
    await act(async () => {
      finishSpawn("terminal-1")
    })
    expect(h.kill).not.toHaveBeenCalled()

    h.snapshot.mockResolvedValueOnce(snapshot("still running", 1))
    render(
      <TerminalView {...props} attach spawnOnMissing={false} reuseCompleted />
    )
    await waitFor(() => expect(h.writes).toContain("still running"))
    expect(h.spawn).toHaveBeenCalledTimes(1)
  })

  it("keeps one emulator when a new panel tab is marked started by its own spawn", async () => {
    // Wired the way TerminalPanel wires it: `spawnOnMissing={!tab.restored}`,
    // with `onSpawned` setting `restored`. That flip only governs a LATER
    // mount. Re-running this one for it would dispose the emulator a moment
    // after the shell started — with its focus and any keys typed meanwhile.
    let started = false
    h.snapshot.mockImplementation(async () =>
      started
        ? snapshot("prompt$ ", 1)
        : {
            exists: false,
            alive: false,
            data: "",
            seq: 0,
            exit_code: null,
            generation: null,
          }
    )
    h.spawn.mockImplementation(async () => {
      started = true
      return "terminal-1"
    })
    function PanelTab() {
      const [restored, setRestored] = useState(false)
      return (
        <TerminalView
          {...props}
          attach
          spawnOnMissing={!restored}
          reuseCompleted
          onSpawned={() => setRestored(true)}
        />
      )
    }

    const view = render(<PanelTab />)
    await waitFor(() => expect(h.writes.join("")).toContain("prompt$ "))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(h.spawn).toHaveBeenCalledTimes(1)
    expect(h.emulators).toBe(1)
    expect(h.disposed).toBe(0)
    view.unmount()
    expect(h.disposed).toBe(1)
  })

  it("keeps a new PTY's input when the handshake after its spawn fails once", async () => {
    // A canvas card restarting over a completed PTY: the old reader's late
    // exit can land while the new process's generation is still unknown. A
    // failed handshake must be retried, not taken as "accept every generation".
    h.snapshot.mockResolvedValueOnce({
      ...snapshot("old completed output", 3, false),
      exit_code: 6,
      generation: "old-generation",
    })
    let failHandshake!: (reason: Error) => void
    h.snapshot.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failHandshake = reject
        })
    )
    h.snapshot.mockResolvedValueOnce(snapshot("new shell$ ", 1))

    const view = render(<TerminalView {...props} attach />)
    await waitFor(() => expect(h.snapshot).toHaveBeenCalledTimes(2))
    expect(h.spawn).toHaveBeenCalledTimes(1)
    act(() => {
      h.handlers.get("terminal://exit/terminal-1")?.({
        terminal_id: "terminal-1",
        data: "",
        seq: 0,
        generation: "old-generation",
      })
    })
    await act(async () => {
      failHandshake(new Error("snapshot temporarily unavailable"))
    })
    await waitFor(() => expect(h.writes.join("")).toContain("new shell$ "))
    expect(h.writes.join("")).not.toContain("processExited")
    act(() => {
      h.onData?.("x")
    })
    await waitFor(() => expect(h.write).toHaveBeenCalledWith("terminal-1", "x"))
    view.unmount()
  })

  it("flushes what an overlapping resync buffered when the newer snapshot fails", async () => {
    h.snapshot.mockResolvedValueOnce(snapshot("before", 2))
    const view = render(
      <TerminalView {...props} attach spawnOnMissing={false} reuseCompleted />
    )
    await waitFor(() => expect(h.writes).toContain("before"))

    // The first resync's snapshot is still out when a second ready arrives.
    h.snapshot.mockImplementationOnce(() => new Promise(() => {}))
    act(() => {
      h.ready?.()
    })
    act(() => {
      h.handlers.get("terminal://output/terminal-1")?.({
        terminal_id: "terminal-1",
        data: "between",
        seq: 3,
        generation: "new-generation",
      })
    })
    h.snapshot.mockRejectedValueOnce(new Error("offline again"))
    await act(async () => {
      h.ready?.()
    })
    await waitFor(() => expect(h.writes).toContain("between"))
    view.unmount()
  })

  it("reports a launch that lands after its view unmounted", async () => {
    // A drawer swiped shut mid-spawn unmounts the view, but the tab stays.
    // Unless the launch is reported anyway, the tab still reads as never
    // started, and the next mount after the PTY is gone runs the command again.
    let finishSpawn!: (id: string) => void
    h.spawn.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSpawn = resolve
        })
    )
    const onSpawned = vi.fn()
    const view = render(
      <TerminalView
        {...props}
        attach
        initialCommand="make deploy"
        onSpawned={onSpawned}
      />
    )
    await waitFor(() => expect(h.spawn).toHaveBeenCalledTimes(1))
    view.unmount()
    await act(async () => {
      finishSpawn("terminal-1")
    })
    await waitFor(() => expect(onSpawned).toHaveBeenCalledWith("terminal-1"))
    expect(h.kill).not.toHaveBeenCalled()
  })

  it("replays a snapshot at the size its output was laid out for", async () => {
    // xterm opens at 80 columns. Drawn there, a 133-column line wraps —
    // zsh's end-of-output mark pads to the right edge, so every reload left
    // a stray "%" line behind.
    h.snapshot.mockResolvedValueOnce({
      ...snapshot("wide output", 3),
      cols: 133,
      rows: 41,
    })
    const view = render(
      <TerminalView {...props} attach spawnOnMissing={false} reuseCompleted />
    )
    await waitFor(() => expect(h.writes).toContain("wide output"))
    expect(h.writes.indexOf("<resize 133x41>")).toBeGreaterThan(-1)
    expect(h.writes.indexOf("<resize 133x41>")).toBeLessThan(
      h.writes.indexOf("wide output")
    )
    // The PTY already has that size: telling it again would be noise.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80))
    })
    expect(h.resize).not.toHaveBeenCalled()
    view.unmount()
  })

  it("treats a restored tab the backend never knew as gone, not unconfirmed", async () => {
    // Retried until the deadline because a reload can beat the spawn request.
    // If every answer was "no such terminal", the tab's input is dead and the
    // tab is over — the same as an explicit "missing" on reconnect.
    let now = 0
    const clock = vi.spyOn(Date, "now").mockImplementation(() => {
      now += 20_000
      return now
    })
    const exited = vi.fn()
    const view = render(
      <TerminalView
        {...props}
        attach
        spawnOnMissing={false}
        reuseCompleted
        onProcessExited={exited}
      />
    )
    await waitFor(() => expect(h.writes.join("")).toContain("unavailable"))
    clock.mockRestore()
    expect(exited).toHaveBeenCalledWith("terminal-1")
    act(() => {
      h.onData?.("x")
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(h.write).not.toHaveBeenCalled()
    view.unmount()
  })

  it("draws an ended terminal's exit line again after a reconnect redraws it", async () => {
    const ended = { ...snapshot("final output", 3, false), exit_code: 7 }
    h.snapshot.mockResolvedValueOnce(ended)
    const view = render(
      <TerminalView {...props} attach spawnOnMissing={false} reuseCompleted />
    )
    await waitFor(() =>
      expect(h.writes.join("")).toContain("Process exited (code 7)")
    )

    h.snapshot.mockResolvedValueOnce(ended)
    act(() => {
      h.ready?.()
    })
    await waitFor(() => expect(h.resets).toBe(1))
    expect(h.writes.slice(h.writes.indexOf("<reset>") + 1).join("")).toContain(
      "Process exited (code 7)"
    )
    view.unmount()
  })

  it("keeps this process's exit when an older one's lands after it", async () => {
    // Both arrive before the snapshot names the current generation. Only the
    // order of arrival differs from the usual case, and it must not decide
    // whether the pane learns that its process ended.
    let finish!: (value: TerminalSnapshot) => void
    h.snapshot.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const view = render(
      <TerminalView {...props} attach spawnOnMissing={false} reuseCompleted />
    )
    await waitFor(() => expect(h.snapshot).toHaveBeenCalledTimes(1))
    act(() => {
      for (const generation of ["new-generation", "old-generation"]) {
        h.handlers.get("terminal://exit/terminal-1")?.({
          terminal_id: "terminal-1",
          data: "",
          seq: 0,
          generation,
        })
      }
    })
    await act(async () => {
      finish(snapshot("taken before the exit", 1))
    })
    expect(h.writes.join("")).toContain("taken before the exit")
    expect(h.writes.join("")).toContain("processExited")
    view.unmount()
  })

  it("fits the pane again once a reconnect's replay is drawn", async () => {
    // The replay is drawn at the PTY's size, which another viewer may have
    // set. The pane has to be fitted back to itself afterwards, or it stays
    // at that size until its container happens to change.
    const width = vi
      .spyOn(Element.prototype, "clientWidth", "get")
      .mockReturnValue(800)
    const height = vi
      .spyOn(Element.prototype, "clientHeight", "get")
      .mockReturnValue(600)
    try {
      h.snapshot.mockResolvedValueOnce({
        ...snapshot("before", 2),
        cols: 133,
        rows: 41,
      })
      const view = render(
        <TerminalView {...props} attach spawnOnMissing={false} reuseCompleted />
      )
      await waitFor(() => expect(h.writes).toContain("before"))
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 60))
      })
      const fitted = h.fits

      h.snapshot.mockResolvedValueOnce({
        ...snapshot("before and after", 3),
        cols: 90,
        rows: 30,
      })
      act(() => {
        h.ready?.()
      })
      await waitFor(() => expect(h.resets).toBe(1))
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 60))
      })
      expect(h.fits).toBeGreaterThan(fitted)
      view.unmount()
    } finally {
      width.mockRestore()
      height.mockRestore()
    }
  })

  it("leaves a restored tab unconfirmed when its last probe could not reach the backend", async () => {
    // "Missing" early in the probe can be out of date: the spawn it raced may
    // have landed while the later probes failed. Only the last answer counts.
    const clock = vi
      .spyOn(Date, "now")
      .mockImplementation(() =>
        h.snapshot.mock.calls.length >= 2 ? 20_000 : 0
      )
    h.snapshot.mockResolvedValueOnce({
      exists: false,
      alive: false,
      data: "",
      seq: 0,
      exit_code: null,
      generation: null,
    })
    h.snapshot.mockRejectedValueOnce(new Error("offline"))
    const exited = vi.fn()
    const view = render(
      <TerminalView
        {...props}
        attach
        spawnOnMissing={false}
        reuseCompleted
        onProcessExited={exited}
      />
    )
    await waitFor(() => expect(h.writes.join("")).toContain("unavailable"))
    clock.mockRestore()
    expect(h.snapshot).toHaveBeenCalledTimes(2)
    expect(exited).not.toHaveBeenCalled()
    act(() => {
      h.onData?.("x")
    })
    await waitFor(() => expect(h.write).toHaveBeenCalledWith("terminal-1", "x"))
    view.unmount()
  })

  it("drops a resize queued for the pane before the snapshot set the size", async () => {
    // A fit before the handshake queues the PTY a size. Adopting the PTY's
    // own size from the snapshot makes that queued size stale: sent later,
    // it would leave the PTY at a size the pane no longer has.
    const width = vi
      .spyOn(Element.prototype, "clientWidth", "get")
      .mockReturnValue(800)
    const height = vi
      .spyOn(Element.prototype, "clientHeight", "get")
      .mockReturnValue(600)
    try {
      let finishHandshake!: (value: TerminalSnapshot) => void
      h.snapshot.mockResolvedValueOnce({
        exists: false,
        alive: false,
        data: "",
        seq: 0,
        exit_code: null,
        generation: null,
      })
      h.snapshot.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishHandshake = resolve
          })
      )
      const view = render(<TerminalView {...props} attach />)
      await waitFor(() => expect(h.snapshot).toHaveBeenCalledTimes(2))

      // Re-activated while the handshake is out: the pane fits to 133x41.
      h.pane = { cols: 133, rows: 41 }
      view.rerender(<TerminalView {...props} attach isActive={false} />)
      view.rerender(<TerminalView {...props} attach />)
      await waitFor(() => expect(h.writes).toContain("<resize 133x41>"))

      // The pane is back to the PTY's size by the time the handshake lands.
      h.pane = { cols: 80, rows: 24 }
      await act(async () => {
        finishHandshake({ ...snapshot("prompt$ ", 1), cols: 80, rows: 24 })
      })
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 120))
      })
      expect(h.resize).not.toHaveBeenCalledWith("terminal-1", 133, 41)
      view.unmount()
    } finally {
      width.mockRestore()
      height.mockRestore()
    }
  })

  it("holds every fit until a replay has been drawn", async () => {
    // xterm draws a write later. A fit landing before that would lay the
    // replay out at the pane's width — the stray "%" line again.
    const width = vi
      .spyOn(Element.prototype, "clientWidth", "get")
      .mockReturnValue(800)
    const height = vi
      .spyOn(Element.prototype, "clientHeight", "get")
      .mockReturnValue(600)
    try {
      h.holdParse = true
      h.pane = { cols: 90, rows: 30 }
      h.snapshot.mockResolvedValueOnce({
        ...snapshot("wide replay", 3),
        cols: 133,
        rows: 41,
      })
      const view = render(
        <TerminalView {...props} attach spawnOnMissing={false} reuseCompleted />
      )
      await waitFor(() => expect(h.writes).toContain("wide replay"))
      // The initial fit, a re-activation and a font change all come and go
      // meanwhile.
      h.fontSize = 14
      view.rerender(
        <TerminalView
          {...props}
          attach
          spawnOnMissing={false}
          reuseCompleted
          isActive={false}
        />
      )
      view.rerender(
        <TerminalView {...props} attach spawnOnMissing={false} reuseCompleted />
      )
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 80))
      })
      expect(h.writes).not.toContain("<resize 90x30>")

      // Drawn: now the pane gets its own size.
      h.holdParse = false
      await act(async () => {
        for (const parsed of h.parsed.splice(0)) parsed()
        await new Promise((resolve) => setTimeout(resolve, 80))
      })
      expect(h.writes.indexOf("<resize 90x30>")).toBeGreaterThan(
        h.writes.indexOf("wide replay")
      )
      view.unmount()
    } finally {
      width.mockRestore()
      height.mockRestore()
    }
  })
})
