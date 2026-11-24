/**
 * Parsing helper for the codeg-mcp `check_user_feedback` tool result, shared by
 * the timeline's feedback-check row and the adapter pass that hides no-op
 * checks (`dropHiddenFeedbackChecks`).
 *
 * The tool polls for live-steering notes the user sent mid-turn. Its result is
 * persisted differently per host:
 *   - Codex wraps it in an exec-style envelope:
 *       "Wall time: 0.0029 seconds\nOutput:\n{json}"
 *   - Other CLIs may persist the bare structured JSON, the full MCP result
 *     ({ content, structuredContent }), or just the human-readable text.
 *
 * The structured shape is:
 *   { "count": 1, "feedback": [{ "created_at": "…ISO…", "text": "…" }] }
 * `count: 0` / `feedback: []` means "no new feedback". We key visibility off the
 * `feedback` array (the texts to show), not `count`, so a truncated transcript
 * that kept only the count still resolves to "nothing to render".
 */

export interface FeedbackEntry {
  /** ISO 8601 send time, or null when only the human-readable text survived. */
  createdAt: string | null
  text: string
}

export interface FeedbackCheckOutcome {
  /** The received notes. Empty means the check found no new feedback. */
  entries: FeedbackEntry[]
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function tryParseObject(text: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(text))
  } catch {
    return null
  }
}

/**
 * Pull a JSON object out of `text`, tolerant of a leading non-JSON envelope
 * (Codex's "Wall time:/Output:" header). Tries a direct parse first, then falls
 * back to the first `{` … last `}` slice — the feedback payload is the only JSON
 * object the tool ever emits, so the outer braces bound it cleanly.
 */
function extractJsonObject(text: string): Record<string, unknown> | null {
  const direct = tryParseObject(text)
  if (direct) return direct
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start >= 0 && end > start) {
    return tryParseObject(text.slice(start, end + 1))
  }
  return null
}

function parseEntries(raw: unknown): FeedbackEntry[] {
  if (!Array.isArray(raw)) return []
  const out: FeedbackEntry[] = []
  for (const item of raw) {
    const obj = asRecord(item)
    if (!obj) continue
    const text = typeof obj.text === "string" ? obj.text : ""
    // A note with no text carries nothing to display; drop it.
    if (!text.trim()) continue
    const createdAt =
      typeof obj.created_at === "string"
        ? obj.created_at
        : typeof obj.createdAt === "string"
          ? obj.createdAt
          : null
    out.push({ createdAt, text })
  }
  return out
}

const NUMBERED_LINE_RE = /^\s*\d+\.\s+(.+?)\s*$/gm

/**
 * Reconstruct the feedback-check outcome from the persisted tool result.
 *
 * Returns `null` when there is no result yet (the call is still in flight) or
 * the text is unrecognizable — callers treat that the same as "no feedback to
 * show". A successful parse with `entries: []` is the explicit "no new feedback"
 * case, distinct from `null` only in that we know the check actually ran.
 */
export function parseFeedbackCheckOutcome(
  output: string | null | undefined
): FeedbackCheckOutcome | null {
  if (!output || !output.trim()) return null

  // Primary: the structured `{ count, feedback }` envelope, possibly nested
  // under `structuredContent` (full MCP result) and possibly preceded by the
  // Codex exec wrapper.
  const obj = extractJsonObject(output)
  if (obj) {
    const env =
      Array.isArray(obj.feedback) || typeof obj.count === "number"
        ? obj
        : asRecord(obj.structuredContent)
    if (env) {
      if (Array.isArray(env.feedback)) {
        return { entries: parseEntries(env.feedback) }
      }
      // Count present without the array (truncated payload): nothing to show.
      if (typeof env.count === "number") return { entries: [] }
    }
  }

  // Fallback: the companion's human-readable text, for any CLI that keeps
  // `content` instead of `structuredContent`.
  //   "No new feedback from the user. Continue with your current plan."
  //   "The user sent N message(s) … \n1. <text>\n2. <text>\n"
  if (/no new feedback/i.test(output)) return { entries: [] }
  if (/the user sent\b/i.test(output)) {
    const entries = [...output.matchAll(NUMBERED_LINE_RE)].map((m) => ({
      createdAt: null,
      text: m[1],
    }))
    if (entries.length > 0) return { entries }
  }

  return null
}

/**
 * Whether a `check_user_feedback` result should surface a capsule at all. True
 * only when the check actually received notes — the no-feedback / in-flight /
 * unparseable cases stay hidden so routine polls don't clutter the transcript.
 */
export function feedbackCheckHasContent(
  output: string | null | undefined
): boolean {
  const outcome = parseFeedbackCheckOutcome(output)
  return !!outcome && outcome.entries.length > 0
}
