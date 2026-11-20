import type { LogRecord } from "@/lib/types"

/** Keep the newest records while a live-tail animation frame is pending. */
export class PendingLogBatch {
  private records: LogRecord[] = []
  private nextIndex = 0

  constructor(private readonly limit: number) {}

  append(record: LogRecord) {
    const newestIndex =
      this.nextIndex === 0 ? this.records.length - 1 : this.nextIndex - 1
    const newest = this.records[newestIndex]
    if (newest && record.seq <= newest.seq) return false

    this.records[this.nextIndex] = record
    this.nextIndex = (this.nextIndex + 1) % this.limit
    return true
  }

  drain(): LogRecord[] {
    const { records, nextIndex } = this
    this.clear()
    if (nextIndex === 0 || nextIndex === records.length) return records
    return records.slice(nextIndex).concat(records.slice(0, nextIndex))
  }

  clear() {
    this.records = []
    this.nextIndex = 0
  }
}

/**
 * Fold a batch of newly-appended log records into the existing list, applying
 * the monotonic-seq de-dup guard and the display cap once for the whole batch.
 *
 * The backend assigns strictly increasing seqs and both the initial snapshot
 * and live events arrive in seq order, so any incoming record at or below the
 * newest seq already held is a duplicate (the snapshot/live overlap on mount)
 * and is dropped. When the list would exceed `limit`, the oldest records are
 * trimmed. Returns `prev` unchanged (same reference) when nothing new is added,
 * so callers can skip a re-render.
 */
export function applyLogBatch(
  prev: LogRecord[],
  batch: LogRecord[],
  limit: number
): LogRecord[] {
  if (batch.length === 0) return prev

  let lastSeq =
    prev.length > 0 ? prev[prev.length - 1].seq : Number.NEGATIVE_INFINITY
  const fresh: LogRecord[] = []
  for (const rec of batch) {
    if (rec.seq <= lastSeq) continue // duplicate / out-of-order → drop
    fresh.push(rec)
    lastSeq = rec.seq
  }
  if (fresh.length === 0) return prev

  let next = prev.length > 0 ? prev.concat(fresh) : fresh
  if (next.length > limit) {
    next = next.slice(next.length - limit)
  }
  return next
}
