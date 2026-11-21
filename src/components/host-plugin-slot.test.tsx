import { type ReactElement } from "react"
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import type { InstalledPlugin } from "@/lib/host-plugins"
import type { Transport } from "@/lib/transport"

const state = vi.hoisted(() => ({
  transport: null as Transport | null,
  isMobile: false,
}))

vi.mock("@/lib/transport", () => ({
  getTransport: () => {
    if (!state.transport) throw new Error("mock transport not configured")
    return state.transport
  },
}))

vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => state.isMobile,
}))

import { HostPluginSlot } from "./host-plugin-slot"

function createCatalogTransport(initialPlugins: InstalledPlugin[]) {
  let plugins = initialPlugins
  const listeners = new Map<string, Set<(payload: unknown) => void>>()

  const call = vi.fn(
    async (method: string, params?: Record<string, unknown>) => {
      if (method === "host_plugins_list") {
        return plugins
      }
      if (method === "host_plugins_client_html") {
        return `<div data-plugin="${String(params?.pluginId ?? "")}">surface</div>`
      }
      throw new Error(`Unexpected RPC call: ${method}`)
    }
  )

  const subscribe = vi.fn(
    async <T,>(channel: string, handler: (payload: T) => void) => {
      let set = listeners.get(channel)
      if (!set) {
        set = new Set()
        listeners.set(channel, set)
      }
      const wrapped = handler as (payload: unknown) => void
      set.add(wrapped)
      return () => {
        set?.delete(wrapped)
      }
    }
  )

  const setPlugins = (next: InstalledPlugin[]) => {
    plugins = next
    for (const handler of listeners.get("host-plugins://changed") ?? []) {
      handler(null)
    }
  }

  return {
    transport: {
      call: call as Transport["call"],
      subscribe: subscribe as Transport["subscribe"],
    },
    call,
    setPlugins,
  }
}

function pluginWithSurfaces(
  id: string,
  name: string,
  clientSurfaces: NonNullable<
    InstalledPlugin["manifest"]["contributes"]["clientSurfaces"]
  >,
  opts?: { enabled?: boolean; clientEntry?: string | null }
): InstalledPlugin {
  return {
    enabled: opts?.enabled ?? true,
    manifest: {
      id,
      name,
      version: "1.0.0",
      client:
        opts?.clientEntry === null
          ? undefined
          : { entry: opts?.clientEntry ?? "client.html" },
      contributes: {
        workspacePanels: [],
        commands: [],
        hooks: [],
        clientSurfaces,
      },
    },
  }
}

function withIntl(ui: ReactElement) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

describe("HostPluginSlot", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.isMobile = false
  })

  afterEach(() => {
    cleanup()
    state.transport = null
  })

  it("renders only enabled plugins with client.entry and opens the iframe via HostPluginSurface", async () => {
    const mock = createCatalogTransport([
      pluginWithSurfaces("acme.inspector", "Acme Inspector", [
        { id: "session-tools", title: "Session Tools", slot: "sessionHeader" },
        { id: "composer-tool", title: "Draft Aid", slot: "composer" },
      ]),
      pluginWithSurfaces(
        "acme.disabled",
        "Disabled Plugin",
        [{ id: "hidden", title: "Disabled Surface", slot: "sessionHeader" }],
        { enabled: false }
      ),
      pluginWithSurfaces(
        "acme.no-client",
        "No Client Entry",
        [{ id: "no-html", title: "No HTML Surface", slot: "sessionHeader" }],
        { clientEntry: null }
      ),
    ])
    state.transport = mock.transport

    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(
      withIntl(
        <HostPluginSlot
          slot="sessionHeader"
          sessionContext={{
            folderId: 12,
            conversationId: 34,
            sessionKey: "tab-34",
          }}
        />
      )
    )

    const trigger = await screen.findByRole("button", { name: "Session Tools" })
    expect(
      screen.queryByRole("button", { name: "Disabled Surface" })
    ).toBeNull()
    expect(screen.queryByRole("button", { name: "No HTML Surface" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Draft Aid" })).toBeNull()

    await user.click(trigger)

    const dialog = await screen.findByRole("dialog")
    expect(dialog).toHaveTextContent("Session Tools")
    expect(dialog).toHaveTextContent("Acme Inspector")

    const iframe = await within(dialog).findByTitle("Session Tools")
    expect(iframe.tagName).toBe("IFRAME")
    expect(iframe.getAttribute("srcdoc")).toContain(
      'data-plugin="acme.inspector"'
    )
    expect(mock.call).toHaveBeenCalledWith("host_plugins_client_html", {
      pluginId: "acme.inspector",
    })
  })

  it("withdraws an open surface when switching workspace or session", async () => {
    const mock = createCatalogTransport([
      pluginWithSurfaces("acme.notes", "Acme Notes", [
        { id: "notes", title: "Quick Notes", slot: "composer" },
      ]),
    ])
    state.transport = mock.transport

    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const { rerender } = render(
      withIntl(
        <HostPluginSlot
          slot="composer"
          sessionContext={{
            folderId: 1,
            conversationId: 101,
            sessionKey: "tab-1",
          }}
        />
      )
    )

    await user.click(await screen.findByRole("button", { name: "Quick Notes" }))
    expect(
      await within(await screen.findByRole("dialog")).findByTitle("Quick Notes")
    ).toBeInTheDocument()

    // Switch session within the same workspace -> immediately withdrawn
    rerender(
      withIntl(
        <HostPluginSlot
          slot="composer"
          sessionContext={{
            folderId: 1,
            conversationId: 102,
            sessionKey: "tab-2",
          }}
        />
      )
    )
    expect(screen.queryByRole("dialog")).toBeNull()

    // Reopen in tab-2, then switch workspace -> withdrawn again
    await user.click(screen.getByRole("button", { name: "Quick Notes" }))
    expect(
      await within(await screen.findByRole("dialog")).findByTitle("Quick Notes")
    ).toBeInTheDocument()

    rerender(
      withIntl(
        <HostPluginSlot
          slot="composer"
          sessionContext={{
            folderId: 2,
            conversationId: 102,
            sessionKey: "tab-2",
          }}
        />
      )
    )
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("withdraws buttons and any open dialog when a plugin is disabled via catalog event", async () => {
    const initial = [
      pluginWithSurfaces("acme.live", "Live Plugin", [
        { id: "live", title: "Live Tool", slot: "sessionHeader" },
      ]),
    ]
    const mock = createCatalogTransport(initial)
    state.transport = mock.transport

    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(
      withIntl(
        <HostPluginSlot
          slot="sessionHeader"
          sessionContext={{
            folderId: 3,
            conversationId: 9,
            sessionKey: "tab-9",
          }}
        />
      )
    )

    await user.click(await screen.findByRole("button", { name: "Live Tool" }))
    expect(
      await within(await screen.findByRole("dialog")).findByTitle("Live Tool")
    ).toBeInTheDocument()

    act(() => {
      mock.setPlugins([
        pluginWithSurfaces(
          "acme.live",
          "Live Plugin",
          [{ id: "live", title: "Live Tool", slot: "sessionHeader" }],
          { enabled: false }
        ),
      ])
    })

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull()
      expect(screen.queryByRole("button", { name: "Live Tool" })).toBeNull()
    })
  })

  it("caps inline triggers on desktop and places extra surfaces into an overflow menu", async () => {
    const mock = createCatalogTransport([
      pluginWithSurfaces("acme.multi", "Multi Plugin", [
        { id: "one", title: "First Tool", slot: "sessionHeader" },
        { id: "two", title: "Second Tool", slot: "sessionHeader" },
        { id: "three", title: "Third Tool", slot: "sessionHeader" },
      ]),
    ])
    state.transport = mock.transport

    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(
      withIntl(
        <HostPluginSlot
          slot="sessionHeader"
          sessionContext={{
            folderId: 5,
            conversationId: 50,
            sessionKey: "tab-50",
          }}
        />
      )
    )

    expect(
      await screen.findByRole("button", { name: "First Tool" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Second Tool" })
    ).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Third Tool" })).toBeNull()

    const overflow = screen.getByRole("button", { name: "More plugin actions" })
    expect(overflow).toHaveTextContent("+1")

    await user.click(overflow)
    await user.click(
      await screen.findByRole("menuitem", { name: /Third Tool/ })
    )
    expect(
      await within(await screen.findByRole("dialog")).findByTitle("Third Tool")
    ).toBeInTheDocument()
  })

  it("collapses multiple surfaces into a single compact icon menu on narrow/mobile screens", async () => {
    state.isMobile = true
    const mock = createCatalogTransport([
      pluginWithSurfaces("acme.mobile", "Mobile Plugin", [
        { id: "one", title: "Prompt Templates", slot: "composer" },
        { id: "two", title: "Context Builder", slot: "composer" },
      ]),
    ])
    state.transport = mock.transport

    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(
      withIntl(
        <HostPluginSlot
          slot="composer"
          sessionContext={{
            folderId: 8,
            conversationId: null,
            sessionKey: "draft-8",
          }}
        />
      )
    )

    const menuTrigger = await screen.findByRole("button", {
      name: "Plugin actions",
    })
    expect(menuTrigger.textContent).toBe("")
    expect(
      screen.queryByRole("button", { name: "Prompt Templates" })
    ).toBeNull()

    await user.click(menuTrigger)
    await user.click(
      await screen.findByRole("menuitem", { name: /Context Builder/ })
    )
    expect(
      await within(await screen.findByRole("dialog")).findByTitle(
        "Context Builder"
      )
    ).toBeInTheDocument()
  })

  it("renders a single icon-only button on narrow/mobile screens when only one surface exists", async () => {
    state.isMobile = true
    const mock = createCatalogTransport([
      pluginWithSurfaces("acme.solo", "Solo Plugin", [
        { id: "solo", title: "Solo Inspector", slot: "sessionHeader" },
      ]),
    ])
    state.transport = mock.transport

    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(
      withIntl(
        <HostPluginSlot
          slot="sessionHeader"
          sessionContext={{
            folderId: 8,
            conversationId: 1,
            sessionKey: "tab-8",
          }}
        />
      )
    )

    const button = await screen.findByRole("button", {
      name: "Solo Inspector",
    })
    // No visible text label competing for space in the mobile header.
    expect(button.textContent).toBe("")

    await user.click(button)
    expect(
      await within(await screen.findByRole("dialog")).findByTitle(
        "Solo Inspector"
      )
    ).toBeInTheDocument()
  })
})
