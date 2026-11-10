import { beforeEach, describe, expect, it } from "vitest"
import {
  commandLinkKey,
  resolveLiveCommandTerminalId,
  useCommandTerminalLinkStore,
} from "./command-terminal-link-store"

// Command `n` as run in folder 1.
const k = (n: number) => commandLinkKey(1, n)

beforeEach(() => {
  useCommandTerminalLinkStore.setState({ links: {} })
})

describe("command-terminal-link store", () => {
  describe("setLink", () => {
    it("adds a link", () => {
      useCommandTerminalLinkStore.getState().setLink(k(1), "term-a")
      expect(useCommandTerminalLinkStore.getState().links).toEqual({
        [k(1)]: "term-a",
      })
    })

    it("overwrites the link for the same command", () => {
      const store = useCommandTerminalLinkStore.getState()
      store.setLink(k(1), "term-a")
      store.setLink(k(1), "term-b")
      expect(useCommandTerminalLinkStore.getState().links).toEqual({
        [k(1)]: "term-b",
      })
    })

    it("keeps one command's runs in different folders apart", () => {
      // A global command has one id in every folder it is shown in.
      const store = useCommandTerminalLinkStore.getState()
      store.setLink(commandLinkKey(1, -1), "term-a")
      store.setLink(commandLinkKey(2, -1), "term-b")
      store.clearLink(commandLinkKey(1, -1))
      expect(useCommandTerminalLinkStore.getState().links).toEqual({
        [commandLinkKey(2, -1)]: "term-b",
      })
    })

    it("keeps the links reference stable when unchanged", () => {
      const store = useCommandTerminalLinkStore.getState()
      store.setLink(k(1), "term-a")
      const before = useCommandTerminalLinkStore.getState().links
      store.setLink(k(1), "term-a")
      expect(useCommandTerminalLinkStore.getState().links).toBe(before)
    })
  })

  describe("clearLink", () => {
    it("removes a link, leaving the others", () => {
      const store = useCommandTerminalLinkStore.getState()
      store.setLink(k(1), "term-a")
      store.setLink(k(2), "term-b")
      store.clearLink(k(1))
      expect(useCommandTerminalLinkStore.getState().links).toEqual({
        [k(2)]: "term-b",
      })
    })

    it("is a stable no-op when the command has no link", () => {
      const store = useCommandTerminalLinkStore.getState()
      store.setLink(k(1), "term-a")
      const before = useCommandTerminalLinkStore.getState().links
      store.clearLink(k(999))
      expect(useCommandTerminalLinkStore.getState().links).toBe(before)
    })
  })

  describe("pruneTerminals", () => {
    it("drops links whose terminal matches the predicate", () => {
      const store = useCommandTerminalLinkStore.getState()
      store.setLink(k(1), "term-a")
      store.setLink(k(2), "term-b")
      store.setLink(k(3), "term-c")
      store.pruneTerminals((termId) => termId === "term-b")
      expect(useCommandTerminalLinkStore.getState().links).toEqual({
        [k(1)]: "term-a",
        [k(3)]: "term-c",
      })
    })

    it("is a stable no-op when nothing matches", () => {
      const store = useCommandTerminalLinkStore.getState()
      store.setLink(k(1), "term-a")
      const before = useCommandTerminalLinkStore.getState().links
      store.pruneTerminals(() => false)
      expect(useCommandTerminalLinkStore.getState().links).toBe(before)
    })
  })

  describe("resolveLiveCommandTerminalId", () => {
    const isLive = (id: string) => id === "term-a"

    it("returns the terminal id when the link exists and is live", () => {
      expect(
        resolveLiveCommandTerminalId({ [k(1)]: "term-a" }, k(1), isLive)
      ).toBe("term-a")
    })

    it("returns undefined when the command has no link", () => {
      expect(resolveLiveCommandTerminalId({}, k(1), isLive)).toBeUndefined()
    })

    it("returns undefined when the linked terminal is not live (exited/closed)", () => {
      expect(
        resolveLiveCommandTerminalId({ [k(1)]: "term-dead" }, k(1), isLive)
      ).toBeUndefined()
    })
  })
})
