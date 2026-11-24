import { useEffect, useLayoutEffect, useState } from "react"
import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"

const mocks = vi.hoisted(() => ({
  engine: null as null | {
    handle: (command: string, args?: Record<string, unknown>) => unknown
  },
  listeners: new Map<string, Set<(payload: unknown) => void>>(),
  mobile: false,
  desktop: true,
  remote: null as null | { connection: { name: string; base_url: string } },
}))

function listen(event: string, handler: (payload: unknown) => void) {
  const set = mocks.listeners.get(event) ?? new Set()
  set.add(handler)
  mocks.listeners.set(event, set)
  return () => set.delete(handler)
}

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({
    call: async (command: string, args?: Record<string, unknown>) =>
      mocks.engine?.handle(command, args),
    subscribe: async (event: string, handler: (payload: unknown) => void) =>
      listen(event, handler),
    onReconnect: () => () => {},
  }),
  getActiveRemoteConnectionId: () => (mocks.remote ? 7 : null),
  isDesktop: () => mocks.desktop,
}))
vi.mock("@/lib/platform", () => ({
  isDesktop: () => mocks.desktop,
  isLocalDesktop: () => mocks.desktop && !mocks.remote,
  revealItemInDir: async () => {},
  openUrl: async () => {},
  subscribe: async (event: string, handler: (payload: unknown) => void) =>
    listen(event, handler),
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
import { OFFICE_INSTALL } from "@/lib/harness/packs-state"
import {
  MEMBERS,
  rawListedHost,
  rawListedPlugin,
} from "@/lib/harness/plugin-install-fixtures"
import {
  createEngine,
  STORE,
  type Engine,
  type EngineOptions,
} from "@/lib/skills/test-fixtures"
import { HarnessChromeActions } from "../harness-chrome-actions"
import { PacksSection } from "./packs-section"

const m = enMessages.Harness.packs
const ms = enMessages.Harness.skills
const tUi = enMessages.GenerativeUiSettings
const tOffice = enMessages.OfficeToolsSettings

let view: ReturnType<typeof useHarnessView>
function Capture() {
  const current = useHarnessView()
  useEffect(() => {
    view = current
  })
  return null
}

/** The page is on Skill packs: what the chrome's Refresh acts on. */
function OnPacks() {
  const { setSection } = useHarnessView()
  useLayoutEffect(() => setSection("packs"), [setSection])
  return null
}

/** The page with the section — or, `shown` off, without it: to a
 *  conversation and back, or to another section. */
function Page({ initial = true }: { initial?: boolean }) {
  const [shown, setShown] = useState(initial)
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <button type="button" onClick={() => setShown((prev) => !prev)}>
        toggle section
      </button>
      <HarnessViewProvider>
        <Capture />
        <OnPacks />
        {/* Refresh is in the window's chrome, beside the page. */}
        <HarnessChromeActions buttonClassName="" iconClassName="" />
        {shown && <PacksSection />}
      </HarnessViewProvider>
    </NextIntlClientProvider>
  )
}

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  let reject: (error: unknown) => void = () => {}
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const meta = (id: string, name: string, category = "planning") => ({
  id,
  category,
  icon: null,
  sort_order: 0,
  featured: false,
  accent: null,
  needs_key: false,
  needs_env: false,
  display_name: { en: name },
  description: { en: `${name} does things.` },
  bundled_hash: "",
})

let engine: Engine
const answers: Record<string, (args: Record<string, unknown>) => unknown> = {}

function setup(options: Partial<EngineOptions> = {}) {
  engine = createEngine({
    agents: [
      { agent: "claude_code" },
      { agent: "codex", shared: true },
      { agent: "cline", shared: true },
      { agent: "custom:only-shared", own: false, shared: true },
    ],
    skills: [
      {
        id: "brainstorming",
        origin: "experts",
        cells: { claude_code: "linked" },
      },
      {
        id: "writing-plans",
        origin: "experts",
        cells: { claude_code: "blocked" },
      },
      { id: "hypothesis", origin: "science" },
      { id: "docx", origin: "office" },
      { id: "ui-render", origin: "ui", cells: { claude_code: "linked" } },
    ],
    ...options,
  })
  for (const key of Object.keys(answers)) delete answers[key]
  const lists: Record<string, (args: Record<string, unknown>) => unknown> = {
    experts_list: () => [
      {
        metadata: meta("brainstorming", "Brainstorming", "discovery"),
        installed_centrally: true,
        user_modified: false,
        central_path: "",
      },
      {
        metadata: meta("writing-plans", "Writing plans"),
        installed_centrally: true,
        user_modified: false,
        central_path: "",
      },
    ],
    science_list: () => [
      {
        metadata: meta("hypothesis", "Hypothesis", "ideation"),
        installed_centrally: true,
        user_modified: false,
        central_path: "",
      },
    ],
    officecli_list_skills: () => [
      {
        id: "docx",
        category: "documents",
        icon: "FileText",
        sortOrder: 0,
        displayName: { en: "Word" },
        description: { en: "" },
        installedCentrally: true,
      },
      {
        id: "pptx",
        category: "presentations",
        icon: "Presentation",
        sortOrder: 1,
        displayName: { en: "PowerPoint" },
        description: { en: "" },
        installedCentrally: false,
      },
    ],
    officecli_detect: () => ({
      installed: true,
      version: "1.0.0",
      path: "/usr/local/bin/officecli",
      runtimeError: null,
    }),
    generative_ui_skill_info: () => ({ id: "ui-render", conflict: false }),
    // Nothing installed from SRN Harness, so no plugin provides an expert.
    harness_installed: () => ({ mcp: [], skills: [], plugins: [] }),
    experts_read_content: () => "---\nname: brainstorming\n---\n# Brainstorm\n",
    generative_ui_read_content: () =>
      "---\nname: ui-render\n---\n# Show it as UI\n",
  }
  const handle = engine.handle
  engine.handle = (command, args = {}) => {
    const answer = answers[command] ?? lists[command]
    if (answer) {
      engine.calls.push({ command, args })
      return answer(args)
    }
    return handle(command, args)
  }
  engine.onChanged = (change) =>
    queueMicrotask(() => {
      for (const handler of mocks.listeners.get("skills://changed") ?? []) {
        handler(change)
      }
    })
  mocks.engine = engine
  return engine
}

const callsOf = (command: string) =>
  engine.calls.filter((call) => call.command === command)

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

let restoreWidth: (() => void) | null = null
beforeEach(() => {
  localStorage.clear()
  mocks.listeners.clear()
  mocks.mobile = false
  mocks.desktop = true
  mocks.remote = null
  restoreWidth = stubWidth(1600)
})
afterEach(() => {
  restoreWidth?.()
})

async function chooseTab(name: string) {
  await userEvent.click(await screen.findByRole("tab", { name }))
}

const refresh = () =>
  userEvent.click(screen.getByRole("button", { name: m.refresh }))

describe("PacksSection — the hub", () => {
  it("has the four packs, Experts first, and the Custom tab no more", async () => {
    setup()
    render(<Page />)
    expect(
      (await screen.findAllByRole("tab")).map((tab) => tab.textContent)
    ).toEqual(["Experts", "Science", "Office", "UI"])
    expect(screen.getByRole("tab", { name: "Experts" })).toHaveAttribute(
      "aria-selected",
      "true"
    )
    expect(screen.getByRole("button", { name: m.openCentral })).toBeTruthy()
    expect(screen.getByRole("button", { name: m.refresh })).toBeTruthy()
  })

  it("opens the pack a request asks for", async () => {
    setup()
    render(<Page />)
    await screen.findAllByRole("tab")
    act(() => {
      view.open({ section: "packs", tab: "office" })
    })
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Office" })).toHaveAttribute(
        "aria-selected",
        "true"
      )
    )
  })

  it("says which Codeg to update on an older one", async () => {
    setup()
    answers.skills_inventory = () => {
      throw { code: "not_implemented", message: "unknown command" }
    }
    render(<Page />)
    expect((await screen.findByRole("alert")).textContent).toBe(
      m.errors.unsupported
    )
  })
})

describe("PacksSection — switching through the engine", () => {
  it("toggles a cell through skills_apply_links, then reads the skills again", async () => {
    setup()
    render(<Page />)
    const cell = await screen.findByRole("switch", {
      name: "Brainstorming, Codex: Off",
    })
    const reads = callsOf("skills_inventory").length
    await userEvent.click(cell)
    await waitFor(() => expect(engine.writes()).toHaveLength(1))
    expect(engine.writes()[0]).toEqual([
      { skill: "brainstorming", agent: "codex", action: "enable" },
    ])
    await waitFor(() =>
      expect(callsOf("skills_inventory").length).toBeGreaterThan(reads)
    )
    // The packs' own wrappers, which refuse anything that reaches another
    // agent, are not what the page uses.
    expect(callsOf("experts_apply_links")).toHaveLength(0)
    expect(
      await screen.findByRole("switch", { name: "Brainstorming, Codex: On" })
    ).toHaveAttribute("aria-checked", "true")
  })

  it("asks first when a pack skill would be linked into a shared folder", async () => {
    setup()
    render(<Page />)
    await userEvent.click(
      await screen.findByRole("switch", {
        name: /^Brainstorming, custom:only-shared: Off/,
      })
    )
    const dialog = await screen.findByRole("dialog")
    expect(dialog.textContent).toContain(ms.effects.gains)
    expect(engine.writes()).toHaveLength(0)
    await userEvent.click(
      within(dialog).getByRole("button", { name: ms.effects.confirm.on })
    )
    await waitFor(() => expect(engine.writes()).toHaveLength(1))
    expect(engine.writes()[0][0].ack).toBe(
      "ack-brainstorming-custom:only-shared-enable-1"
    )
  })

  it("does not toggle a blocked cell", async () => {
    setup()
    render(<Page />)
    const cell = await screen.findByRole("switch", {
      name: `Writing plans, Claude Code: ${ms.cells.blocked}`,
    })
    expect(cell).toBeDisabled()
    await userEvent.click(cell, { pointerEventsCheck: 0 })
    expect(callsOf("skills_apply_links")).toHaveLength(0)
  })

  it("says a folder of the pack's name was left alone when the pack could not tell it is its own", async () => {
    setup({
      skills: [
        {
          id: "brainstorming",
          origin: "experts",
          cells: { claude_code: "linked" },
        },
        { id: "writing-plans", origin: "custom" },
      ],
      nameTaken: [{ id: "writing-plans", pack: "experts", held_by: "custom" }],
      problems: [
        {
          code: "ownership_unresolved",
          path: "/home/u/.codeg/skills/writing-plans",
          detail: "experts",
        },
      ],
    })
    render(<Page />)
    const cell = await screen.findByRole("switch", {
      name: `Writing plans, Claude Code: ${ms.cells.off} · ${m.unresolved}`,
    })
    expect(cell).toBeDisabled()
    await userEvent.click(screen.getByRole("button", { name: "Writing plans" }))
    expect((await screen.findByRole("article")).textContent).toContain(
      m.unresolved
    )
  })

  it("words what an Office sync left alone", async () => {
    setup()
    answers.officecli_sync_skills = () => ({
      synced: 1,
      errors: [],
      issues: [
        {
          code: "ownership_unresolved",
          path: "/home/u/.codeg/skills/pptx",
          detail: "office",
        },
      ],
    })
    render(<Page />)
    await chooseTab("Office")
    await userEvent.click(
      await screen.findByRole("button", { name: tOffice.detection.syncSkills })
    )
    expect(
      await screen.findByText(/Codeg could not read the Office pack's records/)
    ).toBeTruthy()
    expect(screen.getByText("/home/u/.codeg/skills/pptx")).toBeTruthy()
  })

  it("disables the cells of an Office skill that is not synced yet", async () => {
    setup()
    render(<Page />)
    await chooseTab("Office")
    const cell = await screen.findByRole("switch", {
      name: `PowerPoint, Claude Code: Off · ${tOffice.syncFirst}`,
    })
    expect(cell).toBeDisabled()
  })

  it("shows a search box for a pack, and none for the one skill of UI", async () => {
    setup()
    render(<Page />)
    expect(
      await screen.findByRole("textbox", { name: m.search.label })
    ).toBeTruthy()
    await chooseTab("UI")
    await screen.findByRole("switch", { name: /^UI Render, Claude Code/ })
    expect(screen.queryByRole("textbox", { name: m.search.label })).toBeNull()
  })
})

describe("PacksSection — experts a plugin provides", () => {
  const EXPERTS = [
    { id: "brainstorming", origin: "experts" as const },
    { id: "writing-plans", origin: "experts" as const },
  ]
  /** superpowers, with brainstorming its one skill, whole on `agents`. */
  const providing = (agents: string[]) => () => ({
    mcp: [],
    skills: [],
    plugins: [
      rawListedPlugin({
        members: [MEMBERS[0]],
        hosts: agents.map((agent) => rawListedHost(agent)),
      }),
    ],
  })
  const rowOf = async (name: string) => {
    await screen.findByRole("switch", { name: new RegExp(`^${name}, Codex`) })
    const row = screen.getByText(name).closest("tr")
    if (!row) throw new Error(`no row for ${name}`)
    return row
  }

  it("drops the count of a row a plugin holds for every agent, and skips it in a batch", async () => {
    setup({ skills: EXPERTS })
    answers.harness_installed = providing([
      "claude_code",
      "codex",
      "cline",
      "custom:only-shared",
    ])
    render(<Page />)
    const held = await rowOf("Brainstorming")
    expect(
      within(held).getByText(
        ms.grid.providedBy.replace("{plugin}", "superpowers")
      )
    ).toBeTruthy()
    expect(within(held).queryByText("0/4")).toBeNull()
    expect(within(await rowOf("Writing plans")).getByText("0/4")).toBeTruthy()

    await userEvent.click(
      screen.getByRole("button", { name: ms.grid.everything })
    )
    await userEvent.click(
      await screen.findByRole("menuitem", { name: ms.grid.everythingOn })
    )
    await waitFor(() =>
      expect(callsOf("skills_apply_links").length).toBeGreaterThan(0)
    )
    const skills = callsOf("skills_apply_links").flatMap((call) =>
      (call.args.ops as { skill: string }[]).map((op) => op.skill)
    )
    expect(skills).toContain("writing-plans")
    expect(skills).not.toContain("brainstorming")
  })

  it("keeps the count of a row a plugin holds for some agents only", async () => {
    setup({ skills: EXPERTS })
    answers.harness_installed = providing(["claude_code"])
    render(<Page />)
    const row = await rowOf("Brainstorming")
    expect(
      within(row).getByText(
        ms.grid.providedBy.replace("{plugin}", "superpowers")
      )
    ).toBeTruthy()
    expect(within(row).getByText("0/4")).toBeTruthy()
  })
})

// The pack bodies' own tests (settings/skill-pack-bodies.refresh,
// office-tools-settings.refresh, generative-ui-settings), carried over to the
// tabs that replace them.
describe.each([
  [
    "Experts",
    "experts_list",
    (name: string) => ({
      metadata: meta(name.toLowerCase(), name),
      installed_centrally: true,
      user_modified: false,
      central_path: "",
    }),
  ],
  [
    "Science",
    "science_list",
    (name: string) => ({
      metadata: meta(name.toLowerCase(), name, "ideation"),
      installed_centrally: true,
      user_modified: false,
      central_path: "",
    }),
  ],
] as const)("the %s tab", (tab, command, item) => {
  it("keeps a newer load when an earlier one fails late", async () => {
    setup()
    answers[command] = () => [item("Original")]
    render(<Page />)
    await chooseTab(tab)
    await screen.findByText("Original")

    // The first Refresh hangs, a second one answers, then the first fails.
    const first = deferred<unknown>()
    answers[command] = () => first.promise
    await refresh()
    answers[command] = () => [item("Newer")]
    await refresh()
    expect(await screen.findByText("Newer")).toBeInTheDocument()

    await act(async () => first.reject(new Error("stale failure")))
    expect(screen.queryByText(/stale failure/)).toBeNull()
    expect(screen.getByText("Newer")).toBeInTheDocument()
  })
})

describe("the Office tab", () => {
  const office = (name: string) => ({
    id: name.toLowerCase(),
    category: "documents",
    icon: "FileText",
    sortOrder: 0,
    displayName: { en: name },
    description: { en: "" },
    installedCentrally: true,
  })
  const info = (version: string) => ({
    installed: true,
    version,
    path: "/usr/local/bin/officecli",
    runtimeError: null,
  })

  it("keeps the newer skill list when an earlier load answers late", async () => {
    setup()
    answers.officecli_list_skills = () => [office("Original")]
    render(<Page />)
    await chooseTab("Office")
    await screen.findByText("Original")
    const first = deferred<unknown>()
    answers.officecli_list_skills = () => first.promise
    await refresh()
    answers.officecli_list_skills = () => [office("Newer")]
    await refresh()
    expect(await screen.findByText("Newer")).toBeInTheDocument()

    await act(async () => first.resolve([office("Stale")]))
    expect(screen.queryByText("Stale")).toBeNull()
    expect(screen.getByText("Newer")).toBeInTheDocument()
  })

  it("says nothing about an earlier load that fails late", async () => {
    setup()
    answers.officecli_list_skills = () => [office("Original")]
    render(<Page />)
    await chooseTab("Office")
    await screen.findByText("Original")
    const first = deferred<unknown>()
    answers.officecli_list_skills = () => first.promise
    await refresh()
    answers.officecli_list_skills = () => [office("Original")]
    await refresh()
    await act(async () => first.reject(new Error("stale failure")))
    expect(screen.queryByText(/stale failure/)).toBeNull()
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("keeps the newer detection when an earlier one answers late", async () => {
    setup()
    render(<Page />)
    await chooseTab("Office")
    expect(await screen.findByText("1.0.0")).toBeInTheDocument()
    const first = deferred<unknown>()
    answers.officecli_detect = () => first.promise
    await refresh()
    answers.officecli_detect = () => info("3.0.0")
    await refresh()
    expect(await screen.findByText("3.0.0")).toBeInTheDocument()

    await act(async () => first.resolve(info("2.0.0")))
    expect(screen.queryByText("2.0.0")).toBeNull()
    expect(screen.getByText("3.0.0")).toBeInTheDocument()
  })

  it("keeps an install's progress and log across a tab switch and a section switch, and lets it run once", async () => {
    setup()
    answers.officecli_detect = () => ({
      installed: false,
      version: null,
      path: null,
      runtimeError: null,
    })
    const install = deferred<unknown>()
    answers.officecli_install = () => install.promise
    answers.officecli_sync_skills = () => ({ synced: 9, errors: [] })
    render(<Page />)
    await chooseTab("Office")
    const button = await screen.findByRole("button", {
      name: tOffice.detection.install,
    })
    await userEvent.click(button)
    await waitFor(() => expect(callsOf("officecli_install")).toHaveLength(1))
    const taskId = callsOf("officecli_install")[0].args.taskId
    const say = (payload: string) =>
      act(() => {
        for (const handler of mocks.listeners.get("app://officecli-install") ??
          []) {
          handler({ task_id: taskId, kind: "log", payload })
        }
      })
    say("Downloading officecli…")

    // Install cannot be pressed again while it runs.
    expect(
      screen.getByRole("button", { name: m.office.installing })
    ).toBeDisabled()

    // Another pack, and back.
    await chooseTab("Experts")
    say("Unpacking…")
    await chooseTab("Office")
    expect(screen.getByRole("log").textContent).toContain(
      "Downloading officecli…"
    )
    expect(screen.getByRole("log").textContent).toContain("Unpacking…")

    // Another section (the section unmounts), and back.
    await userEvent.click(screen.getByText("toggle section"))
    expect(screen.queryByRole("tablist")).toBeNull()
    say("Almost there…")
    await userEvent.click(screen.getByText("toggle section"))
    expect((await screen.findByRole("log")).textContent).toContain(
      "Almost there…"
    )
    expect(
      screen.getByRole("button", { name: m.office.installing })
    ).toBeDisabled()
    expect(callsOf("officecli_install")).toHaveLength(1)

    answers.officecli_detect = () => ({
      installed: true,
      version: "1.2.0",
      path: "/usr/local/bin/officecli",
      runtimeError: null,
    })
    await act(async () =>
      install.resolve({
        installed: true,
        version: "1.2.0",
        path: "/usr/local/bin/officecli",
        runtimeError: null,
      })
    )
    await waitFor(() =>
      expect(view.slots.get(OFFICE_INSTALL).status).toBe("succeeded")
    )
    expect(callsOf("officecli_sync_skills")).toHaveLength(1)
    expect(await screen.findByText(m.office.installed)).toBeTruthy()
  })

  it("asks before uninstalling", async () => {
    setup()
    answers.officecli_uninstall = () => ({
      installed: false,
      version: null,
      path: null,
      runtimeError: null,
    })
    render(<Page />)
    await chooseTab("Office")
    await userEvent.click(
      await screen.findByRole("button", { name: tOffice.detection.uninstall })
    )
    const ask = await screen.findByRole("alertdialog")
    expect(ask.textContent).toContain(m.office.uninstallBody)
    await userEvent.click(
      within(ask).getByRole("button", { name: m.office.keep })
    )
    expect(callsOf("officecli_uninstall")).toHaveLength(0)

    await userEvent.click(
      screen.getByRole("button", { name: tOffice.detection.uninstall })
    )
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: tOffice.detection.uninstall,
      })
    )
    await waitFor(() => expect(callsOf("officecli_uninstall")).toHaveLength(1))
  })
})

describe("the UI tab", () => {
  it("is one ui-render row with a column per agent that has skills", async () => {
    setup()
    render(<Page />)
    await chooseTab("UI")
    expect(
      await screen.findByRole("switch", {
        name: `${tUi.skillName}, Claude Code: On`,
      })
    ).toHaveAttribute("aria-checked", "true")
    expect(
      screen.getByRole("switch", { name: `${tUi.skillName}, Codex: Off` })
    ).toHaveAttribute("aria-checked", "false")
    expect(screen.getAllByRole("switch")).toHaveLength(4)
    expect(screen.getByText(tUi.usage)).toBeInTheDocument()
  })

  it("enables the skill for one agent with a click", async () => {
    setup()
    render(<Page />)
    await chooseTab("UI")
    await userEvent.click(
      await screen.findByRole("switch", {
        name: `${tUi.skillName}, Codex: Off`,
      })
    )
    await waitFor(() =>
      expect(engine.writes()[0]).toEqual([
        { skill: "ui-render", agent: "codex", action: "enable" },
      ])
    )
    expect(
      await screen.findByRole("switch", { name: `${tUi.skillName}, Codex: On` })
    ).toHaveAttribute("aria-checked", "true")
  })

  it("locks every cell while a skill of the user's holds the name", async () => {
    setup({
      skills: [
        { id: "ui-render", origin: "custom", cells: { claude_code: "linked" } },
      ],
      nameTaken: [{ id: "ui-render", pack: "ui", held_by: "custom" }],
    })
    answers.generative_ui_skill_info = () => ({
      id: "ui-render",
      conflict: true,
    })
    render(<Page />)
    await chooseTab("UI")
    const cells = await screen.findAllByRole("switch")
    expect(cells).toHaveLength(4)
    for (const cell of cells) {
      expect(cell).toBeDisabled()
      // The user's own skill of that name is not the pack's to switch.
      expect(cell).toHaveAttribute("aria-checked", "false")
    }
    // Nor through the batch menu.
    await userEvent.click(
      screen.getByRole("button", { name: ms.grid.everything })
    )
    await userEvent.click(
      await screen.findByRole("menuitem", { name: ms.grid.everythingOn })
    )
    expect(callsOf("skills_apply_links")).toHaveLength(0)
    expect(screen.getAllByText(m.ui.nameTaken).length).toBeGreaterThan(0)
    expect(screen.getAllByText(tUi.badges.nameTaken).length).toBeGreaterThan(0)
  })

  it("says why when it cannot load", async () => {
    setup()
    answers.generative_ui_skill_info = () => {
      throw new Error("backend unreachable")
    }
    render(<Page />)
    await chooseTab("UI")
    expect(await screen.findByText(/backend unreachable/)).toBeInTheDocument()
    expect(screen.queryByRole("switch")).toBeNull()
  })

  it("reloads when Refresh asks it to", async () => {
    setup()
    render(<Page />)
    await chooseTab("UI")
    await screen.findByRole("switch", { name: `${tUi.skillName}, Codex: Off` })
    expect(callsOf("generative_ui_skill_info")).toHaveLength(1)
    engine.setCell("ui-render", "codex", "linked")
    await refresh()
    expect(
      await screen.findByRole("switch", { name: `${tUi.skillName}, Codex: On` })
    ).toHaveAttribute("aria-checked", "true")
    expect(callsOf("generative_ui_skill_info")).toHaveLength(2)
  })

  it("keeps a newer load when an earlier one fails late", async () => {
    setup()
    render(<Page />)
    await chooseTab("UI")
    await screen.findByRole("switch", { name: `${tUi.skillName}, Codex: Off` })
    const first = deferred<unknown>()
    answers.generative_ui_skill_info = () => first.promise
    await refresh()
    answers.generative_ui_skill_info = () => ({
      id: "ui-render",
      conflict: false,
    })
    engine.setCell("ui-render", "codex", "linked")
    await refresh()
    expect(
      await screen.findByRole("switch", { name: `${tUi.skillName}, Codex: On` })
    ).toBeInTheDocument()
    await act(async () => first.reject(new Error("stale failure")))
    expect(screen.queryByText(/stale failure/)).toBeNull()
    expect(
      screen.getByRole("switch", { name: `${tUi.skillName}, Codex: On` })
    ).toBeInTheDocument()
  })

  it("previews the skill the agents get", async () => {
    setup()
    render(<Page />)
    await chooseTab("UI")
    await userEvent.click(
      await screen.findByRole("button", { name: tUi.skillName })
    )
    expect(await screen.findByText("Show it as UI")).toBeInTheDocument()
    expect(callsOf("generative_ui_read_content")).toHaveLength(1)
    // Read only here; copied to be changed.
    expect(screen.getByRole("button", { name: m.copyAsCustom })).toBeTruthy()
    expect(screen.getByText(`${STORE}/ui-render`)).toBeTruthy()
  })
})
