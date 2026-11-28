import { SKIP, visit } from "unist-util-visit"

type HastNodeLike = {
  type: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: HastNodeLike[]
}

/**
 * Mark every image inside a link — a remote `<img>`, or a repository upload's
 * inert span — with `data-codeg-image-linked`, so a click on it follows the
 * link instead of opening the image's preview. Runs after sanitize and harden:
 * a link they removed leaves its image unmarked, and so zoomable.
 * (`remarkLocalImages` marks local images itself, before this runs.)
 */
export function rehypeLinkedImages() {
  return (tree: HastNodeLike) => {
    visit(tree as never, "element", (link: HastNodeLike) => {
      if (link.tagName !== "a") return
      visit(link as never, "element", (node: HastNodeLike) => {
        if (
          node.tagName === "img" ||
          node.properties?.dataCodegForgeImage != null
        ) {
          node.properties = {
            ...node.properties,
            dataCodegImageLinked: "true",
          }
        }
      })
      return SKIP
    })
  }
}
