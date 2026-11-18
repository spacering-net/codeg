import { useEffect, useState as useReactState } from "react"
import {
  act,
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

const mocks = vi.hoisted(() => ({
  engine: null as null | {
    handle: (command: string, args?: Record<string, unknown>) => unknown
  },
  listeners: new Map<string, Set<(payload: unknown) => void>>(),
  reconnect: new Set<() => void>(),
  mobile: false,
  desktop: true,
  remote: null as null | { connection: { name: string; base_url: string } },
  revealed: [] as string[],
}))

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({
    call: async (command: string, args?: Record<string, unknown>) =>
      mocks.engine?.handle(command, args),
    subscribe: async (event: string, handler: (payload: unknown) => void) => {
      const set = mocks.listeners.get(event) ?? new Set()
      set.add(handler)
      mocks.listeners.set(event, set)
      return () => set.delete(handler)
    },
    onReconnect: (callback: () => void) => {
      mocks.reconnect.add(callback)
      return () => mocks.reconnect.delete(callback)
    },
  }),
  getActiveRemoteConnectionId: () => (mocks.remote ? 7 : null),
  isDesktop: () => mocks.desktop,
}))
vi.mock("@/lib/platform", () => ({
  isDesktop: () => mocks.desktop,
  isLocalDesktop: () => mocks.desktop && !mocks.remote,
  revealItemInDir: async (path: string) => {
    mocks.revealed.push(path)
  },
  openUrl: async () => {},
  subscribe: async () => () => {},
  onTransportReconnect: () => () => {},
}))
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => mocks.mobile }))
vi.mock("@/contexts/remote-connection-context", () => ({
  useRemoteConnection: () => mocks.remote,
}))

import {
  HarnessViewProvider,
  useHarnessView,
} from "@/contexts/harness-view-context"
import { useAgentSkills } from "@/hooks/use-agent-skills"
import {
  SKILLS_DIALOG,
  SKILLS_SELECTED,
  SKILLS_VIEW,
} from "@/lib/harness/skills-state"
import {
  createEngine,
  ownDir,
  SHARED_DIR,
  STORE,
  type Engine,
  type EngineOptions,
} from "@/lib/skills/test-fixtures"
import { SkillsSection } from "./skills-section"

const m = enMessages.Harness.skills

// ─── Rendering ────────────────────────────────────────────────────────

type View = ReturnType<typeof useHarnessView>
let view: View

function Capture() {
  const current = useHarnessView()
  useEffect(() => {
    view = current
  })
  return null
}

/** A composer's `$` menu: what the chat reads of an agent's skills. */
function Composer({ agent }: { agent: string }) {
  const skills = useAgentSkills(agent, null)
  return (
    <ul data-testid={`composer-${agent}`}>
      {skills.map((skill) => (
        <li key={skill.id}>{skill.id}</li>
      ))}
    </ul>
  )
}

function Harness({
  show = true,
  composer,
}: {
  show?: boolean
  composer?: string
}) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <HarnessViewProvider>
        <Capture />
        {composer && <Composer agent={composer} />}
        {show && <SkillsSection />}
      </HarnessViewProvider>
    </NextIntlClientProvider>
  )
}

let engine: Engine

function setup(options: EngineOptions) {
  engine = createEngine(options)
  engine.onChanged = (change) => {
    // As the backend does: every window hears of a change, this one too.
    queueMicrotask(() => {
      for (const handler of mocks.listeners.get("skills://changed") ?? []) {
        handler(change)
      }
    })
  }
  mocks.engine = engine
  return engine
}

const callsOf = (command: string) =>
  engine.calls.filter((call) => call.command === command)
const preflights = () =>
  callsOf("skills_apply_links").filter((call) => call.args.preflight === true)
const realRuns = () =>
  callsOf("skills_apply_links").filter((call) => call.args.preflight !== true)
const lastRepair = () => {
  const calls = callsOf("skills_repair_link")
  return calls[calls.length - 1]
}

/** Another window — or another client — changed skills, and said so. */
async function emitChanged(kinds = ["links"], agents: string[] = []) {
  await act(async () => {
    for (const handler of mocks.listeners.get("skills://changed") ?? []) {
      handler({ kinds, agents })
    }
  })
}

function stubWidth(width: number): () => void {
  const original = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "clientWidth"
  )
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => width,
  })
  return () => {
    if (original) {
      Object.defineProperty(HTMLElement.prototype, "clientWidth", original)
    } else {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)
        .clientWidth
    }
  }
}

/** The usual host: Claude Code with a folder of its own; Codex, Gemini and
 *  Cline sharing `~/.agents/skills` beside theirs; one custom agent with only
 *  the shared folder. */
function usualHost(): EngineOptions {
  return {
    agents: [
      { agent: "claude_code" },
      { agent: "codex", shared: true },
      { agent: "gemini", shared: true },
      { agent: "cline", shared: true },
      { agent: "custom:only-shared", own: false, shared: true },
    ],
    skills: [
      {
        id: "my-flow",
        origin: "custom",
        name: "My flow",
        description: "Ship it the way I like.",
        cells: { claude_code: "linked" },
      },
      {
        id: "pdf-tools",
        origin: "harness",
        name: "PDF tools",
        harness: { ref: "acme/pdf-tools", version: "1.2.0" },
        cells: {
          codex: "through",
          gemini: "through",
          cline: "through",
          "custom:only-shared": "through",
        },
      },
      {
        id: "brainstorming",
        origin: "experts",
        cells: { claude_code: "linked" },
      },
    ],
  }
}

beforeEach(() => {
  localStorage.clear()
  mocks.listeners.clear()
  mocks.reconnect.clear()
  mocks.mobile = false
  mocks.desktop = true
  mocks.remote = null
  mocks.revealed = []
})

let restoreWidth: (() => void) | null = null
afterEach(() => {
  restoreWidth?.()
  restoreWidth = null
})

/** A wide pane: the matrix beside the detail. */
function wide() {
  restoreWidth = stubWidth(1600)
}

async function openSkill(name: string) {
  const row = await screen.findByRole("button", { name })
  await userEvent.click(row)
  return screen.findByRole("article")
}

// ─── The two views ────────────────────────────────────────────────────

describe("SkillsSection — Codeg-managed skills", () => {
  it("lists the store's Custom and Harness skills, not the packs'", async () => {
    setup(usualHost())
    render(<Harness />)
    expect(await screen.findByRole("button", { name: "My flow" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "PDF tools" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "brainstorming" })).toBeNull()
    // Each marked with where it comes from; Harness with its version.
    expect(screen.getAllByText(m.origins.custom).length).toBeGreaterThan(0)
    expect(screen.getAllByText("SRN Harness 1.2.0").length).toBeGreaterThan(0)
  })

  it("shows each agent's cell in words, a shared folder said as such", async () => {
    setup(usualHost())
    render(<Harness />)
    const article = await openSkill("PDF tools")
    const rows = within(article).getAllByRole("listitem")
    const codex = rows.find((row) => row.textContent?.includes("Codex"))!
    // A mark beside the name says on or off; the line under it, how.
    expect(
      within(codex).getByRole("switch", { name: "Codex" })
    ).toHaveAccessibleDescription(
      new RegExp(`^${m.cells.on} Through the shared folder`)
    )
    expect(codex.textContent).toContain(SHARED_DIR)
    expect(codex.textContent).toContain("Also seen by")
    // Claude Code has nothing of it: the mark alone says so.
    const claude = rows.find((row) => row.textContent?.includes("Claude Code"))!
    expect(
      within(claude).getByRole("switch", { name: "Claude Code" })
    ).toHaveAccessibleDescription(m.cells.off)
  })

  it("draws the matrix on a wide pane, a cell per agent", async () => {
    wide()
    setup(usualHost())
    render(<Harness />)
    const cell = await screen.findByRole("switch", {
      name: "My flow, Claude Code: On",
    })
    expect(cell).toHaveAttribute("aria-checked", "true")
    expect(
      screen.getByRole("switch", {
        name: `PDF tools, Codex: On, through the shared folder ${SHARED_DIR}`,
      })
    ).toHaveAttribute("aria-checked", "true")
  })

  it("lists the skills instead of a matrix with no agent's column to draw", async () => {
    wide()
    setup({
      agents: [{ agent: "codex", shared: true }],
      skills: [{ id: "my-flow", origin: "custom", name: "My flow", cells: {} }],
    })
    // Codex is not installed and holds none of them: folded away.
    engine.answer.acp_list_agents = () => [
      {
        agent_type: "codex",
        name: "codex",
        skills_capable: true,
        sort_order: 0,
        installed_version: null,
        custom_source: null,
        env: {},
        enabled: true,
      },
    ]
    render(<Harness />)
    const row = await screen.findByRole("button", { name: /^My flow/ })
    expect(row.textContent).toContain("No agents shown")
    expect(screen.queryByRole("table")).toBeNull()
  })
})

// ─── Effects on other agents ──────────────────────────────────────────

describe("SkillsSection — the confirmation for effects on other agents", () => {
  it("turns a skill on at once for an agent with a folder of its own", async () => {
    wide()
    setup(usualHost())
    render(<Harness />)
    await userEvent.click(
      await screen.findByRole("switch", { name: "PDF tools, Claude Code: Off" })
    )
    await waitFor(() => expect(realRuns()).toHaveLength(1))
    // Nothing to ask: its own folder reaches no one else.
    expect(preflights()).toHaveLength(0)
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(realRuns()[0].args.ops).toEqual([
      { skill: "pdf-tools", agent: "claude_code", action: "enable" },
    ])
    expect(
      await screen.findByRole("switch", { name: "PDF tools, Claude Code: On" })
    ).toHaveAttribute("aria-checked", "true")
  })

  it("shows who else starts seeing it before linking into a shared folder, and sends the ack it showed", async () => {
    wide()
    setup(usualHost())
    render(<Harness />)
    await userEvent.click(
      await screen.findByRole("switch", {
        name: /^My flow, custom:only-shared: Off/,
      })
    )
    const dialog = await screen.findByRole("dialog")
    expect(dialog.textContent).toContain(m.effects.gains)
    for (const agent of ["Codex", "Gemini CLI", "Cline"]) {
      expect(dialog.textContent).toContain(agent)
    }
    expect(dialog.textContent).toContain(SHARED_DIR)
    // Planned, not written.
    expect(preflights()).toHaveLength(1)
    expect(engine.writes()).toHaveLength(0)

    const ack = (
      (preflights()[0].args.ops as unknown[])[0] as unknown as { skill: string }
    ).skill
    expect(ack).toBe("my-flow")
    await userEvent.click(
      within(dialog).getByRole("button", { name: m.effects.confirm.on })
    )
    await waitFor(() => expect(engine.writes()).toHaveLength(1))
    expect(engine.writes()[0]).toEqual([
      {
        skill: "my-flow",
        agent: "custom:only-shared",
        action: "enable",
        ack: "ack-my-flow-custom:only-shared-enable-1",
      },
    ])
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  it("lists everyone who loses it before turning off a link in a shared folder", async () => {
    wide()
    setup(usualHost())
    render(<Harness />)
    await userEvent.click(
      await screen.findByRole("switch", {
        name: /^PDF tools, Codex: On, through/,
      })
    )
    const dialog = await screen.findByRole("dialog")
    expect(dialog.textContent).toContain(m.effects.loses)
    expect(dialog.textContent).toContain("Gemini CLI")
    expect(dialog.textContent).toContain("Cline")
    expect(dialog.textContent).toContain(
      "Gemini CLI, Cline, custom:only-shared read the same folder, so they lose it too."
    )
    expect(engine.writes()).toHaveLength(0)
  })

  it("writes nothing when the confirmation is cancelled", async () => {
    wide()
    setup(usualHost())
    render(<Harness />)
    await userEvent.click(
      await screen.findByRole("switch", {
        name: /^PDF tools, Codex: On, through/,
      })
    )
    const dialog = await screen.findByRole("dialog")
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Cancel" })
    )
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(realRuns()).toHaveLength(0)
    expect(engine.writes()).toHaveLength(0)
  })

  it("plans again and asks again when the effects changed before the confirmation", async () => {
    wide()
    setup(usualHost())
    render(<Harness />)
    await userEvent.click(
      await screen.findByRole("switch", {
        name: /^PDF tools, Codex: On, through/,
      })
    )
    let dialog = await screen.findByRole("dialog")
    // Another agent's link appears meanwhile: the ack shown is stale.
    engine.bumpEffects()
    await userEvent.click(
      within(dialog).getByRole("button", { name: m.effects.confirm.off })
    )

    await waitFor(() =>
      expect(screen.getByRole("dialog").textContent).toContain(
        m.effects.changed
      )
    )
    // The engine refused it unwritten, and the page planned it again.
    expect(engine.writes()).toHaveLength(0)
    expect(realRuns()).toHaveLength(1)
    expect(preflights()).toHaveLength(2)

    dialog = screen.getByRole("dialog")
    await userEvent.click(
      within(dialog).getByRole("button", { name: m.effects.confirm.off })
    )
    await waitFor(() => expect(engine.writes()).toHaveLength(1))
    expect(engine.writes()[0][0].ack).toBe("ack-pdf-tools-codex-disable-2")
  })

  it("turns a refused direct save into the question it needs", async () => {
    wide()
    setup(usualHost())
    // The disk changed after it was read: Claude Code's turn-on would now
    // reach someone else.
    const op = {
      index: 0,
      skill: "pdf-tools",
      agent: "claude_code",
      action: "enable",
      status: "needs_ack",
      creates: [{ path: `${SHARED_DIR}/pdf-tools`, kind: "link" }],
      removes: [],
      moves: [],
      gains: ["codex"],
      loses: [],
      touches: [],
      ack: "fresh-ack",
      warnings: [],
    }
    engine.answer.skills_apply_links = (args) =>
      args.preflight
        ? {
            outcome: "preflight",
            ok: true,
            issues: [],
            ops: [{ ...op, issues: [] }],
          }
        : {
            outcome: "acknowledgement_required",
            ok: false,
            issues: [],
            ops: [
              {
                ...op,
                issues: [
                  { code: "acknowledgement_required", agents: ["codex"] },
                ],
              },
            ],
          }
    render(<Harness />)
    await userEvent.click(
      await screen.findByRole("switch", { name: "PDF tools, Claude Code: Off" })
    )
    const dialog = await screen.findByRole("dialog")
    expect(dialog.textContent).toContain(m.effects.gains)
    expect(dialog.textContent).toContain("Codex")
    // Sent once without an ack, refused unwritten, then planned to be asked.
    expect(realRuns()).toHaveLength(1)
    expect(preflights()).toHaveLength(1)
    expect(engine.writes()).toHaveLength(0)
  })

  it("keeps a skill for one agent only, after saying who loses it", async () => {
    setup(usualHost())
    render(<Harness />)
    const article = await openSkill("PDF tools")
    await userEvent.click(
      within(article).getByRole("button", { name: "Only for Codex…" })
    )
    const dialog = await screen.findByRole("dialog")
    expect(dialog.textContent).toContain(m.effects.move)
    expect(dialog.textContent).toContain(`${ownDir("codex")}/pdf-tools`)
    expect(dialog.textContent).toContain(m.effects.loses)
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Keep for Codex only" })
    )
    await waitFor(() => expect(engine.writes()).toHaveLength(1))
    expect(engine.writes()[0]).toEqual([
      {
        skill: "pdf-tools",
        agent: "codex",
        action: "only",
        ack: "ack-pdf-tools-codex-only-1",
      },
    ])
  })

  it("says what a failed switch came to, with a retry for a busy lock", async () => {
    wide()
    setup(usualHost())
    engine.answer.skills_apply_links = (args) =>
      args.preflight
        ? undefined
        : {
            outcome: "busy",
            ok: false,
            issues: [{ code: "lock_busy" }],
            ops: [
              {
                index: 0,
                skill: "pdf-tools",
                agent: "claude_code",
                action: "enable",
                status: "not_done",
                creates: [],
                removes: [],
                moves: [],
                gains: [],
                loses: [],
                touches: [],
                ack: null,
                issues: [],
                warnings: [],
              },
            ],
          }
    render(<Harness />)
    await userEvent.click(
      await screen.findByRole("switch", { name: "PDF tools, Claude Code: Off" })
    )
    const alert = await screen.findByText(/was not turned on for Claude Code/)
    const notice = alert.closest("[role=alert]") as HTMLElement
    expect(notice.textContent).toContain(m.issues.lock_busy)
    delete engine.answer.skills_apply_links
    await userEvent.click(
      within(notice).getByRole("button", { name: m.write.retry })
    )
    await waitFor(() => expect(engine.writes()).toHaveLength(1))
  })

  it("lists what a failed rollback left in place", async () => {
    wide()
    setup(usualHost())
    const staged = `${ownDir("claude_code")}/.codeg-skills-staging/op-1`
    engine.answer.skills_apply_links = (args) =>
      args.preflight
        ? undefined
        : {
            outcome: "write_failed",
            ok: false,
            issues: [],
            ops: [
              {
                index: 0,
                skill: "pdf-tools",
                agent: "claude_code",
                action: "enable",
                status: "failed",
                creates: [],
                removes: [],
                moves: [],
                gains: [],
                loses: [],
                touches: [],
                ack: null,
                issues: [
                  { code: "link_failed", detail: "permission denied" },
                  {
                    code: "rollback_failed",
                    path: ownDir("claude_code"),
                    kept: [`${staged}/pdf-tools`, staged],
                  },
                ],
                warnings: [],
              },
            ],
          }
    render(<Harness />)
    await userEvent.click(
      await screen.findByRole("switch", { name: "PDF tools, Claude Code: Off" })
    )
    const alert = await screen.findByText(/was not turned on for Claude Code/)
    const notice = alert.closest("[role=alert]") as HTMLElement
    expect(notice.textContent).toContain(m.issues.rollback_failed)
    expect(notice.textContent).toContain(m.issues.kept)
    expect(notice.textContent).toContain(`${staged}/pdf-tools`)
  })

  it("names the agent whose changed copy stops a switch in a shared folder", async () => {
    wide()
    setup(usualHost())
    engine.answer.skills_apply_links = (args) =>
      args.preflight
        ? {
            outcome: "invalid",
            ok: false,
            issues: [],
            ops: [
              {
                index: 0,
                skill: "my-flow",
                agent: "custom:only-shared",
                action: "enable",
                status: "blocked",
                creates: [],
                removes: [],
                moves: [],
                gains: [],
                loses: [],
                touches: [],
                ack: null,
                issues: [
                  {
                    code: "copy_modified",
                    agents: ["codex"],
                    path: `${SHARED_DIR}/my-flow`,
                  },
                ],
                warnings: [],
              },
            ],
          }
        : undefined
    render(<Harness />)
    await userEvent.click(
      await screen.findByRole("switch", {
        name: "My flow, custom:only-shared: Off",
      })
    )
    const dialog = await screen.findByRole("dialog")
    expect(dialog.textContent).toContain(m.effects.blocked)
    expect(dialog.textContent).toContain(
      m.issues.copy_modified_others.replace("{agents}", "Codex")
    )
    expect(engine.writes()).toHaveLength(0)
  })
})

// ─── Copies ───────────────────────────────────────────────────────────

describe("SkillsSection — copies (where no link can be made)", () => {
  function copyHost(cell: "copy" | "copyOutdated" | "copyChanged") {
    return {
      agents: [{ agent: "claude_code" }],
      skills: [
        { id: "my-flow", name: "My flow", cells: { claude_code: cell } },
      ],
    } as EngineOptions
  }

  it("says a copy is not updated by itself", async () => {
    setup(copyHost("copy"))
    render(<Harness />)
    const article = await openSkill("My flow")
    expect(article.textContent).toContain(m.cellNotes.copy)
  })

  it("updates an outdated copy nobody changed, without asking", async () => {
    setup(copyHost("copyOutdated"))
    render(<Harness />)
    const article = await openSkill("My flow")
    expect(article.textContent).toContain(m.cellNotes.copyOutdated)
    await userEvent.click(
      within(article).getByRole("button", { name: m.agentRow.refresh })
    )
    await waitFor(() => expect(engine.writes()).toHaveLength(1))
    expect(engine.writes()[0]).toEqual([
      { skill: "my-flow", agent: "claude_code", action: "refresh" },
    ])
  })

  it("offers to keep a copy changed on the agent's side", async () => {
    setup(copyHost("copyChanged"))
    render(<Harness />)
    const article = await openSkill("My flow")
    expect(article.textContent).toContain(m.cellNotes.copyChanged)
    // Its switch would not take it away: there is none to flip.
    expect(
      within(article).getByRole("switch", { name: "Claude Code" })
    ).toBeDisabled()
    await userEvent.click(
      within(article).getByRole("button", { name: m.agentRow.keep })
    )
    expect(article.textContent).toContain(m.agentRow.kept)
    expect(engine.writes()).toHaveLength(0)
  })

  it("replaces a changed copy only once it is confirmed, backing it up first", async () => {
    setup(copyHost("copyChanged"))
    render(<Harness />)
    const article = await openSkill("My flow")
    await userEvent.click(
      within(article).getByRole("button", { name: m.agentRow.replace })
    )
    const dialog = await screen.findByRole("dialog")
    expect(dialog.textContent).toContain(m.effects.about.replace)
    expect(engine.writes()).toHaveLength(0)
    await userEvent.click(
      within(dialog).getByRole("button", { name: m.effects.confirm.replace })
    )
    await waitFor(() => expect(engine.writes()).toHaveLength(1))
    expect(engine.writes()[0]).toEqual([
      {
        skill: "my-flow",
        agent: "claude_code",
        action: "refresh",
        replace_modified: true,
      },
    ])
  })
})

// ─── By agent ─────────────────────────────────────────────────────────

/** Claude Code's global folder, with one skill of every kind of owner. */
function agentHost(): EngineOptions {
  const claude = ownDir("claude_code")
  return {
    ...usualHost(),
    broken: [
      {
        path: `${claude}/dead`,
        dir: claude,
        target: `${STORE}/dead`,
        skill: "dead",
        agents: ["claude_code"],
      },
    ],
    listings: {
      "claude_code|global": [
        { id: "my-flow", owner: "custom", linkTarget: `${STORE}/my-flow` },
        {
          id: "brainstorming",
          owner: "pack",
          pack: "experts",
          linkTarget: `${STORE}/brainstorming`,
        },
        { id: "pdf-tools", owner: "harness", linkTarget: `${STORE}/pdf-tools` },
        { id: "own-skill", owner: "agent", description: "Mine, by hand." },
        {
          id: "ext",
          owner: "linked_elsewhere",
          linkTarget: "/home/u/dotfiles/ext",
        },
        { id: "dead", owner: "broken", linkTarget: `${STORE}/dead` },
        { id: "stray", owner: "broken", linkTarget: "/nowhere/stray" },
        { id: "sys", owner: "agent", readOnly: true },
        { id: "odd", owner: "mystery" },
      ],
    },
  }
}

async function byAgent() {
  await userEvent.click(
    await screen.findByRole("radio", { name: m.views.agent })
  )
  await screen.findByRole("list", { name: m.byAgent.listLabel })
}

async function openAgentSkill(id: string) {
  await userEvent.click(
    await screen.findByRole("button", { name: new RegExp(`^${id}\\b`) })
  )
  return screen.findByRole("article")
}

describe("SkillsSection — by agent", () => {
  it("marks the agents that are not installed in the picker, after the rest", async () => {
    setup(agentHost())
    engine.answer.acp_list_agents = () =>
      ["claude_code", "codex", "gemini", "cline", "custom:only-shared"].map(
        (agent, index) => ({
          agent_type: agent,
          name: agent,
          skills_capable: true,
          sort_order: index,
          installed_version: agent === "codex" ? null : "1.0.0",
          custom_source: null,
          env: {},
          enabled: true,
        })
      )
    render(<Harness />)
    await byAgent()
    await userEvent.click(
      await screen.findByRole("combobox", { name: m.byAgent.agent })
    )
    const options = await screen.findAllByRole("option")
    const names = ["Claude Code", "Gemini CLI", "Cline", "custom:only-shared"]
    // The installed ones first, unmarked; Codex last, marked.
    names.forEach((name, index) => {
      expect(options[index].textContent).toContain(name)
      expect(options[index].textContent).not.toContain(m.byAgent.notInstalled)
    })
    expect(options[4].textContent).toContain("Codex")
    expect(options[4].textContent).toContain(m.byAgent.notInstalled)
  })

  it("says what its detail shows before a skill is picked", async () => {
    wide()
    setup(agentHost())
    render(<Harness />)
    await byAgent()
    expect(await screen.findByText(m.byAgent.pickSkill)).toBeTruthy()
    expect(screen.queryByText(m.detail.pickSkill)).toBeNull()
  })

  it("lists every skill the agent sees, each with whose it is", async () => {
    setup(agentHost())
    render(<Harness />)
    await byAgent()
    const list = screen.getByRole("list", { name: m.byAgent.listLabel })
    const text = (id: string) =>
      within(list).getByRole("button", { name: new RegExp(`^${id}\\b`) })
        .textContent
    expect(text("my-flow")).toContain(m.owners.custom)
    expect(text("brainstorming")).toContain("Skill pack · Experts")
    expect(text("pdf-tools")).toContain(m.owners.harness)
    expect(text("own-skill")).toContain(m.owners.agent)
    expect(text("ext")).toContain(m.owners.linked_elsewhere)
    expect(text("dead")).toContain(m.owners.broken)
    expect(text("sys")).toContain(m.byAgent.systemMark)
    // An owner this build does not know is said to be unknown, not hidden.
    expect(text("odd")).toContain(m.owners.unknown)
    // The broken links were asked for.
    expect(callsOf("acp_list_agent_skills")[0].args.includeBroken).toBe(true)
  })

  it("edits the agent's own skill in place", async () => {
    setup(agentHost())
    render(<Harness />)
    await byAgent()
    const article = await openAgentSkill("own-skill")
    await userEvent.click(
      within(article).getByRole("button", { name: m.byAgent.edit })
    )
    const dialog = await screen.findByRole("dialog")
    const text = await within(dialog).findByRole("textbox", {
      name: m.editor.content,
    })
    fireEvent.change(text, {
      target: { value: "---\nname: own-skill\n---\nNew body\n" },
    })
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }))
    await waitFor(() => expect(callsOf("acp_save_agent_skill")).toHaveLength(1))
    expect(callsOf("acp_save_agent_skill")[0].args).toMatchObject({
      agentType: "claude_code",
      scope: "global",
      skillId: "own-skill",
      content: "---\nname: own-skill\n---\nNew body\n",
    })
    // An edit, not a creation.
    expect(callsOf("acp_save_agent_skill")[0].args.create).toBeUndefined()
  })

  it("keeps a pack's and a Harness skill read only, with a copy to change them", async () => {
    setup(agentHost())
    render(<Harness />)
    await byAgent()
    for (const id of ["brainstorming", "pdf-tools"]) {
      const article = await openAgentSkill(id)
      expect(
        within(article).queryByRole("button", { name: m.byAgent.edit })
      ).toBeNull()
      expect(
        within(article).queryByRole("button", { name: m.byAgent.delete })
      ).toBeNull()
      expect(article.textContent).toContain(m.byAgent.about.readOnly)
      expect(
        within(article).getByRole("button", { name: m.byAgent.copyAsCustom })
      ).toBeTruthy()
    }
  })

  it("copies a pack skill as a custom skill, then opens the copy to edit", async () => {
    setup(agentHost())
    render(<Harness />)
    await byAgent()
    const article = await openAgentSkill("brainstorming")
    await userEvent.click(
      within(article).getByRole("button", { name: m.byAgent.copyAsCustom })
    )
    const dialog = await screen.findByRole("dialog")
    expect(
      within(dialog).getByRole("textbox", { name: m.editor.id })
    ).toHaveValue("brainstorming-copy")
    await userEvent.click(
      within(dialog).getByRole("button", { name: m.copy.confirm })
    )
    await waitFor(() =>
      expect(callsOf("custom_duplicate_skill")).toHaveLength(1)
    )
    expect(callsOf("custom_duplicate_skill")[0].args).toEqual({
      sourceId: "brainstorming",
      newId: "brainstorming-copy",
    })
    // The copy, open in the editor, in Codeg's store.
    await waitFor(() =>
      expect(screen.getByRole("dialog").textContent).toContain(
        "Edit brainstorming-copy"
      )
    )
    const editor = screen.getByRole("dialog")
    expect(view.slots.get(SKILLS_DIALOG)).toMatchObject({
      kind: "editor",
      target: { kind: "custom", mode: "edit", skillId: "brainstorming-copy" },
    })
    expect(editor.textContent).toContain(`${STORE}/brainstorming-copy/SKILL.md`)
    expect(view.slots.get(SKILLS_VIEW)).toBe("managed")
    expect(view.slots.get(SKILLS_SELECTED)).toBe("brainstorming-copy")
  })

  it("edits a custom skill in Codeg's store, not through the link", async () => {
    setup(agentHost())
    render(<Harness />)
    await byAgent()
    const article = await openAgentSkill("my-flow")
    await userEvent.click(
      within(article).getByRole("button", { name: m.byAgent.editCustom })
    )
    const dialog = await screen.findByRole("dialog")
    const text = await within(dialog).findByRole("textbox", {
      name: m.editor.content,
    })
    fireEvent.change(text, { target: { value: "changed" } })
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }))
    await waitFor(() => expect(callsOf("custom_save_skill")).toHaveLength(1))
    expect(callsOf("custom_save_skill")[0].args).toEqual({
      id: "my-flow",
      content: "changed",
    })
    expect(callsOf("acp_save_agent_skill")).toHaveLength(0)
  })

  it("offers nothing to change in a skill that comes with the agent", async () => {
    setup(agentHost())
    render(<Harness />)
    await byAgent()
    const article = await openAgentSkill("sys")
    expect(article.textContent).toContain(m.byAgent.about.system)
    for (const name of [m.byAgent.edit, m.byAgent.delete, m.byAgent.adopt]) {
      expect(within(article).queryByRole("button", { name })).toBeNull()
    }
  })
})

// ─── Move into Codeg ──────────────────────────────────────────────────

describe("SkillsSection — move into Codeg management", () => {
  it("says what will happen, then that the agent sees it through Codeg's link", async () => {
    setup(agentHost())
    render(<Harness />)
    await byAgent()
    const article = await openAgentSkill("own-skill")
    await userEvent.click(
      within(article).getByRole("button", { name: m.byAgent.adopt })
    )
    const dialog = await screen.findByRole("dialog")
    expect(dialog.textContent).toContain(m.adopt.step1)
    expect(dialog.textContent).toContain(m.adopt.safe)
    expect(dialog.textContent).toContain(`${ownDir("claude_code")}/own-skill`)
    expect(dialog.textContent).toContain(`${STORE}/own-skill`)
    await userEvent.click(
      within(dialog).getByRole("button", { name: m.adopt.confirm })
    )
    await waitFor(() =>
      expect(screen.getByRole("dialog").textContent).toContain(
        "Moved. It is a custom skill now, and Claude Code sees it through Codeg's link."
      )
    )
    expect(callsOf("skills_adopt")[0].args).toEqual({
      agent: "claude_code",
      skill: "own-skill",
      dir: ownDir("claude_code"),
    })
    // Read again: it is a custom skill now, on for Claude Code. (The result
    // is still open over the page, which hides it from the roles.)
    const list = screen.getByRole("list", {
      name: m.byAgent.listLabel,
      hidden: true,
    })
    await waitFor(() =>
      expect(
        within(list).getByRole("button", { name: /^own-skill\b/, hidden: true })
          .textContent
      ).toContain(m.owners.custom)
    )
    expect(
      engine.inventory().skills.find((s) => s.id === "own-skill")?.cells[0]
        .state
    ).toBe("linked")
  })

  it.each([
    [
      "refused",
      {
        outcome: "invalid",
        ok: false,
        restored: false,
        issues: [{ code: "not_own_skill" }],
      },
      m.adopt.refused,
      m.issues.not_own_skill,
    ],
    [
      "failed and put back",
      {
        outcome: "failed",
        ok: false,
        restored: true,
        issues: [{ code: "verify_failed" }],
      },
      m.adopt.failedRestored,
      m.issues.verify_failed,
    ],
    [
      "failed and not put back",
      {
        outcome: "failed",
        ok: false,
        restored: false,
        issues: [{ code: "rollback_failed", detail: "the original is at /x" }],
      },
      m.adopt.failedNotRestored,
      "the original is at /x",
    ],
    [
      "busy",
      {
        outcome: "busy",
        ok: false,
        restored: false,
        issues: [{ code: "lock_busy" }],
      },
      m.adopt.busy,
      m.issues.lock_busy,
    ],
  ])(
    "tells a move that %s as it is",
    async (_name, answer, headline, detail) => {
      setup(agentHost())
      engine.answer.skills_adopt = (args) => ({
        skill: args.skill,
        agent: args.agent,
        source: null,
        store_path: null,
        link_path: null,
        mode: null,
        ...answer,
      })
      render(<Harness />)
      await byAgent()
      const article = await openAgentSkill("own-skill")
      await userEvent.click(
        within(article).getByRole("button", { name: m.byAgent.adopt })
      )
      await userEvent.click(
        within(await screen.findByRole("dialog")).getByRole("button", {
          name: m.adopt.confirm,
        })
      )
      await waitFor(() =>
        expect(screen.getByRole("dialog").textContent).toContain(headline)
      )
      expect(screen.getByRole("dialog").textContent).toContain(detail)
    }
  )
})

// ─── Broken links ─────────────────────────────────────────────────────

describe("SkillsSection — broken links", () => {
  it("repairs a broken link Codeg made in an agent's own folder, without asking", async () => {
    const options = agentHost()
    options.skills!.push({
      id: "dead",
      origin: "custom",
      cells: { claude_code: "broken" },
    })
    setup(options)
    render(<Harness />)
    await byAgent()
    const article = await openAgentSkill("dead")
    expect(article.textContent).toContain(m.byAgent.about.brokenCodeg)
    await userEvent.click(
      within(article).getByRole("button", { name: m.byAgent.repair })
    )
    await waitFor(() =>
      expect(
        callsOf("skills_repair_link").filter((call) => !call.args.preflight)
      ).toHaveLength(1)
    )
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(lastRepair().args).toEqual({
      path: `${ownDir("claude_code")}/dead`,
      action: "repoint",
      preflight: false,
      ack: null,
    })
  })

  it("asks first when re-pointing a link in a shared folder shows the skill to others", async () => {
    setup({
      ...usualHost(),
      broken: [
        {
          path: `${SHARED_DIR}/pdf-tools`,
          dir: SHARED_DIR,
          target: `${STORE}/pdf-tools`,
          skill: "pdf-tools",
          agents: ["codex", "gemini", "cline"],
        },
      ],
    })
    render(<Harness />)
    const article = await openSkill("PDF tools")
    await userEvent.click(
      within(article).getByRole("button", { name: m.broken.repoint })
    )
    const dialog = await screen.findByRole("dialog")
    expect(dialog.textContent).toContain(m.effects.gains)
    expect(
      callsOf("skills_repair_link").filter((call) => !call.args.preflight)
    ).toHaveLength(0)
    await userEvent.click(
      within(dialog).getByRole("button", { name: m.effects.confirm.repoint })
    )
    await waitFor(() =>
      expect(
        callsOf("skills_repair_link").filter((call) => !call.args.preflight)
      ).toHaveLength(1)
    )
    expect(lastRepair().args.ack).toBe(`ack-repair-${SHARED_DIR}/pdf-tools-1`)
  })

  it("removes a broken link Codeg made to a skill that is gone", async () => {
    setup({
      ...usualHost(),
      broken: [
        {
          path: `${ownDir("claude_code")}/gone`,
          dir: ownDir("claude_code"),
          target: `${STORE}/gone`,
          skill: "gone",
          agents: ["claude_code"],
        },
      ],
    })
    render(<Harness />)
    await userEvent.click(await screen.findByRole("button", { name: /^gone/ }))
    const article = await screen.findByRole("article")
    expect(article.textContent).toContain(m.broken.orphanBody)
    // There is nothing to re-point it at.
    expect(
      within(article).queryByRole("button", { name: m.broken.repoint })
    ).toBeNull()
    await userEvent.click(
      within(article).getByRole("button", { name: m.broken.remove })
    )
    await waitFor(() =>
      expect(
        callsOf("skills_repair_link").filter((call) => !call.args.preflight)
      ).toHaveLength(1)
    )
    expect(lastRepair().args.action).toBe("remove")
  })

  it("offers removing a broken link the agent would see twice if repaired", async () => {
    const options = agentHost()
    options.skills!.push({
      id: "dead",
      origin: "custom",
      cells: { claude_code: "broken" },
    })
    setup(options)
    const elsewhere = `${SHARED_DIR}/dead`
    engine.answer.skills_repair_link = (args) =>
      args.action === "repoint"
        ? {
            outcome: "invalid",
            ok: false,
            status: "blocked",
            path: args.path,
            action: "repoint",
            skill: "dead",
            creates: [],
            removes: [],
            moves: [],
            gains: [],
            loses: [],
            touches: [],
            ack: null,
            issues: [{ code: "already_visible", path: elsewhere }],
            warnings: [],
          }
        : undefined
    render(<Harness />)
    await byAgent()
    const article = await openAgentSkill("dead")
    await userEvent.click(
      within(article).getByRole("button", { name: m.byAgent.repair })
    )
    const dialog = await screen.findByRole("dialog")
    expect(dialog.textContent).toContain(m.issues.already_visible)
    expect(dialog.textContent).toContain(elsewhere)
    expect(dialog.textContent).toContain(m.effects.alreadyVisible)
    await userEvent.click(
      within(dialog).getByRole("button", { name: m.effects.removeInstead })
    )
    // The removal is planned and shown, then made only when confirmed.
    await userEvent.click(
      await within(dialog).findByRole("button", {
        name: m.effects.confirm.remove,
      })
    )
    await waitFor(() =>
      expect(
        callsOf("skills_repair_link").filter((call) => !call.args.preflight)
      ).toHaveLength(1)
    )
    expect(lastRepair().args).toMatchObject({
      path: `${ownDir("claude_code")}/dead`,
      action: "remove",
    })
  })
})

// ─── New skills ───────────────────────────────────────────────────────

describe("SkillsSection — new skills", () => {
  async function newCustom() {
    await userEvent.click(
      await screen.findByRole("button", { name: m.add.label })
    )
    await userEvent.click(
      await screen.findByRole("menuitem", { name: new RegExp(m.add.newCustom) })
    )
    return screen.findByRole("dialog")
  }

  it("refuses a name the store already has, before sending anything", async () => {
    setup(usualHost())
    render(<Harness />)
    const dialog = await newCustom()
    const id = within(dialog).getByRole("textbox", { name: m.editor.id })
    await userEvent.type(id, "pdf-tools")
    expect(dialog.textContent).toContain("pdf-tools is already taken.")
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled()
    await userEvent.clear(id)
    await userEvent.type(id, ".hidden")
    expect(dialog.textContent).toContain(m.editor.idInvalid)
    expect(callsOf("custom_create_skill")).toHaveLength(0)
  })

  it("creates a custom skill and opens it", async () => {
    setup(usualHost())
    render(<Harness />)
    const dialog = await newCustom()
    await userEvent.type(
      within(dialog).getByRole("textbox", { name: m.editor.id }),
      "fresh"
    )
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }))
    await waitFor(() => expect(callsOf("custom_create_skill")).toHaveLength(1))
    expect(callsOf("custom_create_skill")[0].args.id).toBe("fresh")
    expect(
      await screen.findByRole("heading", { name: "fresh", level: 2 })
    ).toBeTruthy()
  })

  it("shows the backend's refusal in words, and keeps what was typed", async () => {
    setup(usualHost())
    engine.answer.custom_create_skill = () =>
      new Error(
        JSON.stringify({
          code: "invalid_input",
          message: "x",
          i18n_key: "errors.idReserved",
          i18n_params: { code: "id_reserved" },
        })
      )
    render(<Harness />)
    const dialog = await newCustom()
    await userEvent.type(
      within(dialog).getByRole("textbox", { name: m.editor.id }),
      "brainstorm"
    )
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }))
    await waitFor(() =>
      expect(dialog.textContent).toContain(m.issues.id_reserved)
    )
    expect(
      within(dialog).getByRole("textbox", { name: m.editor.id })
    ).toHaveValue("brainstorm")
  })

  it("says a skill Harness installed is kept as it came", async () => {
    setup(usualHost())
    engine.answer.custom_save_skill = () =>
      new Error(
        JSON.stringify({
          code: "invalid_input",
          message: "x",
          i18n_key: "errors.idReserved",
          i18n_params: { code: "id_reserved", detail: "harness" },
        })
      )
    render(<Harness />)
    const article = await openSkill("My flow")
    await userEvent.click(
      within(article).getByRole("button", { name: m.detail.edit })
    )
    const dialog = await screen.findByRole("dialog")
    fireEvent.change(
      await within(dialog).findByRole("textbox", { name: m.editor.content }),
      { target: { value: "changed" } }
    )
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }))
    await waitFor(() =>
      expect(dialog.textContent).toContain(m.issues.id_reserved_harness)
    )
    // The word that picked the message is not shown as a detail.
    expect(within(dialog).queryByText("harness")).toBeNull()
  })

  it("creates an agent's skill with `create`, refused when the name is taken", async () => {
    setup(agentHost())
    engine.listings.set("claude_code|project|/w", [{ id: "hidden-elsewhere" }])
    render(<Harness />)
    await byAgent()
    await userEvent.click(screen.getByRole("button", { name: m.add.label }))
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /New skill for Claude Code/ })
    )
    const dialog = await screen.findByRole("dialog")
    const id = within(dialog).getByRole("textbox", { name: m.editor.id })
    // Taken in this scope: said at once.
    await userEvent.type(id, "own-skill")
    expect(dialog.textContent).toContain("own-skill is already taken.")
    await userEvent.clear(id)
    await userEvent.type(id, "brand-new")
    expect(dialog.textContent).toContain(
      `${ownDir("claude_code")}/brand-new/SKILL.md`
    )
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }))
    await waitFor(() => expect(callsOf("acp_save_agent_skill")).toHaveLength(1))
    expect(callsOf("acp_save_agent_skill")[0].args).toMatchObject({
      skillId: "brand-new",
      create: true,
      layout: "skill_directory",
    })
  })

  it("tells a taken name the page could not see, with where it is", async () => {
    setup(agentHost())
    engine.answer.acp_save_agent_skill = () =>
      new Error(
        JSON.stringify({
          code: "already_exists",
          message: "a skill named 'x' already exists",
          i18n_key: "errors.idTaken",
          i18n_params: { code: "id_taken", detail: "/home/u/.agents/skills/x" },
        })
      )
    render(<Harness />)
    await byAgent()
    await userEvent.click(screen.getByRole("button", { name: m.add.label }))
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /New skill for Claude Code/ })
    )
    const dialog = await screen.findByRole("dialog")
    await userEvent.type(
      within(dialog).getByRole("textbox", { name: m.editor.id }),
      "x"
    )
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }))
    await waitFor(() => expect(dialog.textContent).toContain(m.issues.id_taken))
    expect(dialog.textContent).toContain("/home/u/.agents/skills/x")
  })
})

describe("SkillsSection — new skills for an agent that shares its folder", () => {
  async function chooseAgent(name: string) {
    await userEvent.click(
      await screen.findByRole("radio", { name: m.views.agent })
    )
    await userEvent.click(
      await screen.findByRole("combobox", { name: m.byAgent.agent })
    )
    await userEvent.click(await screen.findByRole("option", { name }))
    // It has no skills of its own yet.
    await screen.findByText(m.byAgent.none)
  }

  it("writes a new skill into the agent's own folder, not the shared one it reads", async () => {
    setup(usualHost())
    render(<Harness />)
    await chooseAgent("Cline")
    await userEvent.click(screen.getByRole("button", { name: m.add.label }))
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /New skill for Cline/ })
    )
    const dialog = await screen.findByRole("dialog")
    await userEvent.type(
      within(dialog).getByRole("textbox", { name: m.editor.id }),
      "mine"
    )
    expect(dialog.textContent).toContain(`${ownDir("cline")}/mine/SKILL.md`)
    expect(dialog.textContent).not.toContain(`${SHARED_DIR}/mine`)
  })

  it("makes a new skill a Custom one for an agent with no folder of its own, and plans turning it on", async () => {
    setup(usualHost())
    render(<Harness />)
    await chooseAgent("custom:only-shared")
    await userEvent.click(screen.getByRole("button", { name: m.add.label }))
    const item = await screen.findByRole("menuitem", {
      name: /New skill for custom:only-shared/,
    })
    expect(item.textContent).toContain(
      "custom:only-shared has no skills folder of its own"
    )
    await userEvent.click(item)
    const dialog = await screen.findByRole("dialog")
    expect(dialog.textContent).toContain(
      "Once it is saved, Codeg turns it on for custom:only-shared"
    )
    await userEvent.type(
      within(dialog).getByRole("textbox", { name: m.editor.id }),
      "shared-new"
    )
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }))
    await waitFor(() => expect(callsOf("custom_create_skill")).toHaveLength(1))
    expect(callsOf("acp_save_agent_skill")).toHaveLength(0)
    // Turning it on shows who else would see it, before anything is linked.
    const plan = await screen.findByRole("dialog")
    expect(plan.textContent).toContain(m.effects.gains)
    const planned = preflights()
    expect(planned[planned.length - 1]?.args.ops).toEqual([
      { skill: "shared-new", agent: "custom:only-shared", action: "enable" },
    ])
    expect(engine.writes()).toHaveLength(0)
  })

  it("offers the Custom route when the backend refuses a new skill for want of a folder", async () => {
    setup(agentHost())
    engine.answer.acp_save_agent_skill = () =>
      new Error(
        JSON.stringify({
          code: "invalid_input",
          message: "no folder of its own",
          i18n_key: "errors.noOwnDirectory",
          i18n_params: { code: "no_own_directory", detail: "codex,gemini" },
        })
      )
    render(<Harness />)
    await byAgent()
    await userEvent.click(screen.getByRole("button", { name: m.add.label }))
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /New skill for Claude Code/ })
    )
    const dialog = await screen.findByRole("dialog")
    await userEvent.type(
      within(dialog).getByRole("textbox", { name: m.editor.id }),
      "fresh-one"
    )
    fireEvent.change(
      within(dialog).getByRole("textbox", { name: m.editor.content }),
      { target: { value: "typed text" } }
    )
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }))
    // In words, naming who would see it; no raw agent ids.
    await waitFor(() =>
      expect(dialog.textContent).toContain(
        "a new skill would be seen by Codex, Gemini CLI too."
      )
    )
    expect(dialog.textContent).not.toContain("codex,gemini")
    await userEvent.click(
      within(dialog).getByRole("button", { name: m.editor.makeCustom })
    )
    expect(view.slots.get(SKILLS_DIALOG)).toMatchObject({
      kind: "editor",
      draftId: "fresh-one",
      content: "typed text",
      target: { kind: "custom", mode: "create", enableFor: "claude_code" },
    })
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }))
    await waitFor(() => expect(callsOf("custom_create_skill")).toHaveLength(1))
    expect(callsOf("custom_create_skill")[0].args).toEqual({
      id: "fresh-one",
      content: "typed text",
    })
  })
})

// ─── A pack's folder whose owner is unknown ───────────────────────────

describe("SkillsSection — store problems", () => {
  it("says a folder the pack could not tell is its own was left alone, and marks it", async () => {
    setup({
      ...usualHost(),
      skills: [
        ...usualHost().skills!,
        { id: "writing-plans", origin: "custom", name: "Writing plans" },
      ],
      nameTaken: [{ id: "writing-plans", pack: "experts", held_by: "custom" }],
      problems: [
        {
          code: "ownership_unresolved",
          path: `${STORE}/writing-plans`,
          detail: "experts",
        },
        {
          code: "manifest_unreadable",
          path: `${STORE}/.manifest.experts.json`,
          detail: "expected value at line 1",
        },
      ],
    })
    render(<Harness />)
    // What is no one skill's is said above the list.
    const store = await screen.findByRole("region", { name: m.list.problems })
    expect(store.textContent).toContain(m.issues.manifest_unreadable)
    expect(store.textContent).toContain("expected value at line 1")
    const article = await openSkill("Writing plans")
    expect(article.textContent).toContain(
      "Codeg could not read the Experts pack's records"
    )
    // The pack's name is the message's, not a detail under it.
    expect(within(article).queryByText("experts")).toBeNull()
    expect(screen.getAllByText(m.marks.problem).length).toBeGreaterThan(0)
  })
})

// ─── Delete ───────────────────────────────────────────────────────────

describe("SkillsSection — delete", () => {
  it("says a custom skill goes from every agent and from the store", async () => {
    setup(usualHost())
    render(<Harness />)
    const article = await openSkill("My flow")
    await userEvent.click(
      within(article).getByRole("button", { name: m.detail.delete })
    )
    const dialog = await screen.findByRole("dialog")
    expect(dialog.textContent).toContain(
      "Codeg turns it off for every agent and deletes it from its store."
    )
    expect(dialog.textContent).toContain("Agents that lose it: Claude Code.")
    expect(dialog.textContent).toContain(`${STORE}/my-flow`)
    expect(callsOf("custom_delete_skills")).toHaveLength(0)
    await userEvent.click(
      within(dialog).getByRole("button", { name: m.delete.confirm })
    )
    await waitFor(() => expect(callsOf("custom_delete_skills")).toHaveLength(1))
    expect(callsOf("custom_delete_skills")[0].args).toEqual({
      ids: ["my-flow"],
    })
  })

  it("does not count an agent that keeps its changed copy among those losing it", async () => {
    const options = usualHost()
    options.skills![0].cells = { claude_code: "linked", codex: "copyChanged" }
    setup(options)
    render(<Harness />)
    const article = await openSkill("My flow")
    await userEvent.click(
      within(article).getByRole("button", { name: m.detail.delete })
    )
    const dialog = await screen.findByRole("dialog")
    expect(dialog.textContent).toContain("Agents that lose it: Claude Code.")
    expect(dialog.textContent).toContain(m.delete.changedCopiesKept)
  })

  it("says an agent's own skill goes from that folder only", async () => {
    setup(agentHost())
    render(<Harness />)
    await byAgent()
    const article = await openAgentSkill("own-skill")
    await userEvent.click(
      within(article).getByRole("button", { name: m.byAgent.delete })
    )
    const dialog = await screen.findByRole("dialog")
    expect(dialog.textContent).toContain(m.delete.agentReach)
    // Asked first, deleting nothing.
    expect(
      await within(dialog).findByText("Only Claude Code reads this folder.")
    ).toBeTruthy()
    expect(callsOf("acp_delete_agent_skill")).toEqual([
      {
        command: "acp_delete_agent_skill",
        args: {
          agentType: "claude_code",
          scope: "global",
          skillId: "own-skill",
          workspacePath: null,
          preflight: true,
          ack: null,
        },
      },
    ])
    await userEvent.click(
      within(dialog).getByRole("button", { name: m.delete.confirm })
    )
    await waitFor(() =>
      expect(callsOf("acp_delete_agent_skill")).toHaveLength(2)
    )
    // A folder of its own: no ack to send.
    expect(callsOf("acp_delete_agent_skill")[1].args).toEqual({
      agentType: "claude_code",
      scope: "global",
      skillId: "own-skill",
      workspacePath: null,
      preflight: false,
      ack: null,
    })
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  it("names the agents that share the folder an agent's own skill is deleted from", async () => {
    setup({
      ...usualHost(),
      listings: {
        "codex|global": [{ id: "shared-one", owner: "agent", dir: SHARED_DIR }],
      },
    })
    render(<Harness />)
    await userEvent.click(
      await screen.findByRole("radio", { name: m.views.agent })
    )
    await userEvent.click(
      await screen.findByRole("combobox", { name: m.byAgent.agent })
    )
    await userEvent.click(await screen.findByRole("option", { name: "Codex" }))
    const article = await openAgentSkill("shared-one")
    expect(article.textContent).toContain("This folder is shared")
    await userEvent.click(
      within(article).getByRole("button", { name: m.byAgent.delete })
    )
    const dialog = await screen.findByRole("dialog")
    // Who loses it is the backend's answer to the preflight.
    expect(
      await within(dialog).findByText(
        "This folder is shared: Gemini CLI, Cline, custom:only-shared lose it too."
      )
    ).toBeTruthy()
    await userEvent.click(
      within(dialog).getByRole("button", { name: m.delete.confirm })
    )
    await waitFor(() =>
      expect(callsOf("acp_delete_agent_skill")).toHaveLength(2)
    )
    expect(callsOf("acp_delete_agent_skill")[1].args).toMatchObject({
      preflight: false,
      ack: "ack-delete-codex-shared-one-1",
    })
  })

  it("asks again, deleting nothing, when who reads the folder changed since it was shown", async () => {
    setup({
      ...usualHost(),
      listings: {
        "codex|global": [{ id: "shared-one", owner: "agent", dir: SHARED_DIR }],
      },
    })
    render(<Harness />)
    await userEvent.click(
      await screen.findByRole("radio", { name: m.views.agent })
    )
    await userEvent.click(
      await screen.findByRole("combobox", { name: m.byAgent.agent })
    )
    await userEvent.click(await screen.findByRole("option", { name: "Codex" }))
    const article = await openAgentSkill("shared-one")
    await userEvent.click(
      within(article).getByRole("button", { name: m.byAgent.delete })
    )
    const dialog = await screen.findByRole("dialog")
    await within(dialog).findByText(/This folder is shared/)
    // Something changed between the preflight and the confirmation.
    engine.bumpEffects()
    await userEvent.click(
      within(dialog).getByRole("button", { name: m.delete.confirm })
    )
    expect(await within(dialog).findByText(m.delete.changed)).toBeTruthy()
    const deletes = () =>
      callsOf("acp_delete_agent_skill").filter((call) => !call.args.preflight)
    // The refused delete, then a new preflight; the skill is still listed.
    expect(deletes()).toHaveLength(1)
    expect(engine.listings.get("codex|global")).toHaveLength(1)
    await within(dialog).findByText(/This folder is shared/)
    await userEvent.click(
      within(dialog).getByRole("button", { name: m.delete.confirm })
    )
    await waitFor(() => expect(deletes()).toHaveLength(2))
    expect(deletes()[1].args.ack).toBe("ack-delete-codex-shared-one-2")
    await waitFor(() =>
      expect(engine.listings.get("codex|global")).toHaveLength(0)
    )
  })

  it("shows the new list of who loses it when another agent started reading the folder", async () => {
    setup(agentHost())
    let readers = ["gemini"]
    engine.answer.acp_delete_agent_skill = (args) => {
      const ack = `ack-${readers.join("+")}`
      if (args.preflight) {
        return {
          deleted: false,
          path: `${ownDir("claude_code")}/own-skill`,
          kind: "folder",
          shared_with: readers,
          ack,
        }
      }
      if (args.ack !== ack) {
        return new Error(
          JSON.stringify({
            code: "invalid_input",
            message: "changed",
            i18n_params: {
              code: args.ack ? "effects_changed" : "acknowledgement_required",
              detail: readers.join(","),
            },
          })
        )
      }
      return {
        deleted: true,
        path: `${ownDir("claude_code")}/own-skill`,
        kind: "folder",
        shared_with: readers,
        ack,
      }
    }
    render(<Harness />)
    await byAgent()
    const article = await openAgentSkill("own-skill")
    await userEvent.click(
      within(article).getByRole("button", { name: m.byAgent.delete })
    )
    const dialog = await screen.findByRole("dialog")
    await within(dialog).findByText(
      "This folder is shared: Gemini CLI lose it too."
    )
    readers = ["gemini", "cline"]
    await userEvent.click(
      within(dialog).getByRole("button", { name: m.delete.confirm })
    )
    expect(await within(dialog).findByText(m.delete.changed)).toBeTruthy()
    expect(
      await within(dialog).findByText(
        "This folder is shared: Gemini CLI, Cline lose it too."
      )
    ).toBeTruthy()
    await userEvent.click(
      within(dialog).getByRole("button", { name: m.delete.confirm })
    )
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    const real = callsOf("acp_delete_agent_skill").filter(
      (call) => !call.args.preflight
    )
    expect(real.map((call) => call.args.ack)).toEqual([
      "ack-gemini",
      "ack-gemini+cline",
    ])
  })

  it("deletes nothing when it cannot ask what a delete would do", async () => {
    setup(agentHost())
    engine.answer.acp_delete_agent_skill = (args) =>
      args.preflight ? new Error("offline") : undefined
    render(<Harness />)
    await byAgent()
    const article = await openAgentSkill("own-skill")
    await userEvent.click(
      within(article).getByRole("button", { name: m.byAgent.delete })
    )
    const dialog = await screen.findByRole("dialog")
    expect(await within(dialog).findByText(m.delete.checkFailed)).toBeTruthy()
    expect(
      within(dialog).queryByRole("button", { name: m.delete.confirm })
    ).toBeNull()
    delete engine.answer.acp_delete_agent_skill
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Check again" })
    )
    expect(
      await within(dialog).findByRole("button", { name: m.delete.confirm })
    ).toBeEnabled()
    expect(
      callsOf("acp_delete_agent_skill").filter((call) => !call.args.preflight)
    ).toHaveLength(0)
  })
})

// ─── Backups ──────────────────────────────────────────────────────────

describe("SkillsSection — backups", () => {
  function backupHost(): EngineOptions {
    return {
      ...usualHost(),
      backups: [
        {
          skill: "my-flow",
          name: "20261116-031500.123",
          path: `${STORE}/.user-backups/my-flow/20261116-031500.123`,
          kind: "update",
          created_at: "2026-11-16T03:15:00.123Z",
          agent: null,
          linked_by: [],
        },
        {
          skill: "my-flow",
          name: "legacy",
          path: `${STORE}/my-flow.user-backup-20250101-120000`,
          kind: "legacy",
          created_at: "2025-01-01T12:00:00Z",
          agent: null,
          linked_by: ["codex"],
        },
      ],
    }
  }

  it("lists a skill's backups under it", async () => {
    setup(backupHost())
    render(<Harness />)
    const article = await openSkill("My flow")
    const part = within(article).getByRole("region", { name: m.backups.title })
    expect(part.textContent).toContain(m.backups.kinds.update)
    expect(part.textContent).toContain(m.backups.kinds.legacy)
    expect(part.textContent).toContain("Still used through a link by Codex.")
  })

  it("restores a backup as a new custom skill", async () => {
    setup(backupHost())
    render(<Harness />)
    const article = await openSkill("My flow")
    const part = within(article).getByRole("region", { name: m.backups.title })
    await userEvent.click(
      within(part).getAllByRole("button", { name: m.backups.restore })[0]
    )
    const dialog = await screen.findByRole("dialog")
    expect(
      within(dialog).getByRole("textbox", { name: m.editor.id })
    ).toHaveValue("my-flow-restored")
    await userEvent.click(
      within(dialog).getByRole("button", { name: m.restore.confirm })
    )
    await waitFor(() =>
      expect(dialog.textContent).toContain("Restored as my-flow-restored.")
    )
    expect(callsOf("skills_backup_restore")[0].args).toEqual({
      skill: "my-flow",
      name: "20261116-031500.123",
      id: "my-flow-restored",
    })
    expect(view.slots.get(SKILLS_SELECTED)).toBe("my-flow-restored")
  })

  it("deletes a backup once confirmed", async () => {
    setup(backupHost())
    render(<Harness />)
    const article = await openSkill("My flow")
    const part = within(article).getByRole("region", { name: m.backups.title })
    await userEvent.click(
      within(part).getAllByRole("button", { name: m.backups.delete })[0]
    )
    const dialog = await screen.findByRole("dialog")
    expect(dialog.textContent).toContain(m.backupDelete.undo)
    expect(callsOf("skills_backup_delete")).toHaveLength(0)
    await userEvent.click(
      within(dialog).getByRole("button", { name: m.backupDelete.confirm })
    )
    await waitFor(() => expect(callsOf("skills_backup_delete")).toHaveLength(1))
    expect(callsOf("skills_backup_delete")[0].args).toEqual({
      skill: "my-flow",
      name: "20261116-031500.123",
    })
  })

  it("turns off the links to a legacy backup an agent still uses, then lets it go", async () => {
    setup(backupHost())
    render(<Harness />)
    const article = await openSkill("My flow")
    const part = within(article).getByRole("region", { name: m.backups.title })
    await userEvent.click(
      within(part).getAllByRole("button", { name: m.backups.delete })[1]
    )
    let dialog = await screen.findByRole("dialog")
    await userEvent.click(
      within(dialog).getByRole("button", { name: m.backupDelete.confirm })
    )
    await waitFor(() =>
      expect(screen.getByRole("dialog").textContent).toContain(
        "Agents still use this backup through a link: Codex."
      )
    )
    dialog = screen.getByRole("dialog")
    await userEvent.click(
      within(dialog).getByRole("button", { name: m.backupDelete.turnOff })
    )
    // Through the same confirmation as any other switch.
    await waitFor(() => expect(preflights()).toHaveLength(1))
    expect(preflights()[0].args.ops).toEqual([
      {
        skill: "my-flow.user-backup-20250101-120000",
        agent: "codex",
        action: "disable",
      },
    ])
  })
})

// ─── Following changes ────────────────────────────────────────────────

describe("SkillsSection — following skills://changed", () => {
  it("reads the skills again when Codeg changes them anywhere", async () => {
    setup(usualHost())
    render(<Harness />)
    await screen.findByRole("button", { name: "My flow" })
    const before = callsOf("skills_inventory").length
    await emitChanged(["store"], [])
    await waitFor(() =>
      expect(callsOf("skills_inventory").length).toBe(before + 1)
    )
  })

  it("updates the composer's skill list as soon as a switch is saved, with no window focus", async () => {
    wide()
    setup({
      ...usualHost(),
      listings: { "claude_code|global": [{ id: "my-flow", owner: "custom" }] },
    })
    render(<Harness composer="claude_code" />)
    const composer = await screen.findByTestId("composer-claude_code")
    await waitFor(() => expect(composer.textContent).toBe("my-flow"))
    const scans = callsOf("acp_list_agent_runtime_skills").length

    // Turning a skill on makes the backend announce it; the composer, in the
    // same window, follows.
    engine.listings.set("claude_code|global", [
      { id: "my-flow", owner: "custom" },
      { id: "pdf-tools", owner: "harness" },
    ])
    await userEvent.click(
      await screen.findByRole("switch", { name: "PDF tools, Claude Code: Off" })
    )
    await waitFor(() =>
      expect(callsOf("acp_list_agent_runtime_skills").length).toBeGreaterThan(
        scans
      )
    )
    await waitFor(() => expect(composer.textContent).toBe("my-flowpdf-tools"))
  })
})

// ─── Targets ──────────────────────────────────────────────────────────

describe("SkillsSection — openHarness targets", () => {
  it("opens a Custom or Harness skill in the Codeg-managed view", async () => {
    setup(usualHost())
    render(<Harness />)
    await screen.findByRole("button", { name: "My flow" })
    act(() => {
      view.open({ section: "skills", skillId: "pdf-tools" })
    })
    expect(
      await screen.findByRole("heading", { name: "PDF tools", level: 2 })
    ).toBeTruthy()
    expect(view.slots.get(SKILLS_VIEW)).toBe("managed")
  })

  it("opens a pack's skill in the view of an agent that sees it", async () => {
    setup(agentHost())
    render(<Harness />)
    await screen.findByRole("button", { name: "My flow" })
    act(() => {
      view.open({ section: "skills", skillId: "brainstorming" })
    })
    await waitFor(() => expect(view.slots.get(SKILLS_VIEW)).toBe("agent"))
    const article = await screen.findByRole("article")
    expect(article.textContent).toContain("brainstorming")
    expect(article.textContent).toContain("Skill pack · Experts")
  })

  it("waits for the skills to be read before choosing the view", async () => {
    setup(agentHost())
    // Asked for before the section has read anything.
    const { rerender } = render(<Harness show={false} />)
    act(() => {
      view.open({ section: "skills", skillId: "brainstorming" })
    })
    rerender(<Harness />)
    // Parked on the managed view until the inventory says where it is…
    expect(view.slots.get(SKILLS_VIEW)).toBe("managed")
    // …then moved to the view of the agent that sees it.
    await waitFor(() => expect(view.slots.get(SKILLS_VIEW)).toBe("agent"))
  })

  it("says so for a skill that is not there", async () => {
    setup(usualHost())
    render(<Harness />)
    await screen.findByRole("button", { name: "My flow" })
    act(() => {
      view.open({ section: "skills", skillId: "nope" })
    })
    expect(await screen.findByText(/There is no skill/)).toBeTruthy()
  })
})

// ─── State that outlives the page ─────────────────────────────────────

describe("SkillsSection — state that outlives the page", () => {
  function Toggle() {
    const [shown, setShown] = useStateHolder()
    return (
      <>
        <button type="button" onClick={() => setShown(!shown)}>
          toggle page
        </button>
        <NextIntlClientProvider locale="en" messages={enMessages}>
          <HarnessViewProvider>
            <Capture />
            {shown && <SkillsSection />}
          </HarnessViewProvider>
        </NextIntlClientProvider>
      </>
    )
  }

  it("comes back on the view, the agent, the selection and an open editor with its text", async () => {
    setup(agentHost())
    render(<Toggle />)
    await byAgent()
    const article = await openAgentSkill("own-skill")
    await userEvent.click(
      within(article).getByRole("button", { name: m.byAgent.edit })
    )
    const dialog = await screen.findByRole("dialog")
    const text = await within(dialog).findByRole("textbox", {
      name: m.editor.content,
    })
    fireEvent.change(text, { target: { value: "typed, not saved" } })

    // To a conversation and back: the page is unmounted, not hidden.
    await userEvent.click(
      screen.getByText("toggle page", { selector: "button" }),
      {
        pointerEventsCheck: 0,
      }
    )
    expect(screen.queryByRole("dialog")).toBeNull()
    await userEvent.click(
      screen.getByText("toggle page", { selector: "button" }),
      {
        pointerEventsCheck: 0,
      }
    )

    const back = await screen.findByRole("dialog")
    expect(
      within(back).getByRole("textbox", { name: m.editor.content })
    ).toHaveValue("typed, not saved")
    expect(view.slots.get(SKILLS_VIEW)).toBe("agent")
    expect(callsOf("acp_save_agent_skill")).toHaveLength(0)
  })
})

function useStateHolder(): [boolean, (next: boolean) => void] {
  const [value, setValue] = useReactState(true)
  return [value, setValue]
}

// ─── Unsaved changes ──────────────────────────────────────────────────

describe("SkillsSection — unsaved changes", () => {
  async function editMyFlow() {
    const article = await openSkill("My flow")
    await userEvent.click(
      within(article).getByRole("button", { name: m.detail.edit })
    )
    const dialog = await screen.findByRole("dialog")
    const text = await within(dialog).findByRole("textbox", {
      name: m.editor.content,
    })
    return { dialog, text }
  }

  it("asks before closing an editor with changes", async () => {
    setup(usualHost())
    render(<Harness />)
    const { dialog, text } = await editMyFlow()
    fireEvent.change(text, { target: { value: "half done" } })
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Cancel" })
    )
    const ask = await screen.findByRole("alertdialog")
    await userEvent.click(
      within(ask).getByRole("button", { name: "Keep editing" })
    )
    expect(screen.getByRole("textbox", { name: m.editor.content })).toHaveValue(
      "half done"
    )
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }))
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Discard",
      })
    )
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(view.slots.get(SKILLS_DIALOG)).toBeNull()
  })

  it("never loads a change made elsewhere over what is typed, and offers to", async () => {
    setup(usualHost())
    render(<Harness />)
    const { text } = await editMyFlow()
    fireEvent.change(text, { target: { value: "mine" } })
    // Another window saves the same skill.
    engine.skillContent.set("my-flow", "theirs")
    await emitChanged(["store"], [])
    const dialog = screen.getByRole("dialog")
    await waitFor(() => expect(dialog.textContent).toContain(m.editor.drifted))
    expect(
      within(dialog).getByRole("textbox", { name: m.editor.content })
    ).toHaveValue("mine")
    // Saving waits for the choice.
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled()
    await userEvent.click(
      within(dialog).getByRole("button", { name: m.editor.takeTheirs })
    )
    expect(
      within(dialog).getByRole("textbox", { name: m.editor.content })
    ).toHaveValue("theirs")
  })

  it("keeps what is typed, and saves it over the change made elsewhere once told", async () => {
    setup(usualHost())
    render(<Harness />)
    const { text } = await editMyFlow()
    fireEvent.change(text, { target: { value: "mine" } })
    engine.skillContent.set("my-flow", "theirs")
    // No event this time: the save itself finds out.
    let dialog = screen.getByRole("dialog")
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }))
    await waitFor(() => expect(dialog.textContent).toContain(m.editor.drifted))
    expect(callsOf("custom_save_skill")).toHaveLength(0)
    await userEvent.click(
      within(dialog).getByRole("button", { name: m.editor.keepMine })
    )
    dialog = screen.getByRole("dialog")
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }))
    await waitFor(() => expect(callsOf("custom_save_skill")).toHaveLength(1))
    expect(callsOf("custom_save_skill")[0].args.content).toBe("mine")
  })
})

// ─── An older backend ─────────────────────────────────────────────────

describe("SkillsSection — an older Codeg", () => {
  it.each([
    ["this computer", () => {}, m.errors.unsupported],
    [
      "a remote host",
      () => {
        mocks.remote = { connection: { name: "Lab", base_url: "https://lab" } }
      },
      m.errors.unsupportedRemote,
    ],
    [
      "a web server",
      () => {
        mocks.desktop = false
      },
      m.errors.unsupportedWeb,
    ],
  ])("says which Codeg to update on %s", async (_host, arrange, message) => {
    arrange()
    setup(usualHost())
    engine.answer.skills_inventory = () => {
      throw { code: "not_implemented", message: "unknown command" }
    }
    render(<Harness />)
    expect((await screen.findByRole("alert")).textContent).toBe(message)
  })
})

// ─── Values this build does not know ──────────────────────────────────

describe("SkillsSection — codes and states a newer Codeg may send", () => {
  it("words an unknown code as such, and an unknown cell state", async () => {
    wide()
    setup({
      ...usualHost(),
      skills: [
        {
          id: "my-flow",
          name: "My flow",
          cells: { claude_code: { state: "quantum" } },
        },
        { id: "pdf-tools", name: "PDF tools", origin: "harness" },
      ],
    })
    engine.answer.skills_apply_links = (args) =>
      args.preflight
        ? undefined
        : {
            outcome: "invalid",
            ok: false,
            issues: [],
            ops: [
              {
                index: 0,
                skill: "pdf-tools",
                agent: "claude_code",
                action: "enable",
                status: "blocked",
                creates: [],
                removes: [],
                moves: [],
                gains: [],
                loses: [],
                touches: [],
                ack: null,
                issues: [{ code: "brand_new_code", detail: "whatever it is" }],
                warnings: [],
              },
            ],
          }
    render(<Harness />)
    expect(
      await screen.findByRole("switch", {
        name: "My flow, Claude Code: Unknown state (quantum)",
      })
    ).toBeDisabled()
    await userEvent.click(
      screen.getByRole("switch", { name: "PDF tools, Claude Code: Off" })
    )
    const notice = (await screen.findByText(/was not turned on/)).closest(
      "[role=alert]"
    )!
    expect(notice.textContent).toContain(
      "This Codeg reported brand_new_code, which this page does not know."
    )
    expect(notice.textContent).toContain("whatever it is")
  })
})

// ─── On a phone ───────────────────────────────────────────────────────

describe("SkillsSection — on a phone", () => {
  it("lists the skills, each with the agents it is on for, and opens one as a screen", async () => {
    mocks.mobile = true
    setup(usualHost())
    render(<Harness />)
    const row = await screen.findByRole("button", { name: /^My flow/ })
    expect(row.textContent).toContain("On for 1 of 5 agents")
    // No matrix on a phone.
    expect(screen.queryByRole("table")).toBeNull()
    await userEvent.click(row)
    expect(
      await screen.findByRole("button", { name: m.detail.back })
    ).toBeTruthy()
    expect(screen.getByRole("switch", { name: "Claude Code" })).toBeChecked()
  })
})
