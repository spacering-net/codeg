import type { Spec } from "@json-render/core"
import { describe, expect, it } from "vitest"

import {
  cardIdOf,
  elementIdOf,
  itemizeOpeners,
  itemizeRepeats,
  PA_ITEM_CARD,
  PA_LINE,
  parseElementId,
  sanitizeAssistantSpec,
} from "./pa-spec"

function spec(elements: Record<string, unknown>): Spec {
  return { root: "main", elements } as unknown as Spec
}

const REPLY = { action: "pa.reply", params: {} }
const SET = { action: "setState", params: { statePath: "/x", value: 1 } }

describe("sanitizeAssistantSpec", () => {
  it("keeps a lone press on a button, marked with its key and parent", () => {
    const { spec: out, stripped } = sanitizeAssistantSpec(
      spec({
        main: { type: "Stack", props: {}, children: ["a"] },
        a: {
          type: "Button",
          props: { label: "Go with A" },
          on: { press: { action: "pa.reply", params: { text: "t" } } },
          children: [],
        },
      })
    )
    expect(stripped).toBe(false)
    const a = out.elements.a
    expect(a.on?.press).toEqual({
      action: "pa.reply",
      params: { text: "t", __el: "a" },
    })
    expect(a.props).toMatchObject({
      label: "Go with A",
      __paAction: "pa.reply",
      __paKey: "a",
      __paParent: "main",
      __paParams: { text: "t" },
    })
  })

  it("takes them out of watch", () => {
    const { spec: out, stripped } = sanitizeAssistantSpec(
      spec({
        main: {
          type: "Card",
          props: {},
          watch: { "/a": REPLY, "/b": [SET, REPLY] },
          children: [],
        },
      })
    )
    expect(stripped).toBe(true)
    expect(out.elements.main.watch).toEqual({ "/b": [SET] })
  })

  it("takes them out of onSuccess and onError chains, however deep", () => {
    const { spec: out, stripped } = sanitizeAssistantSpec(
      spec({
        b: {
          type: "Button",
          props: { label: "x" },
          on: {
            press: {
              ...SET,
              onSuccess: { ...SET, onError: { action: "pa.open" } },
              onError: { action: "pa.reply" },
            },
          },
          children: [],
        },
      })
    )
    expect(stripped).toBe(true)
    expect(out.elements.b.on?.press).toEqual({
      ...SET,
      onSuccess: { ...SET },
    })
    expect(out.elements.b.props).not.toHaveProperty("__paAction")
  })

  it("strips the chain of a kept one too", () => {
    const { spec: out, stripped } = sanitizeAssistantSpec(
      spec({
        b: {
          type: "Button",
          props: { label: "x" },
          on: { press: { ...REPLY, onSuccess: { action: "pa.item" } } },
          children: [],
        },
      })
    )
    expect(stripped).toBe(true)
    expect(out.elements.b.on?.press).toEqual({
      action: "pa.reply",
      params: { __el: "b" },
    })
  })

  it("allows them only as a press's only binding", () => {
    const { spec: out, stripped } = sanitizeAssistantSpec(
      spec({
        b: {
          type: "Button",
          props: { label: "x" },
          on: { press: [SET, REPLY] },
          children: [],
        },
      })
    )
    expect(stripped).toBe(true)
    expect(out.elements.b.on?.press).toEqual([SET])
    expect(out.elements.b.props).not.toHaveProperty("__paAction")
  })

  it("allows them on no event but press, and on nothing but a button or a link", () => {
    const { spec: out, stripped } = sanitizeAssistantSpec(
      spec({
        input: {
          type: "Input",
          props: { label: "x", name: "x" },
          on: { submit: REPLY, focus: SET },
          children: [],
        },
        card: {
          type: "Card",
          props: {},
          on: { press: REPLY },
          children: [],
        },
        link: {
          type: "Link",
          props: { label: "open", href: "" },
          on: {
            press: { action: "pa.open", params: { target: "bot", id: 2 } },
          },
          children: [],
        },
      })
    )
    expect(stripped).toBe(true)
    expect(out.elements.input.on).toEqual({ focus: SET })
    expect(out.elements.card.on).toEqual({})
    expect(out.elements.link.props).toMatchObject({ __paAction: "pa.open" })
  })

  it("drops a confirm on one", () => {
    const { spec: out } = sanitizeAssistantSpec(
      spec({
        b: {
          type: "Button",
          props: { label: "x" },
          on: { press: { ...REPLY, confirm: { title: "?", message: "?" } } },
          children: [],
        },
      })
    )
    expect(out.elements.b.on?.press).not.toHaveProperty("confirm")
  })

  it("never lets a spec mark a button itself or name another element", () => {
    const { spec: out } = sanitizeAssistantSpec(
      spec({
        b: {
          type: "Button",
          props: { label: "x", __paAction: "pa.reply", __paKey: "c" },
          children: [],
        },
        c: {
          type: "Button",
          props: { label: "y" },
          on: { press: { action: "pa.reply", params: { __el: "b" } } },
          children: [],
        },
      })
    )
    expect(out.elements.b.props).toEqual({ label: "x" })
    expect(out.elements.c.on?.press).toEqual({
      action: "pa.reply",
      params: { __el: "c" },
    })
    expect(out.elements.c.props).toMatchObject({ __paParams: {} })
  })

  it("leaves a card without assistant actions as it was", () => {
    const input = spec({
      b: { type: "Button", props: { label: "x" }, on: { press: SET } },
    })
    const { spec: out, stripped } = sanitizeAssistantSpec(input)
    expect(stripped).toBe(false)
    expect(out.elements.b).toBe(input.elements.b)
  })
})

describe("card and element ids", () => {
  it("hashes the trimmed source", () => {
    expect(cardIdOf(" a\n")).toBe(cardIdOf("a"))
    expect(cardIdOf("a")).toMatch(/^[0-9a-f]{8}$/)
    expect(cardIdOf("a")).not.toBe(cardIdOf("b"))
  })

  it("round-trips an element id", () => {
    const id = elementIdOf("0123abcd", "btn", "/items/2")
    expect(id).toBe("0123abcd/btn#/items/2")
    expect(parseElementId(id)).toEqual({
      cardId: "0123abcd",
      key: "btn",
      repeat: "/items/2",
    })
    expect(parseElementId(elementIdOf("0123abcd", "b"))).toEqual({
      cardId: "0123abcd",
      key: "b",
      repeat: null,
    })
    expect(parseElementId("nonsense")).toBeNull()
  })
})

describe("itemizeRepeats", () => {
  const text = (t: string) => ({
    type: "Text",
    props: { text: t },
    children: [],
  })
  const press = (label: string) => ({
    type: "Button",
    props: { label },
    on: { press: REPLY },
    children: [],
  })
  const list = (children: string[]) => ({
    type: "Stack",
    props: {},
    repeat: { statePath: "/needs", key: "key" },
    children,
  })

  it("puts a repeated line and its button on a row of their own, keys and marks kept", () => {
    const { spec: marked } = sanitizeAssistantSpec(
      spec({
        main: { type: "Card", props: {}, children: ["list"] },
        list: list(["line", "go"]),
        line: text("x"),
        go: press("Open it"),
      })
    )
    const out = itemizeRepeats(marked)
    // The rows space themselves: the list's own gap goes.
    expect(out.elements.list).toMatchObject({
      repeat: { statePath: "/needs", key: "key" },
      props: { className: "gap-0" },
      children: ["list~item"],
    })
    expect(out.elements["list~item"]).toEqual({
      type: PA_ITEM_CARD,
      props: { actions: ["go"], lead: null, sole: false },
      children: ["line", "go"],
    })
    // The button as it was: its key, and the container it was written in.
    expect(out.elements.go).toBe(marked.elements.go)
    expect(out.elements.go.props).toMatchObject({
      __paKey: "go",
      __paParent: "list",
    })
    // Its lone line marked as the item's, to set its subject over it.
    expect(out.elements.line.props).toEqual({ text: "x", [PA_LINE]: true })
    expect(marked.elements.line.props).toEqual({ text: "x" })
    // Once is enough: the list now repeats one card.
    expect(itemizeRepeats(out)).toBe(out)
  })

  it("takes a row of buttons for the item's actions, and never a key in use", () => {
    const out = itemizeRepeats(
      spec({
        main: { type: "Stack", props: {}, children: ["list"] },
        list: list(["line", "row"]),
        "list~item": text("the spec's own"),
        line: text("x"),
        row: {
          type: "Stack",
          props: { direction: "horizontal" },
          children: ["a", "b"],
        },
        a: press("Yes"),
        b: { type: "Link", props: { label: "See" }, children: [] },
      })
    )
    expect(out.elements.list.children).toEqual(["list~item~"])
    expect(out.elements["list~item~"].props).toEqual({
      actions: ["row"],
      lead: null,
      sole: false,
    })
    expect(out.elements["list~item"]).toEqual(text("the spec's own"))
  })

  it("marks only an item's lone Text as its line, not one inside its words", () => {
    const out = itemizeRepeats(
      spec({
        main: { type: "Stack", props: {}, children: ["list", "two"] },
        list: list(["words", "go"]),
        words: { type: "Stack", props: {}, children: ["a", "b"] },
        a: text("Dev: waits"),
        b: text("Ops: waits"),
        go: press("Go"),
        two: {
          ...list(["c", "d", "go2"]),
          repeat: { statePath: "/two", key: "key" },
        },
        c: text("Dev: waits"),
        d: text("since Monday"),
        go2: press("Go"),
      })
    )
    for (const k of ["words", "a", "b", "c", "d"]) {
      expect(out.elements[k].props).not.toHaveProperty(PA_LINE)
    }
    expect(out.elements["list~item"].type).toBe(PA_ITEM_CARD)
  })

  it("leaves a list that only reads, one that only acts, and one still arriving", () => {
    const reads = spec({
      main: { type: "Stack", props: {}, children: ["list"] },
      list: list(["line", "more"]),
      line: text("x"),
      more: text("y"),
    })
    expect(itemizeRepeats(reads)).toBe(reads)
    const acts = spec({
      main: { type: "Stack", props: {}, children: ["list"] },
      list: list(["a", "b"]),
      a: press("Plan A"),
      b: press("Plan B"),
    })
    expect(itemizeRepeats(acts)).toBe(acts)
    const arriving = spec({
      main: { type: "Stack", props: {}, children: ["list"] },
      list: list(["line", "go"]),
      line: text("x"),
    })
    expect(itemizeRepeats(arriving)).toBe(arriving)
    // Not repeated: a card's own lines and buttons stay where they are.
    const plain = spec({
      main: { type: "Stack", props: {}, children: ["line", "go"] },
      line: text("x"),
      go: press("Go"),
    })
    expect(itemizeRepeats(plain)).toBe(plain)
  })

  it("leads a row with where its first pa.open goes, as the button's own parameters", () => {
    const { spec: marked } = sanitizeAssistantSpec(
      spec({
        main: { type: "Stack", props: {}, children: ["list"] },
        list: {
          type: "Stack",
          props: { gap: "md", className: "pt-1" },
          repeat: { statePath: "/needs", key: "key" },
          children: ["line", "ask", "open"],
        },
        line: text("x"),
        ask: press("Hand it to you"),
        open: {
          type: "Button",
          props: { label: { $item: "label" } },
          on: {
            press: {
              action: "pa.open",
              params: { target: { $item: "target" }, id: { $item: "id" } },
            },
          },
          children: [],
        },
      })
    )
    const out = itemizeRepeats(marked)
    expect(out.elements["list~item"].props).toEqual({
      actions: ["ask", "open"],
      lead: { target: { $item: "target" }, id: { $item: "id" } },
      sole: false,
    })
    expect(out.elements.list.props).toEqual({
      gap: "md",
      className: "pt-1 gap-0",
    })
  })
})

describe("itemizeOpeners", () => {
  const text = (t: string, variant?: string) => ({
    type: "Text",
    props: variant ? { text: t, variant } : { text: t },
    children: [],
  })
  const heading = (t: string) => ({
    type: "Heading",
    props: { text: t, level: "h3" },
    children: [],
  })
  const open = (label: string, target: string, id: number) => ({
    type: "Button",
    props: { label },
    on: { press: { action: "pa.open", params: { target, id } } },
    children: [],
  })

  it("draws a line and the button that opens its thing as one row, set off above and below", () => {
    const { spec: marked } = sanitizeAssistantSpec(
      spec({
        main: {
          type: "Card",
          props: {},
          children: ["watch", "watchText", "done", "doneText", "doneButton"],
        },
        watch: heading("Watching"),
        watchText: text("my-app has changes"),
        done: heading("Done yesterday"),
        doneText: text("dispatch #13 · Tidy: done at 20:55"),
        doneButton: open("See the result", "dispatch", 13),
      })
    )
    const out = itemizeOpeners(marked)
    // A line with nothing to open stays as written; the line and its
    // button a row, in a list of its own.
    expect(out.elements.main.children).toEqual([
      "watch",
      "watchText",
      "done",
      "doneText~rows",
    ])
    expect(out.elements["doneText~rows"]).toEqual({
      type: "Stack",
      props: { gap: "none" },
      children: ["doneText~row"],
    })
    expect(out.elements["doneText~row"]).toEqual({
      type: PA_ITEM_CARD,
      props: {
        actions: ["doneButton"],
        lead: { target: "dispatch", id: 13 },
        sole: true,
      },
      children: ["doneText", "doneButton"],
    })
    // The button as it was: its key and the container it was written in.
    expect(out.elements.doneButton).toBe(marked.elements.doneButton)
    expect(out.elements.doneButton.props).toMatchObject({
      __paKey: "doneButton",
      __paParent: "main",
    })
    expect(out.elements.doneText.props).toEqual({
      text: "dispatch #13 · Tidy: done at 20:55",
      [PA_LINE]: true,
    })
    expect(out.elements.watchText).toBe(marked.elements.watchText)
    expect(marked.elements.main.children).toHaveLength(5)
    // Once is enough.
    expect(itemizeOpeners(out)).toBe(out)
  })

  it("lists such rows one after another together, and leaves the rest as written", () => {
    const { spec: marked } = sanitizeAssistantSpec(
      spec({
        main: {
          type: "Stack",
          props: {},
          children: ["a", "aGo", "b", "bGo", "bSee", "note", "c", "cReply"],
        },
        a: text("Task #1: failed"),
        aGo: open("Open task", "task", 1),
        b: text("Task #2: review"),
        bGo: open("Open task", "task", 2),
        bSee: open("Its session", "session", 7),
        note: text("an aside", "muted"),
        c: text("Should I?"),
        cReply: {
          type: "Button",
          props: { label: "Yes" },
          on: { press: REPLY },
          children: [],
        },
      })
    )
    const out = itemizeOpeners(marked)
    expect(out.elements.main.children).toEqual([
      "a~rows",
      "note",
      "c",
      "cReply",
    ])
    expect(out.elements["a~rows"].children).toEqual(["a~row", "b~row"])
    expect(out.elements["b~row"].props).toEqual({
      actions: ["bGo", "bSee"],
      lead: { target: "task", id: 2 },
      sole: false,
    })
    // A muted aside before an opener is no line of its; a button that
    // answers is no opener: both as written.
    const { spec: aside } = sanitizeAssistantSpec(
      spec({
        main: { type: "Stack", props: {}, children: ["n", "go"] },
        n: text("an aside", "muted"),
        go: open("Open", "task", 1),
      })
    )
    expect(itemizeOpeners(aside)).toBe(aside)
  })

  it("leaves a list's items and a repeated element to itemizeRepeats", () => {
    const { spec: marked } = sanitizeAssistantSpec(
      spec({
        main: { type: "Card", props: {}, children: ["list"] },
        list: {
          type: "Stack",
          props: {},
          repeat: { statePath: "/needs", key: "key" },
          children: ["line", "go"],
        },
        line: text("x"),
        go: open("Open", "task", 1),
      })
    )
    const rows = itemizeRepeats(marked)
    expect(itemizeOpeners(rows)).toBe(rows)
    expect(itemizeOpeners(marked)).toBe(marked)
  })

  it("leads a list's row by an opener always shown, not one shown now and then", () => {
    const { spec: marked } = sanitizeAssistantSpec(
      spec({
        main: { type: "Card", props: {}, children: ["list"] },
        list: {
          type: "Stack",
          props: {},
          repeat: { statePath: "/needs", key: "key" },
          children: ["line", "maybe", "go"],
        },
        line: text("x"),
        maybe: { ...open("Dev", "bot", 5), visible: { $state: "/never" } },
        go: open("Its session", "session", 7),
      })
    )
    const out = itemizeRepeats(marked)
    expect(out.elements["list~item"].props).toEqual({
      actions: ["maybe", "go"],
      lead: { target: "session", id: 7 },
      sole: false,
    })
  })

  it("never takes a key in use", () => {
    const { spec: marked } = sanitizeAssistantSpec(
      spec({
        main: { type: "Card", props: {}, children: ["t", "go"] },
        t: text("x"),
        go: open("Open", "task", 1),
        "t~row": text("the spec's own"),
      })
    )
    const out = itemizeOpeners(marked)
    expect(out.elements.main.children).toEqual(["t~rows"])
    expect(out.elements["t~rows"].children).toEqual(["t~row~"])
    expect(out.elements["t~row"]).toEqual(text("the spec's own"))
  })
})
