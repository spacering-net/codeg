import type { FolderCommand } from "@/lib/types"

/**
 * Commands shown in every folder — other repos, worktrees, remote connections
 * alike — rather than in the one folder they were added to. Folder commands
 * live in the folder host's database, keyed by folder; these live in this
 * client's localStorage instead, so they need nothing from the server and
 * follow the user to whichever host a window is bound to.
 *
 * They wear the `FolderCommand` shape so the launcher and the manage dialog
 * treat both kinds alike. Their ids are negative, which keeps them apart from
 * the database's (positive) primary keys in every map keyed by command id.
 */
export const GLOBAL_COMMANDS_STORAGE_KEY = "codeg:global-commands:v1"

interface StoredGlobalCommand {
  id: number
  name: string
  command: string
}

export function isGlobalCommandId(id: number): boolean {
  return id < 0
}

/** One stored entry, or null when it isn't `{id<0, name, command}` — the
 *  storage is shared with older and newer builds, so it is untrusted input. */
function parseEntry(value: unknown): StoredGlobalCommand | null {
  if (!value || typeof value !== "object") return null
  const { id, name, command } = value as Record<string, unknown>
  if (!Number.isSafeInteger(id) || !isGlobalCommandId(id as number)) return null
  if (typeof name !== "string" || typeof command !== "string") return null
  return { id: id as number, name, command }
}

function readStored(): StoredGlobalCommand[] {
  try {
    const raw = localStorage.getItem(GLOBAL_COMMANDS_STORAGE_KEY)
    if (!raw) return []
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) return []
    const seen = new Set<number>()
    const out: StoredGlobalCommand[] = []
    for (const item of value) {
      const entry = parseEntry(item)
      if (!entry || seen.has(entry.id)) continue
      seen.add(entry.id)
      out.push(entry)
    }
    return out
  } catch {
    return []
  }
}

function writeStored(entries: StoredGlobalCommand[]): void {
  localStorage.setItem(GLOBAL_COMMANDS_STORAGE_KEY, JSON.stringify(entries))
}

function toFolderCommand(
  entry: StoredGlobalCommand,
  index: number
): FolderCommand {
  return {
    id: entry.id,
    folder_id: 0,
    name: entry.name,
    command: entry.command,
    sort_order: index,
    created_at: "",
    updated_at: "",
  }
}

export function listGlobalCommands(): FolderCommand[] {
  return readStored().map(toFolderCommand)
}

export function createGlobalCommand(
  name: string,
  command: string
): FolderCommand {
  const entries = readStored()
  const id = Math.min(0, ...entries.map((entry) => entry.id)) - 1
  const next = [...entries, { id, name, command }]
  writeStored(next)
  return toFolderCommand(next[next.length - 1], next.length - 1)
}

export function updateGlobalCommand(
  id: number,
  name: string,
  command: string
): FolderCommand {
  const entries = readStored()
  const index = entries.findIndex((entry) => entry.id === id)
  if (index < 0) throw new Error("Command not found")
  entries[index] = { id, name, command }
  writeStored(entries)
  return toFolderCommand(entries[index], index)
}

export function deleteGlobalCommand(id: number): void {
  writeStored(readStored().filter((entry) => entry.id !== id))
}

/** Reorder to `ids`; entries missing from it keep their place at the end. */
export function reorderGlobalCommands(ids: number[]): void {
  const entries = readStored()
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const ordered = ids.flatMap((id) => {
    const entry = byId.get(id)
    if (!entry) return []
    byId.delete(id)
    return [entry]
  })
  writeStored([...ordered, ...byId.values()])
}
