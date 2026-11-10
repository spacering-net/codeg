import { compileSpec, hasChildCycle, isSpecStream } from "./spec"

const line = (patch: object) => JSON.stringify(patch)

describe("isSpecStream", () => {
  it("takes a fence whose first line is a patch", () => {
    const source = `\n\n${line({ op: "add", path: "/root", value: "main" })}\n`
    expect(isSpecStream(source)).toBe(true)
  })

  it("leaves an RPM spec file and a half-written first line as code", () => {
    expect(isSpecStream("Name: hello\nVersion: 1.0\n")).toBe(false)
    expect(isSpecStream('{"op":"add","pa')).toBe(false)
    expect(isSpecStream("")).toBe(false)
  })
})

describe("compileSpec", () => {
  it("has elements to read from the first line on", () => {
    expect(
      compileSpec(line({ op: "add", path: "/root", value: "main" }))
    ).toEqual({ root: "main", elements: {} })
  })

  it("skips the line still being written and picks it up once complete", () => {
    const root = line({ op: "add", path: "/root", value: "main" })
    const element = line({
      op: "add",
      path: "/elements/main",
      value: { type: "Text", props: { text: "hi" } },
    })
    const partial = `${root}\n${element.slice(0, 30)}`
    expect(compileSpec(partial).elements).toEqual({})
    expect(compileSpec(`${root}\n${element}`).elements.main.type).toBe("Text")
  })

  it("starts every compile from a fresh seed", () => {
    compileSpec(
      line({ op: "add", path: "/elements/a", value: { type: "Text" } })
    )
    expect(compileSpec("").elements).toEqual({})
  })

  it("never writes through __proto__", () => {
    const hostile = [
      line({ op: "add", path: "/__proto__/jrPolluted", value: "yes" }),
      line({
        op: "replace",
        path: "/elements/x/__proto__/jrPolluted",
        value: 1,
      }),
      line({ op: "copy", from: "/root", path: "/__proto__/jrPolluted" }),
      // The same path spelled with a JSON escape.
      '{"op":"add","path":"/\\u005f_proto__/jrPolluted","value":"yes"}',
      line({ op: "add", path: "/root", value: "main" }),
    ].join("\n")
    const spec = compileSpec(hostile)
    expect(({} as Record<string, unknown>).jrPolluted).toBeUndefined()
    // The rest of the stream still applies.
    expect(spec.root).toBe("main")
  })
})

describe("hasChildCycle", () => {
  const spec = (elements: Record<string, unknown>, root = "a") =>
    ({ root, elements }) as Parameters<typeof hasChildCycle>[0]

  it("finds two elements that are each other's child", () => {
    expect(
      hasChildCycle(
        spec({
          a: { type: "Card", props: {}, children: ["b"] },
          b: { type: "Card", props: {}, children: ["a"] },
        })
      )
    ).toBe(true)
  })

  it("finds an element that is its own child, and a cycle through slots", () => {
    expect(
      hasChildCycle(spec({ a: { type: "Card", props: {}, children: ["a"] } }))
    ).toBe(true)
    expect(
      hasChildCycle(
        spec({
          a: { type: "Card", props: {}, slots: { header: ["b"] } },
          b: { type: "Card", props: {}, children: ["a"] },
        })
      )
    ).toBe(true)
  })

  it("lets a shared child, a missing child and a cycle nothing renders through", () => {
    expect(
      hasChildCycle(
        spec({
          a: { type: "Stack", props: {}, children: ["b", "c", "gone"] },
          b: { type: "Stack", props: {}, children: ["d"] },
          c: { type: "Stack", props: {}, children: ["d"] },
          d: { type: "Text", props: {} },
          x: { type: "Card", props: {}, children: ["y"] },
          y: { type: "Card", props: {}, children: ["x"] },
        })
      )
    ).toBe(false)
  })

  it("checks every child, even after a hole in the list", () => {
    // `replace` without a value leaves `undefined` in the list.
    const compiled = compileSpec(
      [
        line({ op: "add", path: "/root", value: "a" }),
        line({
          op: "add",
          path: "/elements/a",
          value: { type: "Stack", props: {}, children: ["a", "unused"] },
        }),
        line({ op: "replace", path: "/elements/a/children/1" }),
      ].join("\n")
    )
    expect(compiled.elements.a.children).toEqual(["a", undefined])
    expect(hasChildCycle(compiled)).toBe(true)

    // And the hole first, so the walk has to go on past it.
    const holeFirst = compileSpec(
      [
        line({ op: "add", path: "/root", value: "a" }),
        line({
          op: "add",
          path: "/elements/a",
          value: { type: "Stack", props: {}, children: ["unused", "a"] },
        }),
        line({ op: "replace", path: "/elements/a/children/0" }),
      ].join("\n")
    )
    expect(holeFirst.elements.a.children).toEqual([undefined, "a"])
    expect(hasChildCycle(holeFirst)).toBe(true)
  })

  it("does not trip over malformed elements", () => {
    expect(
      hasChildCycle(
        spec({
          a: { type: "Stack", props: {}, children: ["b", "c", 7, null] },
          b: null,
          c: { type: "Stack", props: {}, children: "not-a-list" },
        })
      )
    ).toBe(false)
    expect(hasChildCycle(spec({}, ""))).toBe(false)
  })

  it("walks a deep chain without recursion", () => {
    const elements: Record<string, unknown> = {}
    for (let i = 0; i < 50_000; i++) {
      elements[`e${i}`] = { type: "Stack", props: {}, children: [`e${i + 1}`] }
    }
    expect(hasChildCycle(spec(elements, "e0"))).toBe(false)
  })
})
