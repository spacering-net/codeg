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
  run_local: boolean
}

interface StoredGlobalCommands {
  /**
   * The last id handed out. Ids are never reused: a deleted command's id can
   * still be a folder's remembered selection, or linked to a terminal it is
   * running in, and either would pass to the next command created.
   */
  lastId: number
  commands: StoredGlobalCommand[]
}

export function isGlobalCommandId(id: number): boolean {
  return id < 0
}

/**
 * Drop entries that claim a global command's id from a list the folder's host
 * returned. Its database hands out positive ids only, so such an entry is not
 * the host's own; letting it through would pass it off as one of the commands
 * kept on this computer.
 */
export function withoutGlobalIds(commands: FolderCommand[]): FolderCommand[] {
  return commands.filter((command) => !isGlobalCommandId(command.id))
}

/** A command the folder's host returned from a save, refused for the same
 *  reason `withoutGlobalIds` drops one: it claims a global command's id. */
export function requireHostCommand(command: FolderCommand): FolderCommand {
  if (isGlobalCommandId(command.id)) {
    throw new Error(`the folder's host returned command id ${command.id}`)
  }
  return command
}

/** One stored entry, or null when it isn't `{id<0, name, command}` — the
 *  storage is shared with older and newer builds, so it is untrusted input.
 *  Only an explicit `run_local: true` runs a command on this computer. */
function parseEntry(value: unknown): StoredGlobalCommand | null {
  if (!value || typeof value !== "object") return null
  const { id, name, command, run_local } = value as Record<string, unknown>
  if (!Number.isSafeInteger(id) || !isGlobalCommandId(id as number)) return null
  if (typeof name !== "string" || typeof command !== "string") return null
  return { id: id as number, name, command, run_local: run_local === true }
}

function readStored(): StoredGlobalCommands {
  const empty: StoredGlobalCommands = { lastId: 0, commands: [] }
  try {
    const raw = localStorage.getItem(GLOBAL_COMMANDS_STORAGE_KEY)
    if (!raw) return empty
    const value: unknown = JSON.parse(raw)
    // Builds before `lastId` stored the bare list.
    const record = Array.isArray(value) ? { commands: value } : value
    if (!record || typeof record !== "object") return empty
    const { lastId, commands } = record as Record<string, unknown>
    if (!Array.isArray(commands)) return empty
    const seen = new Set<number>()
    const out: StoredGlobalCommand[] = []
    for (const item of commands) {
      const entry = parseEntry(item)
      if (!entry || seen.has(entry.id)) continue
      seen.add(entry.id)
      out.push(entry)
    }
    // Never above an id in use, whatever the stored mark says.
    const floor = out.reduce((min, entry) => Math.min(min, entry.id), 0)
    return {
      lastId:
        Number.isSafeInteger(lastId) && (lastId as number) < floor
          ? (lastId as number)
          : floor,
      commands: out,
    }
  } catch {
    return empty
  }
}

function writeStored(stored: StoredGlobalCommands): void {
  localStorage.setItem(GLOBAL_COMMANDS_STORAGE_KEY, JSON.stringify(stored))
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
    run_local: entry.run_local,
    created_at: "",
    updated_at: "",
  }
}

export function listGlobalCommands(): FolderCommand[] {
  return readStored().commands.map(toFolderCommand)
}

export function createGlobalCommand(
  name: string,
  command: string,
  runLocal: boolean
): FolderCommand {
  const { lastId, commands } = readStored()
  const id = lastId - 1
  // Past the last safe integer an id no longer reads back as one.
  if (!Number.isSafeInteger(id)) throw new Error("No command ids left")
  const next = [...commands, { id, name, command, run_local: runLocal }]
  writeStored({ lastId: id, commands: next })
  return toFolderCommand(next[next.length - 1], next.length - 1)
}

export function updateGlobalCommand(
  id: number,
  name: string,
  command: string,
  runLocal: boolean
): FolderCommand {
  const { lastId, commands } = readStored()
  const index = commands.findIndex((entry) => entry.id === id)
  if (index < 0) throw new Error("Command not found")
  commands[index] = { id, name, command, run_local: runLocal }
  writeStored({ lastId, commands })
  return toFolderCommand(commands[index], index)
}

export function deleteGlobalCommand(id: number): void {
  const { lastId, commands } = readStored()
  writeStored({
    lastId,
    commands: commands.filter((entry) => entry.id !== id),
  })
}

/** Reorder to `ids`; entries missing from it keep their place at the end. */
export function reorderGlobalCommands(ids: number[]): void {
  const { lastId, commands } = readStored()
  const byId = new Map(commands.map((entry) => [entry.id, entry]))
  const ordered = ids.flatMap((id) => {
    const entry = byId.get(id)
    if (!entry) return []
    byId.delete(id)
    return [entry]
  })
  writeStored({ lastId, commands: [...ordered, ...byId.values()] })
}
