import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { listFolderCommands } from "@/lib/api"
import { createGlobalCommand } from "@/lib/global-commands"
import { useCommandTerminalLinkStore } from "@/stores/command-terminal-link-store"
import { CommandDropdown } from "./command-dropdown"

const h = vi.hoisted(() => ({
  stop: vi.fn(async () => {}),
  kill: vi.fn(async () => {}),
  create: vi.fn(async () => "launched-terminal"),
  runLocal: vi.fn(async () => {}),
  toastError: vi.fn(),
  desktop: true,
  command: "pnpm dev",
  tabs: [] as { id: string }[],
  t: (key: string) => key,
}))

vi.mock("next-intl", () => ({ useTranslations: () => h.t }))
vi.mock("sonner", () => ({ toast: { error: h.toastError } }))
vi.mock("@/lib/transport", () => ({
  isDesktop: () => h.desktop,
  isRemoteDesktopMode: () => true,
  getServerBaseUrl: () => "https://devbox.example:3080",
}))
vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({ activeFolder: { id: 1, path: "/repo" } }),
}))
vi.mock("@/contexts/terminal-context", () => ({
  useTerminalContext: () => ({
    createTerminalWithCommand: h.create,
    exitedTerminals: new Set<string>(),
    tabs: h.tabs,
  }),
}))
vi.mock("@/lib/api", () => ({
  listFolderCommands: vi.fn(async () => [
    {
      id: 5,
      folder_id: 1,
      name: "dev",
      command: h.command,
      sort_order: 0,
      created_at: "",
      updated_at: "",
    },
  ]),
  bootstrapFolderCommandsFromPackageJson: vi.fn(async () => []),
  runLocalCommand: h.runLocal,
  terminalStop: h.stop,
  terminalKill: h.kill,
}))
vi.mock("./command-manage-dialog", () => ({ CommandManageDialog: () => null }))

describe("CommandDropdown", () => {
  beforeEach(() => {
    h.stop.mockClear()
    h.kill.mockClear()
    h.create.mockClear()
    h.runLocal.mockClear()
    h.toastError.mockClear()
    h.desktop = true
    h.command = "pnpm dev"
    h.tabs = []
    useCommandTerminalLinkStore.setState({ links: {} })
    localStorage.clear()
  })

  it("launches with the command's id, so its tab can find the launcher again", async () => {
    render(<CommandDropdown />)
    fireEvent.click(await screen.findByTitle("runCommandTitle"))
    await waitFor(() =>
      expect(h.create).toHaveBeenCalledWith("dev", "pnpm dev", 5)
    )
    expect(useCommandTerminalLinkStore.getState().links).toEqual({
      5: "launched-terminal",
    })
  })

  it("stops a running command without closing its terminal", async () => {
    // The tab stays open on what the command printed. A plain kill would
    // also forget that output, and a reload of the tab would find nothing.
    h.tabs = [{ id: "running-terminal" }]
    useCommandTerminalLinkStore.setState({ links: { 5: "running-terminal" } })
    render(<CommandDropdown />)
    fireEvent.click(await screen.findByTitle("stopCommandTitle"))
    await waitFor(() => expect(h.stop).toHaveBeenCalledWith("running-terminal"))
    expect(h.kill).not.toHaveBeenCalled()
    expect(useCommandTerminalLinkStore.getState().links).toEqual({})
  })

  it("runs a local: command on this machine instead of in a terminal", async () => {
    h.command = 'local: zed "ssh://$CODEG_REMOTE_HOST$CODEG_FOLDER_PATH"'
    render(<CommandDropdown />)
    fireEvent.click(await screen.findByTitle("runCommandTitle"))
    await waitFor(() =>
      expect(h.runLocal).toHaveBeenCalledWith(
        'zed "ssh://$CODEG_REMOTE_HOST$CODEG_FOLDER_PATH"',
        "/repo",
        "devbox.example"
      )
    )
    expect(h.create).not.toHaveBeenCalled()
    expect(useCommandTerminalLinkStore.getState().links).toEqual({})
  })

  it("refuses a local: command outside the desktop app", async () => {
    h.desktop = false
    h.command = "local: zed ."
    render(<CommandDropdown />)
    fireEvent.click(await screen.findByTitle("runCommandTitle"))
    await waitFor(() =>
      expect(h.toastError).toHaveBeenCalledWith("localUnavailable")
    )
    expect(h.runLocal).not.toHaveBeenCalled()
    expect(h.create).not.toHaveBeenCalled()
  })

  it("offers a global command in a folder that has none of its own", async () => {
    vi.mocked(listFolderCommands).mockResolvedValueOnce([])
    createGlobalCommand("zed", "local: zed .")
    render(<CommandDropdown />)
    fireEvent.click(await screen.findByTitle("runCommandTitle"))
    await waitFor(() =>
      expect(h.runLocal).toHaveBeenCalledWith(
        "zed .",
        "/repo",
        "devbox.example"
      )
    )
  })
})
