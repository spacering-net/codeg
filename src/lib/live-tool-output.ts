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

function mayBeStructuredOutput(chunks: readonly string[]): boolean {
  for (const chunk of chunks) {
    const first = chunk.trimStart()[0]
    if (first) return first === "{" || first === "["
  }
  return false
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
  // Copy only the bounded tail: substring implementations can share the
  // backing storage of a much larger input. The temporary array is bounded
  // by the preview budget as well.
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
