import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { SessionFailureRecord } from "@/lib/types"

const mocks = vi.hoisted(() => ({
  mcpInventory: vi.fn(),
  mcpApply: vi.fn(),
  openHarness: vi.fn(() => ({ ok: true, section: "mcp", targeted: true })),
  harnessAvailable: true,
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock("@/lib/mcp/api", () => ({
  mcpInventory: mocks.mcpInventory,
  mcpApply: mocks.mcpApply,
}))

vi.mock("@/hooks/use-open-harness", () => ({
  useOpenHarness: () => ({
    available: mocks.harnessAvailable,
    openHarness: mocks.openHarness,
  }),
}))

vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
  },
}))

import {
  McpFailureRecoveryStrip,
  type McpFailureRecoveryStripProps,
} from "./mcp-failure-recovery-strip"

function renderStrip(props: McpFailureRecoveryStripProps) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <McpFailureRecoveryStrip {...props} />
    </NextIntlClientProvider>
  )
}

function failureRecord(
  overrides: Partial<SessionFailureRecord> = {}
): SessionFailureRecord {
  return {
    id: "fail-1",
    revision: 1,
    category: "connection",
    severity: "error",
    title: "MCP load failed for linear: 401 Unauthorized",
    actions: [],
    resolved: false,
    ...overrides,
  }
}

describe("McpFailureRecoveryStrip", () => {
  beforeEach(() => {
    mocks.mcpInventory.mockReset()
    mocks.mcpApply.mockReset()
    mocks.openHarness.mockClear()
    mocks.toastSuccess.mockClear()
    mocks.toastError.mockClear()
    mocks.harnessAvailable = true
  })

  it("renders zero DOM when there is no MCP initialization failure or only chrome_devtools failed", () => {
    const { container, rerender } = renderStrip({
      agentType: "claude_code",
      sessionFailures: [],
      errorText: null,
    })
    expect(container).toBeEmptyDOMElement()

    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <McpFailureRecoveryStrip
          agentType="claude_code"
          sessionFailures={[
            failureRecord({
              title: "MCP load failed for chrome_devtools: browser closed",
            }),
          ]}
        />
      </NextIntlClientProvider>
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("pauses the failing server via set_enabled(false) and reconnects on click", async () => {
    const user = userEvent.setup()
    const onReconnect = vi.fn()

    mocks.mcpInventory.mockResolvedValue({
      agents: [
        {
          agent: "claude_code",
          installed: true,
          config: {
            path: "/tmp/claude.json",
            format: "json",
            status: "ok",
            basis: "basis-claude-1",
            symlink: false,
            comments_lost_on_write: false,
            related: [],
          },
          writable: true,
          transports: ["stdio", "http", "sse"],
          delivery: "agent_file",
          can_disable: true,
          disable_mode: "codeg_pause",
          codeg_mcp: false,
          session_capabilities: null,
          entries: [
            {
              key: "linear",
              definition: { type: "http", url: "https://mcp.linear.app" },
              extra: {},
              enabled: true,
              paused: false,
              fingerprint: "fp-1",
              read_only: false,
              reserved: false,
              legacy: false,
              problems: [],
            },
          ],
        },
      ],
      reserved_keys: ["codeg-mcp"],
      key_pattern: "^[A-Za-z0-9_-]{1,64}$",
    })
    mocks.mcpApply.mockResolvedValue({
      outcome: "applied",
      ok: true,
      agents: [
        {
          agent: "claude_code",
          path: "/tmp/claude.json",
          status: "written",
          basis: "basis-claude-2",
          issues: [],
          warnings: [],
          ops: [{ index: 0, key: "linear", effect: "disabled" }],
          writes: [],
          backup_paths: [],
        },
      ],
    })

    renderStrip({
      agentType: "claude_code",
      sessionFailures: [failureRecord()],
      onReconnect,
    })

    expect(screen.getByRole("status")).toHaveTextContent(
      'MCP server "linear" failed to initialize'
    )

    await user.click(
      screen.getByRole("button", { name: "Pause linear & reconnect" })
    )

    await waitFor(() => expect(onReconnect).toHaveBeenCalledTimes(1))
    expect(mocks.mcpApply).toHaveBeenCalledWith({
      basis: { claude_code: "basis-claude-1" },
      ops: [
        {
          agent: "claude_code",
          key: "linear",
          action: "set_enabled",
          enabled: false,
        },
      ],
    })
    expect(mocks.toastSuccess).toHaveBeenCalled()
    expect(screen.queryByRole("status")).toBeNull()
  })

  it("opens MCP settings targeting the failing server and supports dismissing the current incident", async () => {
    const user = userEvent.setup()
    const { container } = renderStrip({
      agentType: "codex",
      errorText:
        "The MCP server 'notion' failed to initialize: session ID mismatch",
    })

    await user.click(screen.getByRole("button", { name: "Open MCP settings" }))
    expect(mocks.openHarness).toHaveBeenCalledWith({
      section: "mcp",
      serverKey: "notion",
    })

    await user.click(screen.getByRole("button", { name: "Dismiss" }))
    expect(container).toBeEmptyDOMElement()
  })

  it("supports pause & reconnect for custom ACP agents and hides the pause button for unknown agents", async () => {
    const user = userEvent.setup()
    const onReconnect = vi.fn()
    mocks.mcpInventory.mockResolvedValue({
      agents: [
        {
          agent: "custom:my-agent",
          display_name: "My Custom ACP",
          custom: true,
          installed: true,
          writable: true,
          can_disable: true,
          disable_mode: "codeg_pause",
          transports: ["stdio", "http"],
          delivery: "codeg_session",
          codeg_mcp: true,
          session_capabilities: null,
          config: {
            path: "/home/u/.codeg/custom-mcp/my-agent.json",
            format: "json",
            status: "ok",
            basis: "basis-custom-1",
            symlink: false,
            comments_lost_on_write: false,
            related: [],
          },
          entries: [
            {
              key: "linear",
              definition: { type: "http", url: "https://mcp.linear.app/mcp" },
              extra: {},
              enabled: true,
              paused: false,
              fingerprint: "fp-1",
              read_only: false,
              reserved: false,
              legacy: false,
              problems: [],
            },
          ],
        },
      ],
      reserved_keys: ["codeg-mcp"],
      key_pattern: "^[A-Za-z0-9_-]{1,64}$",
    })
    mocks.mcpApply.mockResolvedValue({
      outcome: "applied",
      ok: true,
      agents: [
        {
          agent: "custom:my-agent",
          path: "/home/u/.codeg/custom-mcp/my-agent.json",
          status: "written",
          basis: "basis-custom-2",
          issues: [],
          warnings: [],
          ops: [{ index: 0, key: "linear", effect: "disabled" }],
          writes: [],
          backup_paths: [],
        },
      ],
    })

    const { unmount } = renderStrip({
      agentType: "custom:my-agent",
      errorText: "MCP load failed for linear: timeout",
      onReconnect,
    })

    await user.click(
      screen.getByRole("button", { name: "Pause linear & reconnect" })
    )
    await waitFor(() => expect(onReconnect).toHaveBeenCalledTimes(1))
    expect(mocks.mcpApply).toHaveBeenCalledWith({
      basis: { "custom:my-agent": "basis-custom-1" },
      ops: [
        {
          agent: "custom:my-agent",
          key: "linear",
          action: "set_enabled",
          enabled: false,
        },
      ],
    })
    unmount()

    renderStrip({
      agentType: "unknown_agent",
      errorText: "MCP load failed for linear: timeout",
    })
    expect(screen.getByRole("status")).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: /Pause linear/i })
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Open MCP settings" })
    ).toBeInTheDocument()
  })

  it("matches MCP failures in multi-line combined errors and renders actions in a left-aligned row below the title", async () => {
    const user = userEvent.setup()
    const onReconnect = vi.fn()

    mocks.mcpInventory.mockResolvedValue({
      agents: [
        {
          agent: "claude_code",
          installed: true,
          config: {
            path: "/tmp/claude.json",
            format: "json",
            status: "ok",
            basis: "basis-claude-qa",
            symlink: false,
            comments_lost_on_write: false,
            related: [],
          },
          writable: true,
          transports: ["stdio", "http", "sse"],
          delivery: "agent_file",
          can_disable: true,
          disable_mode: "codeg_pause",
          codeg_mcp: false,
          session_capabilities: null,
          entries: [
            {
              key: "qa-mismatch-404",
              definition: { type: "http", url: "http://127.0.0.1:9999/mcp" },
              extra: {},
              enabled: true,
              paused: false,
              fingerprint: "fp-qa",
              read_only: false,
              reserved: false,
              legacy: false,
              problems: [],
            },
          ],
        },
      ],
      reserved_keys: ["codeg-mcp"],
      key_pattern: "^[A-Za-z0-9_-]{1,64}$",
    })
    mocks.mcpApply.mockResolvedValue({
      outcome: "applied",
      ok: true,
      agents: [
        {
          agent: "claude_code",
          path: "/tmp/claude.json",
          status: "written",
          basis: "basis-claude-qa-2",
          issues: [],
          warnings: [],
          ops: [{ index: 0, key: "qa-mismatch-404", effect: "disabled" }],
          writes: [],
          backup_paths: [],
        },
      ],
    })

    renderStrip({
      agentType: "claude_code",
      errorText: [
        "Failed to connect to Claude Code",
        "MCP load failed for qa-mismatch-404: 404 Not Found",
      ].join("\n"),
      onReconnect,
    })

    const strip = screen.getByRole("status")
    expect(strip).toHaveTextContent(
      'MCP server "qa-mismatch-404" failed to initialize'
    )

    const pauseButton = screen.getByRole("button", {
      name: "Pause qa-mismatch-404 & reconnect",
    })
    const actionsRow = pauseButton.parentElement
    expect(actionsRow).not.toBeNull()
    expect(actionsRow?.className).toContain("ps-[1.375rem]")
    expect(actionsRow?.className).toContain("mt-1.5")
    expect(strip.children[0]).not.toContainElement(pauseButton)
    expect(strip.children[1]).toBe(actionsRow)

    await user.click(pauseButton)
    await waitFor(() => expect(onReconnect).toHaveBeenCalledTimes(1))
  })
})
