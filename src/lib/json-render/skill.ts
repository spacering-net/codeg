import { jsonRenderCatalog } from "./catalog"

/**
 * The name of the skill Codeg links into the skill directory of every agent it
 * is enabled for (Settings > Skill Packs > UI). It is what the user types:
 * `/ui-render` (`$ui-render` in Codex).
 */
export const UI_RENDER_SKILL_NAME = "ui-render"

/** Always in the agent's skill list, so it says what the skill is for and that
 *  it only means something inside Codeg's chat. No backticks: two YAML readers
 *  parse this line (`lib/skill-frontmatter.ts` and the Rust side). */
const DESCRIPTION =
  "Show results as interactive UI inside Codeg's chat (cards, tables, charts, tabs, accordions, badges, progress bars, simple forms) by writing a json-render spec code block in your reply. Use when the user invokes this skill or asks to see something as a card, table, chart, dashboard or other visual layout in Codeg."

/** Prepended to json-render's own guide. */
const SYSTEM =
  "Codeg renders a ```spec code block in your reply as interactive UI inside the chat. Write the block directly in your reply message, never into a file. Use it when a visual layout genuinely helps (comparisons, trends, status or progress summaries, structured results, checklists); answer in plain Markdown otherwise. The format reference follows."

/** Appended to json-render's own rules. The first undoes the guide's advice to
 *  fill a UI with realistic sample data, which is right for a mock-up and wrong
 *  for a report on real work; the second is the chat column; the third is
 *  for the charts Codeg adds to json-render's components. */
const CUSTOM_RULES = [
  "The sample-data rules above apply only to mock-ups the user explicitly asks for. Otherwise show only real data from your work in this session (files, command output, test results); never invent numbers.",
  "The UI renders in a chat column of limited width: keep it compact, and never use viewport-height classes (h-screen, min-h-screen).",
  "Charts (AreaChart, BarChart, LineChart, PieChart, RadarChart, RadialChart, ScatterChart) take their values as JSON numbers, and their colors follow the theme. Put each chart in a Card whose title says what it shows, and use a Table instead when exact values matter more than the shape.",
]

/**
 * The `SKILL.md` an agent reads: a frontmatter block, then json-render's
 * official inline-mode guide for the shared catalog.
 *
 * The backend ships the committed copy in `src-tauri/genui/ui-render/`;
 * `skill.test.ts` keeps that copy equal to this output, and rewrites it when
 * run with `UPDATE_UI_RENDER_SKILL=1` (after a json-render upgrade).
 */
export function buildUiRenderSkill(): string {
  const frontmatter = [
    "---",
    `name: ${UI_RENDER_SKILL_NAME}`,
    `description: ${DESCRIPTION}`,
    "---",
  ].join("\n")
  const guide = jsonRenderCatalog.prompt({
    mode: "inline",
    system: SYSTEM,
    customRules: CUSTOM_RULES,
  })
  return `${frontmatter}\n${guide}\n`
}
