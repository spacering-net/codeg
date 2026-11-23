import { useEffect } from "react"
import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  listeners: new Map<string, Set<(payload: unknown) => void>>(),
}))

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({
    call: mocks.call,
    subscribe: async (event: string, handler: (payload: unknown) => void) => {
      const set = mocks.listeners.get(event) ?? new Set()
      set.add(handler)
      mocks.listeners.set(event, set)
      return () => set.delete(handler)
    },
  }),
  getActiveRemoteConnectionId: () => null,
}))
vi.mock("@/lib/platform", () => ({
  isDesktop: () => true,
  openUrl: async () => {},
}))
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }))
vi.mock("@/contexts/remote-connection-context", () => ({
  useRemoteConnection: () => null,
}))

import {
  HarnessViewProvider,
  useHarnessView,
} from "@/contexts/harness-view-context"
import { MCP_HARNESS_DIALOG } from "@/lib/harness/mcp-install-state"
import {
  openSkillInstall,
  openSkillUninstall,
} from "@/lib/harness/skill-install-state"
import {
  ACK_CODEX,
  ACK_CODEX_RENAMED,
  NEW_STATE,
  rawInstalledSkill,
  rawLinks,
  rawLinksApplied,
  rawSkillInstallResult,
  rawSkillPlan,
  rawSkillPlanAgent,
  rawSkillSnapshot,
  rawSkillUninstallResult,
  STATE,
} from "@/lib/harness/skill-install-fixtures"
import { HarnessInstallDialogs } from "./harness-install-dialogs"

type Args = Record<string, unknown> | undefined
type Handler = (args: Args) => unknown

let backend: Record<string, Handler>
const callsOf = (command: string) =>
  mocks.call.mock.calls
    .filter(([name]) => name === command)
    .map(([, args]) => args as Record<string, unknown>)

type View = ReturnType<typeof useHarnessView>
let view: View
function Capture() {
  const current = useHarnessView()
  useEffect(() => {
    view = current
  })
  return null
}

/** `show` stands for the Harness page being on screen: the provider (and its
 *  slots) stays when the user goes to a conversation; the page goes. */
function Harness({ show = true }: { show?: boolean }) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <HarnessViewProvider>
        <Capture />
        {show && <HarnessInstallDialogs />}
      </HarnessViewProvider>
    </NextIntlClientProvider>
  )
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** A plan whose link preview is for the agents it was asked about. */
const planFor =
  (overrides: Record<string, unknown> = {}): Handler =>
  (args) =>
    rawSkillPlan(overrides, (args?.agents as string[] | null) ?? null)

const EXPECTED_ARGS = {
  itemRef: "anthropics/pdf",
  revision: 3,
  installName: "pdf",
  agents: ["claude_code", "codex"],
  keepAllowedTools: false,
  stateSha256: STATE,
  acks: { codex: ACK_CODEX },
  acceptYanked: false,
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  mocks.listeners.clear()
  backend = {
    harness_skill_plan: planFor(),
    harness_installed: () => ({ mcp: [], skills: [] }),
    harness_skill_install: () =>
      rawSkillInstallResult("installed", {
        links: rawLinksApplied(["claude_code", "codex"]),
        rewrites: {},
      }),
  }
  mocks.call.mockReset()
  mocks.call.mockImplementation(async (command: string, args: Args) => {
    const handler = backend[command]
    if (!handler) throw new Error(`unexpected command ${command}`)
    return handler(args)
  })
})

async function openDialog(
  request: Partial<Parameters<typeof openSkillInstall>[1]> = {}
) {
  render(<Harness />)
  act(() => {
    openSkillInstall(view.slots, {
      itemRef: "anthropics/pdf",
      purpose: "install",
      from: "discover",
      ...request,
    })
  })
  return screen.findByRole("dialog")
}

const dialog = () => screen.getByRole("dialog")
/** A footer's button: the frame's own close button is named "Close" too. */
const button = (name: string | RegExp) => {
  const found = within(dialog()).getAllByRole("button", { name })
  return found[found.length - 1]
}
const ready = async (name = "Install") => {
  await waitFor(() => expect(button(name)).toBeEnabled())
}

describe("Skill install dialog — what it shows", () => {
  it("shows the item, the catalog's state now, the package, the name and what linking does — and installs nothing on opening", async () => {
    await openDialog()
    expect(
      await screen.findByRole("heading", { name: "Install PDF Tools" })
    ).toBeInTheDocument()
    await ready()
    const body = dialog()
    expect(body).toHaveTextContent("anthropics/pdf")
    expect(body).toHaveTextContent("Version 1.2.0, revision 3")
    // From the fresh snapshot.
    expect(body).toHaveTextContent("Low risk")
    expect(body).toHaveTextContent("Findings: 0 high, 1 medium, 2 low")
    // SKILL.md as the catalog read it, as text.
    expect(body).toHaveTextContent("Read, fill and merge PDF files.")
    expect(body).toHaveTextContent("License: MIT")
    expect(body).toHaveTextContent("2 files")
    // The agents: Codex links into a folder OpenCode reads too.
    const agents = within(body).getByRole("group", { name: "Link to" })
    expect(within(agents).getByLabelText(/Claude Code/)).toBeChecked()
    expect(within(agents).getByLabelText(/^Codex/)).toBeChecked()
    expect(within(agents).getByLabelText(/Kiro CLI/)).toBeDisabled()
    expect(agents).toHaveTextContent("No skills folder to link into")
    // Only what is off gets a word: Codex reaches OpenCode, said on its
    // row; Claude Code's link goes where the tick says, unremarked.
    expect(
      within(agents)
        .getByLabelText(/^Codex/)
        .closest("li")
    ).toHaveTextContent("Also affects OpenCode")
    expect(
      within(agents)
        .getByLabelText(/Claude Code/)
        .closest("li")
    ).not.toHaveTextContent(/Will link|Already sees/)
    // Gemini is not installed: folded away.
    expect(within(agents).queryByLabelText(/Gemini/)).toBeNull()
    // No list of the links' effects under the agents: a warning, if any.
    expect(within(body).queryByText("Also turns it on for:")).toBeNull()
    expect(body).toHaveTextContent(
      "Linking also changes what other agents see. Confirming confirms this too."
    )
    expect(callsOf("harness_skill_install")).toHaveLength(0)
  })

  it("says on an agent's own row why it cannot be linked", async () => {
    const links = rawLinks(["claude_code", "codex"]) as {
      ok: boolean
      ops: Record<string, unknown>[]
    }
    links.ok = false
    links.ops[0] = {
      ...links.ops[0],
      status: "blocked",
      creates: [],
      issues: [
        { code: "target_occupied", path: "/home/u/.claude_code/skills/pdf" },
      ],
    }
    backend.harness_skill_plan = planFor({ links })
    await openDialog()
    await ready()
    const agents = within(dialog()).getByRole("group", { name: "Link to" })
    expect(
      within(agents)
        .getByLabelText(/Claude Code/)
        .closest("li")
    ).toHaveTextContent(
      "Cannot be linked · A folder or file of the same name is in the way."
    )
    expect(dialog()).toHaveTextContent("Some agents cannot be linked.")
  })

  it("says why the skill's own name was not used, and that SKILL.md's name follows", async () => {
    backend.harness_skill_plan = planFor({
      install_name: {
        name: "pdf",
        default: "pdf-anthropics",
        taken: [
          {
            name: "pdf",
            by: "custom",
            pack: null,
            item_id: null,
            item_ref: null,
            path: "/home/u/.codeg/skills/pdf",
            agents: [],
          },
          {
            name: "pdf",
            by: "agent_dir",
            pack: null,
            item_id: null,
            item_ref: null,
            path: "/home/u/.codex/skills/pdf",
            agents: ["codex"],
          },
        ],
        pattern: "^(?!-)(?!.*--)[a-z0-9-]{1,64}(?<!-)$",
      },
    })
    await openDialog()
    await ready()
    const name = within(dialog()).getByLabelText("Install name")
    expect(name).toHaveValue("pdf-anthropics")
    expect(dialog()).toHaveTextContent(
      "pdf is taken, so it is installed as pdf-anthropics. Taken by:"
    )
    expect(dialog()).toHaveTextContent("your custom skill in Codeg's store")
    expect(dialog()).toHaveTextContent(
      "something in the skills folder of Codex"
    )
    expect(dialog()).toHaveTextContent(
      "SKILL.md's name is set to pdf-anthropics"
    )
  })

  it("drops allowed-tools unless the user keeps it, and says what it allows", async () => {
    const user = userEvent.setup()
    backend.harness_skill_plan = planFor({
      skill: {
        name: "pdf",
        description: "Read PDFs.",
        license: null,
        compatibility: null,
        allowed_tools: ["Bash(python:*)", "Read"],
      },
    })
    await openDialog()
    await ready()
    const keep = within(dialog()).getByLabelText("Keep allowed-tools")
    expect(keep).not.toBeChecked()
    expect(dialog()).toHaveTextContent("Bash(python:*)")
    expect(dialog()).toHaveTextContent(
      "Off: Codeg removes this line from SKILL.md"
    )
    await user.click(button("Install"))
    await screen.findByText("Installed.")
    expect(callsOf("harness_skill_install")[0].keepAllowedTools).toBe(false)
  })

  it("keeps allowed-tools when ticked — and only then", async () => {
    const user = userEvent.setup()
    backend.harness_skill_plan = planFor({
      skill: { name: "pdf", allowed_tools: ["Read"] },
    })
    await openDialog()
    await ready()
    await user.click(within(dialog()).getByLabelText("Keep allowed-tools"))
    expect(dialog()).toHaveTextContent(
      "On: the agent may use these tools without asking you."
    )
    await user.click(button("Install"))
    await screen.findByText("Installed.")
    expect(callsOf("harness_skill_install")[0].keepAllowedTools).toBe(true)
  })

  it("says why an item cannot be installed, and offers nothing to confirm", async () => {
    backend.harness_skill_plan = planFor({
      blocking: [
        {
          code: "file_too_large",
          params: { path: "big.bin", size: "20971520", limit: "10485760" },
        },
        { code: "not_a_skill", params: { kind: "mcp" } },
      ],
    })
    await openDialog()
    expect(
      await screen.findByText("This cannot be installed")
    ).toBeInTheDocument()
    expect(dialog()).toHaveTextContent(
      "big.bin is 20 MB; a file may be at most 10 MB."
    )
    expect(dialog()).toHaveTextContent("This is not a skill (it is: MCP).")
    expect(
      within(dialog()).queryByRole("button", { name: "Install" })
    ).toBeNull()
  })
})

describe("Skill install dialog — confirming", () => {
  it("installs only when confirmed, with exactly the plan's revision, fingerprint, name, agents and acks", async () => {
    const user = userEvent.setup()
    await openDialog()
    await ready()
    // Re-rendering and waiting install nothing.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(callsOf("harness_skill_install")).toHaveLength(0)

    await user.click(button("Install"))
    expect(await screen.findByText("Installed.")).toBeInTheDocument()
    expect(callsOf("harness_skill_install")).toEqual([EXPECTED_ARGS])
    // Each agent's link, as the Skills section shows a change.
    expect(dialog()).toHaveTextContent("Claude Code")
    expect(dialog()).toHaveTextContent("Done")
    // What is installed is read again, not patched.
    await waitFor(() => expect(callsOf("harness_installed")).toHaveLength(1))
  })

  it("asks for the links of the agents ticked before anything can be confirmed", async () => {
    const user = userEvent.setup()
    await openDialog()
    await ready()
    const pending = deferred<unknown>()
    backend.harness_skill_plan = () => pending.promise
    await user.click(
      within(dialog()).getByRole("button", { name: /Show all agents/ })
    )
    await user.click(within(dialog()).getByLabelText(/Gemini CLI/))
    expect(callsOf("harness_skill_plan").slice(-1)[0]).toEqual({
      itemRef: "anthropics/pdf",
      revision: null,
      agents: ["claude_code", "codex", "gemini"],
    })
    expect(button("Install")).toBeDisabled()
    expect(dialog()).toHaveTextContent("Working out what linking does…")
    await act(async () => {
      pending.resolve(rawSkillPlan({}, ["claude_code", "codex", "gemini"]))
    })
    await ready()
    await user.click(button("Install"))
    await screen.findByText("Installed.")
    expect(callsOf("harness_skill_install")[0]).toMatchObject({
      agents: ["claude_code", "codex", "gemini"],
      acks: { codex: ACK_CODEX },
    })
  })

  it("unticking an agent drops its ack from the call", async () => {
    const user = userEvent.setup()
    await openDialog()
    await ready()
    await user.click(within(dialog()).getByLabelText(/^Codex/))
    await ready()
    await user.click(button("Install"))
    await screen.findByText("Installed.")
    expect(callsOf("harness_skill_install")[0]).toMatchObject({
      agents: ["claude_code"],
      acks: {},
    })
  })

  it("lets only the newest plan land", async () => {
    const user = userEvent.setup()
    await openDialog()
    await ready()
    const first = deferred<unknown>()
    const second = deferred<unknown>()
    const answers = [first, second]
    backend.harness_skill_plan = () => answers.shift()!.promise
    await user.click(within(dialog()).getByLabelText(/^Codex/))
    await user.click(within(dialog()).getByLabelText(/^Codex/))
    // The second answer (both ticked) comes first; the first, late.
    await act(async () => {
      second.resolve(rawSkillPlan({}, ["claude_code", "codex"]))
    })
    await act(async () => {
      first.resolve(
        rawSkillPlan({ state_sha256: "dead".repeat(16) }, ["claude_code"])
      )
    })
    await ready()
    await user.click(button("Install"))
    await screen.findByText("Installed.")
    expect(callsOf("harness_skill_install")).toEqual([EXPECTED_ARGS])
  })

  it("under a name the user typed, shows what linking does when the install says so, and confirms that", async () => {
    const user = userEvent.setup()
    backend.harness_skill_install = (args) =>
      (args?.acks as Record<string, string>).codex === ACK_CODEX_RENAMED
        ? rawSkillInstallResult("installed", {
            name: "pdf-mine",
            links: rawLinksApplied(["claude_code", "codex"], "pdf-mine"),
            rewrites: { name: { from: "pdf", to: "pdf-mine" } },
          })
        : rawSkillInstallResult("acknowledgement_required", {
            name: "pdf-mine",
            issues: [
              { code: "acknowledgement_required", params: { agent: "codex" } },
            ],
            links: rawLinks(["claude_code", "codex"], "pdf-mine"),
          })
    await openDialog()
    await ready()
    const name = within(dialog()).getByLabelText("Install name")
    await user.clear(name)
    await user.type(name, "pdf-mine")
    expect(dialog()).toHaveTextContent(
      "What linking does under pdf-mine is worked out when you confirm."
    )
    await user.click(button("Install"))
    // Nothing written: the effects under the new name, to confirm.
    expect(
      await screen.findByText(/Linking it does not do what was shown before/)
    ).toBeInTheDocument()
    expect(callsOf("harness_skill_install")[0]).toMatchObject({
      installName: "pdf-mine",
      acks: {},
    })
    expect(
      within(dialog())
        .getByLabelText(/^Codex/)
        .closest("li")
    ).toHaveTextContent("Also affects OpenCode")
    await user.click(button("Install"))
    expect(await screen.findByText("Installed.")).toBeInTheDocument()
    expect(callsOf("harness_skill_install")[1]).toMatchObject({
      installName: "pdf-mine",
      acks: { codex: ACK_CODEX_RENAMED },
    })
    expect(dialog()).toHaveTextContent("SKILL.md's name was set to pdf-mine.")
  })

  it("when the catalog's account changed, shows what changed and confirms the new state", async () => {
    const user = userEvent.setup()
    backend.harness_skill_install = (args) =>
      args?.stateSha256 === NEW_STATE
        ? rawSkillInstallResult("installed", {
            links: rawLinksApplied(["claude_code", "codex"]),
          })
        : rawSkillInstallResult("state_changed", {
            changes: [
              {
                code: "risk_changed",
                params: { from: "low", to: "high" },
              },
            ],
            snapshot: rawSkillSnapshot({
              risk: "high",
              stateSha256: NEW_STATE,
            }),
            state_sha256: NEW_STATE,
          })
    await openDialog()
    await ready()
    await user.click(button("Install"))
    expect(
      await screen.findByText(
        "SRN Harness's account of this version changed after you opened this"
      )
    ).toBeInTheDocument()
    expect(dialog()).toHaveTextContent("Risk: low → high")
    expect(dialog()).toHaveTextContent("High risk")
    await user.click(button("Install with these changes"))
    await screen.findByText("Installed.")
    expect(callsOf("harness_skill_install")[1]).toMatchObject({
      stateSha256: NEW_STATE,
      acks: { codex: ACK_CODEX },
    })
  })

  it("needs a withdrawn version accepted in so many words", async () => {
    const user = userEvent.setup()
    backend.harness_skill_plan = planFor({
      confirm: [{ code: "yanked" }],
      snapshot: rawSkillSnapshot({ status: "yanked" }),
    })
    await openDialog()
    await screen.findByText("Its author withdrew this version")
    expect(button("Install")).toBeDisabled()
    expect(dialog()).toHaveTextContent(
      "Confirm installing the withdrawn version."
    )
    await user.click(
      within(dialog()).getByLabelText("Install the withdrawn version anyway")
    )
    await ready()
    await user.click(button("Install"))
    await screen.findByText("Installed.")
    expect(callsOf("harness_skill_install")[0].acceptYanked).toBe(true)
  })

  it("retries a busy lock with the same call", async () => {
    const user = userEvent.setup()
    let busy = true
    backend.harness_skill_install = () =>
      busy
        ? rawSkillInstallResult("busy", { issues: [{ code: "lock_busy" }] })
        : rawSkillInstallResult("installed", {
            links: rawLinksApplied(["claude_code", "codex"]),
          })
    await openDialog()
    await ready()
    await user.click(button("Install"))
    expect(
      await screen.findByText(
        "Another change to skills was in progress, so nothing was written. Try again."
      )
    ).toBeInTheDocument()
    busy = false
    await user.click(button("Try again"))
    await screen.findByText("Installed.")
    expect(callsOf("harness_skill_install")).toEqual([
      EXPECTED_ARGS,
      EXPECTED_ARGS,
    ])
  })

  it("says in words what was wrong with a package, and offers nothing to retry", async () => {
    const user = userEvent.setup()
    backend.harness_skill_install = () =>
      rawSkillInstallResult("invalid_package", {
        issues: [
          { code: "file_hash_mismatch", params: { path: "scripts/fill.py" } },
          {
            code: "archive_size_mismatch",
            params: { expected: "4096", actual: "5000" },
          },
        ],
        phases: [
          { phase: "download", status: "done" },
          { phase: "verify", status: "failed" },
        ],
      })
    await openDialog()
    await ready()
    await user.click(button("Install"))
    expect(
      await screen.findByText(
        "The package is not what SRN Harness lists, so nothing was installed; Codeg's store is as it was."
      )
    ).toBeInTheDocument()
    expect(dialog()).toHaveTextContent(
      "scripts/fill.py is not the file SRN Harness lists: its SHA-256 differs."
    )
    expect(dialog()).toHaveTextContent(
      "The archive downloaded is 4.9 KB, not the 4 KB SRN Harness lists."
    )
    expect(dialog()).toHaveTextContent("Check the files")
    expect(
      within(dialog()).queryByRole("button", { name: /Try again/ })
    ).toBeNull()
    expect(callsOf("harness_skill_install")).toHaveLength(1)
  })

  it("goes back to the input with why, when the name was refused", async () => {
    const user = userEvent.setup()
    backend.harness_skill_install = () =>
      rawSkillInstallResult("refused", {
        issues: [
          {
            code: "name_taken",
            params: { name: "pdf", by: "harness", item_ref: "acme/pdf" },
          },
        ],
      })
    await openDialog()
    await ready()
    await user.click(button("Install"))
    expect(
      await screen.findByText("Codeg did not install it, and wrote nothing:")
    ).toBeInTheDocument()
    expect(dialog()).toHaveTextContent(
      "pdf is taken: another skill from SRN Harness (acme/pdf)"
    )
    expect(within(dialog()).getByLabelText("Install name")).toBeInTheDocument()
  })

  it("installed meanwhile under another name: plans again, and waits for another confirmation", async () => {
    const user = userEvent.setup()
    let installed = false
    backend.harness_skill_plan = (args) =>
      rawSkillPlan(
        installed
          ? {
              install_name: {
                name: "pdf",
                default: "pdf-other",
                taken: [],
                pattern: "",
              },
              installed: rawInstalledSkill({ name: "pdf-other" }),
            }
          : {},
        (args?.agents as string[] | null) ?? null
      )
    backend.harness_skill_install = () => {
      installed = true
      return rawSkillInstallResult("refused", {
        issues: [
          {
            code: "installed_under_other_name",
            params: { name: "pdf-other" },
          },
        ],
      })
    }
    await openDialog()
    await ready()
    await user.click(button("Install"))
    await waitFor(() =>
      expect(dialog()).toHaveTextContent("It is already installed as pdf-other")
    )
    await waitFor(() =>
      expect(within(dialog()).getByLabelText("Install name")).toHaveValue(
        "pdf-other"
      )
    )
    expect(callsOf("harness_skill_plan").length).toBeGreaterThanOrEqual(2)
    expect(callsOf("harness_skill_install")).toHaveLength(1)
    await ready("Reinstall")
    // Nothing else is sent until the user confirms; the dialog can close.
    await user.click(button("Cancel"))
    expect(view.slots.get(MCP_HARNESS_DIALOG)).toBeNull()
    expect(callsOf("harness_skill_install")).toHaveLength(1)
  })

  it("shows what links were left out, and the copies kept, after an update", async () => {
    const user = userEvent.setup()
    backend.harness_skill_install = () =>
      rawSkillInstallResult("installed", {
        links: rawLinksApplied(["claude_code"]),
        links_skipped: [
          {
            index: 1,
            skill: "pdf",
            agent: "codex",
            action: "enable",
            status: "blocked",
            issues: [
              { code: "target_occupied", path: "/home/u/.agents/skills/pdf" },
            ],
          },
        ],
        copies: {
          refreshed: [],
          kept_changed: ["/home/u/.cline/skills/pdf"],
          problems: [],
        },
        backup: "/home/u/.codeg/skills/.user-backups/pdf/20261117-093000.000",
      })
    await openDialog()
    await ready()
    await user.click(button("Install"))
    await screen.findByText("Installed.")
    expect(dialog()).toHaveTextContent(
      "Not linked, because something is in the way"
    )
    expect(dialog()).toHaveTextContent(
      "A folder or file of the same name is in the way."
    )
    expect(dialog()).toHaveTextContent(
      "Copies changed on the agent's side keep the old version:"
    )
    expect(dialog()).toHaveTextContent(".user-backups/pdf/20261117-093000.000")
  })
})

describe("Skill install dialog — an update", () => {
  it("lists the files changed here and what the new version asks for that the installed one did not", async () => {
    backend.harness_skill_plan = (args) =>
      args?.revision === 2
        ? rawSkillPlan({
            item: {
              id: "item-pdf",
              ref: "anthropics/pdf",
              kind: "skill",
              title: { en: "PDF Tools" },
              revision: 2,
              version: "1.1.0",
              published_at: "2026-11-01T08:00:00.000Z",
            },
            snapshot: rawSkillSnapshot({
              revision: 2,
              risk: "low",
              permissions: {
                declared: { network: [] },
                detected: { runsCode: ["node"] },
              },
            }),
          })
        : rawSkillPlan(
            {
              snapshot: rawSkillSnapshot({
                risk: "medium",
                permissions: {
                  declared: { network: ["api.acme.example"] },
                  detected: { runsCode: ["node"] },
                },
              }),
              default_agents: ["claude_code"],
              warnings: [
                { code: "files_changed_locally", params: { count: "2" } },
              ],
              installed: rawInstalledSkill({
                revision: 2,
                version: "1.1.0",
                state: "changed_locally",
                files: {
                  changed: ["SKILL.md"],
                  added: ["notes.md"],
                  missing: [],
                },
              }),
            },
            (args?.agents as string[] | null) ?? ["claude_code"]
          )
    await openDialog({ purpose: "update" })
    expect(
      await screen.findByRole("heading", { name: "Update PDF Tools" })
    ).toBeInTheDocument()
    expect(dialog()).toHaveTextContent("From version 1.1.0 to 1.2.0.")
    expect(dialog()).toHaveTextContent("SKILL.md")
    expect(dialog()).toHaveTextContent("notes.md")
    expect(dialog()).toHaveTextContent(
      "kept in Codeg's backups (.user-backups), never deleted"
    )
    expect(
      await screen.findByText(
        "The new version asks for more than the installed one:"
      )
    ).toBeInTheDocument()
    expect(dialog()).toHaveTextContent("Risk: low → medium")
    expect(dialog()).toHaveTextContent("Now declares: Network api.acme.example")
    // The installed revision's state was asked for, fresh.
    expect(callsOf("harness_skill_plan")).toContainEqual({
      itemRef: "anthropics/pdf",
      revision: 2,
      agents: null,
    })
    // The agent that sees it keeps it.
    const agents = within(dialog()).getByRole("group", { name: "Link to" })
    expect(within(agents).getByLabelText(/Claude Code/)).toBeDisabled()
    expect(agents).toHaveTextContent("Sees it now, and keeps it")
    expect(within(dialog()).getByLabelText("Install name")).toHaveAttribute(
      "readonly"
    )
    expect(callsOf("harness_skill_install")).toHaveLength(0)
  })
})

describe("Skill uninstall dialog", () => {
  it("shows what goes and that the changed folder is kept, then uninstalls with the preflight's ack", async () => {
    const user = userEvent.setup()
    const ack = "ab".repeat(32)
    backend.harness_skill_uninstall = (args) =>
      args?.preflight
        ? rawSkillUninstallResult("preflight", {
            files: { changed: ["SKILL.md"], added: [], missing: [] },
            keeps_folder: true,
          })
        : rawSkillUninstallResult("uninstalled", {
            backup: "/home/u/.codeg/skills/.user-backups/pdf/20261117-1",
          })
    render(<Harness />)
    act(() => {
      openSkillUninstall(view.slots, {
        itemId: "item-pdf",
        itemRef: "anthropics/pdf",
        name: "pdf",
      })
    })
    expect(
      await screen.findByRole("heading", { name: "Uninstall pdf" })
    ).toBeInTheDocument()
    await waitFor(() => expect(button("Uninstall")).toBeEnabled())
    expect(dialog()).toHaveTextContent("/home/u/.claude_code/skills/pdf")
    expect(dialog()).toHaveTextContent("Stop seeing it:")
    expect(dialog()).toHaveTextContent(
      "Its folder is kept in Codeg's backups (.user-backups), with your changes."
    )
    expect(callsOf("harness_skill_uninstall")).toEqual([
      { itemId: "item-pdf", preflight: true, ack: null },
    ])
    await user.click(button("Uninstall"))
    expect(await screen.findByText("Uninstalled.")).toBeInTheDocument()
    expect(callsOf("harness_skill_uninstall")[1]).toEqual({
      itemId: "item-pdf",
      preflight: false,
      ack,
    })
    expect(dialog()).toHaveTextContent(".user-backups/pdf/20261117-1")
    await waitFor(() => expect(callsOf("harness_installed")).toHaveLength(1))
  })

  it("when what it would do changed, removes nothing and asks again with the new account", async () => {
    const user = userEvent.setup()
    const fresh = "cd".repeat(32)
    backend.harness_skill_uninstall = (args) =>
      args?.preflight
        ? rawSkillUninstallResult("preflight")
        : args?.ack === fresh
          ? rawSkillUninstallResult("uninstalled")
          : rawSkillUninstallResult("acknowledgement_required", {
              issues: [{ code: "effects_changed", params: {} }],
              loses: ["claude_code", "codex"],
              ack: fresh,
            })
    render(<Harness />)
    act(() => {
      openSkillUninstall(view.slots, {
        itemId: "item-pdf",
        itemRef: "anthropics/pdf",
        name: "pdf",
      })
    })
    await waitFor(() => expect(button("Uninstall")).toBeEnabled())
    await user.click(button("Uninstall"))
    expect(
      await screen.findByText(
        /What uninstalling does changed since it was shown/
      )
    ).toBeInTheDocument()
    expect(dialog()).toHaveTextContent("Codex")
    await user.click(button("Uninstall"))
    await screen.findByText("Uninstalled.")
    expect(callsOf("harness_skill_uninstall").map((args) => args.ack)).toEqual([
      null,
      "ab".repeat(32),
      fresh,
    ])
  })
})

describe("Skill install dialog — across leaving the page", () => {
  it("keeps the ticks and the name, and an install in flight lands on the way back", async () => {
    const user = userEvent.setup()
    const page = render(<Harness />)
    act(() => {
      openSkillInstall(view.slots, {
        itemRef: "anthropics/pdf",
        purpose: "install",
        from: "discover",
      })
    })
    await screen.findByRole("dialog")
    await ready()
    await user.click(within(dialog()).getByLabelText(/^Codex/))
    await ready()
    const pending = deferred<unknown>()
    backend.harness_skill_install = () => pending.promise
    await user.click(button("Install"))
    page.rerender(<Harness show={false} />)
    expect(screen.queryByRole("dialog")).toBeNull()
    await act(async () => {
      pending.resolve(
        rawSkillInstallResult("installed", {
          links: rawLinksApplied(["claude_code"]),
        })
      )
    })
    page.rerender(<Harness />)
    expect(await screen.findByText("Installed.")).toBeInTheDocument()
    expect(callsOf("harness_skill_install")[0].agents).toEqual(["claude_code"])
    const state = view.slots.get(MCP_HARNESS_DIALOG)
    expect(state?.kind === "skillInstall" && state.input?.agents).toEqual([
      "claude_code",
    ])
  })
})

describe("Skill install dialog — an older Codeg", () => {
  it("says which Codeg to update, and offers no retry", async () => {
    backend.harness_skill_plan = () => {
      throw "Command harness_skill_plan not found"
    }
    await openDialog()
    expect(
      await screen.findByText(
        "This Codeg is too old to install from SRN Harness. Update it."
      )
    ).toBeInTheDocument()
    expect(
      within(dialog()).queryByRole("button", { name: /Try again/ })
    ).toBeNull()
  })

  it("a plan that failed is asked again on retry, never installed", async () => {
    const user = userEvent.setup()
    let fail = true
    backend.harness_skill_plan = (args) => {
      if (fail) {
        throw {
          code: "network_error",
          message: "offline",
          i18n_key: "Harness.errors.network",
        }
      }
      return rawSkillPlan({}, (args?.agents as string[] | null) ?? null)
    }
    await openDialog()
    await screen.findByRole("button", { name: /Try again/ })
    fail = false
    await user.click(button(/Try again/))
    await ready()
    expect(callsOf("harness_skill_plan").length).toBeGreaterThanOrEqual(2)
    expect(callsOf("harness_skill_install")).toHaveLength(0)
  })
})

describe("Skill install dialog — a plan whose agents moved", () => {
  it("asks once more for exactly the agents ticked when the plan's own choice holds one it cannot link", async () => {
    backend.harness_skill_plan = (args) =>
      rawSkillPlan(
        {
          agents: [
            rawSkillPlanAgent("claude_code"),
            rawSkillPlanAgent("kiro", { link_dir: null }),
          ],
          default_agents: ["claude_code", "kiro"],
        },
        (args?.agents as string[] | null) ?? ["claude_code", "kiro"]
      )
    await openDialog()
    await ready()
    expect(callsOf("harness_skill_plan").map((args) => args.agents)).toEqual([
      null,
      ["claude_code"],
    ])
  })
})
