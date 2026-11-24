/** The output tab's sorting out, apart from how it is drawn: how a piece of
 *  ended work came out, what a day holds — its documents gathered by the
 *  folder they are in — and which documents are pictures. */

import type { DispatchInfo, PersonalAgentOutputDoc } from "@/lib/types"

/** How a piece of ended work came out, for the tasks' summary: done (merged
 *  or finished), failed, closed without being done, or still open — ready
 *  to merge, a pull request waiting — for the owner to see to. */
export type Outcome = "done" | "failed" | "closed" | "open"

export const OUTCOMES: readonly Outcome[] = ["done", "failed", "closed", "open"]

export function outcomeOf(d: DispatchInfo): Outcome {
  switch (d.ladder) {
    case "merged":
    case "done":
      return "done"
    case "failed":
    case "checks_failed":
      return "failed"
    case "canceled":
    case "pr_closed":
    case "handed_over":
      return "closed"
  }
  if (d.state === "failed") return "failed"
  if (
    d.state === "canceled" ||
    d.state === "interrupted" ||
    d.state === "handed_over"
  )
    return "closed"
  return "open"
}

/** How many came out each way. */
export function outcomeCounts(list: DispatchInfo[]): Record<Outcome, number> {
  const counts: Record<Outcome, number> = {
    done: 0,
    failed: 0,
    closed: 0,
    open: 0,
  }
  for (const d of list) counts[outcomeOf(d)] += 1
  return counts
}

/** The picture formats a thumbnail is drawn for. */
const IMAGE_EXT: ReadonlySet<string> = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
  "bmp",
  "ico",
])

export function isImage(path: string): boolean {
  const name = baseName(path)
  const dot = name.lastIndexOf(".")
  return dot > 0 && IMAGE_EXT.has(name.slice(dot + 1).toLowerCase())
}

/** A path's last name. */
export function baseName(path: string): string {
  const cut = path.search(/[^\\/]+$/)
  return cut > 0 ? path.slice(cut) : path
}

/** The folder a document is in, under the working directory: its first
 *  name — "" at the top. */
export function topFolder(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.length > 1 ? parts[0] : ""
}

/** One thing a day shows. */
export type DayEntry<D> =
  | { kind: "dispatch"; key: string; at: string; dispatch: D }
  | { kind: "doc"; key: string; at: string; doc: PersonalAgentOutputDoc }
  | {
      kind: "folder"
      key: string
      at: string
      folder: string
      docs: PersonalAgentOutputDoc[]
    }

/** A day's things, newest first as given: its documents in a folder
 *  gathered into that folder where it holds two or more of them, at the
 *  place of its newest; one alone, or one at the top, as itself. */
export function gatherDay<D>(
  entries: (
    | { kind: "dispatch"; key: string; at: string; dispatch: D }
    | { kind: "doc"; key: string; at: string; doc: PersonalAgentOutputDoc }
  )[]
): DayEntry<D>[] {
  const byFolder = new Map<string, PersonalAgentOutputDoc[]>()
  for (const e of entries) {
    if (e.kind !== "doc") continue
    const f = topFolder(e.doc.path)
    if (!f) continue
    const list = byFolder.get(f)
    if (list) list.push(e.doc)
    else byFolder.set(f, [e.doc])
  }
  const out: DayEntry<D>[] = []
  const placed = new Set<string>()
  for (const e of entries) {
    if (e.kind === "doc") {
      const f = topFolder(e.doc.path)
      const docs = f ? byFolder.get(f) : undefined
      if (docs && docs.length > 1) {
        if (placed.has(f)) continue
        placed.add(f)
        out.push({ kind: "folder", key: `dir:${f}`, at: e.at, folder: f, docs })
        continue
      }
    }
    out.push(e)
  }
  return out
}
