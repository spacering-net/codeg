/**
 * Retained plain-text output per live tool call, measured in UTF-16 code units
 * (the same unit as String.length). Structured tool results are consumed by
 * cards as JSON and must not be cut into an invalid suffix.
 */
export const MAX_LIVE_TOOL_RAW_OUTPUT_CHARS = 200_000
const MAX_OUTPUT_CHUNKS = 128

export interface LiveToolRawOutput {
  raw_output_chunks: string[]
  raw_output_total_bytes: number
}

/** How much of the head is checked before an output counts as structured. */
const STRUCTURED_PROBE_CHARS = 1024

function isJsonWhitespace(c: string): boolean {
  return c === " " || c === "\n" || c === "\r" || c === "\t"
}

/**
 * Whether `head` (starting at its first non-whitespace character) is a valid
 * prefix of a JSON object or array. A bracket alone is not enough: plain
 * terminal streams routinely open with one (`[+] Building`, `[1/200]`,
 * `[INFO]`, `{{ … }}`), and exempting those would leave them unbounded. A
 * probe that runs out mid-token counts as a prefix, so a structured result
 * still arriving across append frames stays a candidate.
 */
function isJsonContainerPrefix(head: string): boolean {
  if (head[0] !== "{" && head[0] !== "[") return false
  const stack: string[] = []
  type Expect =
    | "value"
    | "valueOrClose"
    | "key"
    | "keyOrClose"
    | "colon"
    | "commaOrClose"
    | "end"
  let expect = "value" as Expect
  const afterValue = (): Expect => (stack.length === 0 ? "end" : "commaOrClose")
  let i = 0
  while (i < head.length) {
    const c = head[i]
    if (isJsonWhitespace(c)) {
      i += 1
      continue
    }
    if (expect === "end") return false
    if (expect === "colon") {
      if (c !== ":") return false
      expect = "value"
      i += 1
      continue
    }
    if (expect === "commaOrClose") {
      const top = stack[stack.length - 1]
      if (c === ",") expect = top === "{" ? "key" : "value"
      else if ((c === "}" && top === "{") || (c === "]" && top === "[")) {
        stack.pop()
        expect = afterValue()
      } else return false
      i += 1
      continue
    }
    if (c === '"') {
      let j = i + 1
      while (j < head.length && head[j] !== '"') {
        if (head.charCodeAt(j) < 0x20) return false
        j += head[j] === "\\" ? 2 : 1
      }
      if (j >= head.length) return true
      i = j + 1
      expect =
        expect === "key" || expect === "keyOrClose" ? "colon" : afterValue()
      continue
    }
    if (expect === "keyOrClose" && c === "}") {
      stack.pop()
      expect = afterValue()
      i += 1
      continue
    }
    if (expect === "key" || expect === "keyOrClose") return false
    if (expect === "valueOrClose" && c === "]") {
      stack.pop()
      expect = afterValue()
      i += 1
      continue
    }
    if (c === "{" || c === "[") {
      stack.push(c)
      expect = c === "{" ? "keyOrClose" : "valueOrClose"
      i += 1
      continue
    }
    if (c === "-" || (c >= "0" && c <= "9")) {
      const number = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y
      number.lastIndex = i
      const match = number.exec(head)
      // A number cut off by the probe window (`-`, `1.`, `1e`) is a prefix.
      if (!match || match[0].length === 0) return /^-?$/.test(head.slice(i))
      i += match[0].length
      if (i >= head.length) return true
      if (/[.eE+\-\d]/.test(head[i])) {
        return /^[.eE+\-\d]+$/.test(head.slice(i))
      }
      expect = afterValue()
      continue
    }
    const literal = ["true", "false", "null"].find((word) => word[0] === c)
    if (!literal) return false
    const rest = head.slice(i, i + literal.length)
    if (!literal.startsWith(rest)) return false
    if (rest.length < literal.length) return true
    i += literal.length
    expect = afterValue()
  }
  return true
}

function mayBeStructuredOutput(chunks: readonly string[]): boolean {
  let head = ""
  for (const chunk of chunks) {
    let from = 0
    if (!head) {
      from = chunk.search(/\S/)
      if (from === -1) continue
    }
    head += chunk.slice(from, from + STRUCTURED_PROBE_CHARS - head.length)
    if (head.length >= STRUCTURED_PROBE_CHARS) break
  }
  return head.length > 0 && isJsonContainerPrefix(head)
}

function copyTail(value: string, budget: number): string {
  let start = value.length - budget
  // A tail must not start halfway through a surrogate pair.
  const unit = value.charCodeAt(start)
  if (
    start > 0 &&
    unit >= 0xdc00 &&
    unit <= 0xdfff &&
    value.charCodeAt(start - 1) >= 0xd800 &&
    value.charCodeAt(start - 1) <= 0xdbff
  ) {
    start += 1
  }
  const tail = value.slice(start)
  // Substring implementations can share the backing storage of the input, so
  // a tail cut from a much larger frame is copied. Shaving the oldest chunk
  // of a stream that sits at the budget discards little, and copying ~budget
  // characters on every such frame would cost milliseconds per append; the
  // shared storage there stays within twice the budget.
  if (start <= budget) return tail
  return tail.length === 1
    ? String.fromCharCode(tail.charCodeAt(0))
    : tail.split("").join("")
}

function boundChunks(chunks: string[], total: number): LiveToolRawOutput {
  // A JSON object/array can arrive across append frames. Preserve candidates
  // even while incomplete; testing JSON.parse on each partial frame would
  // truncate a large result before its closing bracket arrives.
  if (
    total > MAX_LIVE_TOOL_RAW_OUTPUT_CHARS &&
    !mayBeStructuredOutput(chunks)
  ) {
    const kept: string[] = []
    let room = MAX_LIVE_TOOL_RAW_OUTPUT_CHARS
    for (let i = chunks.length - 1; i >= 0 && room > 0; i -= 1) {
      const chunk = chunks[i]
      if (!chunk) continue
      const tail = chunk.length > room ? copyTail(chunk, room) : chunk
      kept.push(tail)
      room -= tail.length
      if (chunk.length > tail.length) break
    }
    chunks = kept.reverse()
    total = MAX_LIVE_TOOL_RAW_OUTPUT_CHARS - room
  }
  // Byte/character limits alone do not bound the chunk array: tiny or empty
  // append frames can otherwise accumulate for an entire long-running call.
  if (chunks.length > MAX_OUTPUT_CHUNKS) chunks = [chunks.join("")]
  return {
    raw_output_chunks: chunks,
    raw_output_total_bytes: total,
  }
}

/** Opening frames, replacements and snapshot hydration share one policy. */
export function replaceLiveToolRawOutput(
  output: string | null
): LiveToolRawOutput {
  return output === null
    ? { raw_output_chunks: [], raw_output_total_bytes: 0 }
    : boundChunks([output], output.length)
}

/** A null update is absent; an empty update still establishes output precedence. */
export function appendLiveToolRawOutput(
  previous: LiveToolRawOutput,
  output: string | null
): LiveToolRawOutput {
  if (
    output === null ||
    (output === "" && previous.raw_output_chunks.length > 0)
  ) {
    return {
      raw_output_chunks: previous.raw_output_chunks,
      raw_output_total_bytes: previous.raw_output_total_bytes,
    }
  }
  return boundChunks(
    [...previous.raw_output_chunks, output],
    previous.raw_output_total_bytes + output.length
  )
}
