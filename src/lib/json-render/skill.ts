import { assistantJsonRenderCatalog, jsonRenderCatalog } from "./catalog"

/**
 * The name of the skill Codeg links into the skill directory of every agent it
 * is enabled for (Harness › Skill Packs › UI). It is what the user types:
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

/** The file next to an assistant's own skill (`codeg-personal-agent`) that
 *  teaches its brain the format: `ui-render.md`. */
export const ASSISTANT_UI_RENDER_FILE = "ui-render.md"

/** Opens an assistant's guide: where its cards show and when to write one. */
const ASSISTANT_SYSTEM =
  "Your reply on the owner's assistants page is drawn as UI: a ```spec code block in it renders as a card, and its buttons can act for the owner. Write the block in the reply itself, never into a file. The format reference follows."

/** An assistant's rules after json-render's own. The first undoes the
 *  guide's advice to fill a UI with sample data; the rest are how its
 *  cards work in codeg (9.2, 9.3) — a list of things with a button each
 *  drawn as rows (`itemizeRepeats`). */
const ASSISTANT_RULES = [
  "The sample-data rules above do not apply to you: show only real data — what codeg gave you and what your tools returned. Never invent numbers or ids.",
  CUSTOM_RULES[1],
  CUSTOM_RULES[2],
  "Write a sentence or two first, then the ```spec block, and nothing after it: only the last text you write stays as your reply, so a card written before a tool call is gone when the turn ends.",
  "Keep a card compact: a few sections; a Table for more than five rows of plain values; a chart only for numbers that change over time.",
  "Things that each have a button — what needs the owner, matters, work — are a list, not a Table (a Table cannot hold buttons): put them in a state array and repeat over it, with each item's line and its button as the repeated element's children. Codeg draws each item as a row of its own, led by the face of the assistant or the icon of the place its pa.open button opens, its button at its end. Write an item's line as its subject, a colon, then what about it (Task #1 · Fix the title: failed, waiting 3 days): codeg sets the subject over it, smaller.",
  "The actions pa.reply, pa.item and pa.open act for the owner, so they run only when the owner really clicks: bind one only to a Button's or a Link's on.press, as that event's only action. Codeg removes them from watch, from onSuccess and onError chains and from events with more than one action, and marks the card.",
  'For a choice between options, give each option a Button with pa.reply whose label is what the owner would say ("Go with plan A", "Look at the second one first"); the buttons of one choice go in one container, and once the owner picks one the others grey out. Use pa.item to close one of your open matters and pa.open to take the owner somewhere.',
  "Do not draw buttons for things a tool of yours does (dispatching work, messaging an assistant, creating an assistant, changing a setting): call the tool — codeg shows the owner its own card, with undo where it can. When you only suggest such a thing, call the tool with suggest: codeg shows a suggestion card.",
]

/**
 * The `ui-render.md` an assistant's brain reads before its first card (9.1):
 * json-render's guide for the assistant's catalog — the shared components
 * and its three actions. Not a skill of its own (no frontmatter): it sits
 * in the assistant's `codeg-personal-agent` skill, which points to it.
 *
 * The backend ships the committed copy in `src-tauri/genui/personal-agent/`;
 * `skill.test.ts` keeps it equal to this output.
 */
export function buildAssistantUiRenderGuide(): string {
  const guide = assistantJsonRenderCatalog.prompt({
    mode: "inline",
    system: ASSISTANT_SYSTEM,
    customRules: ASSISTANT_RULES,
  })
  return `# Cards in your replies\n\n${guide}\n`
}
