import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const env = vi.hoisted(() => ({ localDesktop: false }))
const call = vi.hoisted(() =>
  vi.fn<(command: string, args?: unknown) => Promise<null>>(async () => null)
)

vi.mock("@/lib/platform", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/platform")>("@/lib/platform")
  return { ...actual, isLocalDesktop: () => env.localDesktop }
})
vi.mock("@/lib/transport", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/transport")>("@/lib/transport")
  return { ...actual, getTransport: () => ({ call }) }
})

import { AppearanceProvider } from "./appearance-provider"
import { useAppearance } from "@/hooks/use-appearance"
import { STORAGE_KEY_UI_FONT_STACK } from "@/lib/appearance-script"

function WidthProbe() {
  const { setChatContentWidth, setThemeColor } = useAppearance()
  return (
    <>
      <button onClick={() => setChatContentWidth(900)}>width</button>
      <button onClick={() => setThemeColor("red")}>color</button>
    </>
  )
}

function renderProvider() {
  return render(
    <AppearanceProvider>
      <WidthProbe />
    </AppearanceProvider>
  )
}

async function settle() {
  await act(async () => {
    await vi.runAllTimersAsync()
  })
}

function mirrored(): Record<string, string>[] {
  return call.mock.calls
    .filter(([command]) => command === "config_sync_mirror_appearance")
    .map(([, args]) => (args as { values: Record<string, string> }).values)
}

beforeEach(() => {
  localStorage.clear()
  call.mockClear()
  env.localDesktop = false
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  document.documentElement.removeAttribute("style")
})

describe("appearance mirroring for config sync", () => {
  /// Opening a fresh browser against a codeg-server must not replace the
  /// server's appearance mirror with that browser's near-empty storage: the
  /// mount-time font-stack cache fix is not a user change.
  it("does not mirror when a fresh browser merely opens", async () => {
    renderProvider()
    await settle()
    // The cache fix itself still happened, locally.
    expect(localStorage.getItem(STORAGE_KEY_UI_FONT_STACK)).not.toBeNull()
    expect(mirrored()).toEqual([])
  })

  it("mirrors a local desktop window on launch, cache fix included", async () => {
    env.localDesktop = true
    renderProvider()
    await settle()
    expect(mirrored()).toHaveLength(1)
    expect(mirrored()[0][STORAGE_KEY_UI_FONT_STACK]).toBeDefined()
  })

  it("mirrors a user's change, including the chat width", async () => {
    renderProvider()
    await settle()
    fireEvent.click(screen.getByText("width"))
    await settle()
    expect(mirrored()).toEqual([
      expect.objectContaining({ "codeg-chat-content-width": "900" }),
    ])

    fireEvent.click(screen.getByText("color"))
    await settle()
    expect(mirrored()[1]).toEqual(
      expect.objectContaining({ "codeg-theme-color": "red" })
    )
  })
})
