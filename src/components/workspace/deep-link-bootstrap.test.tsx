import { act, render, waitFor, cleanup } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"

let tabs: { tabsHydrated: boolean; openTab: ReturnType<typeof vi.fn> }

const h = vi.hoisted(() => ({ toastError: vi.fn() }))

vi.mock("sonner", () => ({ toast: { error: h.toastError } }))
vi.mock("@/contexts/tab-context", () => ({
  useTabStore: (selector: (s: typeof tabs) => unknown) => selector(tabs),
  useTabActions: () => tabs,
}))
// PetFocusBridge shares this module; keep its backend call off the wire.
vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ subscribe: async () => () => {} }),
}))
vi.mock("@/lib/deep-link", () => ({ takePendingDeepLink: async () => null }))

import { DeepLinkBootstrap } from "./deep-link-bootstrap"

const CONVERSATION = {
  id: 42,
  folder_id: 7,
  agent_type: "grok",
} as never

describe("DeepLinkBootstrap", () => {
  beforeEach(() => {
    h.toastError.mockReset()
    window.history.replaceState(
      {},
      "",
      "/workspace?folderId=7&conversationId=42&agent=grok"
    )
    resetAppWorkspaceStore()
    useAppWorkspaceStore.setState({
      foldersHydrated: false,
      conversationsLoading: true,
      conversations: [],
      folders: [{ id: 7 }] as never,
      addFolderToWorkspaceById: vi.fn(),
    })
    tabs = { tabsHydrated: true, openTab: vi.fn() }
  })
  afterEach(() => cleanup())

  // A cold-start `codeg://session/<id>` lands here as this query string on
  // Windows/Linux. `conversations` is fetched in parallel with the folders, so
  // it routinely settles after `foldersHydrated` flips — and the URL is cleared
  // on the way out, so a premature check would reject the link for good.
  it("waits for the conversation list instead of rejecting the link", async () => {
    render(<DeepLinkBootstrap />)
    act(() => {
      useAppWorkspaceStore.setState({ foldersHydrated: true })
    })
    await act(async () => {})
    expect(tabs.openTab).not.toHaveBeenCalled()
    expect(h.toastError).not.toHaveBeenCalled()

    act(() => {
      useAppWorkspaceStore.setState({
        conversations: [CONVERSATION],
        conversationsLoading: false,
      })
    })

    await waitFor(() =>
      expect(tabs.openTab).toHaveBeenCalledWith(7, 42, "grok", true)
    )
    expect(h.toastError).not.toHaveBeenCalled()
    await waitFor(() => expect(window.location.search).toBe(""))
  })

  it("reports a link whose conversation really is gone", async () => {
    act(() => {
      useAppWorkspaceStore.setState({
        foldersHydrated: true,
        conversationsLoading: false,
        conversations: [],
      })
    })
    render(<DeepLinkBootstrap />)

    await waitFor(() => expect(h.toastError).toHaveBeenCalled())
    expect(tabs.openTab).not.toHaveBeenCalled()
  })

  // The conversation list is global, but `addFolderToWorkspaceById` awaits a
  // backend round trip that refreshes the workspace — the pre-await snapshot
  // is stale by the time the check runs.
  it("re-reads the conversation list after opening the folder", async () => {
    const addFolderToWorkspaceById = vi.fn(async () => {
      useAppWorkspaceStore.setState({ conversations: [CONVERSATION] })
      return { id: 7 } as never
    })
    act(() => {
      useAppWorkspaceStore.setState({
        foldersHydrated: true,
        conversationsLoading: false,
        conversations: [],
        folders: [],
        addFolderToWorkspaceById,
      })
    })
    render(<DeepLinkBootstrap />)

    await waitFor(() =>
      expect(tabs.openTab).toHaveBeenCalledWith(7, 42, "grok", true)
    )
    expect(addFolderToWorkspaceById).toHaveBeenCalledWith(7)
    expect(h.toastError).not.toHaveBeenCalled()
  })

  it("does nothing without deep-link params", async () => {
    window.history.replaceState({}, "", "/workspace")
    act(() => {
      useAppWorkspaceStore.setState({
        foldersHydrated: true,
        conversationsLoading: false,
      })
    })
    render(<DeepLinkBootstrap />)
    await act(async () => {})
    expect(tabs.openTab).not.toHaveBeenCalled()
    expect(h.toastError).not.toHaveBeenCalled()
  })
})
