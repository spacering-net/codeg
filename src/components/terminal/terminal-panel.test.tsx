import { fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { TerminalPanel } from "./terminal-panel"

// The panel only decides *whether* the mobile key bar is on; the tab bar and
// the xterm host are stubbed so this stays a test of that decision (and of the
// collapse state it persists), not of xterm.
vi.mock("./terminal-tab-bar", () => ({
  TerminalTabBar: ({
    showKeybarToggle,
    keybarCollapsed,
    onToggleKeybar,
  }: {
    showKeybarToggle?: boolean
    keybarCollapsed?: boolean
    onToggleKeybar?: () => void
  }) => (
    <div>
      <span data-testid="toggle-shown">{String(showKeybarToggle)}</span>
      <span data-testid="collapsed">{String(keybarCollapsed)}</span>
      <button data-testid="toggle" onClick={onToggleKeybar}>
        toggle
      </button>
    </div>
  ),
}))

vi.mock("./terminal-view", () => ({
  TerminalView: ({
    terminalId,
    keybarVisible,
  }: {
    terminalId: string
    keybarVisible?: boolean
  }) => (
    <div
      data-testid={`view-${terminalId}`}
      data-keybar={String(keybarVisible)}
    />
  ),
}))

const terminalContext = {
  isOpen: true,
  tabs: [{ id: "t1", title: "1", workingDir: "/tmp" }],
  activeTabId: "t1",
  markTerminalExited: () => {},
}

vi.mock("@/contexts/terminal-context", () => ({
  useTerminalContext: () => terminalContext,
}))

const STORAGE_KEY = "codeg:term-keybar"
const DESKTOP_WIDTH = 1280
/** The width the app's mobile shell starts at — `useIsMobile()` is max-width 767px. */
const MOBILE_WIDTH = 767

const realMatchMedia = window.matchMedia

/**
 * Drive `useIsMobile()` at a real viewport width by evaluating the
 * `(max-width: Npx)` query against `width`, rather than hard-coding a boolean.
 * The panel used to ask for 768px while the workspace shell asks for 767px, so
 * the exact boundary is the thing worth asserting.
 */
function setViewportWidth(width: number) {
  window.matchMedia = ((query: string) => {
    const max = /\(max-width:\s*(\d+)px\)/.exec(query)
    return {
      matches: max ? width <= Number(max[1]) : false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }
  }) as unknown as typeof window.matchMedia
}

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  // Other suites render at the desktop breakpoint by default (test-setup.ts);
  // put the original stub back rather than leaving ours behind.
  window.matchMedia = realMatchMedia
  window.localStorage.clear()
})

describe("<TerminalPanel /> 键栏门控", () => {
  it("桌面端不显示折叠开关，也不给 view 传 keybarVisible", () => {
    setViewportWidth(DESKTOP_WIDTH)
    render(<TerminalPanel />)
    expect(screen.getByTestId("toggle-shown")).toHaveTextContent("false")
    expect(screen.getByTestId("view-t1")).toHaveAttribute(
      "data-keybar",
      "false"
    )
  })

  it("移动端默认展开键栏并显示折叠开关", () => {
    setViewportWidth(MOBILE_WIDTH)
    render(<TerminalPanel />)
    expect(screen.getByTestId("toggle-shown")).toHaveTextContent("true")
    expect(screen.getByTestId("view-t1")).toHaveAttribute("data-keybar", "true")
  })

  it("断点与工作区外壳一致：768px 仍是桌面态，不冒出键栏", () => {
    setViewportWidth(768)
    render(<TerminalPanel />)
    expect(screen.getByTestId("toggle-shown")).toHaveTextContent("false")
    expect(screen.getByTestId("view-t1")).toHaveAttribute(
      "data-keybar",
      "false"
    )
  })

  it("折叠状态写入 localStorage，并在重新挂载后恢复", () => {
    setViewportWidth(MOBILE_WIDTH)
    const { unmount } = render(<TerminalPanel />)

    fireEvent.click(screen.getByTestId("toggle"))
    expect(screen.getByTestId("view-t1")).toHaveAttribute(
      "data-keybar",
      "false"
    )
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("1")

    unmount()
    render(<TerminalPanel />)
    expect(screen.getByTestId("collapsed")).toHaveTextContent("true")
    expect(screen.getByTestId("view-t1")).toHaveAttribute(
      "data-keybar",
      "false"
    )
  })

  it("折叠态是面板级的：桌面端折叠后切到移动端仍然折叠", () => {
    setViewportWidth(DESKTOP_WIDTH)
    const { unmount } = render(<TerminalPanel />)
    fireEvent.click(screen.getByTestId("toggle"))
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("1")
    unmount()

    setViewportWidth(MOBILE_WIDTH)
    render(<TerminalPanel />)
    expect(screen.getByTestId("view-t1")).toHaveAttribute(
      "data-keybar",
      "false"
    )
  })
})
