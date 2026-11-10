import { readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"

import { buildUiRenderSkill, UI_RENDER_SKILL_NAME } from "./skill"

// The copy the backend compiles in (`include_str!` in
// `src-tauri/src/commands/generative_ui.rs`) and installs for agents.
const COMMITTED = resolve(process.cwd(), "src-tauri/genui/ui-render/SKILL.md")

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
})
