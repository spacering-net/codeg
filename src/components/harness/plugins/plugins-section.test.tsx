import { useEffect } from "react"
import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"

const mocks = vi.hoisted(() => ({
  answers: {} as Record<string, (args: Record<string, unknown>) => unknown>,
  calls: [] as { command: string; args: Record<string, unknown> }[],
  listeners: new Map<string, Set<(payload: unknown) => void>>(),
}))

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({
    call: async (command: string, args: Record<string, unknown> = {}) => {
      mocks.calls.push({ command, args })
      return mocks.answers[command]?.(args)
    },
    subscribe: async (event: string, handler: (payload: unknown) => void) => {
      const set = mocks.listeners.get(event) ?? new Set()
      set.add(handler)
      mocks.listeners.set(event, set)
      return () => set.delete(handler)
    },
    onReconnect: () => () => {},
  }),
  getActiveRemoteConnectionId: () => null,
  isDesktop: () => true,
}))
vi.mock("@/lib/platform", () => ({
  isDesktop: () => true,
  isLocalDesktop: () => true,
  revealItemInDir: async () => {},
  openUrl: async () => {},
  subscribe: async () => () => {},
  onTransportReconnect: () => () => {},
}))
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }))
vi.mock("@/contexts/remote-connection-context", () => ({
  useRemoteConnection: () => null,
}))

import {
  HarnessViewProvider,
  useHarnessView,
} from "@/contexts/harness-view-context"
import type { HarnessSlotStore } from "@/lib/harness-slots"
import { MCP_HARNESS_DIALOG } from "@/lib/harness/mcp-install-state"
import { HARNESS_INSTALLED_CHANGED_EVENT } from "@/lib/harness/mcp-install-types"
import type { HarnessPluginUninstallResult } from "@/lib/harness/plugin-install-types"
import { confirmPluginUninstall } from "@/lib/harness/plugin-manage-state"
import {
  rawListedHost,
  rawListedPlugin,
} from "@/lib/harness/plugin-install-fixtures"
import { PluginsSection } from "./plugins-section"

const m = enMessages.Harness.plugins
const reasons = enMessages.Harness.install.reasons
const pluginReasons = enMessages.Harness.pluginInstall.reasons

let slots: HarnessSlotStore
function Capture() {
  const view = useHarnessView()
  useEffect(() => {
    slots = view.slots
  })
  return null
}

/** The section in the page — remounted, without the page's state lost, by
 *  a change of `visit`. */
function Page({ visit = 0 }: { visit?: number }) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <HarnessViewProvider>
        <Capture />
        <PluginsSection key={visit} />
      </HarnessViewProvider>
    </NextIntlClientProvider>
  )
}

function installed(hosts: Record<string, unknown>[]) {
  mocks.answers.harness_installed = () => ({
    mcp: [],
    skills: [],
    plugins: [rawListedPlugin({ hosts })],
  })
}

/** The trust mark shown in a line (not its screen reader's copy). */
const markIn = (line: HTMLElement, text: string) =>
  within(line).findByText(text, { selector: "span.rounded-full" })

/** The line of one agent: the list item its name is in. */
async function hostLine(agent: string) {
  const name = await screen.findByText(agent, { selector: "span.font-medium" })
  const line = name.closest("li")
  if (!line) throw new Error(`no line for ${agent}`)
  return line
}

/** What the host says when what is installed changed: read it again. */
async function installedChanged() {
  await act(async () => {
    for (const handler of mocks.listeners.get(
      HARNESS_INSTALLED_CHANGED_EVENT
    ) ?? []) {
      handler({ item_ids: ["itm_superpowers"], agents: ["codex"] })
    }
  })
}

beforeEach(() => {
  mocks.answers = { harness_updates: () => null }
  mocks.calls = []
  mocks.listeners.clear()
})

describe("PluginsSection — an agent's line", () => {
  it("asks Codex's trust from the line's actions and says it on the same line", async () => {
    installed([rawListedHost("codex", { codex_hooks: true })])
    let answer = "untrusted"
    mocks.answers.harness_plugin_hook_trust = () => ({
      hooks: [{ key: "h1", event: "SessionStart", state: answer }],
      problem: null,
    })
    render(<Page />)
    const line = await hostLine("Codex")
    const disable = within(line).getByRole("button", {
      name: m.actions.disable,
    })
    const trust = within(line).getByRole("button", {
      name: m.actions.hookTrust,
    })
    // A ghost button of the action group, as Disable is.
    expect(trust.parentElement).toBe(disable.parentElement)
    expect(trust.className).toBe(disable.className)
    expect(trust.querySelector("svg")).toBeTruthy()

    await userEvent.click(trust)
    const mark = await markIn(line, m.hooks.untrusted)
    // Beside the mode, before the actions — not a line of its own.
    expect(mark.parentElement).toBe(disable.parentElement?.parentElement)
    // Said to a screen reader as it comes.
    expect(within(line).getByRole("status").textContent).toBe(m.hooks.untrusted)
    expect(mocks.calls).toContainEqual({
      command: "harness_plugin_hook_trust",
      args: { itemId: "itm_superpowers", agent: "codex" },
    })

    answer = "trusted"
    await userEvent.click(
      within(line).getByRole("button", { name: m.hooks.again })
    )
    expect(await markIn(line, m.hooks.trusted)).toBeTruthy()
    expect(within(line).queryByText(m.hooks.untrusted)).toBeNull()
    expect(within(line).getByRole("status").textContent).toBe(m.hooks.trusted)
  })

  it("says why Codex's trust could not be read", async () => {
    installed([rawListedHost("codex", { codex_hooks: true })])
    mocks.answers.harness_plugin_hook_trust = () => ({ nothing: true })
    render(<Page />)
    const line = await hostLine("Codex")
    await userEvent.click(
      within(line).getByRole("button", { name: m.actions.hookTrust })
    )
    expect(await within(line).findByRole("alert")).toBeTruthy()
    expect(
      within(line).getByRole("button", { name: m.hooks.again })
    ).toBeTruthy()
  })

  it("says why Codex could not be asked, as an error and not as a mark", async () => {
    installed([rawListedHost("codex", { codex_hooks: true })])
    mocks.answers.harness_plugin_hook_trust = () => ({
      hooks: [],
      problem: { code: "plugin_hooks_unreadable", params: {}, detail: null },
    })
    render(<Page />)
    const line = await hostLine("Codex")
    await userEvent.click(
      within(line).getByRole("button", { name: m.actions.hookTrust })
    )
    expect((await within(line).findByRole("alert")).textContent).toBe(
      pluginReasons.plugin_hooks_unreadable
    )
    expect(within(line).queryByText(m.hooks.unknown)).toBeNull()
    expect(within(line).queryByText(m.hooks.none)).toBeNull()
    expect(
      within(line).getByRole("button", { name: m.hooks.again })
    ).toBeTruthy()
  })

  it("does not carry a trust read over to another revision", async () => {
    installed([rawListedHost("codex", { codex_hooks: true })])
    mocks.answers.harness_plugin_hook_trust = () => ({
      hooks: [{ key: "h1", event: "SessionStart", state: "trusted" }],
      problem: null,
    })
    render(<Page />)
    const line = await hostLine("Codex")
    await userEvent.click(
      within(line).getByRole("button", { name: m.actions.hookTrust })
    )
    await markIn(line, m.hooks.trusted)
    // Updated: the same item at a newer revision.
    mocks.answers.harness_installed = () => ({
      mcp: [],
      skills: [],
      plugins: [
        rawListedPlugin({
          revision: 8,
          version: "7.0.2",
          hosts: [rawListedHost("codex", { codex_hooks: true })],
        }),
      ],
    })
    await installedChanged()
    await screen.findByText(m.version.replace("{version}", "7.0.2"))
    const fresh = await hostLine("Codex")
    expect(within(fresh).queryByText(m.hooks.trusted)).toBeNull()
    expect(
      within(fresh).getByRole("button", { name: m.actions.hookTrust })
    ).toBeTruthy()
  })

  it("forgets a trust read once Codex no longer has the plugin whole", async () => {
    installed([rawListedHost("codex", { codex_hooks: true })])
    mocks.answers.harness_plugin_hook_trust = () => ({
      hooks: [{ key: "h1", event: "SessionStart", state: "trusted" }],
      problem: null,
    })
    render(<Page />)
    await userEvent.click(
      within(await hostLine("Codex")).getByRole("button", {
        name: m.actions.hookTrust,
      })
    )
    await markIn(await hostLine("Codex"), m.hooks.trusted)
    // Its skills only, then whole again, at the same revision.
    installed([
      rawListedHost("codex", {
        mode: "skills",
        codex_hooks: false,
        skills: ["brainstorming"],
      }),
    ])
    await installedChanged()
    await screen.findByText(enMessages.Harness.pluginInstall.modes.skills)
    installed([rawListedHost("codex", { codex_hooks: true })])
    await installedChanged()
    const line = await hostLine("Codex")
    expect(
      await within(line).findByRole("button", { name: m.actions.hookTrust })
    ).toBeTruthy()
    expect(within(line).queryByText(m.hooks.trusted)).toBeNull()
  })

  it("forgets a trust read once the section is left", async () => {
    installed([rawListedHost("codex", { codex_hooks: true })])
    mocks.answers.harness_plugin_hook_trust = () => ({
      hooks: [{ key: "h1", event: "SessionStart", state: "trusted" }],
      problem: null,
    })
    const { rerender } = render(<Page />)
    await userEvent.click(
      within(await hostLine("Codex")).getByRole("button", {
        name: m.actions.hookTrust,
      })
    )
    await markIn(await hostLine("Codex"), m.hooks.trusted)
    // Away (where an uninstall and a reinstall would not be seen) and back.
    rerender(<Page visit={1} />)
    const line = await hostLine("Codex")
    expect(
      await within(line).findByRole("button", { name: m.actions.hookTrust })
    ).toBeTruthy()
    expect(within(line).queryByText(m.hooks.trusted)).toBeNull()
  })

  it("forgets a trust read as soon as a plugin write starts", async () => {
    installed([rawListedHost("codex", { codex_hooks: true })])
    mocks.answers.harness_plugin_hook_trust = () => ({
      hooks: [{ key: "h1", event: "SessionStart", state: "trusted" }],
      problem: null,
    })
    // The write is still on its way when the line is looked at.
    mocks.answers.harness_plugin_uninstall = () => new Promise(() => {})
    render(<Page />)
    await userEvent.click(
      within(await hostLine("Codex")).getByRole("button", {
        name: m.actions.hookTrust,
      })
    )
    await markIn(await hostLine("Codex"), m.hooks.trusted)
    const preflight: HarnessPluginUninstallResult = {
      outcome: "preflight",
      issues: [],
      item_id: "itm_superpowers",
      name: "superpowers",
      removes: {},
      experts: {},
      ack: "ack-1",
      hosts: [],
      needs_repair: [],
      problems: [],
    }
    act(() => {
      slots.set(MCP_HARNESS_DIALOG, {
        kind: "pluginUninstall",
        id: 41,
        subject: {
          itemId: "itm_superpowers",
          itemRef: "obra/superpowers",
          name: "superpowers",
        },
        phase: "ready",
        preflight,
        result: null,
        failure: null,
        notice: null,
        request: 0,
      })
    })
    await act(async () => {
      void confirmPluginUninstall(slots, 41)
    })
    const line = await hostLine("Codex")
    expect(within(line).queryByText(m.hooks.trusted)).toBeNull()
    expect(
      within(line).getByRole("button", { name: m.actions.hookTrust })
    ).toBeTruthy()
  })

  it("offers no trust to read for an agent without Codex's hooks", async () => {
    installed([rawListedHost("claude_code")])
    render(<Page />)
    const line = await hostLine("Claude Code")
    expect(
      within(line).queryByRole("button", { name: m.actions.hookTrust })
    ).toBeNull()
  })

  it("marks an agent Codeg switched off without a sentence under it", async () => {
    installed([
      rawListedHost("claude_code", {
        state: { suspended: { reason: "item_unavailable" } },
        suspended_reason: "item_unavailable",
      }),
      rawListedHost("codex", {
        state: { suspended: { reason: "item_unavailable" } },
        suspended_reason: "item_unavailable",
      }),
    ])
    render(<Page />)
    await waitFor(() =>
      expect(screen.getAllByText(m.states.suspended)).toHaveLength(2)
    )
    expect(screen.queryByText(reasons.item_unavailable)).toBeNull()
  })
})
