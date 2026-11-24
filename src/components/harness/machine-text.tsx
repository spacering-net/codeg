import { Fragment, type ReactNode } from "react"

/**
 * Where machine text — an address, a path, a package, a key, a command line —
 * may be broken between lines.
 *
 * - `"parts"`: after `/`, `:`, `@`, `.`, `-` and `=`, between the parts it is
 *   made of: `pypi:browser-use@` / `0.13.11`, `X-Browser-Use-API-` / `Key`.
 * - `"path"`: after `/` alone, and nowhere a browser would break by itself
 *   (after a hyphen, a question mark): an address that reads as its path,
 *   `github.com/browser-use/` / `browser-use`, never `github.com/browser-` /
 *   `use/browser-use`.
 *
 * Either way a part still longer than its line — a 64-character key with no
 * punctuation at all — is broken wherever it has to be: `MachineText` sets
 * `overflow-wrap: anywhere` on the text itself, so no box it is put in can
 * forget to. (Not `word-break: break-all`, which would make every character
 * a place to break and the places chosen here no better than any other.)
 */
export type MachineTextBreaks = "parts" | "path"

/** A run of the text, and what follows it: a place to break, a place not to,
 *  or nothing (the text's natural flow, or its end). */
export interface MachineTextPiece {
  text: string
  after: "break" | "hold" | null
}

const PART_ENDS = new Set(["/", ":", "@", ".", "-", "="])
/** Between two digits these are inside a number — `0.13.11`, `2026-11-15` —
 *  and not between two parts. */
const NUMBER_JOINS = new Set([".", "-"])

const isSpace = (char: string) => /\s/.test(char)
const isDigit = (char: string | undefined) =>
  char !== undefined && char >= "0" && char <= "9"
/** A letter, a digit, `_`: what a part is made of rather than ends with. */
const isWordChar = (char: string) => /[\p{L}\p{N}_]/u.test(char)

/**
 * The places to break `text` at, as runs of it. Splits the text and nothing
 * else: the runs, joined, are `text` exactly.
 *
 * A break goes after a run of the same character (`//`, `--`), not inside
 * it, and not after `://`; never after punctuation that opens a part (the `@`
 * of `@scope/name`, the `-` of `-y`, the `.` of `.claude`), which would leave
 * it alone at the end of a line.
 */
export function machineTextPieces(
  text: string,
  breaks: MachineTextBreaks = "parts"
): MachineTextPiece[] {
  const pieces: MachineTextPiece[] = []
  let start = 0
  // Whether the part since the last break has more than punctuation in it.
  let worded = false
  const cut = (end: number, after: "break" | "hold") => {
    pieces.push({ text: text.slice(start, end), after })
    start = end
  }

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    const next = text[index + 1]
    if (isSpace(char)) {
      worded = false
      continue
    }
    const breakable = breaks === "path" ? char === "/" : PART_ENDS.has(char)
    if (!breakable) {
      if (isWordChar(char)) worded = true
      // In a path, the browser's own places to break — after a hyphen, a
      // question mark — are held, so that the slashes are the only ones.
      else if (
        breaks === "path" &&
        next !== undefined &&
        next !== "/" &&
        !isSpace(next)
      ) {
        cut(index + 1, "hold")
      }
      continue
    }
    if (next === undefined || isSpace(next)) continue
    if (next === char || (char === ":" && next === "/")) continue
    if (!worded) continue
    if (NUMBER_JOINS.has(char) && isDigit(text[index - 1]) && isDigit(next)) {
      continue
    }
    cut(index + 1, "break")
    worded = false
  }
  if (start < text.length) pieces.push({ text: text.slice(start), after: null })
  return pieces
}

/** Strings and numbers as one text; anything else (an element) as `null`. */
function textOf(children: ReactNode): string | null {
  if (typeof children === "string") return children
  if (typeof children === "number") return String(children)
  if (Array.isArray(children)) {
    let joined = ""
    for (const child of children) {
      const text = textOf(child as ReactNode)
      if (text === null) return null
      joined += text
    }
    return joined
  }
  return null
}

/**
 * The text's own box: anywhere is a place to break once the line has no
 * better one, and — should it be laid out as a flex or grid item — nothing
 * keeps it wider than what it is in.
 */
const MACHINE_TEXT_CLASS = "min-w-0 [overflow-wrap:anywhere]"

/**
 * Machine text, broken between its parts when it does not fit its line (see
 * {@link MachineTextBreaks}), and anywhere when a part does not fit either.
 * The places are marked with empty elements whose `wrap-point` / `wrap-hold`
 * styles (globals.css) generate the character that allows or forbids a
 * break; generated text is neither copied nor, with its empty alternative,
 * read out — so what is selected, copied, searched for and spoken is the
 * value as it is. (A `<wbr>` would do the first job, but Chrome names a link
 * or a button containing one with a space in its place.)
 *
 * Its children are the text: a string, or the chunks of a rich message.
 * Anything with an element in it is rendered as it is, breaking anywhere.
 */
export function MachineText({
  children,
  breaks = "parts",
}: {
  children: ReactNode
  breaks?: MachineTextBreaks
}) {
  const text = textOf(children)
  if (text === null) {
    return <span className={MACHINE_TEXT_CLASS}>{children}</span>
  }
  return (
    <span className={MACHINE_TEXT_CLASS}>
      {machineTextPieces(text, breaks).map((piece, index) => (
        <Fragment key={index}>
          {piece.text}
          {piece.after === "break" && <span className="wrap-point" />}
          {piece.after === "hold" && <span className="wrap-hold" />}
        </Fragment>
      ))}
    </span>
  )
}
