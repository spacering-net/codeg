import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { AvailableCommandInfo } from "@/lib/types"

const PREFIX = "codeg:advertised-commands:"
const keyOf = (agentType: string, folder: string) =>
  PREFIX + JSON.stringify([agentType, folder])

// The store reads localStorage once and caches at module scope, so every test
// gets a module that has not read it yet. A clock that ticks per read keeps the
// "advertised least recently" order deterministic.
beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  let clock = 1_000
  vi.spyOn(Date, "now").mockImplementation(() => (clock += 1))
})

afterEach(() => {
  vi.restoreAllMocks()
})

async function load() {
  return import("./advertised-commands-store")
}

const command = (name: string, description = ""): AvailableCommandInfo => ({
  name,
  description,
})

const names = (commands: readonly { name: string }[] | null) =>
  commands ? commands.map((c) => c.name) : null

/** Every entry in storage, as `agent:folder → names`. */
function stored(): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index)!
    if (!key.startsWith(PREFIX)) continue
    const [agentType, folder] = JSON.parse(key.slice(PREFIX.length))
    out[`${agentType}:${folder}`] = JSON.parse(
      localStorage.getItem(key)!
    ).commands
  }
  return out
}

/** What another window of the app does: write an entry, after which the
 *  browser tells every other window through a `storage` event. */
function writeFromAnotherWindow(
  agentType: string,
  folder: string,
  value: { at: number; commands: string[] } | null
) {
  const key = keyOf(agentType, folder)
  const newValue = value ? JSON.stringify(value) : null
  if (newValue) localStorage.setItem(key, newValue)
  else localStorage.removeItem(key)
  window.dispatchEvent(new StorageEvent("storage", { key, newValue }))
}

describe("rememberAdvertisedCommands", () => {
  it("remembers the names an agent advertised in a folder, for that pair only", async () => {
    const store = await load()
    store.rememberAdvertisedCommands("claude_code", "/a", [
      command("review", "Review the diff"),
      command("init"),
    ])
    expect(names(store.getLastAdvertisedCommands("claude_code", "/a"))).toEqual(
      ["review", "init"]
    )
    // Another folder's commands, or another agent's, say nothing about this.
    expect(store.getLastAdvertisedCommands("claude_code", "/b")).toBeNull()
    expect(store.getLastAdvertisedCommands("codex", "/a")).toBeNull()
    expect(store.getLastAdvertisedCommands("claude_code", null)).toBeNull()
  })

  it("files nothing for a connection without a folder", async () => {
    const store = await load()
    store.rememberAdvertisedCommands("claude_code", null, [command("review")])
    store.rememberAdvertisedCommands("claude_code", "", [command("review")])
    expect(stored()).toEqual({})
  })

  it("replaces what the agent advertised there before rather than merging", async () => {
    const store = await load()
    store.rememberAdvertisedCommands("claude_code", "/a", [
      command("review"),
      command("deploy"),
    ])
    store.rememberAdvertisedCommands("claude_code", "/a", [command("review")])
    expect(names(store.getLastAdvertisedCommands("claude_code", "/a"))).toEqual(
      ["review"]
    )
    // An empty list is an answer too: the agent offers nothing there now.
    store.rememberAdvertisedCommands("claude_code", "/a", [])
    expect(store.getLastAdvertisedCommands("claude_code", "/a")).toEqual([])
    expect(stored()).toEqual({ "claude_code:/a": [] })
  })

  it("is still there after a restart", async () => {
    const before = await load()
    before.rememberAdvertisedCommands("claude_code", "/a", [command("review")])

    vi.resetModules()
    const after = await load()
    expect(names(after.getLastAdvertisedCommands("claude_code", "/a"))).toEqual(
      ["review"]
    )
  })

  it("hands back the same list until this pair's names change", async () => {
    const store = await load()
    store.rememberAdvertisedCommands("claude_code", "/a", [command("review")])
    const first = store.getLastAdvertisedCommands("claude_code", "/a")
    expect(store.getLastAdvertisedCommands("claude_code", "/a")).toBe(first)

    // A reconnect re-advertises the same names (descriptions are not kept).
    store.rememberAdvertisedCommands("claude_code", "/a", [
      command("review", "now with a description"),
    ])
    expect(store.getLastAdvertisedCommands("claude_code", "/a")).toBe(first)

    // Another folder's write leaves this one's reference alone.
    store.rememberAdvertisedCommands("claude_code", "/b", [command("init")])
    expect(store.getLastAdvertisedCommands("claude_code", "/a")).toBe(first)

    store.rememberAdvertisedCommands("claude_code", "/a", [command("init")])
    expect(store.getLastAdvertisedCommands("claude_code", "/a")).not.toBe(first)
  })

  it("wakes its readers for a new list, not for a repeat", async () => {
    const store = await load()
    const listener = vi.fn()
    const unsubscribe = store.subscribeLastAdvertisedCommands(listener)

    store.rememberAdvertisedCommands("claude_code", "/a", [command("review")])
    expect(listener).toHaveBeenCalledTimes(1)
    // A repeat still re-stamps the entry, which is what keeps a folder in use
    // from being the one dropped, but it changes nothing anyone reads.
    store.rememberAdvertisedCommands("claude_code", "/a", [command("review")])
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
    store.rememberAdvertisedCommands("claude_code", "/a", [command("init")])
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("drops the folder advertised least recently once the record is full", async () => {
    const store = await load()
    // Three lists that each take a little over a third of the cap: every name
    // is 7 characters, stored as `"a000000",`.
    const third = Math.ceil(store.MAX_STORED_CHARS / 3 / 10) + 1
    const big = (prefix: string) =>
      Array.from({ length: third }, (_, i) =>
        command(`${prefix}${String(i).padStart(6, "0")}`)
      )
    const listener = vi.fn()
    store.rememberAdvertisedCommands("claude_code", "/a", big("a"))
    store.rememberAdvertisedCommands("claude_code", "/b", big("b"))
    // `/a` advertises again, so `/b` is now the one advertised least recently.
    store.rememberAdvertisedCommands("claude_code", "/a", big("a"))
    store.subscribeLastAdvertisedCommands(listener)
    store.rememberAdvertisedCommands("claude_code", "/c", big("c"))

    expect(store.getLastAdvertisedCommands("claude_code", "/b")).toBeNull()
    expect(store.getLastAdvertisedCommands("claude_code", "/a")).not.toBeNull()
    expect(store.getLastAdvertisedCommands("claude_code", "/c")).not.toBeNull()
    expect(Object.keys(stored()).sort()).toEqual([
      "claude_code:/a",
      "claude_code:/c",
    ])
    let total = 0
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)!
      if (key.startsWith(PREFIX)) {
        total += key.length + localStorage.getItem(key)!.length
      }
    }
    expect(total).toBeLessThanOrEqual(store.MAX_STORED_CHARS)
    // `/b`'s readers lost their list, so they are told.
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("forgets a list too long to keep at all, without pushing out the others", async () => {
    const store = await load()
    store.rememberAdvertisedCommands("claude_code", "/a", [command("review")])
    store.rememberAdvertisedCommands("claude_code", "/b", [command("init")])
    const huge = Array.from({ length: store.MAX_STORED_CHARS / 8 }, (_, i) =>
      command(`c${String(i).padStart(7, "0")}`)
    )
    store.rememberAdvertisedCommands("claude_code", "/b", huge)

    expect(names(store.getLastAdvertisedCommands("claude_code", "/a"))).toEqual(
      ["review"]
    )
    // Not kept in its old form either: that list is no longer what /b offers.
    expect(store.getLastAdvertisedCommands("claude_code", "/b")).toBeNull()
    expect(stored()).toEqual({ "claude_code:/a": ["review"] })
  })

  it("drops an entry too big to ever fit before any older one that does", async () => {
    // Left by some other build of the app: one value over the cap by itself,
    // and newer than everything else.
    localStorage.setItem(
      keyOf("claude_code", "/old"),
      JSON.stringify({ at: 1, commands: ["review"] })
    )
    localStorage.setItem(
      keyOf("claude_code", "/huge"),
      JSON.stringify({ at: 9_999_999, commands: ["x".repeat(70_000)] })
    )
    const store = await load()
    store.rememberAdvertisedCommands("claude_code", "/a", [command("init")])
    expect(stored()).toEqual({
      "claude_code:/old": ["review"],
      "claude_code:/a": ["init"],
    })
  })

  it("holds storage to the cap even with entries this window has not heard of", async () => {
    const store = await load()
    store.getLastAdvertisedCommands("claude_code", "/a")
    // Another window stores two lists of a little over a third of the cap each,
    // and this window has not had their `storage` events yet.
    const third = Math.ceil(store.MAX_STORED_CHARS / 3 / 10) + 1
    const big = (prefix: string) =>
      Array.from(
        { length: third },
        (_, i) => `${prefix}${String(i).padStart(6, "0")}`
      )
    localStorage.setItem(
      keyOf("codex", "/x"),
      JSON.stringify({ at: 10, commands: big("x") })
    )
    localStorage.setItem(
      keyOf("codex", "/y"),
      JSON.stringify({ at: 20, commands: big("y") })
    )
    store.rememberAdvertisedCommands(
      "claude_code",
      "/a",
      big("a").map((name) => command(name))
    )
    expect(Object.keys(stored()).sort()).toEqual(["claude_code:/a", "codex:/y"])
  })

  it("writes only its own entry, so a window that missed another's write cannot undo it", async () => {
    // Two windows, each holding its copy before either writes.
    const first = await load()
    first.getLastAdvertisedCommands("claude_code", "/a")
    vi.resetModules()
    const second = await load()
    second.getLastAdvertisedCommands("claude_code", "/a")

    first.rememberAdvertisedCommands("claude_code", "/a", [command("review")])
    // The second window records another folder without having heard of /a.
    const write = vi.spyOn(Storage.prototype, "setItem")
    const remove = vi.spyOn(Storage.prototype, "removeItem")
    second.rememberAdvertisedCommands("codex", "/b", [command("$ship")])
    expect(write.mock.calls.map(([key]) => key)).toEqual([keyOf("codex", "/b")])
    expect(remove).not.toHaveBeenCalled()
    expect(stored()).toEqual({
      "claude_code:/a": ["review"],
      "codex:/b": ["$ship"],
    })
  })

  it("keeps what it could not store for as long as this window lives", async () => {
    localStorage.setItem(
      keyOf("claude_code", "/a"),
      JSON.stringify({ at: 1, commands: ["review"] })
    )
    const store = await load()
    const write = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("full", "QuotaExceededError")
      })
    store.rememberAdvertisedCommands("claude_code", "/b", [command("init")])
    store.rememberAdvertisedCommands("claude_code", "/c", [command("plan")])
    expect(names(store.getLastAdvertisedCommands("claude_code", "/b"))).toEqual(
      ["init"]
    )
    expect(names(store.getLastAdvertisedCommands("claude_code", "/c"))).toEqual(
      ["plan"]
    )
    // A list that failed to store does not leave the old one standing either.
    store.rememberAdvertisedCommands("claude_code", "/a", [command("init")])
    expect(names(store.getLastAdvertisedCommands("claude_code", "/a"))).toEqual(
      ["init"]
    )
    write.mockRestore()
    store.rememberAdvertisedCommands("claude_code", "/a", [command("review")])
    expect(names(store.getLastAdvertisedCommands("claude_code", "/a"))).toEqual(
      ["review"]
    )
    expect(stored()["claude_code:/a"]).toEqual(["review"])
  })
})

describe("getLastAdvertisedCommands", () => {
  it("follows what another window stores, waking only for a change", async () => {
    const store = await load()
    store.rememberAdvertisedCommands("claude_code", "/a", [command("review")])
    const kept = store.getLastAdvertisedCommands("claude_code", "/a")
    const listener = vi.fn()
    store.subscribeLastAdvertisedCommands(listener)

    writeFromAnotherWindow("codex", "/b", {
      at: 5_000,
      commands: ["$ship", "review"],
    })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(names(store.getLastAdvertisedCommands("codex", "/b"))).toEqual([
      "$ship",
      "review",
    ])
    // Another window re-stamping /a with the same names changes nothing here.
    writeFromAnotherWindow("claude_code", "/a", {
      at: 6_000,
      commands: ["review"],
    })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.getLastAdvertisedCommands("claude_code", "/a")).toBe(kept)

    // Some other key is none of its business.
    window.dispatchEvent(new StorageEvent("storage", { key: "codeg:other" }))
    expect(listener).toHaveBeenCalledTimes(1)

    // Another window dropped /b to stay under the cap.
    writeFromAnotherWindow("codex", "/b", null)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(store.getLastAdvertisedCommands("codex", "/b")).toBeNull()

    // Storage cleared in another window clears this copy as well.
    localStorage.clear()
    window.dispatchEvent(new StorageEvent("storage", { key: null }))
    expect(listener).toHaveBeenCalledTimes(3)
    expect(store.getLastAdvertisedCommands("claude_code", "/a")).toBeNull()
  })

  it("does not let a queued event from an older write put that list back", async () => {
    const store = await load()
    store.rememberAdvertisedCommands("claude_code", "/a", [command("new")])
    const listener = vi.fn()
    store.subscribeLastAdvertisedCommands(listener)
    // Another window stored `old` just before this one stored `new`, and its
    // event only arrives now, with storage already holding the later write.
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: keyOf("claude_code", "/a"),
        newValue: JSON.stringify({ at: 1, commands: ["old"] }),
      })
    )
    expect(names(store.getLastAdvertisedCommands("claude_code", "/a"))).toEqual(
      ["new"]
    )
    expect(listener).not.toHaveBeenCalled()
  })

  it("keeps a newer list it could not store over an older one in storage", async () => {
    const stale = JSON.stringify({ at: 1, commands: ["old"] })
    localStorage.setItem(keyOf("claude_code", "/a"), stale)
    const store = await load()
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError")
    })
    store.rememberAdvertisedCommands("claude_code", "/a", [command("new")])
    // The event for another window's earlier write of that older list.
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: keyOf("claude_code", "/a"),
        newValue: stale,
      })
    )
    expect(names(store.getLastAdvertisedCommands("claude_code", "/a"))).toEqual(
      ["new"]
    )
  })

  it("keeps its copy when storage cannot be read back", async () => {
    const store = await load()
    store.rememberAdvertisedCommands("claude_code", "/a", [command("review")])
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError")
    })
    // Unreadable is not the same as gone, for one entry or for all of them.
    window.dispatchEvent(
      new StorageEvent("storage", { key: keyOf("claude_code", "/a") })
    )
    window.dispatchEvent(new StorageEvent("storage", { key: null }))
    expect(names(store.getLastAdvertisedCommands("claude_code", "/a"))).toEqual(
      ["review"]
    )
  })

  it("reads a damaged entry as nothing remembered, keeping what is well-formed", async () => {
    const put = (folder: string, value: string) =>
      localStorage.setItem(keyOf("claude_code", folder), value)
    put("/a", "{not json")
    put("/b", JSON.stringify(["review"]))
    put("/c", JSON.stringify({ commands: ["review"] }))
    put("/d", JSON.stringify({ at: "1", commands: ["review"] }))
    put("/e", JSON.stringify({ at: 1, commands: "review" }))
    put(
      "/f",
      JSON.stringify({
        at: 1,
        commands: ["review", 3, "", { name: "x" }, "review", "init"],
      })
    )
    localStorage.setItem(`${PREFIX}not json`, JSON.stringify({ at: 1 }))
    const store = await load()
    for (const folder of ["/a", "/b", "/c", "/d", "/e"]) {
      expect(store.getLastAdvertisedCommands("claude_code", folder)).toBeNull()
    }
    expect(names(store.getLastAdvertisedCommands("claude_code", "/f"))).toEqual(
      ["review", "init"]
    )
  })

  it("is what a transcript badges before its connection advertises", async () => {
    const store = await load()
    const { useTranscriptKnownInvocations } =
      await import("@/components/message/use-transcript-known-invocations")
    const { result } = renderHook(() =>
      useTranscriptKnownInvocations("claude_code", null, "/a")
    )
    expect(result.current.size).toBe(0)

    act(() => {
      store.rememberAdvertisedCommands("claude_code", "/a", [command("review")])
    })
    expect([...result.current]).toEqual(["/review"])
  })
})
