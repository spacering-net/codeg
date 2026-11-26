import { beforeEach, describe, expect, it } from "vitest"

import {
  HARNESS_PACK_TABS,
  HARNESS_SECTION_IDS,
  defaultHarnessSection,
  harnessSectionsFor,
  harnessTargetOf,
  isHarnessPackTab,
  isHarnessSectionId,
  loadHarnessSection,
  resolveHarnessSection,
  saveHarnessSection,
  type HarnessOpenRequest,
} from "./harness-sections"

const SECTION_KEY = "workspace:harness-section"

describe("SRN Harness sections", () => {
  it("lists Discover, MCP, Skills, Plugins, Skill packs — in that order", () => {
    expect(HARNESS_SECTION_IDS).toEqual([
      "discover",
      "mcp",
      "skills",
      "plugins",
      "packs",
    ])
  })

  it("offers every section while the catalog is on", () => {
    expect(harnessSectionsFor(true)).toEqual([
      "discover",
      "mcp",
      "skills",
      "plugins",
      "packs",
    ])
  })

  it("drops only Discover when the catalog is switched off", () => {
    expect(harnessSectionsFor(false)).toEqual([
      "mcp",
      "skills",
      "plugins",
      "packs",
    ])
  })

  it("hands back the same list for the same answer", () => {
    // The provider derives the list on every render; a fresh array each time
    // would rebuild its context value, and with it every consumer.
    expect(harnessSectionsFor(true)).toBe(harnessSectionsFor(true))
    expect(harnessSectionsFor(false)).toBe(harnessSectionsFor(false))
  })

  it("recognises a section id, and nothing else", () => {
    for (const id of HARNESS_SECTION_IDS)
      expect(isHarnessSectionId(id)).toBe(true)
    for (const value of ["", "settings", "Discover", null, undefined, 1, {}]) {
      expect(isHarnessSectionId(value)).toBe(false)
    }
  })
})

describe("the section the page lands on", () => {
  it("is Discover on a first visit", () => {
    expect(defaultHarnessSection(true)).toBe("discover")
    expect(resolveHarnessSection(null, true)).toBe("discover")
  })

  it("is MCP on a first visit with no Discover", () => {
    expect(defaultHarnessSection(false)).toBe("mcp")
    expect(resolveHarnessSection(null, false)).toBe("mcp")
  })

  it("is the remembered section while the window still offers it", () => {
    expect(resolveHarnessSection("packs", true)).toBe("packs")
    expect(resolveHarnessSection("skills", false)).toBe("skills")
    expect(resolveHarnessSection("discover", true)).toBe("discover")
  })

  it("falls back to MCP for a remembered Discover that is switched off", () => {
    expect(resolveHarnessSection("discover", false)).toBe("mcp")
  })
})

describe("section persistence", () => {
  beforeEach(() => localStorage.clear())

  it("remembers nothing before the first switch", () => {
    expect(loadHarnessSection()).toBeNull()
  })

  it("round-trips every section", () => {
    for (const id of HARNESS_SECTION_IDS) {
      saveHarnessSection(id)
      expect(localStorage.getItem(SECTION_KEY)).toBe(id)
      expect(loadHarnessSection()).toBe(id)
    }
  })

  it("reads anything it does not recognise as a first visit", () => {
    // A value from a future version, or a hand-edited one, must not select a
    // section that is not there.
    for (const raw of ["", "installed", '"mcp"', "MCP", "null"]) {
      localStorage.setItem(SECTION_KEY, raw)
      expect(loadHarnessSection()).toBeNull()
    }
  })
})

describe("harnessTargetOf", () => {
  it("names the one thing a request asks for", () => {
    expect(
      harnessTargetOf({ section: "discover", itemRef: "acme/pdf-tools" })
    ).toEqual({ section: "discover", itemRef: "acme/pdf-tools" })
    expect(harnessTargetOf({ section: "mcp", serverKey: "github" })).toEqual({
      section: "mcp",
      serverKey: "github",
    })
    expect(harnessTargetOf({ section: "skills", skillId: "pdf" })).toEqual({
      section: "skills",
      skillId: "pdf",
    })
    expect(harnessTargetOf({ section: "packs", tab: "office" })).toEqual({
      section: "packs",
      tab: "office",
    })
    expect(
      harnessTargetOf({ section: "plugins", itemId: "itm_superpowers" })
    ).toEqual({ section: "plugins", itemId: "itm_superpowers" })
  })

  it("is null for a request that only names a section", () => {
    for (const section of HARNESS_SECTION_IDS) {
      expect(harnessTargetOf({ section })).toBeNull()
    }
  })

  it("opens Experts for the Custom tab, which is gone", () => {
    expect(
      harnessTargetOf({
        section: "packs",
        tab: "custom",
      } as unknown as HarnessOpenRequest)
    ).toEqual({ section: "packs", tab: "experts" })
  })

  it("treats an empty or unknown value as no target", () => {
    expect(harnessTargetOf({ section: "discover", itemRef: "" })).toBeNull()
    expect(harnessTargetOf({ section: "mcp", serverKey: "" })).toBeNull()
    expect(harnessTargetOf({ section: "skills", skillId: "" })).toBeNull()
    expect(harnessTargetOf({ section: "plugins", itemId: "" })).toBeNull()
    // A request built from a link can carry anything.
    for (const tab of ["nope", ""]) {
      expect(
        harnessTargetOf({ section: "packs", tab } as HarnessOpenRequest)
      ).toBeNull()
    }
    expect(
      harnessTargetOf({ section: "nowhere" } as unknown as HarnessOpenRequest)
    ).toBeNull()
  })

  it("carries what a link wants done with an item", () => {
    expect(
      harnessTargetOf({
        section: "discover",
        itemRef: "acme/pdf-tools",
        intent: "install",
      })
    ).toEqual({
      section: "discover",
      itemRef: "acme/pdf-tools",
      intent: "install",
    })
    // Without one, there is none — not even an empty key.
    expect(
      harnessTargetOf({ section: "discover", itemRef: "acme/pdf-tools" })
    ).not.toHaveProperty("intent")
    // An intent no section knows, from a request built from a link, is left
    // behind; the item still opens.
    expect(
      harnessTargetOf({
        section: "discover",
        itemRef: "acme/pdf-tools",
        intent: "uninstall",
      } as unknown as HarnessOpenRequest)
    ).toStrictEqual({ section: "discover", itemRef: "acme/pdf-tools" })
    // And no item, no target, whatever it was wanted for.
    expect(
      harnessTargetOf({ section: "discover", itemRef: "", intent: "install" })
    ).toBeNull()
  })

  it("builds a new target for every request", () => {
    // The target's identity stands for one request: asking for the same thing
    // twice has to be two targets, or the second ask would change nothing.
    const request: HarnessOpenRequest = { section: "packs", tab: "ui" }
    expect(harnessTargetOf(request)).not.toBe(harnessTargetOf(request))
  })
})

describe("pack tabs a caller can ask for", () => {
  it("are the four packs, without the Custom tab", () => {
    expect(HARNESS_PACK_TABS).toEqual(["experts", "science", "office", "ui"])
    expect(isHarnessPackTab("office")).toBe(true)
    expect(isHarnessPackTab("custom")).toBe(false)
    expect(isHarnessPackTab(undefined)).toBe(false)
  })
})
