import { describe, expect, it } from "vitest"

import { rehypeListDirection } from "./rehype-list-direction"

type Node = {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: Node[]
}

const text = (value: string): Node => ({ type: "text", value })
const el = (
  tagName: string,
  children: Node[],
  properties: Record<string, unknown> = {}
): Node => ({ type: "element", tagName, properties, children })

function run(list: Node): Node {
  rehypeListDirection()({ type: "root", children: [list] })
  return list
}

describe("rehypeListDirection", () => {
  it("gives a list the direction of its items' text", () => {
    const arabic = run(el("ul", [el("li", [text("عنصر أول")])]))
    expect(arabic.properties?.dir).toBe("rtl")
    const english = run(el("ol", [el("li", [text("first item")])]))
    expect(english.properties?.dir).toBe("ltr")
  })

  it("does not count code as evidence", () => {
    // Code is always left to right; an Arabic list that quotes code is still
    // an Arabic list.
    const list = run(
      el("ul", [
        el("li", [
          text("شغّل "),
          el("code", [text("pnpm build --filter web")]),
        ]),
      ])
    )
    expect(list.properties?.dir).toBe("rtl")
  })

  it("keeps a direction that is already set", () => {
    const list = run(el("ul", [el("li", [text("first item")])], { dir: "rtl" }))
    expect(list.properties?.dir).toBe("rtl")
  })

  it("leaves other elements alone", () => {
    const paragraph = run(el("p", [text("عنصر")]))
    expect(paragraph.properties?.dir).toBeUndefined()
  })
})
