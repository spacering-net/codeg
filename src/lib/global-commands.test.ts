import { beforeEach, describe, expect, it } from "vitest"
import {
  GLOBAL_COMMANDS_STORAGE_KEY,
  createGlobalCommand,
  deleteGlobalCommand,
  isGlobalCommandId,
  listGlobalCommands,
  reorderGlobalCommands,
  updateGlobalCommand,
} from "./global-commands"

const summary = () =>
  listGlobalCommands().map(({ id, name, command }) => ({ id, name, command }))

describe("global commands", () => {
  beforeEach(() => localStorage.clear())

  it("hands out negative ids, apart from folder commands' primary keys", () => {
    const a = createGlobalCommand("zed", "local: zed .")
    const b = createGlobalCommand("open", "local: open .")
    expect(a.id).toBe(-1)
    expect(b.id).toBe(-2)
    expect(isGlobalCommandId(a.id)).toBe(true)
    expect(isGlobalCommandId(5)).toBe(false)
  })

  it("does not reuse the id of a deleted command", () => {
    createGlobalCommand("a", "a")
    const b = createGlobalCommand("b", "b")
    deleteGlobalCommand(-1)
    expect(createGlobalCommand("c", "c").id).toBe(b.id - 1)
  })

  it("updates, deletes and reorders", () => {
    createGlobalCommand("a", "a")
    createGlobalCommand("b", "b")
    createGlobalCommand("c", "c")
    updateGlobalCommand(-2, "B", "bb")
    reorderGlobalCommands([-3, -1])
    expect(summary()).toEqual([
      { id: -3, name: "c", command: "c" },
      { id: -1, name: "a", command: "a" },
      { id: -2, name: "B", command: "bb" },
    ])
    deleteGlobalCommand(-3)
    expect(summary().map((c) => c.id)).toEqual([-1, -2])
  })

  it("throws when updating a command that is gone", () => {
    expect(() => updateGlobalCommand(-9, "x", "x")).toThrow()
  })

  it("ignores malformed storage", () => {
    localStorage.setItem(
      GLOBAL_COMMANDS_STORAGE_KEY,
      JSON.stringify([
        { id: 3, name: "positive", command: "x" },
        { id: -1, name: "ok", command: "y" },
        { id: -1, name: "duplicate", command: "z" },
        { id: -2, name: 7, command: "w" },
        null,
      ])
    )
    expect(summary()).toEqual([{ id: -1, name: "ok", command: "y" }])
    localStorage.setItem(GLOBAL_COMMANDS_STORAGE_KEY, "{not json")
    expect(listGlobalCommands()).toEqual([])
  })
})
