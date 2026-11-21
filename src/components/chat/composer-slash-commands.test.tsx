import { type ComponentProps, type ReactElement } from "react"
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import zhCnMessages from "@/i18n/messages/zh-CN.json"
import type { RichComposerHandle } from "@/components/chat/composer/rich-composer"
import { serializeDocToText } from "@/components/chat/composer/to-prompt-blocks"
import type {
  InstalledPlugin,
  PluginSlashCommandInput,
} from "@/lib/host-plugins"
import {
  loadMessageInputDraftV2,
  saveMessageInputDraftV2,
} from "@/lib/message-input-draft"
import type { Transport } from "@/lib/transport"
import type {
  AgentSkillItem,
  AvailableCommandInfo,
  PromptCapabilitiesInfo,
} from "@/lib/types"

type EventListener = (payload: unknown) => void

interface MockHostTransport {
  transport: Transport
  callMock: ReturnType<typeof vi.fn>
  emit: (event: string, payload?: unknown) => void
  setCatalog: (plugins: InstalledPlugin[]) => void
  setCallHandler: (
    handler: (params: {
      pluginId: string
      method: string
      input: PluginSlashCommandInput
    }) => unknown | Promise<unknown>
  ) => void
}

function createMockHostTransport(
  initialCatalog: InstalledPlugin[],
  initialHandler?: (params: {
    pluginId: string
    method: string
    input: PluginSlashCommandInput
  }) => unknown | Promise<unknown>
): MockHostTransport {
  let catalog = initialCatalog
  let callHandler = initialHandler ?? (() => null)
  const eventListeners = new Map<string, Set<EventListener>>()

  const callMock = vi.fn(async (method: string, params?: unknown) => {
    if (method === "host_plugins_list") return catalog
    if (method === "host_plugins_call") {
      return await callHandler(
        params as {
          pluginId: string
          method: string
          input: PluginSlashCommandInput
        }
      )
    }
    return null
  })

  const transport: Transport = {
    isDesktop: () => false,
    call: callMock as Transport["call"],
    subscribe: async <T,>(event: string, callback: (payload: T) => void) => {
      let set = eventListeners.get(event)
      if (!set) {
        set = new Set()
        eventListeners.set(event, set)
      }
      const wrapped = callback as EventListener
      set.add(wrapped)
      return () => {
        set?.delete(wrapped)
      }
    },
  }

  return {
    transport,
    callMock,
    emit: (event: string, payload?: unknown) => {
      for (const listener of eventListeners.get(event) ?? []) {
        listener(payload)
      }
    },
    setCatalog: (plugins) => {
      catalog = plugins
    },
    setCallHandler: (handler) => {
      callHandler = handler
    },
  }
}

const h = vi.hoisted(() => {
  const transportListeners = new Set<() => void>()
  return {
    transport: null as Transport | null,
    activeRemoteId: null as number | null,
    composerHandle: null as RichComposerHandle | null,
    agentSkills: [] as AgentSkillItem[],
    attachmentsOverride: null as Record<string, unknown> | null,
    notifyTransportChange() {
      for (const listener of transportListeners) listener()
    },
    subscribeTransportChange(listener: () => void) {
      transportListeners.add(listener)
      return () => {
        transportListeners.delete(listener)
      }
    },
    reset() {
      this.transport = null
      this.activeRemoteId = null
      this.composerHandle = null
      this.agentSkills = []
      this.attachmentsOverride = null
      transportListeners.clear()
    },
  }
})

vi.mock("./composer/rich-composer", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./composer/rich-composer")>()
  const React = await import("react")
  const Captured = React.forwardRef<
    RichComposerHandle,
    ComponentProps<typeof actual.RichComposer>
  >((props, ref) => {
    const assign = (handle: RichComposerHandle | null) => {
      h.composerHandle = handle
      if (typeof ref === "function") ref(handle)
      else if (ref) ref.current = handle
    }
    return React.createElement(actual.RichComposer, { ...props, ref: assign })
  })
  Captured.displayName = "CapturedRichComposer"
  return { ...actual, RichComposer: Captured }
})

vi.mock("@/lib/transport", () => ({
  getActiveRemoteConnectionId: () => h.activeRemoteId,
  subscribeTransportChange: (listener: () => void) =>
    h.subscribeTransportChange(listener),
  isDesktop: () => false,
  isRemoteDesktopMode: () => false,
  getTransport: () => {
    if (!h.transport) throw new Error("mock transport not configured")
    return h.transport
  },
}))

vi.mock("@/hooks/use-shortcut-settings", () => ({
  useShortcutSettings: () => ({
    shortcuts: { send_message: "enter", newline_in_message: "shift+enter" },
  }),
}))

vi.mock("@/hooks/use-agent-skills", () => ({
  useAgentSkills: () => h.agentSkills,
}))
vi.mock("@/hooks/use-built-in-experts", () => ({ useBuiltInExperts: () => [] }))
vi.mock("@/hooks/use-built-in-science", () => ({ useBuiltInScience: () => [] }))
vi.mock("@/hooks/use-enabled-skill-ids", () => ({
  useEnabledSkillIds: () => ({
    enabledIds: new Set(),
    ready: false,
    supported: true,
  }),
}))
vi.mock("@/components/chat/composer/use-reference-search", () => ({
  useReferenceSearch: () => async () => [],
}))
vi.mock("@/components/chat/conversation-context-bar", () => ({
  ConversationContextBar: () => null,
  ConversationFolderBranchPicker: () => null,
  useConversationFolderBranchPickerVisible: () => false,
}))
vi.mock("./composer-context-usage", () => ({
  ComposerContextUsage: () => null,
}))
vi.mock("./composer-connection-status", () => ({
  ComposerConnectionStatus: () => null,
}))
vi.mock("@/lib/platform", () => ({
  isDesktop: () => false,
  openFileDialog: vi.fn(),
  openUrl: vi.fn(async () => {}),
}))
vi.mock("@/hooks/use-open-file-target", () => ({
  useOpenFileTarget: () => async () => {},
}))
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  quickMessagesList: vi.fn(async () => []),
  uploadAttachment: vi.fn(() => new Promise(() => {})),
}))
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), dismiss: vi.fn() },
}))
vi.mock("@/hooks/use-appearance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-appearance")>()),
  useZoomLevel: () => ({ zoomLevel: 100, setZoomLevel: () => {} }),
}))
vi.mock("./composer/use-composer-attachments", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./composer/use-composer-attachments")>()
  return {
    ...actual,
    useComposerAttachments: (
      ...args: Parameters<typeof actual.useComposerAttachments>
    ) => {
      const real = actual.useComposerAttachments(...args)
      return h.attachmentsOverride
        ? { ...real, ...h.attachmentsOverride }
        : real
    },
  }
})

import { MessageInput } from "./message-input"

const CAPABILITIES: PromptCapabilitiesInfo = {
  image: true,
  audio: false,
  embedded_context: true,
}

function makeComposerCommandsPlugin(
  overrides?: Partial<InstalledPlugin> & {
    id?: string
    name?: string
    methods?: string[]
    slashCommands?: InstalledPlugin["manifest"]["contributes"]["slashCommands"]
  }
): InstalledPlugin {
  return {
    enabled: overrides?.enabled ?? true,
    manifest: {
      id: overrides?.id ?? "codeg.composer-commands",
      name: overrides?.name ?? "Composer Commands",
      version: "1.0.0",
      server: {
        entry: "commands.mjs",
        methods: overrides?.methods ?? ["show-context"],
      },
      contributes: {
        workspacePanels: [],
        commands: [],
        hooks: [],
        slashCommands: overrides?.slashCommands ?? [
          {
            name: "workspace-check",
            description: "Show the workspace handling this command",
            descriptionTranslations: {
              "zh-CN": "显示处理此命令的工作区",
            },
            argumentHint: "[label]",
            scope: "workspace",
            method: "show-context",
          },
          {
            name: "session-check",
            description: "Show the conversation handling this command",
            descriptionTranslations: {
              "zh-CN": "显示处理此命令的会话",
            },
            argumentHint: "[label]",
            scope: "session",
            method: "show-context",
          },
        ],
      },
    },
  }
}

function renderWithIntl(ui: ReactElement, locale: "en" | "zh-CN" = "en") {
  return render(
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "zh-CN" ? zhCnMessages : enMessages}
    >
      {ui}
    </NextIntlClientProvider>
  )
}

function pluginCalls(mock: MockHostTransport) {
  return mock.callMock.mock.calls.filter(
    ([method]) => method === "host_plugins_call"
  )
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function countReferenceNodes(): number {
  const editor = h.composerHandle?.getEditor()
  if (!editor) return 0
  let count = 0
  editor.state.doc.descendants((node) => {
    if (node.type.name === "reference") count += 1
    return true
  })
  return count
}

async function waitForEditorReady() {
  await waitFor(() => {
    expect(h.composerHandle?.getEditor()).not.toBeNull()
  })
  return h.composerHandle!.getEditor()!
}

function setEditorPlainText(text: string) {
  const editor = h.composerHandle?.getEditor()
  if (!editor) throw new Error("editor not ready")
  act(() => {
    editor.commands.setContent(
      {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: text ? [{ type: "text", text }] : [],
          },
        ],
      },
      { emitUpdate: true }
    )
    editor.commands.focus("end")
  })
}

describe("MessageInput scoped plugin slash commands", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/")
    localStorage.clear()
    h.reset()
  })

  afterEach(() => {
    cleanup()
    window.history.replaceState({}, "", "/")
    h.reset()
  })

  it("orders plugin commands ahead of agent commands, resolves collisions to first valid plugin, inserts plain text without badges, and leaves agent commands and $ skills intact", async () => {
    const firstPlugin = makeComposerCommandsPlugin({
      id: "acme.first",
      name: "First",
      slashCommands: [
        {
          name: "workspace-check",
          description: "First workspace check",
          descriptionTranslations: { "zh-CN": "首个工作区检查" },
          argumentHint: "[label]",
          scope: "workspace",
          method: "show-context",
        },
      ],
    })
    const secondPlugin = makeComposerCommandsPlugin({
      id: "acme.second",
      name: "Second",
      slashCommands: [
        {
          name: "workspace-check",
          description: "Duplicate shadowed by first",
          scope: "workspace",
          method: "show-context",
        },
        {
          name: "second-cmd",
          description: "Second unique command",
          scope: "workspace",
          method: "show-context",
        },
      ],
    })
    const agentCommands: AvailableCommandInfo[] = [
      {
        name: "workspace-check",
        description: "Agent shadowed command",
        input_hint: null,
      },
      {
        name: "compact",
        description: "Compact conversation history",
        input_hint: null,
      },
    ]
    h.agentSkills = [
      {
        id: "deploy-skill",
        name: "Deploy Skill",
        description: "Deploy via Codex",
        scope: "project",
        path: "/repo/.codex/skills/deploy-skill/SKILL.md",
        layout: "skill_directory",
        read_only: false,
      },
    ]

    const host = createMockHostTransport([firstPlugin, secondPlugin])
    h.transport = host.transport
    const onSend = vi.fn()

    renderWithIntl(
      <MessageInput
        onSend={onSend}
        promptCapabilities={CAPABILITIES}
        agentType="codex"
        availableCommands={agentCommands}
        pluginContext={{ folderId: 7, conversationId: null, sessionKey: "d-1" }}
      />,
      "zh-CN"
    )

    const editor = await waitForEditorReady()
    await waitFor(() => {
      expect(host.callMock).toHaveBeenCalledWith("host_plugins_list")
    })

    // Typing `/` at start of draft opens slash menu with plugin commands first
    setEditorPlainText("/")
    const menu = await screen.findByTestId("slash-menu")
    const rows = Array.from(
      menu.querySelectorAll<HTMLButtonElement>("[data-slash-row]")
    )
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("/workspace-check"),
      expect.stringContaining("/second-cmd"),
      expect.stringContaining("/compact"),
    ])
    // First plugin wins collision, localized description + hint rendered, agent duplicate hidden
    expect(rows[0]!.textContent).toContain("[label]")
    expect(rows[0]!.textContent).toContain("首个工作区检查")
    expect(menu.textContent).not.toContain("Duplicate shadowed by first")
    expect(menu.textContent).not.toContain("Agent shadowed command")

    // Selecting a plugin command inserts plain text + trailing space, NOT an agent command badge
    fireEvent.mouseDown(rows[0]!)
    expect(serializeDocToText(editor.state.doc)).toBe("/workspace-check ")
    expect(countReferenceNodes()).toBe(0)
    expect(screen.queryByTestId("slash-menu")).toBeNull()

    // Selecting an unshadowed agent command still inserts an inline reference badge
    setEditorPlainText("/comp")
    const agentMenu = await screen.findByTestId("slash-menu")
    fireEvent.mouseDown(within(agentMenu).getByText("/compact"))
    expect(countReferenceNodes()).toBe(1)
    expect(serializeDocToText(editor.state.doc)).toBe("/compact ")

    // Codex `$` skills remain completely unaffected
    setEditorPlainText("$dep")
    const skillMenu = await screen.findByTestId("slash-menu")
    fireEvent.mouseDown(within(skillMenu).getByText("Deploy Skill"))
    expect(countReferenceNodes()).toBe(1)
    expect(serializeDocToText(editor.state.doc)).toBe("$deploy-skill ")
    expect(onSend).not.toHaveBeenCalled()
  })

  it("executes scoped workspace/session commands with trimmed args, renders plain-text feedback or silent null, works when disconnected, and leaves non-matching prompts to onSend", async () => {
    const plugin = makeComposerCommandsPlugin()
    const host = createMockHostTransport([plugin], ({ input }) => {
      if (input.name === "workspace-check") {
        return {
          message: `Workspace ${input.folderId} — ${input.args} <img src=x>`,
        }
      }
      return null
    })
    h.transport = host.transport
    const onSend = vi.fn()
    const draftKey = "test-slash-draft"
    saveMessageInputDraftV2(draftKey, {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "/workspace-check hi" }],
        },
      ],
    })

    // 1) Workspace draft (disabled=true simulates disconnected agent; plugin command still submits!)
    const view = renderWithIntl(
      <MessageInput
        onSend={onSend}
        disabled
        promptCapabilities={CAPABILITIES}
        draftStorageKey={draftKey}
        pluginContext={{
          folderId: 7,
          conversationId: null,
          sessionKey: "ws-1",
        }}
      />
    )
    const editor = await waitForEditorReady()
    await waitFor(() => {
      expect(host.callMock).toHaveBeenCalledWith("host_plugins_list")
      expect(serializeDocToText(editor.state.doc)).toBe("/workspace-check hi")
    })

    setEditorPlainText("  /workspace-check   hello world  ")
    const sendButton = screen.getByTitle("Send")
    expect(sendButton).not.toBeDisabled()

    await userEvent.click(sendButton)

    await waitFor(() => {
      expect(pluginCalls(host)).toHaveLength(1)
    })
    expect(pluginCalls(host)[0]?.[1]).toEqual({
      pluginId: "codeg.composer-commands",
      method: "show-context",
      input: {
        name: "workspace-check",
        args: "hello world",
        folderId: 7,
        conversationId: null,
      },
    })
    expect(onSend).not.toHaveBeenCalled()

    // Draft cleared and short message rendered as plain text (HTML tag NOT parsed as element)
    await waitFor(() => {
      expect(serializeDocToText(editor.state.doc)).toBe("")
    })
    expect(loadMessageInputDraftV2(draftKey)).toBeNull()
    const status = await screen.findByRole("status")
    expect(status.textContent).toContain(
      "Workspace 7 — hello world <img src=x>"
    )
    expect(status.querySelector("img")).toBeNull()

    // 2) Switch to saved folderless chat: workspace-check is out of scope, session-check runs & returns null silently
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <MessageInput
          onSend={onSend}
          promptCapabilities={CAPABILITIES}
          pluginContext={{
            folderId: null,
            conversationId: 42,
            sessionKey: "chat-42",
          }}
        />
      </NextIntlClientProvider>
    )

    // Previous scope's feedback immediately disappears on scope switch
    expect(screen.queryByRole("status")).toBeNull()

    setEditorPlainText("/session-check   ping ")
    await userEvent.click(screen.getByTitle("Send"))

    await waitFor(() => {
      expect(pluginCalls(host)).toHaveLength(2)
    })
    expect(pluginCalls(host)[1]?.[1]).toEqual({
      pluginId: "codeg.composer-commands",
      method: "show-context",
      input: {
        name: "session-check",
        args: "ping",
        folderId: null,
        conversationId: 42,
      },
    })
    // Silent null success clears draft and displays NO status banner
    await waitFor(() => {
      expect(serializeDocToText(editor.state.doc)).toBe("")
    })
    expect(screen.queryByRole("status")).toBeNull()
    expect(screen.queryByRole("alert")).toBeNull()
    expect(onSend).not.toHaveBeenCalled()

    // Non-matching prefix or mid-sentence text passes straight through to onSend
    setEditorPlainText("/session-check-extra hello")
    await userEvent.click(screen.getByTitle("Send"))
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(pluginCalls(host)).toHaveLength(2)
  })

  it("blocks attachments, inline references, >8 KiB args, queue edit, prompting/steer safely without leaking to agent/queue/steer, and preserves draft on RPC failure", async () => {
    const plugin = makeComposerCommandsPlugin()
    const host = createMockHostTransport([plugin], () => {
      throw new Error("backend exploded")
    })
    h.transport = host.transport

    const onSend = vi.fn()
    const onEnqueue = vi.fn()
    const onSaveQueueEdit = vi.fn()
    const onSteer = vi.fn(async () => {})

    // 1) Image attachment present -> safe rejection, no leak to onSend or host_plugins_call
    h.attachmentsOverride = {
      attachments: [
        {
          id: "img-1",
          name: "shot.png",
          mimeType: "image/png",
          kind: "image",
          previewUrl: "blob:shot",
          status: "ready",
        },
      ],
      imageAttachments: [],
      hasUploadingImage: false,
    }
    const view = renderWithIntl(
      <MessageInput
        onSend={onSend}
        onEnqueue={onEnqueue}
        onSaveQueueEdit={onSaveQueueEdit}
        onSteer={onSteer}
        promptCapabilities={CAPABILITIES}
        pluginContext={{ folderId: 5, conversationId: 10, sessionKey: "s-1" }}
      />
    )
    const editor = await waitForEditorReady()
    await waitFor(() => {
      expect(host.callMock).toHaveBeenCalledWith("host_plugins_list")
    })

    setEditorPlainText("/workspace-check with-image")
    await userEvent.click(screen.getByTitle("Send"))
    expect(await screen.findByRole("alert")).toHaveTextContent("plain text")
    expect(pluginCalls(host)).toHaveLength(0)
    expect(onSend).not.toHaveBeenCalled()
    expect(serializeDocToText(editor.state.doc)).toBe(
      "/workspace-check with-image"
    )

    // 2) Inline reference badge after command -> safe rejection, no leak
    h.attachmentsOverride = null
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <MessageInput
          onSend={onSend}
          onEnqueue={onEnqueue}
          onSaveQueueEdit={onSaveQueueEdit}
          onSteer={onSteer}
          promptCapabilities={CAPABILITIES}
          pluginContext={{ folderId: 5, conversationId: 10, sessionKey: "s-1" }}
        />
      </NextIntlClientProvider>
    )
    act(() => {
      editor.commands.setContent(
        {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "/workspace-check " },
                {
                  type: "reference",
                  attrs: {
                    refType: "file",
                    id: "README.md",
                    label: "README.md",
                    uri: "file:///repo/README.md",
                  },
                },
              ],
            },
          ],
        },
        { emitUpdate: true }
      )
    })
    await userEvent.click(screen.getByTitle("Send"))
    expect(await screen.findByRole("alert")).toHaveTextContent("plain text")
    expect(pluginCalls(host)).toHaveLength(0)
    expect(onSend).not.toHaveBeenCalled()

    // 3) Args > 8 KiB UTF-8 -> safe rejection, draft retained
    setEditorPlainText(`/workspace-check ${"中".repeat(2731)}`)
    await userEvent.click(screen.getByTitle("Send"))
    expect(await screen.findByRole("alert")).toHaveTextContent("8 KiB")
    expect(pluginCalls(host)).toHaveLength(0)
    expect(onSend).not.toHaveBeenCalled()

    // 4) Queue edit mode -> never calls onSaveQueueEdit or plugin
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <MessageInput
          onSend={onSend}
          onEnqueue={onEnqueue}
          onSaveQueueEdit={onSaveQueueEdit}
          isEditingQueueItem
          promptCapabilities={CAPABILITIES}
          pluginContext={{ folderId: 5, conversationId: 10, sessionKey: "s-1" }}
        />
      </NextIntlClientProvider>
    )
    setEditorPlainText("/workspace-check queued")
    await userEvent.click(screen.getByTitle("Save"))
    expect(await screen.findByRole("alert")).toHaveTextContent("queued message")
    expect(onSaveQueueEdit).not.toHaveBeenCalled()
    expect(pluginCalls(host)).toHaveLength(0)

    // 5) Prompting mode (Queue + Steer controls) -> neither queues nor steers
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <MessageInput
          onSend={onSend}
          onEnqueue={onEnqueue}
          onSteer={onSteer}
          onCancel={() => {}}
          isPrompting
          promptCapabilities={CAPABILITIES}
          pluginContext={{ folderId: 5, conversationId: 10, sessionKey: "s-1" }}
        />
      </NextIntlClientProvider>
    )
    setEditorPlainText("/workspace-check mid-turn")
    await userEvent.click(screen.getByTitle("Queue message"))
    expect(await screen.findByRole("alert")).toHaveTextContent("response")
    expect(onEnqueue).not.toHaveBeenCalled()
    expect(onSend).not.toHaveBeenCalled()
    expect(pluginCalls(host)).toHaveLength(0)

    // Click Steer dropdown -> steer menu item -> blocked safely, never calls onSteer
    await userEvent.click(screen.getByLabelText("Send note for next check"))
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Send note for next check" })
    )
    expect(await screen.findByRole("alert")).toHaveTextContent("steered")
    expect(onSteer).not.toHaveBeenCalled()
    expect(onEnqueue).not.toHaveBeenCalled()
    expect(pluginCalls(host)).toHaveLength(0)

    // 6) Normal idle submit when plugin RPC throws -> draft preserved & error shown
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <MessageInput
          onSend={onSend}
          promptCapabilities={CAPABILITIES}
          pluginContext={{ folderId: 5, conversationId: 10, sessionKey: "s-1" }}
        />
      </NextIntlClientProvider>
    )
    setEditorPlainText("/workspace-check fail-me")
    await userEvent.click(screen.getByTitle("Send"))
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "backend exploded"
    )
    expect(serializeDocToText(editor.state.doc)).toBe(
      "/workspace-check fail-me"
    )

    // 7) Invalid return payload -> treated as failure, draft preserved
    host.setCallHandler(() => ({ unexpected: true }))
    await userEvent.click(screen.getByTitle("Send"))
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "invalid response"
    )
    expect(serializeDocToText(editor.state.doc)).toBe(
      "/workspace-check fail-me"
    )
  })

  it("prevents duplicate triggers while running and preserves draft when edited concurrently during RPC", async () => {
    const plugin = makeComposerCommandsPlugin()
    const gate = deferred<{ message: string }>()
    const host = createMockHostTransport([plugin], () => gate.promise)
    h.transport = host.transport
    const onSend = vi.fn()

    renderWithIntl(
      <MessageInput
        onSend={onSend}
        promptCapabilities={CAPABILITIES}
        pluginContext={{ folderId: 3, conversationId: null, sessionKey: "c-1" }}
      />
    )
    const editor = await waitForEditorReady()
    await waitFor(() => {
      expect(host.callMock).toHaveBeenCalledWith("host_plugins_list")
    })

    setEditorPlainText("/workspace-check first")
    await userEvent.click(screen.getByTitle("Send"))
    await waitFor(() => {
      expect(pluginCalls(host)).toHaveLength(1)
    })

    // Repeated submit while in flight is ignored (send button disabled + guard)
    expect(screen.getByTitle("Send")).toBeDisabled()
    fireEvent.keyDown(editor.view.dom, { key: "Enter" })
    expect(pluginCalls(host)).toHaveLength(1)

    // User edits draft while RPC is still in flight
    setEditorPlainText("/workspace-check edited-while-running")

    await act(async () => {
      gate.resolve({ message: "Workspace 3 — first" })
      await Promise.resolve()
    })

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Workspace 3 — first"
    )
    // Edited draft MUST NOT be wiped out
    expect(serializeDocToText(editor.state.doc)).toBe(
      "/workspace-check edited-while-running"
    )
  })

  it("withdraws commands and rejects stale callbacks on plugin disable, scope change, and same-remoteConnectionId transport replacement", async () => {
    const enabledPlugin = makeComposerCommandsPlugin()
    const disabledPlugin: InstalledPlugin = { ...enabledPlugin, enabled: false }

    // 1) Remote boot gate: ?remoteConnectionId=9 while activeRemoteId is null -> zero local transport calls
    window.history.replaceState({}, "", "/?remoteConnectionId=9")
    const localHost = createMockHostTransport([enabledPlugin])
    h.transport = localHost.transport
    h.activeRemoteId = null
    const onSend = vi.fn()

    const view = renderWithIntl(
      <MessageInput
        onSend={onSend}
        promptCapabilities={CAPABILITIES}
        pluginContext={{ folderId: 9, conversationId: null, sessionKey: "r-1" }}
      />
    )
    const editor = await waitForEditorReady()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(localHost.callMock).not.toHaveBeenCalled()

    // 2) Connect remote transport A for remoteConnectionId=9
    const staleGateA = deferred<{ message: string }>()
    const remoteHostA = createMockHostTransport(
      [enabledPlugin],
      () => staleGateA.promise
    )
    h.transport = remoteHostA.transport
    h.activeRemoteId = 9
    act(() => {
      h.notifyTransportChange()
    })
    await waitFor(() => {
      expect(remoteHostA.callMock).toHaveBeenCalledWith("host_plugins_list")
    })

    setEditorPlainText("/workspace-check from-a")
    await userEvent.click(screen.getByTitle("Send"))
    await waitFor(() => {
      expect(pluginCalls(remoteHostA)).toHaveLength(1)
    })

    // Replace transport under the SAME remoteConnectionId=9 while A's RPC is in flight
    const staleGateDisable = deferred<{ message: string }>()
    const remoteHostB = createMockHostTransport(
      [enabledPlugin],
      () => staleGateDisable.promise
    )
    h.transport = remoteHostB.transport
    h.activeRemoteId = 9
    act(() => {
      h.notifyTransportChange()
    })
    await waitFor(() => {
      expect(remoteHostB.callMock).toHaveBeenCalledWith("host_plugins_list")
    })

    // Late resolution from transport A MUST be ignored (no feedback, no draft clear)
    await act(async () => {
      staleGateA.resolve({ message: "Stale from A" })
      await Promise.resolve()
    })
    expect(screen.queryByRole("status")).toBeNull()
    expect(serializeDocToText(editor.state.doc)).toBe("/workspace-check from-a")

    // 3) Transport B is NOT blocked by A's old run; start a run on B, then disable plugin
    await userEvent.click(screen.getByTitle("Send"))
    await waitFor(() => {
      expect(pluginCalls(remoteHostB)).toHaveLength(1)
    })

    remoteHostB.setCatalog([disabledPlugin])
    await act(async () => {
      remoteHostB.emit("host-plugins://changed")
      await Promise.resolve()
      await Promise.resolve()
    })

    // Late resolution after disable MUST be ignored
    await act(async () => {
      staleGateDisable.resolve({ message: "Stale after disable" })
      await Promise.resolve()
    })
    expect(screen.queryByRole("status")).toBeNull()
    expect(serializeDocToText(editor.state.doc)).toBe("/workspace-check from-a")

    // 4) Re-enable plugin, start a run on scope r-1, then switch tab scope to r-2
    const staleScopeGate = deferred<{ message: string }>()
    remoteHostB.setCatalog([enabledPlugin])
    remoteHostB.setCallHandler(() => staleScopeGate.promise)
    await act(async () => {
      remoteHostB.emit("host-plugins://changed")
      await Promise.resolve()
      await Promise.resolve()
    })

    setEditorPlainText("/workspace-check tab-a")
    await userEvent.click(screen.getByTitle("Send"))
    await waitFor(() => {
      expect(pluginCalls(remoteHostB)).toHaveLength(2)
    })

    // Switch tab scope to r-2 while r-1 RPC is in flight
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <MessageInput
          onSend={onSend}
          promptCapabilities={CAPABILITIES}
          pluginContext={{
            folderId: 9,
            conversationId: null,
            sessionKey: "r-2",
          }}
        />
      </NextIntlClientProvider>
    )

    await act(async () => {
      staleScopeGate.resolve({ message: "Leaked from r-1" })
      await Promise.resolve()
    })
    expect(screen.queryByRole("status")).toBeNull()
    expect(serializeDocToText(editor.state.doc)).toBe("/workspace-check tab-a")
  })

  it("permanently invalidates an in-flight run across hide/show, away-and-back scope switches, sequential runs, and live getTransport() mismatch", async () => {
    const plugin = makeComposerCommandsPlugin()
    const run1Gate = deferred<{ message: string }>()
    const run2Gate = deferred<{ message: string }>()
    const run3Gate = deferred<{ message: string }>()
    let callIndex = 0
    const host = createMockHostTransport([plugin], () => {
      callIndex += 1
      if (callIndex === 1) return run1Gate.promise
      if (callIndex === 2) return run2Gate.promise
      return run3Gate.promise
    })
    h.transport = host.transport
    const onSend = vi.fn()
    const scopeA = { folderId: 7, conversationId: null, sessionKey: "tab-a" }
    const scopeB = { folderId: 7, conversationId: null, sessionKey: "tab-b" }

    // 1) Start Run 1 in scopeA, then hide and re-show keep-alive tab (ABA on pluginSlotEnabled)
    const view = renderWithIntl(
      <MessageInput
        onSend={onSend}
        promptCapabilities={CAPABILITIES}
        pluginContext={scopeA}
        pluginSlotEnabled
      />
    )
    const editor = await waitForEditorReady()
    await waitFor(() => {
      expect(host.callMock).toHaveBeenCalledWith("host_plugins_list")
    })

    setEditorPlainText("/workspace-check run-1")
    await userEvent.click(screen.getByTitle("Send"))
    await waitFor(() => {
      expect(pluginCalls(host)).toHaveLength(1)
    })

    // Hide keep-alive tab, then immediately show it again with the SAME scope & transport
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <MessageInput
          onSend={onSend}
          promptCapabilities={CAPABILITIES}
          pluginContext={scopeA}
          pluginSlotEnabled={false}
        />
      </NextIntlClientProvider>
    )
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <MessageInput
          onSend={onSend}
          promptCapabilities={CAPABILITIES}
          pluginContext={scopeA}
          pluginSlotEnabled
        />
      </NextIntlClientProvider>
    )
    await waitFor(() => {
      expect(screen.getByTitle("Send")).not.toBeDisabled()
    })

    // Start Run 2 in scopeA while Run 1 is still unsettled, then settle Run 1 first:
    // Run 1 MUST NOT clear the draft or write feedback for Run 2!
    await userEvent.click(screen.getByTitle("Send"))
    await waitFor(() => {
      expect(pluginCalls(host)).toHaveLength(2)
    })

    await act(async () => {
      run1Gate.resolve({ message: "Stale Run 1 after hide/show" })
      await Promise.resolve()
    })
    expect(screen.queryByRole("status")).toBeNull()
    expect(serializeDocToText(editor.state.doc)).toBe("/workspace-check run-1")

    // Now switch away to scopeB and right back to scopeA while Run 2 is in flight (ABA on scope)
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <MessageInput
          onSend={onSend}
          promptCapabilities={CAPABILITIES}
          pluginContext={scopeB}
          pluginSlotEnabled
        />
      </NextIntlClientProvider>
    )
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <MessageInput
          onSend={onSend}
          promptCapabilities={CAPABILITIES}
          pluginContext={scopeA}
          pluginSlotEnabled
        />
      </NextIntlClientProvider>
    )

    // Run 2 settles AFTER returning to the exact same scopeA -> still permanently rejected!
    await act(async () => {
      run2Gate.resolve({ message: "Stale Run 2 after A->B->A" })
      await Promise.resolve()
    })
    expect(screen.queryByRole("status")).toBeNull()
    expect(serializeDocToText(editor.state.doc)).toBe("/workspace-check run-1")

    // 2) Live getTransport() mismatch WITHOUT React transport notification yet:
    // Run 3 starts on host.transport, then getTransport() flips to a different
    // transport before Run 3 settles -> post-await gate rejects stale callback.
    await userEvent.click(screen.getByTitle("Send"))
    await waitFor(() => {
      expect(pluginCalls(host)).toHaveLength(3)
    })

    const swappedHost = createMockHostTransport([])
    // Swap underlying getTransport() directly without firing notifyTransportChange()
    h.transport = swappedHost.transport

    await act(async () => {
      run3Gate.resolve({ message: "Stale Run 3 after live transport swap" })
      await Promise.resolve()
    })
    expect(screen.queryByRole("status")).toBeNull()
    expect(serializeDocToText(editor.state.doc)).toBe("/workspace-check run-1")

    // 3) Pre-call live getTransport() guard: restore host.transport cleanly, then
    // swap getTransport() right before clicking Send (before any React re-render)
    // -> neither the old transport nor the unsubscribed transport is called.
    h.transport = host.transport
    act(() => {
      h.notifyTransportChange()
    })
    await waitFor(() => {
      expect(screen.getByTitle("Send")).not.toBeDisabled()
    })
    const staleSwapHost = createMockHostTransport([plugin])
    h.transport = staleSwapHost.transport
    await userEvent.click(screen.getByTitle("Send"))
    expect(pluginCalls(host)).toHaveLength(3)
    expect(pluginCalls(staleSwapHost)).toHaveLength(0)
  })
})
