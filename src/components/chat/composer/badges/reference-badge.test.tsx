import { fireEvent, render as rtlRender } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { RosterEntry } from "@/lib/types"
import {
  resetAssistantsStore,
  useAssistantsStore,
} from "@/stores/assistants-store"
import { usePersonalAgentRoster } from "@/stores/personal-agent-roster-store"

const follow = vi.hoisted(() => vi.fn())
vi.mock("@/lib/personal-agent-notify", () => ({
  followPersonalAgentLink: follow,
}))

import { ReferenceBadge } from "./reference-badge"
import type { ReferenceAttrs } from "../types"

function render(ui: ReactNode) {
  return rtlRender(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

function ref(partial: Partial<ReferenceAttrs>): ReferenceAttrs {
  return {
    refType: "file",
    id: "",
    label: "",
    uri: null,
    meta: null,
    ...partial,
  }
}

/** The badge root carries `data-reference-badge` and `data-ref-type`. */
function badgeOf(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>("[data-reference-badge]")
  if (!el) throw new Error("no reference badge rendered")
  return el
}

describe("ReferenceBadge", () => {
  it("renders the label and is vertically centered (align-middle)", () => {
    const { container } = render(
      <ReferenceBadge data={ref({ refType: "file", label: "app.ts" })} />
    )
    const badge = badgeOf(container)
    expect(badge).toHaveTextContent("app.ts")
    // Task 3: badges sit on the text's middle, not its baseline.
    expect(badge).toHaveClass("align-middle")
    expect(badge).not.toHaveClass("align-baseline")
  })

  it("colors a file reference blue with no background or border", () => {
    const { container } = render(
      <ReferenceBadge data={ref({ refType: "file", label: "app.ts" })} />
    )
    const badge = badgeOf(container)
    expect(badge).toHaveAttribute("data-ref-type", "file")
    // Text-only: a color, but no background / border (req 3).
    expect(badge).toHaveClass("text-blue-700")
    expect(badge.className).not.toMatch(/\bbg-/)
    expect(badge.className).not.toMatch(/\bborder\b/)
    expect(container.querySelector(".lucide-file-text")).not.toBeNull()
  })

  it("colors a session reference emerald with the conversation glyph", () => {
    const { container } = render(
      <ReferenceBadge data={ref({ refType: "session", label: "#42" })} />
    )
    const badge = badgeOf(container)
    expect(badge).toHaveAttribute("data-ref-type", "session")
    expect(badge).toHaveClass("text-emerald-700")
    // A session badge always shows the neutral conversation glyph (not the
    // owning agent's icon, not Hash) — see the `session` case in ReferenceIcon.
    expect(container.querySelector(".lucide-message-square")).not.toBeNull()
    expect(container.querySelector(".lucide-hash")).toBeNull()
  })

  it("shows the conversation glyph and no status dot even with agent/status meta", () => {
    // The inline badge ignores the owning agent and the live status: it never
    // shows an agent icon and never paints the trailing status dot (those belong
    // to the `@`-panel option row and the sidebar, not the inline chip).
    const { container } = render(
      <ReferenceBadge
        data={ref({
          refType: "session",
          label: "Login refactor",
          meta: { agentType: "codex", status: "in_progress" },
        })}
      />
    )
    expect(container.querySelector(".lucide-message-square")).not.toBeNull()
    // No agent icon: AgentIcon for codex renders an <svg> with <title>Codex</title>;
    // the conversation glyph carries no <title>, so none should be present.
    expect(container.querySelector("title")).toBeNull()
    // No trailing status dot (the removed `rounded-full` indicator).
    expect(container.querySelector(".rounded-full")).toBeNull()
  })

  it("renders a command/skill with the command glyph, colored rose", () => {
    const { container } = render(
      <ReferenceBadge
        data={ref({
          refType: "skill",
          id: "build",
          label: "build",
          meta: { invocationPrefix: "/" },
        })}
      />
    )
    const badge = badgeOf(container)
    expect(badge).toHaveAttribute("data-ref-type", "skill")
    expect(badge).toHaveClass("text-rose-700")
    expect(container.querySelector(".lucide-command")).not.toBeNull()
  })

  it("renders an expert with the SAME command glyph + color (unified, no star)", () => {
    const { container } = render(
      <ReferenceBadge
        data={ref({
          refType: "skill",
          id: "reviewer",
          label: "Reviewer",
          meta: { scope: "expert", invocationPrefix: "/" },
        })}
      />
    )
    const badge = badgeOf(container)
    expect(badge).toHaveAttribute("data-ref-type", "skill")
    // Experts are no longer distinguished — same rose color, command glyph.
    expect(badge).toHaveClass("text-rose-700")
    expect(container.querySelector(".lucide-command")).not.toBeNull()
    expect(container.querySelector(".lucide-sparkles")).toBeNull()
  })
})

describe("ReferenceBadge — assistants", () => {
  const botRef = (uid: string, label: string) =>
    ref({
      refType: "assistant",
      id: uid,
      label,
      uri: `codeg://bot/${uid}`,
      meta: { botUid: uid },
    })
  const legacyRef = (id: number, label: string) =>
    ref({
      refType: "assistant",
      id: String(id),
      label,
      uri: `codeg://assistant/${id}`,
      meta: { assistantId: id },
    })
  const entry = (
    id: number,
    over: { name?: string; kind?: string; legacy?: number | null } = {}
  ) => ({
    id,
    kind: over.kind ?? "worker",
    uid: `u-${id}`,
    name: over.name ?? `Assistant ${id}`,
    avatar: { kind: "emoji", emoji: "🦉", color: "teal" },
    legacy_assistant_id: over.legacy ?? null,
  })

  const setRoster = (entries: unknown[]) =>
    usePersonalAgentRoster.setState({
      entries: entries as unknown as RosterEntry[],
    })

  beforeEach(() => {
    resetAssistantsStore()
    setRoster([])
    follow.mockReset()
  })

  it("draws the assistant's face and its name now, and opens it outside the editor", () => {
    setRoster([entry(7, { name: "Renamed since" })])
    const { container, unmount } = render(
      <ReferenceBadge data={botRef("u-7", "Reviewer")} />
    )
    const badge = badgeOf(container)
    expect(badge).toHaveTextContent("🦉")
    // The one a click opens is the one named: its name as it is now.
    expect(badge).toHaveTextContent("Renamed since")
    expect(badge).toHaveClass("text-teal-700")
    // In the editor: a plain pill.
    expect(badge.getAttribute("role")).toBe("img")
    fireEvent.click(badge)
    expect(follow).not.toHaveBeenCalled()
    unmount()

    const sent = render(
      <ReferenceBadge data={botRef("u-7", "Reviewer")} openable />
    )
    const link = badgeOf(sent.container)
    expect(link.getAttribute("role")).toBe("link")
    fireEvent.click(link)
    expect(follow).toHaveBeenCalledWith({
      kind: "bot",
      bot_id: 7,
      row_id: null,
    })
  })

  it("names the primary with no name of its own by its role", () => {
    setRoster([entry(1, { name: "", kind: "primary" })])
    const { container } = render(
      <ReferenceBadge data={botRef("u-1", "Atlas")} />
    )
    expect(badgeOf(container)).toHaveTextContent("Personal agent")
    expect(badgeOf(container)).not.toHaveTextContent("Atlas")
  })

  it("greys one that is not on the roster, with the name the link has, and opens nothing", () => {
    const { container } = render(
      <ReferenceBadge data={botRef("u-9", "Gone")} openable />
    )
    const badge = badgeOf(container)
    expect(badge).toHaveTextContent("Gone")
    expect(badge).toHaveClass("text-muted-foreground")
    expect(badge.getAttribute("role")).toBe("img")
    fireEvent.click(badge)
    expect(follow).not.toHaveBeenCalled()
  })

  it("shows an old link as the assistant converted from it", () => {
    setRoster([entry(12, { name: "Reviewer now", legacy: 3 })])
    const { container } = render(
      <ReferenceBadge data={legacyRef(3, "Reviewer")} openable />
    )
    const badge = badgeOf(container)
    expect(badge).toHaveTextContent("Reviewer now")
    fireEvent.click(badge)
    expect(follow).toHaveBeenCalledWith({
      kind: "bot",
      bot_id: 12,
      row_id: null,
    })
  })

  it("shows an old link no assistant came from as the collaboration settings had it", () => {
    useAssistantsStore.getState().merge([
      {
        id: 3,
        uid: "u-3",
        name: "Old reviewer",
        description: "",
        avatar: { kind: "emoji", emoji: "🐢", color: "teal" },
        agent_type: "codex",
        agent_options: { config_values: {} },
        label_snapshot: { agent: "Codex", mode: null, options: [] },
        instructions: "",
        enabled: true,
        sort_order: 1,
        revision: 2,
        created_at: "2026-10-16T00:00:00Z",
        updated_at: "2026-10-16T00:00:00Z",
        deleted_at: null,
      },
    ])
    const { container } = render(
      <ReferenceBadge data={legacyRef(3, "Reviewer")} />
    )
    const badge = badgeOf(container)
    expect(badge).toHaveTextContent("🐢")
    expect(badge).toHaveTextContent("Reviewer")
  })
})
