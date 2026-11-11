import type { Spec } from "@json-render/core"
import { describe, expect, it } from "vitest"

import {
  cardIdOf,
  elementIdOf,
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
