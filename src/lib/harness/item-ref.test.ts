import { describe, expect, it } from "vitest"

import { isItemRef, parseItemRef } from "./item-ref"

describe("parseItemRef", () => {
  it.each([
    ["anthropics/pdf", "anthropics", "pdf"],
    ["browser-use.com/browser-use", "browser-use.com", "browser-use"],
    ["a/b", "a", "b"],
    ["0x/1-2-3", "0x", "1-2-3"],
  ])("reads %s", (input, publisher, name) => {
    expect(parseItemRef(input)).toEqual({ ref: input, publisher, name })
  })

  it("forgives surrounding space and capitals", () => {
    expect(parseItemRef("  Anthropics/PDF \n")?.ref).toBe("anthropics/pdf")
  })

  it.each([
    "",
    "pdf",
    "/pdf",
    "anthropics/",
    "anthropics/pdf/extra",
    "anthropics/pdf tools",
    "anthropics/pdf_tools",
    "-anthropics/pdf",
    ".anthropics/pdf",
    "anthropics//pdf",
    "anthropics/pdf?x=1",
    "anthropics/pdf#top",
    "https://spacering.net/harness/anthropics/pdf",
    "../../other/name",
    "anthropics/" + "a".repeat(65),
    "a".repeat(254) + "/pdf",
    "用户/技能",
  ])("refuses %j", (input) => {
    expect(parseItemRef(input)).toBeNull()
  })

  it.each([null, undefined, 42, {}, ["a/b"]])(
    "refuses the non-string %j",
    (v) => {
      expect(parseItemRef(v)).toBeNull()
    }
  )

  it("accepts the longest publisher and name the catalog allows", () => {
    const ref = `${"a".repeat(253)}/${"b".repeat(64)}`
    expect(parseItemRef(ref)?.ref).toBe(ref)
  })
})

describe("isItemRef", () => {
  it("is true only for an address already in the commands' form", () => {
    expect(isItemRef("anthropics/pdf")).toBe(true)
    expect(isItemRef("Anthropics/pdf")).toBe(false)
    expect(isItemRef(" anthropics/pdf")).toBe(false)
    expect(isItemRef("anthropics")).toBe(false)
    expect(isItemRef(undefined)).toBe(false)
  })
})
