import { render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { OpencodePluginsModal } from "./opencode-plugins-modal"
import {
  opencodeInstallPlugins,
  opencodeListPlugins,
  opencodeUninstallPlugin,
} from "@/lib/api"
import enMessages from "@/i18n/messages/en.json"
import type { PluginCheckSummary, PluginInfo } from "@/lib/types"

vi.mock("@/lib/api", () => ({
  opencodeListPlugins: vi.fn(),
  opencodeInstallPlugins: vi.fn(),
  opencodeUninstallPlugin: vi.fn(),
}))

vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn(async () => () => {}),
}))

/** The plugin from issue #745: a local file opencode imports off disk. */
const pathPlugin: PluginInfo = {
  name: "file:///home/u/.config/opencode/plugins/agentbro.js",
  declared_spec: "file:///home/u/.config/opencode/plugins/agentbro.js",
  installed_version: null,
  status: "path",
  resolved_path: "/home/u/.config/opencode/plugins/agentbro.js",
}

const packagePlugin: PluginInfo = {
  name: "oh-my-opencode",
  declared_spec: "oh-my-opencode@latest",
  installed_version: null,
  status: "missing",
  resolved_path: null,
}

function summaryOf(plugins: PluginInfo[]): PluginCheckSummary {
  return {
    config_path: "/home/u/.config/opencode/opencode.json",
    cache_dir: "/home/u/.cache/opencode",
    plugins,
    has_project_config_hint: false,
  }
}

function renderModal(plugins: PluginInfo[]) {
  vi.mocked(opencodeListPlugins).mockResolvedValue(summaryOf(plugins))
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <OpencodePluginsModal open onOpenChange={() => {}} />
    </NextIntlClientProvider>
  )
}

describe("OpencodePluginsModal", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("offers no install or uninstall action for a path plugin", async () => {
    renderModal([pathPlugin])
    expect(await screen.findByText("Path plugin")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /^Install$/ })).toBeNull()
    expect(screen.queryByRole("button", { name: /Uninstall/ })).toBeNull()
    expect(opencodeInstallPlugins).not.toHaveBeenCalled()
    expect(opencodeUninstallPlugin).not.toHaveBeenCalled()
  })

  it("does not count a path plugin as something to install", async () => {
    renderModal([pathPlugin])
    // Nothing installable and no @latest spec to pin, so the bulk action is
    // both relabelled and disabled instead of forever inviting a failed run.
    const bulk = await screen.findByRole("button", {
      name: /Pin @latest Versions/,
    })
    expect(bulk).toBeDisabled()
    expect(
      screen.queryByRole("button", { name: /Install All Missing/ })
    ).toBeNull()
  })

  it("still installs a genuinely missing package plugin", async () => {
    renderModal([pathPlugin, packagePlugin])
    await waitFor(() =>
      expect(screen.getByText("oh-my-opencode@latest")).toBeInTheDocument()
    )
    expect(screen.getByRole("button", { name: /^Install$/ })).toBeEnabled()
    expect(
      screen.getByRole("button", { name: /Install All Missing/ })
    ).toBeEnabled()
  })

  it("names the path it looked at when a path plugin is gone", async () => {
    renderModal([{ ...pathPlugin, status: "path_missing" }])
    expect(await screen.findByText("Path not found")).toBeInTheDocument()
    expect(
      screen.getByText("/home/u/.config/opencode/plugins/agentbro.js")
    ).toBeInTheDocument()
    // A file that is not there is not a package `bun add` can fetch.
    expect(screen.queryByRole("button", { name: /^Install$/ })).toBeNull()
  })
})
