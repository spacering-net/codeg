import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const api = vi.hoisted(() => ({
  browserSetBlankPageTheme: vi.fn(() => Promise.resolve()),
}))
vi.mock("./browser-api", () => api)

const style = vi.hoisted(() => ({
  readEffectiveTokenValue: vi.fn(() => "oklch(0.145 0 0)"),
  // The real one normalises through a canvas; jsdom has none, so the two
  // colours this file uses are spelled out.
  toHexColor: vi.fn((value: string) =>
    value === "oklch(0.145 0 0)"
      ? "#09090b"
      : value === "oklch(1 0 0)"
        ? "#ffffff"
        : null
  ),
}))
vi.mock("@/lib/custom-style", () => style)

import { readBlankPageTheme, watchBlankPageTheme } from "./blank-page-theme"

/** Long enough for the observer's callback, which is a microtask. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("blank page theme", () => {
  let stop: () => void = () => {}

  beforeEach(() => {
    api.browserSetBlankPageTheme.mockClear()
    api.browserSetBlankPageTheme.mockImplementation(() => Promise.resolve())
    style.readEffectiveTokenValue.mockReturnValue("oklch(0.145 0 0)")
    document.documentElement.classList.add("dark")
    document.documentElement.removeAttribute("style")
    document.documentElement.removeAttribute("data-theme")
  })

  afterEach(() => {
    stop()
    document.documentElement.classList.remove("dark")
  })

  it("reads the running theme's background and scheme", () => {
    expect(readBlankPageTheme()).toEqual({
      background: "#09090b",
      dark: true,
    })
    document.documentElement.classList.remove("dark")
    style.readEffectiveTokenValue.mockReturnValue("oklch(1 0 0)")
    expect(readBlankPageTheme()).toEqual({
      background: "#ffffff",
      dark: false,
    })
  })

  // A colour that cannot be normalised is not a colour to paint with: the
  // page stays as the engine drew it rather than being painted wrong.
  it("says nothing it cannot resolve to a hex colour", async () => {
    style.readEffectiveTokenValue.mockReturnValue("var(--nope)")
    expect(readBlankPageTheme()).toBeNull()
    stop = watchBlankPageTheme()
    await settle()
    expect(api.browserSetBlankPageTheme).not.toHaveBeenCalled()
  })

  it("pushes on start and again when the theme changes", async () => {
    stop = watchBlankPageTheme()
    expect(api.browserSetBlankPageTheme).toHaveBeenCalledWith({
      background: "#09090b",
      dark: true,
    })

    // The theme goes light: the class and the variables change together, and
    // either one is enough to be heard.
    style.readEffectiveTokenValue.mockReturnValue("oklch(1 0 0)")
    document.documentElement.classList.remove("dark")
    await settle()
    expect(api.browserSetBlankPageTheme).toHaveBeenLastCalledWith({
      background: "#ffffff",
      dark: false,
    })
    expect(api.browserSetBlankPageTheme).toHaveBeenCalledTimes(2)
  })

  // The root element carries far more than the theme — the UI font, the
  // workspace background switch — and none of that is worth a round trip.
  it("stays quiet for a root change that is not a colour change", async () => {
    stop = watchBlankPageTheme()
    expect(api.browserSetBlankPageTheme).toHaveBeenCalledTimes(1)
    document.documentElement.style.setProperty("--font-sans", "Inter")
    document.documentElement.setAttribute("data-theme", "blue")
    await settle()
    expect(api.browserSetBlankPageTheme).toHaveBeenCalledTimes(1)
  })

  // Two pushes in flight together are two commands on the backend's runtime
  // and can be applied in either order; the loser would be the colour left
  // on a page nobody is going to change again.
  it("sends the colour that is current when the push lands", async () => {
    let land: () => void = () => {}
    api.browserSetBlankPageTheme.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          land = resolve
        })
    )
    stop = watchBlankPageTheme()
    expect(api.browserSetBlankPageTheme).toHaveBeenCalledTimes(1)

    // The theme moves twice while that first push is still open. Neither may
    // go out beside it.
    style.readEffectiveTokenValue.mockReturnValue("oklch(1 0 0)")
    document.documentElement.classList.remove("dark")
    await settle()
    document.documentElement.setAttribute("data-theme", "blue")
    await settle()
    expect(api.browserSetBlankPageTheme).toHaveBeenCalledTimes(1)

    land()
    await settle()
    // One push for the two changes, carrying where the theme actually is.
    expect(api.browserSetBlankPageTheme).toHaveBeenCalledTimes(2)
    expect(api.browserSetBlankPageTheme).toHaveBeenLastCalledWith({
      background: "#ffffff",
      dark: false,
    })
  })

  // Nothing on the page is going to change again on our account: a failed
  // push is the end of the line unless it tries itself.
  it("tries a failed push again on its own", async () => {
    vi.useFakeTimers()
    try {
      api.browserSetBlankPageTheme.mockImplementationOnce(() =>
        Promise.reject(new Error("no browser"))
      )
      stop = watchBlankPageTheme()
      expect(api.browserSetBlankPageTheme).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1000)
      expect(api.browserSetBlankPageTheme).toHaveBeenCalledTimes(2)
      expect(api.browserSetBlankPageTheme).toHaveBeenLastCalledWith({
        background: "#09090b",
        dark: true,
      })
    } finally {
      vi.useRealTimers()
    }
  })

  // The last go at one colour is not the last go at the next one.
  it("gives a colour that arrives during a failing retry its own attempt", async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      let failRetry: () => void = () => {}
      api.browserSetBlankPageTheme
        .mockImplementationOnce(() => Promise.reject(new Error("no browser")))
        // The second go is held open, so the theme can move while it travels.
        .mockImplementationOnce(
          () =>
            new Promise<void>((_, reject) => {
              failRetry = () => reject(new Error("no browser"))
            })
        )
      stop = watchBlankPageTheme()
      await vi.advanceTimersByTimeAsync(1000)
      expect(api.browserSetBlankPageTheme).toHaveBeenCalledTimes(2)

      style.readEffectiveTokenValue.mockReturnValue("oklch(1 0 0)")
      document.documentElement.classList.remove("dark")
      await vi.advanceTimersByTimeAsync(0)
      // Nothing goes out beside the push that is already travelling.
      expect(api.browserSetBlankPageTheme).toHaveBeenCalledTimes(2)

      // The dark colour is now out of chances — the light one has had none.
      failRetry()
      await vi.advanceTimersByTimeAsync(1000)
      expect(api.browserSetBlankPageTheme).toHaveBeenCalledTimes(3)
      expect(api.browserSetBlankPageTheme).toHaveBeenLastCalledWith({
        background: "#ffffff",
        dark: false,
      })
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  // Two watchers overlap for an instant on a remount (React's development
  // double-invoke does it every time): two commands on one backend value,
  // applied in whichever order the runtime picks.
  it("does not let a second watcher push beside the first", async () => {
    let land: () => void = () => {}
    api.browserSetBlankPageTheme.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          land = resolve
        })
    )
    const first = watchBlankPageTheme()
    expect(api.browserSetBlankPageTheme).toHaveBeenCalledTimes(1)

    // Torn down with that push still travelling, and replaced at once.
    first()
    stop = watchBlankPageTheme()
    style.readEffectiveTokenValue.mockReturnValue("oklch(1 0 0)")
    document.documentElement.classList.remove("dark")
    await settle()
    expect(api.browserSetBlankPageTheme).toHaveBeenCalledTimes(1)

    land()
    await settle()
    expect(api.browserSetBlankPageTheme).toHaveBeenCalledTimes(2)
    expect(api.browserSetBlankPageTheme).toHaveBeenLastCalledWith({
      background: "#ffffff",
      dark: false,
    })
  })

  // Once, though — a backend that has gone is not worth a timer for the rest
  // of the run.
  it("gives up after that one retry", async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      api.browserSetBlankPageTheme.mockImplementation(() =>
        Promise.reject(new Error("no browser"))
      )
      stop = watchBlankPageTheme()
      await vi.advanceTimersByTimeAsync(5000)
      expect(api.browserSetBlankPageTheme).toHaveBeenCalledTimes(2)
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  // A push the backend never took must not be remembered as the colour it
  // has, or a theme flipped there and back would leave it on the wrong one.
  it("sends a failed colour again when it comes back", async () => {
    api.browserSetBlankPageTheme.mockImplementationOnce(() =>
      Promise.reject(new Error("no browser"))
    )
    stop = watchBlankPageTheme()
    await settle()
    style.readEffectiveTokenValue.mockReturnValue("oklch(1 0 0)")
    document.documentElement.classList.remove("dark")
    await settle()
    style.readEffectiveTokenValue.mockReturnValue("oklch(0.145 0 0)")
    document.documentElement.classList.add("dark")
    await settle()
    expect(api.browserSetBlankPageTheme).toHaveBeenCalledTimes(3)
    expect(api.browserSetBlankPageTheme).toHaveBeenLastCalledWith({
      background: "#09090b",
      dark: true,
    })
  })

  it("stops watching when told to", async () => {
    stop = watchBlankPageTheme()
    expect(api.browserSetBlankPageTheme).toHaveBeenCalledTimes(1)
    stop()
    style.readEffectiveTokenValue.mockReturnValue("oklch(1 0 0)")
    document.documentElement.classList.remove("dark")
    await settle()
    expect(api.browserSetBlankPageTheme).toHaveBeenCalledTimes(1)
  })
})
