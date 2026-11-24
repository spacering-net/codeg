import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { useTheme } from "next-themes"
import { ThemeProvider } from "./theme-provider"
import {
  THEME_COLOR_DARK,
  THEME_COLOR_LIGHT,
  THEME_COLOR_MEDIA_DARK,
  THEME_COLOR_MEDIA_LIGHT,
} from "@/lib/theme-color"

/** The two tags the root layout's `viewport.themeColor` renders. */
function addSchemeTags() {
  for (const [media, color] of [
    [THEME_COLOR_MEDIA_LIGHT, THEME_COLOR_LIGHT],
    [THEME_COLOR_MEDIA_DARK, THEME_COLOR_DARK],
  ]) {
    const tag = document.createElement("meta")
    tag.setAttribute("name", "theme-color")
    tag.setAttribute("media", media)
    tag.setAttribute("content", color)
    document.head.appendChild(tag)
  }
}

function removeThemeColorTags() {
  document
    .querySelectorAll('meta[name="theme-color"]')
    .forEach((tag) => tag.remove())
}

function contents() {
  return Array.from(
    document.querySelectorAll('meta[name="theme-color"]'),
    (tag) => tag.getAttribute("content")
  )
}

function ThemeButtons() {
  const { setTheme } = useTheme()
  return (
    <>
      <button onClick={() => setTheme("dark")}>dark</button>
      <button onClick={() => setTheme("light")}>light</button>
      <button onClick={() => setTheme("system")}>system</button>
    </>
  )
}

function renderProvider() {
  // Same props as the root layout.
  return render(
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      <ThemeButtons />
    </ThemeProvider>
  )
}

beforeEach(() => {
  localStorage.clear()
  removeThemeColorTags()
})

afterEach(() => {
  cleanup()
  removeThemeColorTags()
  localStorage.clear()
})

describe("ThemeProvider — theme-color", () => {
  it("gives every tag the color of an explicitly chosen mode", () => {
    addSchemeTags()
    localStorage.setItem("theme", "dark")

    renderProvider()

    expect(contents()).toEqual([THEME_COLOR_DARK, THEME_COLOR_DARK])
  })

  it("follows a switch made after load", () => {
    addSchemeTags()
    renderProvider()
    expect(contents()).toEqual([THEME_COLOR_LIGHT, THEME_COLOR_DARK])

    fireEvent.click(screen.getByText("light"))

    expect(contents()).toEqual([THEME_COLOR_LIGHT, THEME_COLOR_LIGHT])
  })

  it("restores each tag from its media on the way back to system", () => {
    addSchemeTags()
    localStorage.setItem("theme", "dark")
    renderProvider()

    // From dark, only the light-scheme tag has to come back…
    fireEvent.click(screen.getByText("system"))
    expect(contents()).toEqual([THEME_COLOR_LIGHT, THEME_COLOR_DARK])

    // …from light, only the dark-scheme one.
    fireEvent.click(screen.getByText("light"))
    expect(contents()).toEqual([THEME_COLOR_LIGHT, THEME_COLOR_LIGHT])
    fireEvent.click(screen.getByText("system"))
    expect(contents()).toEqual([THEME_COLOR_LIGHT, THEME_COLOR_DARK])
  })

  it("re-applies the choice when a navigation recreates the tags", async () => {
    addSchemeTags()
    localStorage.setItem("theme", "dark")
    renderProvider()

    // Next remounts its head on every client-side navigation (the `/` →
    // `/workspace` launch redirect included): the old tags go, fresh ones
    // carrying the per-scheme defaults take their place.
    removeThemeColorTags()
    addSchemeTags()

    await waitFor(() =>
      expect(contents()).toEqual([THEME_COLOR_DARK, THEME_COLOR_DARK])
    )
  })

  it("stops watching the head once unmounted", async () => {
    addSchemeTags()
    localStorage.setItem("theme", "dark")
    const { unmount } = renderProvider()
    unmount()

    removeThemeColorTags()
    addSchemeTags()
    // Observer callbacks are microtasks; let any stray one run.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(contents()).toEqual([THEME_COLOR_LIGHT, THEME_COLOR_DARK])
  })
})
