import type { ReactNode } from "react"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it } from "vitest"

import en from "@/i18n/messages/en.json"
import zhCN from "@/i18n/messages/zh-CN.json"
import type { HarnessExpertLink } from "@/lib/harness/plugin-install-types"
import { ExpertsNote, SkillsPlanEffects } from "./plugin-manage-parts"

const link = (name: string, agents = ["codex"]): HarnessExpertLink => ({
  name,
  path: `/skills/${name}`,
  copy: false,
  agents,
})

const NAMES = ["brainstorming", "writing-plans", "executing-plans"]

function inLocale(
  ui: ReactNode,
  locale: "en" | "zh-CN" = "en",
  messages: Record<string, unknown> = en
) {
  return render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      {ui}
    </NextIntlClientProvider>
  )
}

describe("ExpertsNote", () => {
  it("says how many experts an agent gives back, with their names on request", async () => {
    const { container } = inLocale(
      <ExpertsNote agent="codex" links={NAMES.map((name) => link(name))} give />
    )
    const summary = screen.getByText(
      en.Harness.plugins.dialog.giveBack.replace("{count, number}", "3")
    )
    expect(summary.tagName).toBe("SUMMARY")
    expect(summary.textContent).not.toContain("brainstorming")
    const details = container.querySelector("details")
    expect(details?.open).toBe(false)
    await userEvent.click(summary)
    expect(details?.open).toBe(true)
    expect(
      within(details as HTMLElement).getByText(/brainstorming/)
    ).toBeTruthy()
  })

  it("counts a name once, however many links it has", () => {
    inLocale(
      <ExpertsNote
        agent="codex"
        links={[link("brainstorming"), link("brainstorming")]}
      />,
      "zh-CN",
      zhCN
    )
    expect(screen.getByText("接管专家技能 1")).toBeTruthy()
  })

  it("names the other agents that stop seeing them on the same line", () => {
    inLocale(
      <ExpertsNote
        agent="codex"
        links={[link("brainstorming", ["codex", "cline"])]}
      />
    )
    const summary = screen.getByText(/Takes over Experts skills 1/)
    expect(summary.tagName).toBe("SUMMARY")
    expect(summary.textContent).toContain("Cline")
  })

  it("says nothing without links", () => {
    const { container } = inLocale(<ExpertsNote agent="codex" links={[]} />)
    expect(container.textContent).toBe("")
  })
})

describe("SkillsPlanEffects", () => {
  it("says how many names are held, with the names on request", () => {
    inLocale(
      <SkillsPlanEffects
        plan={{
          agent: "codex",
          takeover: [],
          held: NAMES.map((name) => ({
            name,
            path: `/skills/${name}`,
            by: "custom",
            plugin: null,
            agents: ["codex"],
          })),
          copies_to_take: [],
          issues: [],
          links: null,
        }}
      />
    )
    const summary = screen.getByText(
      en.Harness.pluginInstall.hosts.held.replace("{count, number}", "3")
    )
    expect(summary.tagName).toBe("SUMMARY")
  })

  it("counts a name held in two folders once", () => {
    const { container } = inLocale(
      <SkillsPlanEffects
        plan={{
          agent: "codex",
          takeover: [],
          held: ["/a", "/b"].map((dir) => ({
            name: "brainstorming",
            path: `${dir}/brainstorming`,
            by: "custom",
            plugin: null,
            agents: ["codex"],
          })),
          copies_to_take: [],
          issues: [],
          links: null,
        }}
      />
    )
    expect(
      screen.getByText(
        en.Harness.pluginInstall.hosts.held.replace("{count, number}", "1")
      )
    ).toBeTruthy()
    expect(container.querySelector("details p")?.textContent).toBe(
      "brainstorming"
    )
  })
})
