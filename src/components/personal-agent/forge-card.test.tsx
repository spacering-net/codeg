/**
 * 2.2: what an assistant does on a forge (7.4), and the team changed from
 * the conversation (10.5) — the forge card, the "changed" card's work
 * assistant and executor config items, and the card about an executor
 * config made or to make.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import zhMessages from "@/i18n/messages/zh-CN.json"
import type { TimelineRow } from "@/lib/types"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

const api = vi.hoisted(() => ({
  personalAgentNoticeAct: vi.fn(),
}))
vi.mock("@/lib/api", () => api)
const platform = vi.hoisted(() => ({ openUrl: vi.fn() }))
vi.mock("@/lib/platform", () => platform)
vi.mock("@/contexts/personal-agent-context", () => ({
  useBotId: () => 7,
  usePersonalAgent: () => ({
    liveReplies: new Map(),
    dispatchById: new Map(),
    quoted: new Map(),
    requestQuoted: () => {},
    rows: [],
  }),
}))
vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({ setRoute: vi.fn(), openConversations: vi.fn() }),
}))
vi.mock("@/contexts/tab-context", () => ({
  useTabActions: () => ({ openTab: vi.fn() }),
}))

import { waitsForOwner } from "./message-list"
import { buildMessageItems, type MessageItem } from "./message-items"
import { NoticeCard } from "./notice-card"
import { PageScopeContext, type PageScope } from "./shared"

function row(data: Record<string, unknown>, body = "Card"): TimelineRow {
  return {
    id: 60,
    segment_id: 1,
    batch_id: null,
    kind: "notice",
    status: null,
    body,
    data,
    dispatch_id: null,
    ref_id: "21",
    reply_to: null,
    read_at: null,
    event_id: null,
    seen_at: null,
    created_at: "2026-11-12T07:00:00Z",
    updated_at: "2026-11-12T07:00:00Z",
  }
}

function forge(data: Record<string, unknown>): TimelineRow {
  return row(
    {
      notice: "forge",
      action: "comment",
      state: "done",
      why: "direct",
      target: {
        provider: "GitHub",
        host: "github.com",
        repo: "acme/app",
        kind: "pr",
        number: 7,
        url: "https://github.com/acme/app/pull/7",
        account: "codeg-bot",
        task_id: null,
      },
      body: "Fixed in abc.",
      method: null,
      head: null,
      checks: null,
      version: null,
      guaranteed: false,
      reason: null,
      ...data,
    },
    "Comment on acme/app#7"
  )
}

function scope(readOnly = false): PageScope {
  return {
    readOnly,
    agentName: "Aide",
    liveRowId: null,
    connectionId: null,
    agentType: null,
    onQuote: vi.fn(),
    jumpTo: vi.fn(),
    rowsById: new Map(),
  }
}

function draw(r: TimelineRow, { readOnly = false, zh = false } = {}) {
  const item = buildMessageItems([r]).find((i) => i.kind === "notice")
  if (!item) throw new Error("no notice item")
  return render(
    <NextIntlClientProvider
      locale={zh ? "zh-CN" : "en"}
      messages={zh ? zhMessages : enMessages}
    >
      <PageScopeContext.Provider value={scope(readOnly)}>
        <NoticeCard item={item as Extract<MessageItem, { kind: "notice" }>} />
      </PageScopeContext.Provider>
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  api.personalAgentNoticeAct.mockReset().mockResolvedValue({})
  platform.openUrl.mockReset().mockResolvedValue(undefined)
  usePersonalAgentUi.setState({
    settings: null,
    botPage: null,
  })
})

afterEach(cleanup)

describe("a forge card", () => {
  it("shows a comment done, its full text, and opens its link", () => {
    draw(
      forge({
        result: { url: "https://github.com/acme/app/pull/7#issuecomment-1" },
      })
    )
    expect(screen.getByText("Done on GitHub")).toBeInTheDocument()
    expect(screen.getByText("Comment on acme/app#7")).toBeInTheDocument()
    expect(screen.getByText("Fixed in abc.")).toBeInTheDocument()
    expect(screen.getByText("GitHub · codeg-bot")).toBeInTheDocument()
    const open = screen.getByRole("button", { name: "Open" })
    // Alone on the card: a button that looks one, on its last band.
    expect(open.getAttribute("data-variant")).toBe("secondary")
    expect(open.closest("[data-pa-sheet-actions]")).not.toBeNull()
    // A card of its own: no bubble round it.
    const card = open.closest("[data-pa-card-message]")!
    expect(card).not.toBeNull()
    expect(card.closest(".pa-agent-bubble")).toBeNull()
    fireEvent.click(open)
    expect(platform.openUrl).toHaveBeenCalledWith(
      "https://github.com/acme/app/pull/7#issuecomment-1"
    )
  })

  it("waits for approval when the owner asked for it, and sends their answer", async () => {
    const r = forge({ state: "open", why: "confirm" })
    expect(waitsForOwner(r)).toBe(true)
    draw(r)
    expect(screen.getByText("Waiting for your approval")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Approve" }))
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(21, "accept", 7)
    )
    cleanup()
    draw(r)
    fireEvent.click(screen.getByRole("button", { name: "Decline" }))
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(21, "dismiss", 7)
    )
  })

  it("does not ask anything of a suggestion it only shows", () => {
    expect(waitsForOwner(forge({ state: "open", why: "suggest" }))).toBe(false)
    draw(forge({ state: "open", why: "suggest" }))
    expect(
      screen.getByText("A suggestion, for you to approve")
    ).toBeInTheDocument()
  })

  it("offers a look, doing it again after checking the forge, or letting it be when in doubt", async () => {
    const r = forge({ state: "unknown", error: "the forge did not answer" })
    expect(waitsForOwner(r)).toBe(true)
    draw(r)
    expect(screen.getByText("Not sure it went through")).toBeInTheDocument()
    expect(
      screen.getByText(/The forge didn't answer: the forge did not answer/)
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Look" }))
    expect(platform.openUrl).toHaveBeenCalledWith(
      "https://github.com/acme/app/pull/7"
    )
    fireEvent.click(screen.getByRole("button", { name: "Do it again" }))
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(21, "retry", 7)
    )
    expect(
      screen.getByRole("button", { name: "Let it be" })
    ).toBeInTheDocument()
  })

  it("shows a merge's head, checks, version and merge commit", () => {
    draw(
      forge({
        action: "merge",
        body: null,
        method: "squash",
        head: "acc3pt3d0000",
        checks: "green",
        version: "accepted",
        guaranteed: true,
        result: { merge_commit: "m3rg3c0mm17", url: null },
      })
    )
    expect(screen.getByText("Merge acme/app#7")).toBeInTheDocument()
    expect(screen.getByText("Head acc3pt3 · squash")).toBeInTheDocument()
    expect(screen.getByText("Checks: all passed")).toBeInTheDocument()
    expect(
      screen.getByText("The version its acceptance passed")
    ).toBeInTheDocument()
    expect(screen.getByText("Merge commit m3rg3c0")).toBeInTheDocument()
    expect(document.querySelector("[data-pa-forge-unguaranteed]")).toBeNull()
  })

  it("says why a merge was not made: commits after its acceptance", () => {
    draw(
      forge({
        action: "merge",
        state: "refused",
        body: null,
        head: "n3wc0mm1t",
        code: "after_acceptance",
        error: "the pull request has commits after its acceptance",
      })
    )
    expect(screen.getByText("Not merged")).toBeInTheDocument()
    expect(
      screen.getByText("The PR has commits after its acceptance")
    ).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull()
  })

  it("marks a CNB merge as not guaranteed, its checks unknown", () => {
    draw(
      forge({
        action: "merge",
        state: "open",
        why: "cnb",
        body: null,
        target: {
          provider: "CNB",
          host: "cnb.cool",
          repo: "acme/app",
          kind: "pr",
          number: 3,
          url: null,
          account: null,
          task_id: null,
        },
        head: "h34d",
        checks: "unknown",
        version: "green",
        guaranteed: false,
      })
    )
    expect(
      screen.getByText("A merge on CNB: always yours to approve")
    ).toBeInTheDocument()
    expect(
      screen.getByText("Checks: unknown (CNB can't read checks)")
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        "Version not guaranteed (the forge takes no head with a merge)"
      )
    ).toBeInTheDocument()
  })

  it("says an approval whose premises changed was not run", () => {
    draw(
      forge({
        action: "merge",
        state: "not_run",
        body: null,
        error: "its head moved from h34d1 to h34d2",
      })
    )
    expect(screen.getByText("Not done: things changed")).toBeInTheDocument()
    expect(
      screen.getByText("Not done: its head moved from h34d1 to h34d2")
    ).toBeInTheDocument()
  })

  it("names a GitLab merge request with a bang, in Chinese too", () => {
    draw(
      forge({
        action: "close",
        target: {
          provider: "GitLab",
          host: "gitlab.com",
          repo: "acme/app",
          kind: "pr",
          number: 5,
          url: null,
          account: null,
          task_id: null,
        },
        body: null,
      }),
      { zh: true }
    )
    expect(screen.getByText("关闭 acme/app!5")).toBeInTheDocument()
  })
})

describe("the team changed from the conversation", () => {
  const changed = (data: Record<string, unknown>) =>
    row({ notice: "changed", state: "applied", why: "asked", ...data })

  it("names a work assistant's items, with the options codeg picked", () => {
    draw(
      changed({
        changes: [
          { key: "bot.u-1.name", from: "Dev", to: "Yan" },
          {
            key: "bot.u-1.brain",
            from: {
              agent_type: "claude_code",
              agent_options: { config_values: {} },
              label_snapshot: { agent: "Claude Code", mode: null, options: [] },
            },
            to: {
              agent_type: "codex",
              agent_options: { config_values: { model: "gpt" } },
              label_snapshot: {
                agent: "Codex",
                mode: null,
                options: [
                  {
                    id: "model",
                    kind: "select",
                    name: "Model",
                    value_label: "GPT-5.5",
                  },
                ],
              },
            },
            picked: [
              {
                id: "model",
                name: "Model",
                value: "gpt",
                value_label: "GPT-5.5",
                from: "agent",
              },
            ],
          },
          {
            key: "bot.u-1.work_agent",
            from: null,
            to: {
              agent_type: "codex",
              agent_options: { config_values: {} },
              label_snapshot: { agent: "Codex", mode: null, options: [] },
            },
          },
          {
            key: "bot.u-1.avatar",
            from: { kind: "face", shape: "ring", color: "red" },
            to: { kind: "face", shape: "magnifier", color: "teal" },
          },
        ],
        names: { "bot:u-1": "Yan" },
      })
    )
    expect(screen.getByText("Yan · name")).toBeInTheDocument()
    expect(screen.getByText("Yan · brain")).toBeInTheDocument()
    expect(screen.getByText("Codex · GPT-5.5")).toBeInTheDocument()
    expect(screen.getByText("agent's default")).toBeInTheDocument()
    // The agent its work runs on, never an executor config's name.
    expect(screen.getByText("Yan · agent its work runs on")).toBeInTheDocument()
    expect(screen.getByText("nothing set")).toBeInTheDocument()
    expect(screen.getByText("Codex")).toBeInTheDocument()
    expect(screen.getByText("Magnifier · Teal")).toBeInTheDocument()
  })

  it("shows a persona's change whole: the opening it has, the one it gets", () => {
    draw(
      changed({
        state: "open",
        why: "show",
        changes: [
          {
            key: "bot.u-1.persona",
            from: "I write code.",
            to: "I write code and its tests.\nI keep PRs small.",
          },
        ],
        names: { "bot:u-1": "Yan" },
        unchecked_quote: "tests too",
      })
    )
    expect(screen.getByText("Yan · persona")).toBeInTheDocument()
    const change = document.querySelector("[data-pa-persona-change]")!
    expect(change.querySelector("[data-pa-persona-from]")?.textContent).toBe(
      "I write code."
    )
    expect(change.querySelector("[data-pa-persona-to]")?.textContent).toBe(
      "I write code and its tests.\nI keep PRs small."
    )
    expect(
      screen.getByText(
        "The primary says you said “tests too” — but you didn't type it this turn"
      )
    ).toBeInTheDocument()
    expect(screen.queryByText(/You said/)).toBeNull()
  })
})
