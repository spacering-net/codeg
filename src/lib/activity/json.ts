/**
 * Lenient readers for tool-call payloads. Agents hand tool input and output
 * over as strings that are usually JSON, sometimes truncated JSON, and
 * occasionally plain text, with the interesting field buried one or two
 * envelopes deep (`{input: {...}}`, `{arguments: "..."}`). These helpers pull
 * a value out of whatever arrived without throwing on any of those shapes.
 */

/** Try JSON.parse; return null on failure or when the value is not an object. */
export function tryParseJson(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s)
    return typeof v === "object" && v !== null && !Array.isArray(v) ? v : null
  } catch {
    return null
  }
}

/** Regex-extract a JSON string value for a given key (works on truncated JSON). */
export function extractJsonField(input: string, key: string): string | null {
  const re = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`)
  const m = input.match(re)
  return m?.[1]?.replace(/\\"/g, '"').replace(/\\\\/g, "\\") ?? null
}

export function asObjectLike(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed.startsWith("{")) return null
  return tryParseJson(trimmed)
}

const NESTED_PAYLOAD_KEYS = ["input", "arguments", "params", "payload"]

export function findStringFieldDeep(
  value: unknown,
  key: string,
  depth: number = 0
): string | null {
  if (depth > 4) return null
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringFieldDeep(item, key, depth + 1)
      if (found) return found
    }
    return null
  }
  const obj = asObjectLike(value)
  if (!obj) return null

  const direct = obj[key]
  if (typeof direct === "string" && direct.trim().length > 0) {
    return direct
  }

  for (const nestedKey of NESTED_PAYLOAD_KEYS) {
    const found = findStringFieldDeep(obj[nestedKey], key, depth + 1)
    if (found) return found
  }

  for (const nestedValue of Object.values(obj)) {
    const found = findStringFieldDeep(nestedValue, key, depth + 1)
    if (found) return found
  }

  return null
}

export function findObjectFieldDeep(
  value: unknown,
  key: string,
  depth: number = 0
): Record<string, unknown> | null {
  if (depth > 4) return null
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findObjectFieldDeep(item, key, depth + 1)
      if (found) return found
    }
    return null
  }
  const obj = asObjectLike(value)
  if (!obj) return null

  const direct = asObjectLike(obj[key])
  if (direct) return direct

  for (const nestedKey of NESTED_PAYLOAD_KEYS) {
    const found = findObjectFieldDeep(obj[nestedKey], key, depth + 1)
    if (found) return found
  }

  for (const nestedValue of Object.values(obj)) {
    const found = findObjectFieldDeep(nestedValue, key, depth + 1)
    if (found) return found
  }

  return null
}

export function decodeJsonEscapedString(value: string): string {
  return value.replace(/\\"/g, '"').replace(/\\\//g, "/").replace(/\\\\/g, "\\")
}

/** Get string field from parsed object */
export function str(
  obj: Record<string, unknown>,
  key: string
): string | undefined {
  const v = obj[key]
  return typeof v === "string" ? v : undefined
}

/** Get number field from parsed object */
export function num(
  obj: Record<string, unknown>,
  key: string
): number | undefined {
  const v = obj[key]
  return typeof v === "number" ? v : undefined
}

export function isLikelyIdField(key: string): boolean {
  const lower = key.toLowerCase()
  return (
    lower === "id" ||
    lower === "uuid" ||
    lower === "callid" ||
    lower === "call_id" ||
    lower === "tool_call_id" ||
    lower.endsWith("_id") ||
    lower.endsWith("id")
  )
}
