import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  GLOBAL_COMMANDS_STORAGE_KEY,
  createGlobalCommand,
} from "@/lib/global-commands"
import type { FolderCommand } from "@/lib/types"
import {
  commandLinkKey,
  useCommandTerminalLinkStore,
} from "@/stores/command-terminal-link-store"
import { CommandDropdown } from "./command-dropdown"

const h = vi.hoisted(() => ({
  stop: vi.fn(async () => {}),
  kill: vi.fn(async () => {}),
  create: vi.fn(async () => "launched-terminal"),
  runLocal: vi.fn(async () => {}),
  toastError: vi.fn(),
  desktop: true,
  remote: true,
  baseUrl: "https://devbox.example:3080",
  folder: { id: 1, path: "/repo" },
  command: "pnpm dev",
  isLocal: false,
  // What the folder's host lists; null for its one "dev" command (`command`).
  hostCommands: null as unknown[] | null,
  tabs: [] as { id: string }[],
  t: (key: string) => key,
}))

vi.mock("next-intl", () => ({ useTranslations: () => h.t }))
vi.mock("sonner", () => ({ toast: { error: h.toastError } }))
vi.mock("@/lib/transport", () => ({
  isDesktop: () => h.desktop,
  isRemoteDesktopMode: () => h.remote,
  getServerBaseUrl: () => h.baseUrl,
}))
vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({ activeFolder: h.folder }),
}))
vi.mock("@/contexts/terminal-context", () => ({
  useTerminalContext: () => ({
    createTerminalWithCommand: h.create,
    exitedTerminals: new Set<string>(),
    tabs: h.tabs,
  }),
}))
vi.mock("@/lib/api", () => ({
  listFolderCommands: vi.fn(
    async () =>
      h.hostCommands ?? [
        {
          id: 5,
          folder_id: 1,
          name: "dev",
          command: h.command,
          sort_order: 0,
          run_local: h.isLocal,
          created_at: "",
          updated_at: "",
        },
      ]
  ),
  bootstrapFolderCommandsFromPackageJson: vi.fn(async () => []),
  runLocalCommand: h.runLocal,
  terminalStop: h.stop,
  terminalKill: h.kill,
}))
vi.mock("./command-manage-dialog", () => ({ CommandManageDialog: () => null }))

function hostCommand(
  id: number,
  command: string,
  runLocal = false
): FolderCommand {
  return {
    id,
    folder_id: 1,
    name: `host-${id}`,
    command,
    sort_order: 0,
    run_local: runLocal,
    created_at: "",
    updated_at: "",
  }
}

describe("CommandDropdown", () => {
  beforeEach(() => {
    h.stop.mockClear()
    h.kill.mockClear()
    h.create.mockClear()
    h.create.mockImplementation(async () => "launched-terminal")
    h.runLocal.mockClear()
    h.toastError.mockClear()
    h.desktop = true
    h.remote = true
    h.baseUrl = "https://devbox.example:3080"
    h.folder = { id: 1, path: "/repo" }
    h.command = "pnpm dev"
    h.isLocal = false
    h.hostCommands = null
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
      [commandLinkKey(1, 5)]: "launched-terminal",
    })
  })

  it("stops a running command without closing its terminal", async () => {
    // The tab stays open on what the command printed. A plain kill would
    // also forget that output, and a reload of the tab would find nothing.
    h.tabs = [{ id: "running-terminal" }]
    useCommandTerminalLinkStore.setState({
      links: { [commandLinkKey(1, 5)]: "running-terminal" },
    })
    render(<CommandDropdown />)
    fireEvent.click(await screen.findByTitle("stopCommandTitle"))
    await waitFor(() => expect(h.stop).toHaveBeenCalledWith("running-terminal"))
    expect(h.kill).not.toHaveBeenCalled()
    expect(useCommandTerminalLinkStore.getState().links).toEqual({})
  })

  it("runs a local window's command on this machine, in the folder", async () => {
    h.remote = false
    h.command = 'open -a Zed "$CODEG_FOLDER_PATH"'
    h.isLocal = true
    render(<CommandDropdown />)
    fireEvent.click(await screen.findByTitle("runCommandTitle"))
    await waitFor(() =>
      expect(h.runLocal).toHaveBeenCalledWith(
        'open -a Zed "$CODEG_FOLDER_PATH"',
        "/repo",
        null,
        "/repo"
      )
    )
    expect(h.create).not.toHaveBeenCalled()
    expect(useCommandTerminalLinkStore.getState().links).toEqual({})
  })

  it("runs a command that merely starts with local: in a terminal", async () => {
    h.command = "local: zed ."
    render(<CommandDropdown />)
    fireEvent.click(await screen.findByTitle("runCommandTitle"))
    await waitFor(() =>
      expect(h.create).toHaveBeenCalledWith("dev", "local: zed .", 5)
    )
    expect(h.runLocal).not.toHaveBeenCalled()
  })

  it("runs a remote server's command on this machine like any other", async () => {
    h.command = 'zed "ssh://$CODEG_REMOTE_HOST$CODEG_FOLDER_PATH"'
    h.isLocal = true
    render(<CommandDropdown />)
    fireEvent.click(await screen.findByTitle("runCommandTitle"))
    await waitFor(() =>
      expect(h.runLocal).toHaveBeenCalledWith(
        'zed "ssh://$CODEG_REMOTE_HOST$CODEG_FOLDER_PATH"',
        "/repo",
        "devbox.example",
        null
      )
    )
    expect(h.toastError).not.toHaveBeenCalled()
    expect(h.create).not.toHaveBeenCalled()
  })

  it("runs a global command from a remote window on this machine, outside any folder", async () => {
    h.hostCommands = []
    createGlobalCommand(
      "zed",
      'zed "ssh://$CODEG_REMOTE_HOST$CODEG_FOLDER_PATH"',
      true
    )
    render(<CommandDropdown />)
    fireEvent.click(await screen.findByTitle("runCommandTitle"))
    await waitFor(() =>
      expect(h.runLocal).toHaveBeenCalledWith(
        'zed "ssh://$CODEG_REMOTE_HOST$CODEG_FOLDER_PATH"',
        "/repo",
        "devbox.example",
        null
      )
    )
    expect(h.create).not.toHaveBeenCalled()
    expect(useCommandTerminalLinkStore.getState().links).toEqual({})
  })

  it("still tells the backend the folder is remote when its host can't be read", async () => {
    // The backend checks a remote folder's path before cmd.exe splices it in.
    h.baseUrl = "not a url"
    h.hostCommands = []
    createGlobalCommand("open", "echo %CODEG_FOLDER_PATH%", true)
    render(<CommandDropdown />)
    fireEvent.click(await screen.findByTitle("runCommandTitle"))
    await waitFor(() =>
      expect(h.runLocal).toHaveBeenCalledWith(
        "echo %CODEG_FOLDER_PATH%",
        "/repo",
        "",
        null
      )
    )
  })

  it("refuses a command set to run on this computer outside the desktop app", async () => {
    h.desktop = false
    h.remote = false
    h.command = "zed ."
    h.isLocal = true
    render(<CommandDropdown />)
    fireEvent.click(await screen.findByTitle("runCommandTitle"))
    await waitFor(() =>
      expect(h.toastError).toHaveBeenCalledWith("localUnavailable")
    )
    expect(h.runLocal).not.toHaveBeenCalled()
    expect(h.create).not.toHaveBeenCalled()
  })

  it("doesn't let the host pass a command off as one kept on this computer", async () => {
    // Global commands have negative ids; the host's database never does.
    h.hostCommands = [hostCommand(-1, "echo from-the-host", true)]
    createGlobalCommand("mine", "echo mine", true)
    render(<CommandDropdown />)
    fireEvent.click(await screen.findByTitle("runCommandTitle"))
    await waitFor(() => expect(h.runLocal).toHaveBeenCalledTimes(1))
    expect(h.runLocal).toHaveBeenCalledWith(
      "echo mine",
      "/repo",
      "devbox.example",
      null
    )
  })

  it("keeps a global command's run in one folder out of the others", async () => {
    h.hostCommands = []
    createGlobalCommand("dev", "pnpm dev", false)
    h.create.mockImplementationOnce(async () => "terminal-a")
    const { rerender } = render(<CommandDropdown />)
    fireEvent.click(await screen.findByTitle("runCommandTitle"))
    await waitFor(() => expect(h.create).toHaveBeenCalledTimes(1))
    h.tabs = [{ id: "terminal-a" }]
    rerender(<CommandDropdown />)
    await screen.findByTitle("stopCommandTitle")

    // Folder 2 never ran it: it offers to, and runs its own copy.
    h.folder = { id: 2, path: "/other" }
    h.create.mockImplementationOnce(async () => "terminal-b")
    rerender(<CommandDropdown />)
    fireEvent.click(await screen.findByTitle("runCommandTitle"))
    await waitFor(() => expect(h.create).toHaveBeenCalledTimes(2))
    h.tabs = [{ id: "terminal-a" }, { id: "terminal-b" }]
    rerender(<CommandDropdown />)

    // Stopping it there leaves folder 1's run alone.
    fireEvent.click(await screen.findByTitle("stopCommandTitle"))
    await waitFor(() => expect(h.stop).toHaveBeenCalledWith("terminal-b"))
    expect(useCommandTerminalLinkStore.getState().links).toEqual({
      [commandLinkKey(1, -1)]: "terminal-a",
    })
  })

  it("picks up global commands another window added", async () => {
    h.hostCommands = []
    render(<CommandDropdown />)
    await screen.findByText("addCommand")

    // Another window writes the store; this one only hears the event.
    createGlobalCommand("zed", "zed .", true)
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: GLOBAL_COMMANDS_STORAGE_KEY })
      )
    })
    fireEvent.click(await screen.findByTitle("runCommandTitle"))
    await waitFor(() =>
      expect(h.runLocal).toHaveBeenCalledWith(
        "zed .",
        "/repo",
        "devbox.example",
        null
      )
    )
  })

  it("drops global commands when another window clears the storage", async () => {
    h.hostCommands = []
    createGlobalCommand("zed", "zed .", true)
    render(<CommandDropdown />)
    await screen.findByTitle("runCommandTitle")

    // `clear()` reaches other windows as a storage event with no key.
    localStorage.clear()
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: null }))
    })
    expect(await screen.findByText("addCommand")).toBeInTheDocument()
  })
})
