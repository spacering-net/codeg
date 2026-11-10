import { create } from "zustand"

/**
 * The command launcher (`CommandDropdown`) lives inside the aux panel's Session
 * Details tab, which the shell unmounts whenever the right sidebar is closed.
 * The command↔terminal linkage that drives the launcher's Run/Stop state used
 * to be local component state, so it was destroyed on that unmount and never
 * reconstructed — reopening the sidebar showed "Run" for a still-running
 * command. Holding the map at module scope here keeps the linkage alive across
 * that unmount; the terminals themselves already survive (their
 * `TerminalProvider` is a top-level provider).
 */
interface CommandTerminalLinkState {
  /**
   * Maps a launcher command, as run in one folder (see `commandLinkKey`), to
   * the terminal it was launched into.
   */
  links: Record<string, string>
  setLink: (key: string, terminalId: string) => void
  clearLink: (key: string) => void
  /** Drop every link whose terminal id matches the predicate (exited/closed). */
  pruneTerminals: (shouldRemove: (terminalId: string) => boolean) => void
}

/**
 * The key a command's link is stored under: the folder it runs in as well as
 * its id. A folder command's id is a database key no other folder shares, but
 * a global command (see `global-commands`) has the same id in every folder,
 * and running it in one folder must not read as running — or be stopped — in
 * another.
 */
export function commandLinkKey(folderId: number, commandId: number): string {
  return `${folderId}:${commandId}`
}

export const useCommandTerminalLinkStore = create<CommandTerminalLinkState>(
  (set) => ({
    links: {},
    setLink: (key, terminalId) =>
      set((s) =>
        s.links[key] === terminalId
          ? s
          : { links: { ...s.links, [key]: terminalId } }
      ),
    clearLink: (key) =>
      set((s) => {
        if (!(key in s.links)) return s
        const next = { ...s.links }
        delete next[key]
        return { links: next }
      }),
    pruneTerminals: (shouldRemove) =>
      set((s) => {
        let changed = false
        const next: Record<string, string> = {}
        for (const [key, termId] of Object.entries(s.links)) {
          if (shouldRemove(termId)) changed = true
          else next[key] = termId
        }
        return changed ? { links: next } : s
      }),
  })
)

/**
 * The terminal a command is currently linked to *and* running in, or
 * `undefined`. A persisted link is only "live" when its terminal still exists
 * and hasn't exited — so a stale link left over from a terminal that ended
 * while the panel was closed reads as not-running (no false "Stop" state).
 * Pure + exported for unit testing.
 */
export function resolveLiveCommandTerminalId(
  links: Record<string, string>,
  key: string,
  isLive: (terminalId: string) => boolean
): string | undefined {
  const terminalId = links[key]
  return terminalId && isLive(terminalId) ? terminalId : undefined
}
