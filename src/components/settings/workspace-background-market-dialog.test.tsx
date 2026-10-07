import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { MarketWallpaper } from "@/lib/workspace-background-market"

const searchMock = vi.fn()

// Only the transport call is stubbed; the pure helpers (blocker/formatting) are
// the thing under test on the "unavailable" path, so they run for real.
vi.mock("@/lib/workspace-background-market", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/workspace-background-market")
  >()),
  searchWorkspaceBgMarket: (input: unknown) => searchMock(input),
}))

// The real hook mints blob URLs, which jsdom does not implement. Pin it to a
// resolved thumb so the card renders its <img> branch deterministically.
vi.mock("@/hooks/use-proxied-background-thumb", () => ({
  useProxiedBackgroundThumb: () => ({
    src: "blob:x",
    loading: false,
    failed: false,
  }),
}))

// Echoes params back, because several strings (the card's accessible name, the
// "too large" hint) carry their meaning entirely in the interpolated values.
vi.mock("next-intl", () => ({
  useTranslations:
    (ns: string) => (key: string, params?: Record<string, unknown>) =>
      params
        ? `${ns}.${key}(${Object.entries(params)
            .map(([k, v]) => `${k}=${v}`)
            .join(",")})`
        : `${ns}.${key}`,
}))

import { WorkspaceBackgroundMarketDialog } from "./workspace-background-market-dialog"

const NS = "AppearanceSettings.workspaceBackground.market"

const ITEM: MarketWallpaper = {
  id: "abc123",
  thumbUrl: "https://th.wallhaven.cc/small/ab/abc123.jpg",
  fullUrl: "https://w.wallhaven.cc/full/ab/wallhaven-abc123.jpg",
  sourceUrl: "https://wallhaven.cc/w/abc123",
  width: 1920,
  height: 1080,
  fileSizeBytes: 4_455_320,
  category: "general",
}

/** Past the backend's 16 MiB ceiling — clicking it could only ever fail. */
const OVERSIZED: MarketWallpaper = {
  ...ITEM,
  id: "huge9",
  sourceUrl: "https://wallhaven.cc/w/huge9",
  fileSizeBytes: 20 * 1024 * 1024,
}

function renderDialog(
  props: Partial<{ appliedSourceUrl: string | null }> = {}
) {
  const onApply = vi.fn().mockResolvedValue(undefined)
  render(
    <WorkspaceBackgroundMarketDialog
      open
      onOpenChange={() => {}}
      appliedSourceUrl={props.appliedSourceUrl ?? null}
      onApply={onApply}
    />
  )
  return { onApply }
}

beforeEach(() => {
  searchMock.mockReset()
})

describe("WorkspaceBackgroundMarketDialog", () => {
  it("renders listing items once loaded", async () => {
    searchMock.mockResolvedValue({ items: [ITEM], page: 1, lastPage: 3 })
    renderDialog()
    await waitFor(() =>
      expect(screen.getByText("1920×1080")).toBeInTheDocument()
    )
    expect(searchMock).toHaveBeenCalledWith({
      query: "",
      category: "all",
      page: 1,
    })
  })

  it("marks the applied wallpaper and applies on click", async () => {
    searchMock.mockResolvedValue({ items: [ITEM], page: 1, lastPage: 1 })
    const { onApply } = renderDialog({
      appliedSourceUrl: "https://wallhaven.cc/w/abc123",
    })
    await waitFor(() =>
      expect(screen.getByText("1920×1080")).toBeInTheDocument()
    )
    expect(screen.getByText(`${NS}.applied`)).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: /abc123/ }))
    await waitFor(() =>
      expect(onApply).toHaveBeenCalledWith(ITEM.fullUrl, ITEM.sourceUrl)
    )
  })

  it("shows a retryable error state, with the backend's reason", async () => {
    searchMock.mockRejectedValue(new Error("wallhaven returned HTTP 429"))
    renderDialog()
    await waitFor(() =>
      expect(screen.getByText(`${NS}.error`)).toBeInTheDocument()
    )
    expect(screen.getByText("wallhaven returned HTTP 429")).toBeInTheDocument()

    searchMock.mockResolvedValue({ items: [ITEM], page: 1, lastPage: 1 })
    // The toolbar's refresh button and this one no longer share a name.
    await userEvent.click(screen.getByRole("button", { name: `${NS}.retry` }))
    await waitFor(() =>
      expect(screen.getByText("1920×1080")).toBeInTheDocument()
    )
  })

  it("refuses a wallpaper the backend's size caps would reject, saying why", async () => {
    searchMock.mockResolvedValue({
      items: [OVERSIZED],
      page: 1,
      lastPage: 1,
    })
    const { onApply } = renderDialog()
    await waitFor(() =>
      expect(screen.getByText(`${NS}.unavailable`)).toBeInTheDocument()
    )
    const card = screen.getByRole("button", { name: /huge9/ })
    expect(card).toBeDisabled()
    // The reason names the actual size and the ceiling, not just "failed" —
    // on screen (a disabled button's tooltip is unreliable) and to AT.
    expect(screen.getByText("20.0 MB")).toBeInTheDocument()
    expect(card).toHaveAccessibleName(/20\.0 MB/)
    expect(card).toHaveAccessibleName(/16\.0 MB/)
    await userEvent.click(card)
    expect(onApply).not.toHaveBeenCalled()
  })

  it("locks the whole grid while a download is in flight", async () => {
    const second = {
      ...ITEM,
      id: "def456",
      sourceUrl: "https://wallhaven.cc/w/def456",
    }
    searchMock.mockResolvedValue({
      items: [ITEM, second],
      page: 1,
      lastPage: 1,
    })
    // Never settles: two concurrent downloads would race over one background
    // file, so the second card must be unreachable while the first is running.
    render(
      <WorkspaceBackgroundMarketDialog
        open
        onOpenChange={() => {}}
        appliedSourceUrl={null}
        onApply={() => new Promise<void>(() => {})}
      />
    )
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /abc123/ })).toBeEnabled()
    )
    await userEvent.click(screen.getByRole("button", { name: /abc123/ }))
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /def456/ })).toBeDisabled()
    )
    expect(screen.getByRole("button", { name: /abc123/ })).toBeDisabled()
  })

  it("labels and pages from the page wallhaven reported", async () => {
    searchMock.mockImplementation(({ page }: { page: number }) =>
      Promise.resolve({ items: [ITEM], page, lastPage: 5 })
    )
    renderDialog()
    await waitFor(() =>
      expect(
        screen.getByText(`${NS}.pageInfo(page=1,lastPage=5)`)
      ).toBeInTheDocument()
    )
    await userEvent.click(
      screen.getByRole("button", { name: `${NS}.nextPage` })
    )
    await waitFor(() =>
      expect(
        screen.getByText(`${NS}.pageInfo(page=2,lastPage=5)`)
      ).toBeInTheDocument()
    )
    expect(searchMock).toHaveBeenLastCalledWith({
      query: "",
      category: "all",
      page: 2,
    })
  })

  it("keeps a page turned right after opening, once the search debounce lands", async () => {
    // The debounce timer is queued at mount too. Unconditionally resetting the
    // page when it fires snapped anyone who paged inside that 300 ms window
    // back to page 1, just as their next page finished loading.
    searchMock.mockImplementation(({ page }: { page: number }) =>
      Promise.resolve({ items: [ITEM], page, lastPage: 5 })
    )
    renderDialog()
    await waitFor(() =>
      expect(
        screen.getByText(`${NS}.pageInfo(page=1,lastPage=5)`)
      ).toBeInTheDocument()
    )
    await userEvent.click(
      screen.getByRole("button", { name: `${NS}.nextPage` })
    )
    await waitFor(() =>
      expect(
        screen.getByText(`${NS}.pageInfo(page=2,lastPage=5)`)
      ).toBeInTheDocument()
    )
    // Outlast the debounce, then confirm nothing yanked the page back.
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(
      screen.getByText(`${NS}.pageInfo(page=2,lastPage=5)`)
    ).toBeInTheDocument()
    expect(searchMock).toHaveBeenLastCalledWith({
      query: "",
      category: "all",
      page: 2,
    })
  })

  it("settles on the served page instead of sticking when wallhaven clamps", async () => {
    // Claims five pages but never serves past two — the shape that used to let
    // next/prev compute forever from a page number nothing would ever return.
    searchMock.mockImplementation(({ page }: { page: number }) =>
      Promise.resolve({ items: [ITEM], page: Math.min(page, 2), lastPage: 5 })
    )
    renderDialog()
    const next = () =>
      userEvent.click(screen.getByRole("button", { name: `${NS}.nextPage` }))
    await waitFor(() =>
      expect(
        screen.getByText(`${NS}.pageInfo(page=1,lastPage=5)`)
      ).toBeInTheDocument()
    )
    await next()
    await waitFor(() =>
      expect(
        screen.getByText(`${NS}.pageInfo(page=2,lastPage=5)`)
      ).toBeInTheDocument()
    )
    await next()
    // It really does ask for 3 …
    await waitFor(() =>
      expect(searchMock).toHaveBeenCalledWith({
        query: "",
        category: "all",
        page: 3,
      })
    )
    // … and lands back on the page it was actually given, without looping.
    await waitFor(() =>
      expect(
        screen.getByText(`${NS}.pageInfo(page=2,lastPage=5)`)
      ).toBeInTheDocument()
    )
    const settled = searchMock.mock.calls.length
    expect(settled).toBeLessThanOrEqual(5)

    // And "next" still works after the bounce: the cursor was reconciled onto
    // the served page, so a second click cannot resolve to the page already
    // loaded and silently issue nothing. (The request that lands *last* is the
    // reconcile back to 2 — what matters is that 3 was asked for again.)
    const asksForThree = () =>
      searchMock.mock.calls.filter((call) => call[0]?.page === 3).length
    expect(asksForThree()).toBe(1)
    await next()
    await waitFor(() => expect(asksForThree()).toBe(2))
    expect(searchMock.mock.calls.length).toBeGreaterThan(settled)
  })
})
