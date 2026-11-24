/**
 * "Is this right?" (10.3): what the page keys a checked message by — the
 * same fingerprint the backend keys its checks by (`fact_check::fingerprint`
 * in src-tauri), so a message is marked with its checks without asking.
 *
 * FNV-1a 64 over the UTF-8 of the normalized text, as 16 hex digits. In two
 * 32-bit halves rather than a BigInt: a long reply is fingerprinted byte by
 * byte, and needs no secure context (`crypto.subtle` is not there on a
 * server reached over plain http).
 */

/** A message as it is fingerprinted: Windows line ends as `\n`, no blank
 *  edges (ASCII whitespace only, as the backend trims). */
export function normalizeCheckText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, "")
}

const encoder = new TextEncoder()

/** Fingerprints computed, by text: a transcript re-renders often. */
const memo = new Map<string, string>()
const MEMO_MAX = 500

export function messageFingerprint(text: string): string {
  const held = memo.get(text)
  if (held !== undefined) return held
  const bytes = encoder.encode(normalizeCheckText(text))
  // The offset basis, 0xcbf29ce484222325.
  let hi = 0xcbf29ce4
  let lo = 0x84222325
  for (let i = 0; i < bytes.length; i++) {
    lo = (lo ^ bytes[i]) >>> 0
    // × 0x100000001b3 = × 0x1b3 + × 2^40, modulo 2^64.
    const low = lo * 0x1b3
    const carry = Math.floor(low / 0x100000000)
    const nextHi = (hi * 0x1b3 + carry + ((lo << 8) >>> 0)) >>> 0
    lo = low >>> 0
    hi = nextHi
  }
  const fp = hi.toString(16).padStart(8, "0") + lo.toString(16).padStart(8, "0")
  if (memo.size >= MEMO_MAX) memo.clear()
  memo.set(text, fp)
  return fp
}
