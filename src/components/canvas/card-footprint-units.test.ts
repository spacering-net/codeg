import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  CARD_GAP,
  REGION_PADDING,
  regionWidthForColumns,
} from "./canvas-model"

/**
 * Guard for the canvas's one hard geometry rule: THE BOARD HAS ITS OWN UNITS,
 * and both halves of every board element have to live in them.
 *
 * `canvas-model.ts` positions elements on a grid of plain numbers (CARD_WIDTH /
 * CARD_HEIGHT), ReactFlow applies them as inline `width`/`height`, SQLite stores
 * them and the Rust side mirrors them. They cannot follow the appearance zoom,
 * which writes `font-size: 16 * zoom/100` onto `<html>` (see
 * `appearance-provider.tsx`) — a rem is not a coordinate.
 *
 * So a board element must neither size ITSELF in rem (a `w-56 h-[8.25rem]` card
 * renders 246×145 at 125% while its slot stays 224×132, and cards overlap their
 * neighbours), nor fill itself with rem CONTENTS (a fixed 132-tall box whose
 * type grew by 50% clipped its title through the middle of a line). The first
 * half shipped as a bug once, the second half three times.
 */

function readNode(name: string): string {
  return readFileSync(
    resolve(process.cwd(), `src/components/canvas/nodes/${name}`),
    "utf8"
  )
}

function readSource(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8")
}

/** Tailwind width/height utilities that resolve through the root font size
 *  (`w-56` = 14rem, `h-[8.25rem]`). Deliberately NOT applied to icons or
 *  popovers, which SHOULD scale with the user's zoom — only to the card boxes
 *  ReactFlow has already sized in pixels. */
const REM_SIZING =
  /\b(?:w|h|min-w|min-h|max-w|max-h)-(?:\d+(?:\.\d+)?|\[[^\]]*rem[^\]]*\])\b/g

/** Utilities that are safe because they don't resolve against a font size. */
const ALLOWED = new Set(["w-full", "h-full", "min-w-0", "min-h-0"])

/** Everything in a collapsed card's box that is not the title, in board units.
 *  Constant only because the card opted out of the appearance zoom — see the
 *  block comment above.
 *
 *  The BORDER is the easy one to forget and the expensive one to get wrong:
 *  Tailwind's preflight makes everything `border-box`, so the card's 1px rule
 *  is spent out of the same 132 as its padding. Two pixels is a quarter of a
 *  line, and `line-clamp` clips to the box rather than to whole lines — a
 *  budget that is 1.25 short doesn't drop the fourth line, it slices it
 *  lengthwise. */
const CARD_CHROME =
  2 + // border, top and bottom
  16 + // py-2
  14 + // icon row (size-3.5 sets it, not the 10px text)
  7 + // above the title
  7 + // below the title
  13.75 // footer line box (11px × leading-tight)

/** Every board element and the root element the board sizes. All of them opt
 *  out of the appearance zoom the same way. `card-frame.tsx` is the shared
 *  window every content-bearing card renders inside (live conversations, file
 *  previews, terminals), so it carries the opt-out for all three at once. */
const BOARD_NODES = [
  "conversation-card-node.tsx",
  "card-frame.tsx",
  "region-node.tsx",
  "note-node.tsx",
] as const

/** The className strings of the card ROOT elements — the ones the node wrapper
 *  sizes. Comments are stripped first so prose about the old bug can't trip the
 *  scan. */
function cardRoots(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "")
  const roots = code.match(/"[^"]*flex h-[^"]*w-[^"]*"/g) ?? []
  expect(roots.length).toBeGreaterThan(0)
  return roots
}

/** Source with comments stripped, so a `0.8125rem` mentioned in prose doesn't
 *  read as a declaration. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")
}

describe("canvas card footprint", () => {
  it("conversation cards size themselves from the node wrapper, not from rem", () => {
    for (const root of cardRoots(readNode("conversation-card-node.tsx"))) {
      expect(root).toContain("h-full")
      expect(root).toContain("w-full")
    }
  })

  it("no rem-based sizing utility survives on a card root", () => {
    for (const root of cardRoots(readNode("conversation-card-node.tsx"))) {
      const offenders = (root.match(REM_SIZING) ?? []).filter(
        (u) => !ALLOWED.has(u)
      )
      expect(offenders).toEqual([])
    }
  })

  it("a card being dragged keeps its footprint", () => {
    // A tilt is a bigger bounding box than the slot it came from: the region
    // grid has exactly zero slack between columns, so a card rotated even a
    // degree overlaps the neighbours it is being dragged past — and the drag
    // already reads as one, since ReactFlow selects a node before it moves it.
    expect(code(readNode("conversation-card-node.tsx"))).not.toMatch(/rotate-/)
  })

  it("the shared card frame keeps its body selectable and drags by its title bar", () => {
    // ReactFlow's own stylesheet puts `user-select: none` on every
    // `.react-flow__node`, so a document rendered inside one cannot be
    // selected or copied unless the body says otherwise out loud — and the
    // title bar has to carry the drag-handle class the node points `dragHandle`
    // at, or the whole card becomes draggable again and clicking into the
    // composer (or the terminal) hauls it around. Both are invisible in review
    // and only show up when someone tries to copy a line of output.
    const source = readNode("card-frame.tsx")
    expect(source).toContain("select-text")
    expect(source).toContain("DRAG_HANDLE_CLASS")
  })

  it("every card built on the shared frame declares a drag handle", () => {
    // `dragHandle` is set by the DERIVE layer, not by the component: without it
    // d3-drag passes every mousedown in the node through its filter and installs
    // a window-level `selectstart` preventDefault, so a click inside the card
    // takes focus without moving the caret. The symptom looks like a broken
    // input, not like a drag bug.
    const derive = readSource("src/components/canvas/canvas-model.ts")
    // The file / terminal branch, which derives both kinds together.
    expect(derive).toContain("dragHandle: DRAG_HANDLE_SELECTOR")
    // The pinned conversation card's is conditional on being expanded — a
    // collapsed summary tile has no document to click into and drags whole.
    expect(derive).toContain("dragHandle: detail ? DRAG_HANDLE_SELECTOR")
    // Draft cards are minted in the view, not the derive layer.
    expect(readSource("src/components/canvas/canvas-view.tsx")).toContain(
      "dragHandle: DRAG_HANDLE_SELECTOR"
    )
  })

  it("the default region width is an exact multiple of the card grid", () => {
    // Zero slack is fine — and correct — now that the card can't outgrow its
    // slot. It is NOT fine if anything ever rounds: a single stray pixel would
    // drop a whole column.
    const width = regionWidthForColumns(3)
    expect(width).toBe(REGION_PADDING * 2 + 3 * CARD_WIDTH + 2 * CARD_GAP)
    expect(Number.isInteger(width)).toBe(true)
    expect(Number.isInteger(CARD_WIDTH)).toBe(true)
    expect(Number.isInteger(CARD_HEIGHT)).toBe(true)
  })
})

describe("board units", () => {
  it.each(BOARD_NODES)("%s opts its subtree out of the app zoom", (name) => {
    // One class per board element, on the root the node wrapper sizes. Miss one
    // and that element alone keeps double-scaling — invisible at 100%, which is
    // where it will be reviewed.
    expect(code(readNode(name))).toContain("canvas-board-units")
  })

  it.each(BOARD_NODES)("%s states its type sizes in board units", (name) => {
    // `text-[0.8125rem]` and friends resolve against the root font size no
    // matter what the scope redefines, because they name the unit themselves.
    // Everything else — `p-3`, `size-3.5`, `text-xs`, `rounded-xl` — goes
    // through `--spacing` / `--text-*` / `--radius` and is converted for free.
    expect(code(readNode(name))).not.toMatch(/\[[\d.]+rem\]/)
  })

  it("the scope actually redefines the variables Tailwind sizes through", () => {
    const css = readSource("src/app/globals.css")
    const block = css.match(/\.canvas-board-units\s*\{([^}]*)\}/)
    expect(block, "no .canvas-board-units rule in globals.css").not.toBeNull()
    const body = block![1]
    // `--spacing` alone covers every padding, gap, margin and `size-*`;
    // `--text-*` covers the type scale; `--radius` covers `rounded-*`.
    expect(body).toMatch(/--spacing:\s*\d+px/)
    expect(body).toMatch(/--text-xs:\s*\d+px/)
    expect(body).toMatch(/--text-sm:\s*\d+px/)
    expect(body).toMatch(/--text-base:\s*\d+px/)
    expect(body).toMatch(/--radius:\s*\d+px/)
    // The two INHERITED metrics, which no variable covers.
    expect(body).toMatch(/font-size:\s*16px/)
    expect(body).toMatch(/line-height:\s*1\.5(?!\w)/)
  })

  it("restates line-height without a unit", () => {
    // `:root` declares it in `em` on purpose (a rem there is frozen at 16px in
    // WebKit — see the note in globals.css), and an em line-height computes to
    // an absolute LENGTH before it inherits. So a board element that only fixes
    // font sizes still inherits the root's 36px line box at 150% zoom, which is
    // enough to burst a region's fixed 40px header. Unitless is the whole fix,
    // and it is invisible until someone changes the zoom.
    const css = readSource("src/app/globals.css")
    const body = css.match(/\.canvas-board-units\s*\{([^}]*)\}/)![1]
    expect(body).not.toMatch(/line-height:[^;]*e?m\s*;/)
  })

  it("the collapsed card's title takes every whole line the box has room for", () => {
    // The point of board units: this arithmetic is a CONSTANT now, so the clamp
    // can be one too. Four 17.875 lines (13px × leading-snug) plus the chrome
    // around them is 131.25 of the 132. Clamping lower truncates a title the
    // card has space for (the original complaint); higher would be clipped
    // through the middle of a line.
    const source = code(readNode("conversation-card-node.tsx"))
    expect(source).toContain("line-clamp-4")
    expect(source).toContain("text-[13px]")
    expect(source).toContain("leading-snug")
    expect(CARD_CHROME + 4 * 17.875).toBeLessThanOrEqual(CARD_HEIGHT)
    expect(CARD_CHROME + 5 * 17.875).toBeGreaterThan(CARD_HEIGHT)
  })

  it("puts the same gap above the title as below it", () => {
    // The two halves of one decision, in different elements: the title's top
    // margin and the footer's top padding. They were 4 and 4 with the whole
    // remainder falling into the footer's `mt-auto`, which is 4 above and 12.75
    // below — a full card that looks like it is sliding upwards, and the third
    // time this card's vertical rhythm has been reported. Equal only holds
    // while both numbers are stated AND both fit: `mt-auto` absorbs a surplus
    // into the bottom gap alone, and a deficit comes out of the title, which is
    // the only thing here allowed to shrink.
    const source = code(readNode("conversation-card-node.tsx"))
    expect(source).toMatch(/mt-\[7px\] line-clamp-4/)
    expect(source).toMatch(/mt-auto[^"]*pt-\[7px\]/)
  })

  it("states the header row's height instead of discovering it", () => {
    // Four things of four different sizes sit on that row — a 14px mark, a 6px
    // dot, 10px text and a pill — and `items-center` only centres them all on
    // one line if the line's height is a decision rather than a side effect of
    // whichever child happens to be tallest today.
    const source = code(readNode("conversation-card-node.tsx"))
    expect(source).toMatch(/flex h-3\.5 shrink-0 items-center/)
  })

  it("keeps every 10px label in the header on one line box", () => {
    // The model name inherits `leading-tight` from the row; the child-count
    // badge used to override it with `leading-none` (plus `py-px`) so it
    // wouldn't set the row's height. Same size text, one gap apart, 1.25 of
    // baseline between them. The row states its height now, so the badge has no
    // reason to differ.
    const badge = code(readNode("conversation-card-node.tsx")).match(
      /className="inline-flex shrink-0 items-center[^"]*"/
    )
    expect(badge, "no child-count badge found").not.toBeNull()
    expect(badge![0]).not.toContain("leading-")
    expect(badge![0]).not.toContain("py-px")
  })

  it("pushes a region's title down by half the padding under it", () => {
    // The header band is REGION_HEADER_HEIGHT tall and the member grid starts a
    // further REGION_PADDING down, so a title centred in the band sits twice as
    // far from the first card as from the top of the region. Twelve of top
    // padding moves a centred row down by six and evens the two out — but only
    // while there IS a grid: a collapsed region is a bare 40-tall capsule.
    const source = code(readNode("region-node.tsx"))
    expect(source).toMatch(/!collapsed && "pt-3"/)
  })

  it("gives a new note the height of a collapsed card", () => {
    // Notes annotate the board's rows, so one dropped beside a row of cards
    // has to line up with it. Derived, not copied — a literal would go stale
    // the next time the card's box moves.
    const menu = code(readSource("src/components/canvas/add-node-menu.tsx"))
    expect(menu).toMatch(/NOTE_H = CARD_HEIGHT/)
  })
})
