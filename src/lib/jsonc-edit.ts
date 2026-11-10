/**
 * Read and edit JSON-with-comments documents without losing what the user
 * wrote.
 *
 * OpenCode 2 reads `opencode.json` and `opencode.jsonc` as JSONC (comments and
 * trailing commas allowed) and edits them itself with `jsonc-parser`'s
 * `modify` / `applyEdits`, which change one value in place and leave every
 * other byte alone. codeg's settings editors work the same way: a structured
 * change is computed on a plain object, then written back as the smallest set
 * of `modify` edits, so comments, key order and formatting outside the changed
 * keys survive.
 */

import {
  applyEdits,
  modify,
  parse,
  printParseErrorCode,
  type FormattingOptions,
  type ParseError,
} from "jsonc-parser"

export type JsonObject = Record<string, unknown>

/** Parse options matching OpenCode's reader: comments and trailing commas. */
const PARSE_OPTIONS = {
  allowTrailingComma: true,
  disallowComments: false,
  allowEmptyContent: true,
} as const

export interface JsoncParseResult {
  /** The parsed root, `{}` for empty text; `null` when the text is invalid. */
  value: JsonObject | null
  /** What is wrong with the text, or `null` when it parses. */
  error: string | null
}

function isPlainObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** Parse `text` as a JSONC object. Empty text is the empty object. */
export function parseJsoncObject(text: string): JsoncParseResult {
  const body = stripBom(text)
  if (!body.trim()) return { value: {}, error: null }
  const errors: ParseError[] = []
  const value = parse(body, errors, PARSE_OPTIONS) as unknown
  if (errors.length > 0) {
    const first = errors[0]
    return {
      value: null,
      error: `${printParseErrorCode(first.error)} at offset ${first.offset}`,
    }
  }
  if (!isPlainObject(value)) {
    return { value: null, error: "the root must be a JSON object" }
  }
  return { value, error: null }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
      return false
    return a.every((item, index) => deepEqual(item, b[index]))
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a)
    if (keys.length !== Object.keys(b).length) return false
    return keys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(b, key) &&
        deepEqual(a[key], b[key])
    )
  }
  return false
}

/** The indentation the document already uses, for values codeg inserts. */
function formattingFor(text: string): FormattingOptions {
  const indented = /\n([ \t]+)\S/.exec(text)
  const indent = indented?.[1] ?? "  "
  const eol = text.includes("\r\n") ? "\r\n" : "\n"
  return indent.startsWith("\t")
    ? { insertSpaces: false, tabSize: 1, eol }
    : { insertSpaces: true, tabSize: indent.length || 2, eol }
}

type Segment = string

/** Every `[path, value | undefined]` that turns `before` into `after`. */
function diff(
  before: JsonObject,
  after: JsonObject,
  path: Segment[],
  out: Array<[Segment[], unknown]>
): void {
  for (const key of Object.keys(before)) {
    if (!Object.prototype.hasOwnProperty.call(after, key))
      out.push([[...path, key], undefined])
  }
  for (const key of Object.keys(after)) {
    const next = after[key]
    const prev = Object.prototype.hasOwnProperty.call(before, key)
      ? before[key]
      : undefined
    if (prev !== undefined && deepEqual(prev, next)) continue
    if (isPlainObject(prev) && isPlainObject(next)) {
      diff(prev, next, [...path, key], out)
    } else {
      out.push([[...path, key], next])
    }
  }
}

export class JsoncEditError extends Error {}

/**
 * Apply `mutate` to a copy of the object `text` holds and write back only what
 * changed. Throws {@link JsoncEditError} when `text` is not a JSONC object:
 * a structured editor must never replace a document it cannot read.
 */
export function patchJsoncText(
  text: string,
  mutate: (draft: JsonObject) => void
): string {
  const parsed = parseJsoncObject(text)
  if (!parsed.value) {
    throw new JsoncEditError(parsed.error ?? "invalid JSON")
  }
  const before = parsed.value
  const after = structuredClone(before)
  mutate(after)
  const changes: Array<[Segment[], unknown]> = []
  diff(before, after, [], changes)
  if (changes.length === 0) return text

  let out = stripBom(text)
  if (!out.trim()) out = "{}"
  const formattingOptions = formattingFor(out)
  for (const [path, value] of changes) {
    const edits = modify(out, path, value, { formattingOptions })
    out = applyEdits(out, edits)
  }
  return out.endsWith("\n") ? out : `${out}\n`
}
