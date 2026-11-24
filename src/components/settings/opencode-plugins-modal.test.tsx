import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { OpencodePluginsModal } from "./opencode-plugins-modal"
import {
  opencodeAddPlugin,
  opencodeListPlugins,
  opencodeRemovePlugin,
} from "@/lib/api"
import enMessages from "@/i18n/messages/en.json"
import type { OpencodePluginEntry, OpencodePluginList } from "@/lib/types"

vi.mock("@/lib/api", () => ({
  opencodeListPlugins: vi.fn(),
  opencodeAddPlugin: vi.fn(),
  opencodeRemovePlugin: vi.fn(),
}))

const CONFIG = "/home/u/.config/opencode/opencode.jsonc"

function entry(
  spec: string,
  overrides: Partial<OpencodePluginEntry> = {}
): OpencodePluginEntry {
  return {
    spec,
    kind: "package",
    legacy: false,
    has_options: false,
    resolved_path: null,
    path_state: null,
    ...overrides,
  }
}

function listOf(plugins: OpencodePluginEntry[]): OpencodePluginList {
  return { config_path: CONFIG, plugins }
}

function renderModal(onCompleted?: () => void) {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <OpencodePluginsModal
        open
        onOpenChange={() => {}}
        onCompleted={onCompleted}
      />
    </NextIntlClientProvider>
  )
}

describe("OpencodePluginsModal", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("lists what the config declares, with no install action", async () => {
    vi.mocked(opencodeListPlugins).mockResolvedValue(
      listOf([
        entry("oh-my-opencode@3.0.0", { legacy: true }),
        entry("./plugins/local", {
          kind: "path",
          resolved_path: "/home/u/.config/opencode/plugins/local",
          path_state: "directory",
        }),
        entry("-opencode.browser", { kind: "directive" }),
      ])
    )
    renderModal()

    expect(await screen.findByText("oh-my-opencode@3.0.0")).toBeInTheDocument()
    expect(screen.getByText(`Config: ${CONFIG}`)).toBeInTheDocument()
    expect(screen.getByText("Package")).toBeInTheDocument()
    expect(screen.getByText("Local directory")).toBeInTheDocument()
    expect(screen.getByText("Directive")).toBeInTheDocument()
    expect(screen.getByText("OpenCode 1 list")).toBeInTheDocument()
    // OpenCode installs packages itself; the dialog never offers to.
    expect(screen.queryByRole("button", { name: /install/i })).toBeNull()
    // A path that loads needs no explanation.
    expect(
      screen.queryByText("/home/u/.config/opencode/plugins/local")
    ).toBeNull()
  })

  it("names where it looked for a local plugin that cannot load", async () => {
    vi.mocked(opencodeListPlugins).mockResolvedValue(
      listOf([
        entry("./plugins/gone", {
          kind: "path",
          resolved_path: "/home/u/.config/opencode/plugins/gone",
          path_state: "missing",
        }),
        entry("/srv/plugin.ts", {
          kind: "path",
          resolved_path: "/srv/plugin.ts",
          path_state: "not_directory",
        }),
      ])
    )
    renderModal()

    expect(await screen.findByText("Not found")).toBeInTheDocument()
    expect(
      screen.getByText("/home/u/.config/opencode/plugins/gone")
    ).toBeInTheDocument()
    expect(screen.getByText("Not a directory")).toBeInTheDocument()
  })

  it("adds the trimmed spec and shows the list the backend returns", async () => {
    vi.mocked(opencodeListPlugins).mockResolvedValue(listOf([]))
    vi.mocked(opencodeAddPlugin).mockResolvedValue(
      listOf([entry("opencode-wakatime@1.2.0")])
    )
    const onCompleted = vi.fn()
    renderModal(onCompleted)

    expect(await screen.findByText("No plugins declared.")).toBeInTheDocument()
    const input = screen.getByRole("textbox")
    fireEvent.change(input, { target: { value: "  opencode-wakatime@1.2.0 " } })
    fireEvent.click(screen.getByRole("button", { name: /^Add$/ }))

    await waitFor(() =>
      expect(opencodeAddPlugin).toHaveBeenCalledWith("opencode-wakatime@1.2.0")
    )
    expect(
      await screen.findByText("opencode-wakatime@1.2.0")
    ).toBeInTheDocument()
    expect(input).toHaveValue("")
  })

  it("removes the entry's own spec", async () => {
    vi.mocked(opencodeListPlugins).mockResolvedValue(
      listOf([entry("keep"), entry("drop")])
    )
    vi.mocked(opencodeRemovePlugin).mockResolvedValue(listOf([entry("keep")]))
    renderModal()

    expect(await screen.findByText("drop")).toBeInTheDocument()
    const removeButtons = screen.getAllByRole("button", { name: /Remove/ })
    fireEvent.click(removeButtons[1])

    await waitFor(() =>
      expect(opencodeRemovePlugin).toHaveBeenCalledWith("drop")
    )
    await waitFor(() => expect(screen.queryByText("drop")).toBeNull())
    expect(screen.getByText("keep")).toBeInTheDocument()
  })

  it("explains entries still in OpenCode 1's list", async () => {
    vi.mocked(opencodeListPlugins).mockResolvedValue(
      listOf([entry("legacy-plugin", { legacy: true })])
    )
    renderModal()

    expect(
      await screen.findByText(/declared under OpenCode 1's `plugin` key/)
    ).toBeInTheDocument()
  })

  it("stays read-only when the config cannot be read", async () => {
    vi.mocked(opencodeListPlugins).mockRejectedValue(
      new Error("opencode.jsonc: unexpected end of input")
    )
    renderModal()

    expect(
      await screen.findByText(/unexpected end of input/)
    ).toBeInTheDocument()
    expect(screen.getByRole("textbox")).toBeDisabled()
    expect(screen.getByRole("button", { name: /^Add$/ })).toBeDisabled()
  })

  it("shows why an edit failed and keeps the list", async () => {
    vi.mocked(opencodeListPlugins).mockResolvedValue(listOf([entry("keep")]))
    vi.mocked(opencodeAddPlugin).mockRejectedValue(
      new Error("`plugins` in opencode.json is not a list")
    )
    renderModal()

    expect(await screen.findByText("keep")).toBeInTheDocument()
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "another" },
    })
    fireEvent.click(screen.getByRole("button", { name: /^Add$/ }))

    expect(await screen.findByText(/is not a list/)).toBeInTheDocument()
    expect(screen.getByText("keep")).toBeInTheDocument()
    expect(screen.getByRole("textbox")).toHaveValue("another")
  })
})
