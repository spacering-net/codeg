import { readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"

import {
  ASSISTANT_UI_RENDER_FILE,
  buildAssistantUiRenderGuide,
  buildUiRenderSkill,
  UI_RENDER_SKILL_NAME,
} from "./skill"

// The copy the backend compiles in (`include_str!` in
// `src-tauri/src/commands/generative_ui.rs`) and installs for agents.
const COMMITTED = resolve(process.cwd(), "src-tauri/genui/ui-render/SKILL.md")
// An assistant's guide (`include_str!` in
// `src-tauri/src/personal_agent/workdir.rs`).
const ASSISTANT_COMMITTED = resolve(
  process.cwd(),
  "src-tauri/genui/personal-agent",
  ASSISTANT_UI_RENDER_FILE
)

describe("ui-render skill", () => {
  it("the committed SKILL.md is what the catalog generates", () => {
    const generated = buildUiRenderSkill()
    // After a json-render upgrade: UPDATE_UI_RENDER_SKILL=1 pnpm test skill
    if (process.env.UPDATE_UI_RENDER_SKILL) {
      writeFileSync(COMMITTED, generated)
    }
    expect(readFileSync(COMMITTED, "utf8")).toBe(generated)
  })

  it("names itself after the directory it is installed under", () => {
    const head = buildUiRenderSkill().split("\n").slice(0, 4)
    // The backend installs the committed copy under its folder's name.
    expect(UI_RENDER_SKILL_NAME).toBe(basename(dirname(COMMITTED)))
    expect(head[0]).toBe("---")
    expect(head[1]).toBe(`name: ${UI_RENDER_SKILL_NAME}`)
    expect(head[2]).toMatch(/^description: [^`]+$/)
    expect(head[3]).toBe("---")
  })

  it("has none of the assistant's actions", () => {
    expect(buildUiRenderSkill()).not.toContain("pa.reply")
  })
})

describe("an assistant's ui-render.md", () => {
  it("the committed copy is what the assistant's catalog generates", () => {
    const generated = buildAssistantUiRenderGuide()
    if (process.env.UPDATE_UI_RENDER_SKILL) {
      writeFileSync(ASSISTANT_COMMITTED, generated)
    }
    expect(readFileSync(ASSISTANT_COMMITTED, "utf8")).toBe(generated)
  })

  it("is the shared guide plus the three actions, spelled out", () => {
    const guide = buildAssistantUiRenderGuide()
    // Not a skill of its own: the assistant's skill points to it.
    expect(guide.startsWith("---")).toBe(false)
    for (const name of ["pa.reply", "pa.item", "pa.open"]) {
      expect(guide).toContain(`- ${name}: `)
    }
    expect(guide).toContain('op: "done" | "drop" | "snooze"')
    // The same components as a session's cards.
    expect(guide).toContain("- BarChart: ")
  })
})
