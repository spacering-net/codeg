import type { Definition, Image, ImageReference, Node, Root } from "mdast"
import { SKIP, visit } from "unist-util-visit"
import { localImagePath } from "@/lib/markdown-local-image"

/** `\` + ASCII punctuation — the escape CommonMark has already applied by the
 *  time this plugin sees a destination. */
const ESCAPED_PUNCTUATION = /\\[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/

/**
 * Where a destination can START inside a node's source: past the first `](`
 * (an inline image) or `]:` (a reference definition). The FIRST match on
 * purpose — a `](` inside the label, which only a code span can produce, makes
 * this start too early, and starting early only widens the region checked
 * below. Starting late is what would be unsound.
 */
function destinationStart(raw: string): number {
  for (let i = 0; i + 1 < raw.length; i += 1) {
    if (raw[i] === "]" && (raw[i + 1] === "(" || raw[i + 1] === ":")) {
      return i + 2
    }
  }
  return 0
}

/**
 * True when the destination may have lost separators to that escape, and so
 * must not be resolved.
 *
 * Every Windows segment starting with punctuation eats its own separator:
 * `C:\repo\shots\.preview.png` parses as `C:\repo\shots.preview.png`. Usually
 * that just points nowhere — but the glued form is still INSIDE the root, so
 * if `shots.preview.png` happens to exist we would silently render a different
 * file under the alt text of the one the agent named. `[Image blocked: …]` had
 * no such failure mode, so refusing is the floor for replacing it. The parsed
 * destination alone cannot reveal this: eating the only backslash
 * (`shots\.preview.png`, or a mixed `C:/repo/shots\.preview.png`) leaves
 * nothing behind to key on.
 *
 * `remarkRestoreWindowsPaths` repairs link destinations but deliberately not
 * image ones (an mdast image keeps its label as the `alt` STRING and has no
 * children, so nothing in the tree says where the label ends and the
 * destination would have to be guessed). Refusing needs no such guess — an
 * over-wide region only refuses more — so this asks the weaker question: does
 * the escape occur anywhere from the earliest possible destination onward?
 * Everything before that point, which is the label, is ignored, so the common
 * `![a \* b](./shot.png)` still resolves. What it over-refuses is an escape in
 * the TITLE, or a cosmetic one in the destination itself (`./my\_file.png`);
 * both are rare and both degrade to the alt text this replaced.
 */
function separatorMayBeLost(node: Node, document: string): boolean {
  const start = node.position?.start?.offset
  const end = node.position?.end?.offset
  if (typeof start !== "number" || typeof end !== "number") return true
  const raw = document.slice(start, end)
  return ESCAPED_PUNCTUATION.test(raw.slice(destinationStart(raw)))
}

/** Preserve local Markdown images as inert spans until React can load them
 * through the workspace-confined reader. Remote images retain the default
 * sanitize/harden pipeline; no file: or data: protocol is allowed through it. */
export function remarkLocalImages() {
  return (tree: Root, file: unknown) => {
    const document = String(file)
    const definitions = new Map<string, Definition>()
    visit(tree, "definition", (node) => {
      const id = node.identifier.toUpperCase()
      if (!definitions.has(id)) definitions.set(id, node)
    })
    const linkedImages = new WeakSet<Image | ImageReference>()
    visit(tree, ["link", "linkReference"], (node) => {
      visit(node, ["image", "imageReference"], (image) => {
        linkedImages.add(image as Image | ImageReference)
      })
      return SKIP
    })
    visit(tree, ["image", "imageReference"], (node) => {
      const image = node as Image | ImageReference
      // A reference image's destination lives in its definition, so that is
      // also the node whose source has to be free of the escape.
      const origin: Image | Definition | undefined =
        image.type === "image"
          ? image
          : definitions.get(image.identifier.toUpperCase())
      if (!origin?.url || !localImagePath(origin.url)) return
      const source = origin.url
      if (separatorMayBeLost(origin, document)) return
      image.data = {
        ...image.data,
        hName: "span",
        hProperties: {
          "data-codeg-local-image": source,
          "data-codeg-image-linked": linkedImages.has(image) ? "true" : "false",
        },
        hChildren: [{ type: "text", value: image.alt ?? "" }],
      }
    })
  }
}
