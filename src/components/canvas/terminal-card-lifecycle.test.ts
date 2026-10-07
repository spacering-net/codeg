import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * What keeps a terminal card's shell alive across the things that unmount it.
 *
 * The canvas is a full-page route: `WorkbenchRoutePage` renders the active page
 * or nothing, so a glance at the task board unmounts every card on the board.
 * A conversation card can be rebuilt from the store when it comes back; a
 * terminal cannot — its state is a process, and the process must NOT be
 * restarted, killed, or left behind a blank pane.
 *
 * Three pieces make that work, and all three are invisible in review:
 *
 *   1. the PTY id is derived from the ROW, not from the component;
 *   2. the view attaches to an existing PTY instead of spawning a second one,
 *      and replays the scrollback so the pane is not blank;
 *   3. attaching NEVER kills on unmount — that is the whole point.
 *
 * Read from source: `TerminalView` needs xterm, a live transport and a real
 * container to mount at all, which is the same reason `card-reentry.test.ts`
 * and `draft-card-handover.test.ts` are written this way.
 */

function read(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8")
}

const CARD = "src/components/canvas/nodes/terminal-node.tsx"
const VIEW = "src/components/terminal/terminal-view.tsx"
const CANVAS_VIEW = "src/components/canvas/canvas-view.tsx"

describe("a terminal card crossing a route switch", () => {
  it("commits its resize without the grid fields the backend rejects", () => {
    // `update_node` rejects `gridColumns`/`gridRows` on a non-region outright,
    // so the WHOLE geometry patch fails and the card snaps back after every
    // resize. Both the live quantization and the commit therefore go through
    // one predicate rather than re-listing the kinds that are not regions.
    const canvas = read(CANVAS_VIEW)
    expect(canvas).not.toMatch(/kind !== "conversation"/)
    expect(canvas.match(/isRegionKind\(/g)?.length ?? 0).toBeGreaterThanOrEqual(
      3
    )
  })

  it("asks the view to attach rather than to spawn", () => {
    // Without `attach` the remount calls `terminal_spawn` with an id the
    // backend already holds, which fails — and the failure prints
    // "[Failed to start terminal]" over a shell that is in fact running fine.
    const card = read(CARD)
    expect(card).toMatch(/\battach\b/)
    expect(card).toContain("canvasTerminalId")
  })

  it("keys the PTY off the row so the same card finds the same shell", () => {
    // A per-mount id (a uuid, a ref) would spawn a new shell every visit and
    // orphan the previous one; a per-component one would do the same in a
    // second window showing the same board.
    const model = read("src/components/canvas/canvas-model.ts")
    expect(model).toContain("`canvas-term-${dbId}`")
  })

  it("never kills the PTY when an attaching view goes away", () => {
    // The cancel path exists for a spawn nobody ever saw. In attach mode the
    // process belongs to the CARD, so the same line would take a running
    // command down with a view switch.
    const view = read(VIEW)
    expect(view).toContain("if (!attach) terminalKill(terminalId)")
    // …and there is exactly one kill in the whole view, so no other path can
    // quietly reintroduce it.
    expect(view.match(/terminalKill\(/g)?.length ?? 0).toBe(1)
  })

  it("subscribes before it asks for the snapshot, and dedupes the overlap", () => {
    // Snapshot-then-subscribe loses whatever the shell printed in between;
    // subscribe-then-snapshot duplicates it. The seq cursor is what makes the
    // second order correct — drop it and the replay double-prints.
    const view = read(VIEW)
    const subscribeAt = view.indexOf("`terminal://output/${terminalId}`")
    const snapshotAt = view.indexOf("terminalSnapshot(terminalId)")
    expect(subscribeAt).toBeGreaterThan(-1)
    expect(snapshotAt).toBeGreaterThan(subscribeAt)
    expect(view).toContain("seq <= snapshotSeq")
  })

  it("does not let ReactFlow cull a mounted terminal off-screen", () => {
    // `onlyRenderVisibleElements` unmounts nodes outside the viewport. The PTY
    // would survive, but panning away and back would drop the emulator and
    // redraw from the scrollback — a visible reset for a purely cosmetic win.
    const canvas = read(CANVAS_VIEW)
    expect(canvas).toContain("terminalNodeIds.length")
    expect(canvas).toContain(
      "onlyRenderVisibleElements={liveSurfaceCount === 0}"
    )
  })

  it("recovers from a lost spawn race instead of reporting a dead terminal", () => {
    // Two windows on one board (or React's double-invoked dev effect) can both
    // see "not alive" and both spawn; only one wins, and the loser's
    // `terminal_spawn` fails with "id already exists" over a shell that is in
    // fact healthy. Re-asking for the snapshot is what turns that into an
    // attach instead of a red error and a card stuck in the "exited" state.
    const view = read(VIEW)
    const spawnAt = view.indexOf("terminalSpawn(")
    const retryAt = view.indexOf("const retry = attach", spawnAt)
    expect(retryAt).toBeGreaterThan(spawnAt)
    expect(view).toContain("if (retry?.alive)")
  })

  it("keeps buffering across the spawn so a lost race cannot double-print", () => {
    // If the buffer were released before the spawn, output from the PTY the
    // OTHER window just started would be written live — and the retry snapshot
    // would then replay that same span, out of order and with the control
    // sequences duplicated. So the release happens on the spawn's RESULT: all
    // of it when the spawn succeeded (nothing else can have written to that
    // id), deduped against the snapshot when it lost the race.
    const view = read(VIEW)
    const snapshotAt = view.indexOf("terminalSnapshot(terminalId)")
    const spawnAt = view.indexOf("terminalSpawn(", snapshotAt)
    const firstFlushAt = view.indexOf("flushReplay(", snapshotAt)
    expect(firstFlushAt).toBeGreaterThan(spawnAt)
  })

  it("holds a PERMANENT seq floor, because the buffer is not a gate", () => {
    // The output events and the snapshot travel different channels (Tauri IPC
    // vs the invoke response; WebSocket vs fetch) with no ordering guarantee
    // between them, so a chunk the snapshot already contains can reach the
    // callback AFTER the buffer was released. A gate that only existed during
    // the handshake would let exactly that one through and print it twice.
    const view = read(VIEW)
    expect(view).toContain("let snapshotSeqFloor = 0")
    expect(view).toContain("if (seq > 0 && seq <= snapshotSeqFloor) return")
    // Raised by snapshots only: live events are ordered and delivered once, so
    // raising the floor on them could only ever swallow output.
    expect(view.match(/snapshotSeqFloor = snapshotSeq/g)?.length ?? 0).toBe(1)
  })

  it("reaps the shell where the delete is authoritative — on the backend", () => {
    // Two things had to be ruled out, and both cost a running command when they
    // are wrong:
    //   · inferring the delete from the row disappearing out of the store —
    //     `applyResponse` writes an optimistic node WITHOUT advancing
    //     `lastRevision`, so a same-revision snapshot refetch (reconnect, gap
    //     repair) legitimately rolls it back, and nothing observable at that
    //     moment tells a rollback from a delete;
    //   · killing from the client after its own successful delete — that is a
    //     second, unretried request, and whenever THAT one is lost the process
    //     keeps running with no card left to reach it from.
    // So the kill rides the deletion itself, inside the command that committed
    // it. The canvas view holds no reaping machinery at all.
    const canvas = read(CANVAS_VIEW)
    for (const gone of [
      "terminalKill",
      "killTerminals",
      "reapCandidatesRef",
      "knownTerminalsRef",
    ]) {
      expect(canvas).not.toContain(gone)
    }
    const command = read("src-tauri/src/commands/canvas.rs")
    expect(command).toContain("fn kill_canvas_terminals(")
    // Both delete commands, and the batch only for what it really deleted.
    expect(command).toContain("kill_canvas_terminals(terminals, &[node_id])")
    expect(command).toContain("kill_canvas_terminals(terminals, &deleted_ids)")
  })

  it("spells the PTY id identically on both sides", () => {
    // The card spawns under `canvas-term-<rowId>` and the delete command kills
    // that exact name. A drift in either spelling is invisible until someone
    // deletes a card and the shell keeps running with nothing left to reach it.
    expect(read("src/components/canvas/canvas-model.ts")).toContain(
      "`canvas-term-${dbId}`"
    )
    expect(read("src-tauri/src/commands/canvas.rs")).toContain(
      'format!("canvas-term-{node_id}")'
    )
  })

  it("asks before a delete ends a running shell", () => {
    // Same rule the board applies to a written note: ask only when the delete
    // destroys something that lives nowhere else, and a half-finished command
    // qualifies.
    const canvas = read(CANVAS_VIEW)
    expect(canvas).toContain("terminalsAtRisk")
    expect(canvas).toContain('rows.get(id)?.kind === "terminal"')
  })
})
