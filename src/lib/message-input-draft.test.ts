import type { JSONContent } from "@tiptap/core"
import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  adoptLegacyNewConversationDraft,
  buildNewConversationDraftStorageKey,
  clearMessageInputDraftV2,
  loadMessageInputDraftV2,
  moveMessageInputDraft,
  resetLegacyDraftAdoptionForTests,
  saveMessageInputDraft,
  saveMessageInputDraftV2,
  sweepOrphanDraftKeys,
} from "./message-input-draft"

const DOC: JSONContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }],
}

const V1 = (k: string) => `codeg:message-input-draft:v1:${k}`
const V2 = (k: string) => `codeg:message-input-draft:v2:${k}`

beforeEach(() => {
  localStorage.clear()
})

describe("message-input-draft v2", () => {
  it("round-trips a document through save/load", () => {
    saveMessageInputDraftV2("k-roundtrip", DOC)
    expect(loadMessageInputDraftV2("k-roundtrip")).toEqual({
      kind: "doc",
      doc: DOC,
    })
  })

  it("persists the document to localStorage under the v2 key", () => {
    saveMessageInputDraftV2("k-persist", DOC)
    const raw = localStorage.getItem(V2("k-persist"))
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw as string)).toEqual({ doc: DOC })
  })

  it("returns null when there is no draft", () => {
    expect(loadMessageInputDraftV2("k-empty")).toBeNull()
  })

  it("falls back to a legacy v1 text draft (migration read)", () => {
    saveMessageInputDraft("k-legacy", "draft text")
    expect(loadMessageInputDraftV2("k-legacy")).toEqual({
      kind: "legacyMarkdown",
      markdown: "draft text",
    })
  })

  it("does not delete the legacy v1 draft on read (unedited migration survives)", () => {
    saveMessageInputDraft("k-keep", "still here")
    loadMessageInputDraftV2("k-keep")
    expect(localStorage.getItem(V1("k-keep"))).not.toBeNull()
  })

  it("a saved v2 document supersedes and removes the legacy v1 draft", () => {
    saveMessageInputDraft("k-mig", "old text")
    expect(loadMessageInputDraftV2("k-mig")).toMatchObject({
      kind: "legacyMarkdown",
    })
    saveMessageInputDraftV2("k-mig", DOC)
    expect(loadMessageInputDraftV2("k-mig")).toEqual({ kind: "doc", doc: DOC })
    expect(localStorage.getItem(V1("k-mig"))).toBeNull()
  })

  it("clearMessageInputDraftV2 removes both the v2 and legacy v1 entries", () => {
    saveMessageInputDraft("k-clear", "legacy")
    saveMessageInputDraftV2("k-clear", DOC)
    clearMessageInputDraftV2("k-clear")
    expect(loadMessageInputDraftV2("k-clear")).toBeNull()
    expect(localStorage.getItem(V2("k-clear"))).toBeNull()
    expect(localStorage.getItem(V1("k-clear"))).toBeNull()
  })

  it("keeps the legacy v1 draft when the v2 write fails (not retired early)", () => {
    saveMessageInputDraft("k-fail", "legacy survives")
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation((key: string) => {
        if (key.startsWith("codeg:message-input-draft:v2:")) {
          throw new Error("quota exceeded")
        }
      })
    try {
      // Flushes synchronously in jsdom; the v2 setItem throws.
      saveMessageInputDraftV2("k-fail", DOC)
    } finally {
      setItem.mockRestore()
    }
    // v1 is still on disk because the v2 write never succeeded.
    expect(localStorage.getItem(V1("k-fail"))).not.toBeNull()
  })

  it("ignores a corrupt v2 payload and falls back to the legacy v1 draft", () => {
    localStorage.setItem(V2("k-corrupt"), JSON.stringify({ doc: {} }))
    saveMessageInputDraft("k-corrupt", "fallback")
    expect(loadMessageInputDraftV2("k-corrupt")).toEqual({
      kind: "legacyMarkdown",
      markdown: "fallback",
    })
  })

  it("ignores a non-object/array v2 payload and returns null without a v1 draft", () => {
    localStorage.setItem(V2("k-corrupt2"), JSON.stringify({ doc: [1, 2] }))
    expect(loadMessageInputDraftV2("k-corrupt2")).toBeNull()
  })
})

// Every split group owns its own unsent draft, so composer text is keyed per
// draft TAB. Before this the key was the single literal "new" and two groups'
// drafts overwrote each other.
describe("per-draft-tab composer drafts", () => {
  beforeEach(() => {
    resetLegacyDraftAdoptionForTests()
  })

  it("keys each draft tab separately", () => {
    const a = buildNewConversationDraftStorageKey("new-1-a")
    const b = buildNewConversationDraftStorageKey("new-2-b")
    expect(a).not.toBe(b)

    saveMessageInputDraftV2(a, DOC)
    expect(loadMessageInputDraftV2(a)).toEqual({ kind: "doc", doc: DOC })
    expect(loadMessageInputDraftV2(b)).toBeNull()
  })

  it("moves a draft to another key (closing tab hands off to its replacement)", () => {
    const from = buildNewConversationDraftStorageKey("new-old")
    const to = buildNewConversationDraftStorageKey("new-fresh")
    saveMessageInputDraftV2(from, DOC)

    moveMessageInputDraft(from, to)

    expect(loadMessageInputDraftV2(to)).toEqual({ kind: "doc", doc: DOC })
    expect(loadMessageInputDraftV2(from)).toBeNull()
    expect(localStorage.getItem(V2(from))).toBeNull()
  })

  it("carries a legacy v1 text draft through a move", () => {
    const from = buildNewConversationDraftStorageKey("new-v1")
    const to = buildNewConversationDraftStorageKey("new-v1-next")
    saveMessageInputDraft(from, "unsent words")

    moveMessageInputDraft(from, to)

    expect(loadMessageInputDraftV2(to)).toEqual({
      kind: "legacyMarkdown",
      markdown: "unsent words",
    })
    expect(localStorage.getItem(V1(from))).toBeNull()
  })

  it("hands the pre-per-tab shared draft to the FIRST draft tab only", () => {
    saveMessageInputDraftV2("new", DOC)
    const first = buildNewConversationDraftStorageKey("new-first")
    const second = buildNewConversationDraftStorageKey("new-second")

    adoptLegacyNewConversationDraft(first)
    adoptLegacyNewConversationDraft(second)

    expect(loadMessageInputDraftV2(first)).toEqual({ kind: "doc", doc: DOC })
    expect(loadMessageInputDraftV2(second)).toBeNull()
    expect(localStorage.getItem(V2("new"))).toBeNull()
  })

  it("never overwrites a draft tab's own text — the next empty tab takes the legacy one", () => {
    const own: JSONContent = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "own" }] },
      ],
    }
    saveMessageInputDraftV2("new", DOC)
    const owner = buildNewConversationDraftStorageKey("new-owner")
    const empty = buildNewConversationDraftStorageKey("new-empty")
    saveMessageInputDraftV2(owner, own)

    adoptLegacyNewConversationDraft(owner)
    expect(loadMessageInputDraftV2(owner)).toEqual({ kind: "doc", doc: own })

    // The handover was not consumed by the tab that declined it.
    adoptLegacyNewConversationDraft(empty)
    expect(loadMessageInputDraftV2(empty)).toEqual({ kind: "doc", doc: DOC })
  })

  it("sweeps drafts whose tab is gone and keeps the live ones", () => {
    const live = buildNewConversationDraftStorageKey("new-live")
    const dead = buildNewConversationDraftStorageKey("new-dead")
    saveMessageInputDraftV2(live, DOC)
    saveMessageInputDraftV2(dead, DOC)
    saveMessageInputDraft(dead, "legacy too")
    // A bound conversation's draft is not a per-tab draft key — untouched.
    saveMessageInputDraftV2("conv:42", DOC)

    sweepOrphanDraftKeys(() => new Set(["new-live"]))

    expect(loadMessageInputDraftV2(live)).toEqual({ kind: "doc", doc: DOC })
    expect(loadMessageInputDraftV2("conv:42")).toEqual({
      kind: "doc",
      doc: DOC,
    })
    expect(localStorage.getItem(V2(dead))).toBeNull()
    expect(localStorage.getItem(V1(dead))).toBeNull()
    expect(loadMessageInputDraftV2(dead)).toBeNull()
  })

  it("reads the live set when it RUNS, so a draft opened after scheduling survives", () => {
    const late = buildNewConversationDraftStorageKey("new-late")
    const dead = buildNewConversationDraftStorageKey("new-dead")
    saveMessageInputDraftV2(late, DOC)
    saveMessageInputDraftV2(dead, DOC)
    const live = new Set<string>()

    // Defer like a real idle callback: scheduled while nothing is open (the
    // hydration-races-recovery window), fired after a draft has appeared.
    let idleCallback: (() => void) | null = null
    const win = window as unknown as { requestIdleCallback?: unknown }
    const hadIdle = "requestIdleCallback" in win
    win.requestIdleCallback = (cb: () => void) => {
      idleCallback = cb
      return 1
    }
    try {
      sweepOrphanDraftKeys(() => live)
      live.add("new-late")
      expect(idleCallback).not.toBeNull()
      idleCallback!()
    } finally {
      if (!hadIdle) delete win.requestIdleCallback
    }

    expect(loadMessageInputDraftV2(late)).toEqual({ kind: "doc", doc: DOC })
    expect(loadMessageInputDraftV2(dead)).toBeNull()
  })
})
