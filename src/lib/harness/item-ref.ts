/**
 * A Harness item's address: `publisher/name`.
 *
 * The same two patterns the backend checks before it asks the catalog
 * anything. Checked here as well so that an address that cannot exist — a
 * link someone mangled, a search box's contents taken for one — is answered
 * on the spot, in words, without a round trip.
 */
const PUBLISHER = /^[a-z0-9][a-z0-9.-]{0,252}$/
const NAME = /^[a-z0-9-]{1,64}$/

export interface HarnessItemRef {
  /** `publisher/name`, as the commands take it. */
  ref: string
  publisher: string
  name: string
}

/**
 * The address `input` spells, or `null` when it spells none.
 *
 * Surrounding space and letter case are forgiven: addresses are lower-case,
 * and one copied out of a sentence or typed with a capital still means the
 * same item. Nothing else is repaired.
 */
export function parseItemRef(input: unknown): HarnessItemRef | null {
  if (typeof input !== "string") return null
  const text = input.trim().toLowerCase()
  const slash = text.indexOf("/")
  if (slash < 0) return null
  const publisher = text.slice(0, slash)
  const name = text.slice(slash + 1)
  if (!PUBLISHER.test(publisher) || !NAME.test(name)) return null
  return { ref: `${publisher}/${name}`, publisher, name }
}

/** Whether `ref` is already an address in the form the commands take. */
export function isItemRef(ref: unknown): ref is string {
  return typeof ref === "string" && parseItemRef(ref)?.ref === ref
}

/** One file of a package is addressed by its SHA-256, in the one spelling
 *  `harness_blob` takes: 64 lower-case hex digits. */
const FILE_HASH = /^[0-9a-f]{64}$/

export function isFileHash(value: unknown): value is string {
  return typeof value === "string" && FILE_HASH.test(value)
}
