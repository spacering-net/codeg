import { detectTextDirection } from "streamdown"
import { visit } from "unist-util-visit"

type HastNodeLike = {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: HastNodeLike[]
}

// Code is always left-to-right, so it is no evidence of a list's direction
// (Streamdown's own pass leaves it out for the same reason).
const CODE_TAGS = new Set(["code", "kbd", "pre", "samp", "var"])

function textOf(node: HastNodeLike): string {
  if (node.type === "text") return node.value ?? ""
  if (node.type === "element" && CODE_TAGS.has(node.tagName ?? "")) return ""
  return (node.children ?? []).map(textOf).join("")
}

/**
 * Streamdown's `dir="auto"` gives each paragraph, heading, list item and table
 * cell the direction of its own text, but not the list around the items — so
 * a list would still indent (`padding-inline-start`) on the page's side: an
 * English list in the Arabic interface, or an Arabic one in an English reply,
 * would start its items on one edge and its indent on the other. Give each
 * list the direction of its text the same way.
 */
export function rehypeListDirection() {
  return (tree: HastNodeLike) => {
    visit(tree as never, "element", (node: HastNodeLike) => {
      if (node.tagName !== "ul" && node.tagName !== "ol") return
      node.properties ??= {}
      if (typeof node.properties.dir === "string") return
      node.properties.dir = detectTextDirection(textOf(node))
    })
  }
}
