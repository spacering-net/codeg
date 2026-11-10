/**
 * Parsing helpers shared by the live `AskQuestionCard` (interactive) and the
 * historical `AskQuestionResultCard` (read-only, in the message stream).
 *
 * The codeg-mcp `ask_user_question` tool serializes into a session transcript
 * as a generic tool call. The input is the raw `{ questions: [...] }` JSON the
 * agent sent. The output is the tool result the agent CLI persisted: in
 * practice that is the companion's structured `{ answers, declined }` envelope
 * (each answer's `selected` is already a string array — see `render_ask_result`
 * in `src-tauri/src/acp/delegation/companion.rs`), which is what we parse first.
 * We also fall back to the companion's human-readable result text for any CLI
 * that persists `content` instead of `structuredContent`.
 */

export interface AskQuestionOption {
  label: string
  description: string
}

export interface AskQuestion {
  question: string
  header: string
  /** The wire field is `multiSelect` (camelCase); we also accept `multi_select`. */
  multiSelect: boolean
  options: AskQuestionOption[]
  /** Codex `request_user_input` marks secret answers (API keys etc.) with
   *  `isSecret`; the read-only card masks them. */
  isSecret: boolean
  /** Codex `request_user_input` gives each question a stable `id`; its chosen
   *  answer envelope is keyed by that id rather than the question text (unlike
   *  the codeg-mcp ask, which the card matches by header+question). */
  id?: string
}

export interface AskQuestionAnswer {
  header: string
  question: string
  /** The user's raw picks: each entry is one offered option label or a free-text
   *  "Other" answer (empty when nothing was chosen). Partition against the
   *  question's options with `matchSelections`. */
  selected: string[]
  /** Present for codex `request_user_input`, whose answers are keyed by the
   *  question `id` rather than its header/question text; the card matches on it
   *  when set, otherwise on the header+question signature. */
  id?: string
}

export interface AskQuestionOutcome {
  declined: boolean
  answers: AskQuestionAnswer[]
}

/**
 * Strip a trailing " (Recommended)" so it can render as a badge while the
 * underlying value keeps the agent's original label verbatim. Shared so the
 * live and historical cards present recommendations identically.
 */
export function splitRecommended(label: string): {
  text: string
  recommended: boolean
} {
  const suffixMatch = label.match(/^(.*?)\s*\(recommended\)\s*$/i)
  if (suffixMatch && suffixMatch[1].trim()) {
    return { text: suffixMatch[1].trim(), recommended: true }
  }
  const prefixMatch = label.match(/^\s*\(recommended\)\s*(.*?)$/i)
  if (prefixMatch && prefixMatch[1].trim()) {
    return { text: prefixMatch[1].trim(), recommended: true }
  }
  return { text: label, recommended: false }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null
}

function parseOptions(raw: unknown): AskQuestionOption[] {
  if (!Array.isArray(raw)) return []
  const out: AskQuestionOption[] = []
  for (const item of raw) {
    if (typeof item === "string") {
      const label = item.trim()
      if (label) out.push({ label, description: "" })
      continue
    }
    if (!item || typeof item !== "object") continue
    const obj = item as Record<string, unknown>
    const label = asString(obj.label)
    // An option with no label carries no meaning to display; drop it.
    if (!label) continue
    out.push({ label, description: asString(obj.description) })
  }
  return out
}

/**
 * Parse the `ask_user_question` tool input (the raw `{ questions: [...] }` JSON
 * the agent sent). Tolerant of partial/streaming input and missing fields —
 * returns `[]` rather than throwing so callers can fall back gracefully.
 */
export function parseAskQuestionInput(
  input: string | null | undefined
): AskQuestion[] {
  if (!input) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== "object") return []
  const root = parsed as Record<string, unknown>
  // codex-acp 1.0.0 wraps every MCP call's input as
  // `{ server, tool, arguments: { questions } }` (see createMcpToolCallUpdate in
  // codex-acp/src/CodexToolCallMapper.ts). Fall back to the nested `arguments`
  // when the questions aren't at the top level (the bare shape Claude / the
  // history parser persist).
  let questions = root.questions
  if (!Array.isArray(questions)) {
    questions = asRecord(root.arguments)?.questions
  }
  if (!Array.isArray(questions)) return []

  const out: AskQuestion[] = []
  for (const item of questions) {
    if (!item || typeof item !== "object") continue
    const obj = item as Record<string, unknown>
    const options = parseOptions(obj.options)
    const question = asString(obj.question)
    // An entry with neither prompt text nor options is empty noise; skip it.
    if (!question && options.length === 0) continue
    out.push({
      question,
      header: asString(obj.header),
      multiSelect:
        obj.multiSelect === true ||
        obj.multi_select === true ||
        obj.is_multi_select === true ||
        obj.isMultiSelect === true,
      options,
      isSecret: obj.isSecret === true || obj.is_secret === true,
      id: typeof obj.id === "string" && obj.id ? obj.id : undefined,
    })
  }
  return out
}

/** The companion's marker for an answered-but-empty selection (English, not localized). */
const NO_SELECTION = "(no selection)"
const HEADER_LINE_RE = /^\s*\d+\.\s*\[([^\]]*)\]\s*(.*)$/
const SELECTED_LINE_RE = /^\s*→\s*(.*)$/

/**
 * codex persists an MCP tool result in its rollout transcript's
 * `function_call_output.output` as `Wall time: <n> seconds\nOutput:\n<body>`,
 * where `<body>` is the actual result (here the `{ answers, declined }` JSON).
 * Strip that wrapper so the body underneath is reachable. Anything without the
 * marker (the live ACP path, Claude, the bare companion shapes) is returned
 * unchanged.
 */
function stripCodexOutputWrapper(text: string): string {
  const match = text.match(/^Wall time:[^\n]*\r?\nOutput:\r?\n([\s\S]*)$/)
  return match ? match[1] : text
}

function parseAnswers(raw: unknown): AskQuestionAnswer[] {
  if (!Array.isArray(raw)) return []
  const out: AskQuestionAnswer[] = []
  for (const item of raw) {
    const obj = asRecord(item)
    if (!obj) continue
    const selected = Array.isArray(obj.selected)
      ? obj.selected.filter((x): x is string => typeof x === "string")
      : []
    out.push({
      header: asString(obj.header),
      question: asString(obj.question),
      selected,
    })
  }
  return out
}

/** codex's prefix for the free-form part of a `request_user_input` answer. */
const CODEX_NOTE_PREFIX = "user_note: "
/** The option codex adds to an `isOther` question for "my own answer". */
const CODEX_OTHER_OPTION = "None of the above"

/**
 * The Claude Code CLI's own AskUserQuestion (its `tool_result` text, which is
 * what a Claude Code transcript keeps) and qodercli's port of it (its
 * `llmContent`, which qoder's ACP `tool_call_update` also streams verbatim)
 * report the answers as plain sentences, not the companion's JSON envelope:
 *   answered: `Your questions have been answered: "Q1"="A1", "Q2"="A2". You can
 *     now continue with these answers in mind.`
 *   declined: `The user did not answer the questions.`
 * Only answered questions appear, in question order. A multi-select answer is
 * its labels joined with ", " (a typed "Other" answer replaces or joins them);
 * a question answered with notes alone reads `"Q"=(no option selected)`; and
 * any entry may trail a ` selected preview:\n…` block and/or ` notes: …`.
 * Nothing is escaped, so a question, an answer or a note may itself contain
 * `"`, ", " or even text shaped like another entry, and no reading is exact.
 * With the asked questions at hand each entry is found by its exact `"Q"=` key
 * (`parseAnchoredEntries`). Without them `ANSWER_PAIR_RE` takes the pairs that
 * open an entry: it cuts a value at its first inner quote, and a note that
 * types a whole `, "Q"="A"` still reads as an answer. The sentences carry no
 * header, so each answer keeps `header: ""` and the card matches it by
 * question text (`byQuestion`).
 */
const ANSWERED_SENTENCE_PREFIX = "Your questions have been answered: "
const DID_NOT_ANSWER_RE = /^The user did not answer the questions\.?$/
const ANSWER_PAIR_RE = /(?:^|, )"([^"]+)"="([^"]*)"/g
/** Joins the sentence's entries, and a multi-select answer's picks. */
const LIST_SEPARATOR = ", "
/** Where a quoted answer that trails a preview or notes block closes. */
const ANSWER_TAIL_MARKERS = ['" selected preview:\n', '" notes: ']
/** An entry's value when the user wrote notes but picked nothing. */
const NOTES_ONLY_VALUE = "(no option selected) notes: "

function parseAnsweredSentence(
  body: string,
  questions: readonly AskQuestion[] | undefined
): AskQuestionOutcome | null {
  const text = body.trim()
  if (!text.startsWith(ANSWERED_SENTENCE_PREFIX)) return null
  const entries = text.slice(ANSWERED_SENTENCE_PREFIX.length)
  const answers =
    (questions && parseAnchoredEntries(entries, questions)) ??
    parseQuotedPairs(entries)
  return { declined: false, answers }
}

/**
 * Read the entries by the asked questions' own text: each answered question
 * opens its entry with `"<question>"=`, so the entry runs from that key to the
 * next answered question's key. Returns `null` when no asked question is found
 * (an input that doesn't belong to this result), so the pair regex can try.
 */
function parseAnchoredEntries(
  entries: string,
  questions: readonly AskQuestion[]
): AskQuestionAnswer[] | null {
  const found: { question: AskQuestion; start: number; valueStart: number }[] =
    []
  let cursor = 0
  for (const question of questions) {
    if (!question.question) continue
    const key = `"${question.question}"=`
    let at = entries.indexOf(key, cursor)
    // The key anywhere but at the head of a well-formed entry is that text
    // inside an earlier answer, preview or note.
    while (at >= 0 && !opensEntry(entries, at, at + key.length)) {
      at = entries.indexOf(key, at + 1)
    }
    if (at < 0) continue
    found.push({ question, start: at, valueStart: at + key.length })
    cursor = at + key.length
  }
  if (found.length === 0) return null
  return found.map(({ question, valueStart }, i) => {
    const next = found[i + 1]
    const end = next ? next.start - LIST_SEPARATOR.length : entries.length
    const value = quotedAnswer(entries.slice(valueStart, end))
    return {
      header: "",
      question: question.question,
      selected: value ? splitJoinedPicks(value, question) : [],
    }
  })
}

/**
 * Whether the `"Q"=` key at `at` heads an entry: entries open the list or
 * follow ", ", and a value opens with its quote or is the notes-only marker
 * (which the CLI writes only before notes).
 */
function opensEntry(entries: string, at: number, valueStart: number): boolean {
  const afterSeparator =
    at === 0 || entries.startsWith(LIST_SEPARATOR, at - LIST_SEPARATOR.length)
  return (
    afterSeparator &&
    (entries.startsWith('"', valueStart) ||
      entries.startsWith(NOTES_ONLY_VALUE, valueStart))
  )
}

/** The answer of one entry, read from just after its `"Q"=` key. */
function quotedAnswer(entry: string): string {
  // `(no option selected)` — notes without a pick — names no answer.
  if (!entry.startsWith('"')) return ""
  const rest = entry.slice(1)
  let close = -1
  for (const marker of ANSWER_TAIL_MARKERS) {
    const at = rest.indexOf(marker)
    if (at >= 0 && (close < 0 || at < close)) close = at
  }
  // Untailed, the answer closes on the entry's last quote: the sentence's
  // closing ". You can now continue…" after the last entry holds none.
  if (close < 0) close = rest.lastIndexOf('"')
  return (close < 0 ? rest : rest.slice(0, close)).trim()
}

/**
 * Split a multi-select answer, its picks joined with ", ", back into picks. A
 * label may itself contain ", ", so at each position the longest run of parts
 * that spells an option label wins; parts that spell none are joined back into
 * one free-text "Other" answer. A single-select answer is always one pick.
 *
 * The joined text can't tell a typed answer that merely contains a label
 * (`custom, Alpha`) from that label picked beside typed text. codeg's own card
 * sends the latter (its labels, then the typed answer), so a part that spells
 * a label always reads as picked.
 */
function splitJoinedPicks(value: string, question: AskQuestion): string[] {
  const labels = new Set(question.options.map((o) => o.label))
  if (!question.multiSelect || labels.has(value)) return [value]
  // No label spans more parts than this, which keeps a long typed answer
  // (many commas, no labels) linear.
  const longestLabel = question.options.reduce(
    (most, o) => Math.max(most, o.label.split(LIST_SEPARATOR).length),
    1
  )
  const parts = value.split(LIST_SEPARATOR)
  const picks: string[] = []
  let typed: string[] = []
  let i = 0
  while (i < parts.length) {
    let end = Math.min(parts.length, i + longestLabel)
    while (end > i && !labels.has(parts.slice(i, end).join(LIST_SEPARATOR))) {
      end -= 1
    }
    if (end === i) {
      typed.push(parts[i])
      i += 1
      continue
    }
    if (typed.length > 0) {
      picks.push(typed.join(LIST_SEPARATOR))
      typed = []
    }
    picks.push(parts.slice(i, end).join(LIST_SEPARATOR))
    i = end
  }
  if (typed.length > 0) picks.push(typed.join(LIST_SEPARATOR))
  return picks
}

/** Every `"Q"="A"` pair, for a sentence read without its questions. */
function parseQuotedPairs(entries: string): AskQuestionAnswer[] {
  const answers: AskQuestionAnswer[] = []
  for (const match of entries.matchAll(ANSWER_PAIR_RE)) {
    const question = match[1].trim()
    const answer = match[2].trim()
    // A pair with no question text names nothing; drop it.
    if (!question) continue
    answers.push({
      header: "",
      question,
      selected: answer ? [answer] : [],
    })
  }
  return answers
}

/**
 * Decode one codex `request_user_input` answer list into what the user chose.
 *
 * codex encodes an answer as option labels plus a free-form note written as a
 * `user_note: <text>` entry. Its own TUI builds `[label?, "user_note: <text>"?]`
 * and splits it back the same way for display. That gives three shapes:
 *   - `["Option 2", "user_note: <text>"]`: an option with a note.
 *   - `["None of the above", "user_note: <text>"]`: an "Other" answer. The TUI
 *     writes this when the user picks the extra option and types. codex-acp
 *     2.1.0+ writes it for the free text codeg's card sends.
 *   - `["user_note: <text>"]`: a free-form question answered in the TUI.
 *
 * The note becomes its bare text, so it matches what the live card showed.
 * The "None of the above" label goes when a note says what it meant, because
 * that pair is a single typed answer. A bare one, picked with no note, is the
 * user's literal choice and stays.
 */
function decodeCodexAnswerEntries(entries: string[]): string[] {
  const labels: string[] = []
  const notes: string[] = []
  for (const entry of entries) {
    if (entry.startsWith(CODEX_NOTE_PREFIX)) {
      const note = entry.slice(CODEX_NOTE_PREFIX.length).trim()
      if (note) notes.push(note)
    } else {
      labels.push(entry)
    }
  }
  if (notes.length === 0) return labels
  return [...labels.filter((label) => label !== CODEX_OTHER_OPTION), ...notes]
}

/**
 * codex `request_user_input` records its answers keyed by question id rather
 * than as the codeg-mcp array envelope:
 *   { "answers": { "<questionId>": { "answers": ["label", ...] } } }
 * Return one answer per id (carrying that id so the card can match it against
 * the question's own id), or `null` when `answers` isn't the object map — so a
 * codeg-mcp / Claude result (whose `answers` is an ARRAY) never lands here.
 * Each list is decoded by `decodeCodexAnswerEntries`.
 */
function parseCodexAnswers(
  source: Record<string, unknown> | null | undefined
): AskQuestionAnswer[] | null {
  if (!source) return null
  const map = source.answers
  if (!map || typeof map !== "object" || Array.isArray(map)) return null
  const out: AskQuestionAnswer[] = []
  for (const [id, entry] of Object.entries(map as Record<string, unknown>)) {
    // Only a record-shaped entry is codex's. Kimi Code keys the same `answers`
    // map with plain STRING values (label per question text — see
    // `parseKimiOutcome`); swallowing those here turned every kimi answer into
    // a ghost empty selection ("no selection" despite a real pick).
    const rec = asRecord(entry)
    if (!rec) continue
    const raw = rec.answers
    const selected = Array.isArray(raw)
      ? decodeCodexAnswerEntries(
          raw.filter((x): x is string => typeof x === "string")
        )
      : []
    out.push({ id, header: "", question: "", selected })
  }
  return out.length > 0 ? out : null
}

/**
 * Kimi Code's native `AskUserQuestion` persists its result as
 *   {"answers": {"<question text>": "<value>"}}
 * — an object map keyed by the QUESTION TEXT whose values are strings: the
 * chosen option label, a free-text "other" answer, or a ", "-joined list for
 * multi-select (kimi-code ask-user.ts: single→label, multi→join(", ")). A
 * dismissal persists as {"answers": {}, "note": "User dismissed…"}. Splitting
 * on ", " mirrors the human-readable fallback's documented lossiness (a label
 * containing ", " degrades to a free-text answer, display-equivalent).
 * Returns `null` when no entry is string-valued and there is no dismissal
 * note, so codex's record-valued map (`parseCodexAnswers`) and the codeg-mcp
 * array envelope never land here.
 */
function parseKimiOutcome(
  source: Record<string, unknown> | null | undefined
): AskQuestionOutcome | null {
  if (!source) return null
  const map = source.answers
  if (!map || typeof map !== "object" || Array.isArray(map)) return null
  const entries = Object.entries(map as Record<string, unknown>)
  const answers: AskQuestionAnswer[] = []
  for (const [question, value] of entries) {
    if (typeof value !== "string") continue
    answers.push({
      header: "",
      question,
      selected: value ? value.split(", ") : [],
    })
  }
  if (answers.length > 0) return { declined: false, answers }
  // Kimi's dismissal: an EMPTY answers map plus an explanatory `note`. (The
  // text fallback would also catch today's exact wording, but the shape is the
  // stable contract — the wording isn't.)
  if (
    entries.length === 0 &&
    typeof source.note === "string" &&
    source.note.trim()
  ) {
    return { declined: true, answers: [] }
  }
  return null
}

/**
 * Parse the structured `{ answers, declined }` envelope the agent CLI persists
 * for the tool result (the companion's `structuredContent`). It may sit at the
 * top level or nested under `structuredContent`. Also recognizes codex's
 * object-keyed `request_user_input` envelope (see `parseCodexAnswers`) and
 * Kimi Code's string-valued native envelope (see `parseKimiOutcome`). Returns
 * `null` when `output` is none of these, so the text fallback can take over.
 */
function parseOutcomeJson(output: string): AskQuestionOutcome | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    return null
  }
  const top = asRecord(parsed)
  if (!top) return null
  // Resolve an answer envelope from a record: the record itself when it carries
  // `answers`/`declined`, otherwise its `structuredContent`.
  const envelopeOf = (
    r: Record<string, unknown> | null
  ): Record<string, unknown> | null => {
    if (!r) return null
    if (Array.isArray(r.answers) || typeof r.declined === "boolean") return r
    return asRecord(r.structuredContent)
  }
  // Prefer the bare top-level shape (Claude / the history parser) first, so a
  // valid top-level envelope is never shadowed by an unrelated `result` key.
  // codex's live ACP path wraps the MCP result as `{ result, error }`, where
  // `result` is the CallToolResult (`{ content, structuredContent }`) — sometimes
  // tagged again under an `Ok` serde variant — so fall through those layers when
  // the top level yields nothing.
  const result = asRecord(top.result)
  const resultOk = result ? (asRecord(result.Ok) ?? asRecord(result.ok)) : null
  const env = envelopeOf(top) ?? envelopeOf(result) ?? envelopeOf(resultOk)
  if (
    env &&
    (Array.isArray(env.answers) || typeof env.declined === "boolean")
  ) {
    if (env.declined === true) return { declined: true, answers: [] }
    return { declined: false, answers: parseAnswers(env.answers) }
  }

  // codex `request_user_input`: object-keyed answers. Checked after the
  // array-shaped envelope above so a codeg-mcp result never falls through here.
  const codex =
    parseCodexAnswers(top) ??
    parseCodexAnswers(asRecord(top.structuredContent)) ??
    parseCodexAnswers(result) ??
    parseCodexAnswers(resultOk)
  if (codex) return { declined: false, answers: codex }

  // Kimi Code's native AskUserQuestion: string-valued answers keyed by
  // question text, always at the top level (both the live ACP wire and the
  // wire.jsonl history carry the bare `{"answers": {...}}` output verbatim).
  return parseKimiOutcome(top)
}

/**
 * Reconstruct the answered/declined outcome from the persisted tool result.
 *
 * Primary shape — the structured envelope the CLI stores verbatim:
 *   {"answers":[{"header":"…","question":"…","selected":["A","B"]}],"declined":false}
 *
 * Fallback shape — the companion's human-readable text, for any CLI that keeps
 * `content` instead of `structuredContent` (see `render_ask_result`):
 *   "The user dismissed the question(s) …"  (declined)
 *   "The user answered your question(s):\n1. [Header] Question\n   → a, b\n…"
 * qodercli / claude-code's native AskUserQuestion persists yet another shape —
 * plain sentences ("Your questions have been answered: …" / "The user did not
 * answer the questions.") — parsed by `parseAnsweredSentence`. That sentence
 * escapes nothing, so pass the asked `questions` (from `parseAskQuestionInput`)
 * whenever they're known: they are what reads it reliably.
 *
 * Returns `null` when there is no output yet (the call is still in flight). In
 * the fallback, selections are split on ", " (lossy for a label containing a
 * comma — the structured envelope keeps such a label intact as one array entry).
 */
export function parseAskQuestionOutcome(
  output: string | null | undefined,
  questions?: readonly AskQuestion[]
): AskQuestionOutcome | null {
  if (!output || !output.trim()) return null

  // codex wraps the result as `Wall time: <n>s\nOutput:\n<body>` in its rollout;
  // strip it so both the JSON and text paths below see the real payload.
  const body = stripCodexOutputWrapper(output)

  const fromJson = parseOutcomeJson(body)
  if (fromJson) return fromJson

  // qodercli / claude-code's native AskUserQuestion sentences (see
  // `parseAnsweredSentence`) — before the line-based fallback, whose
  // `N. [header] question` shape cannot match them and would report an empty
  // "no selection" outcome for a genuinely answered ask.
  const fromSentence = parseAnsweredSentence(body, questions)
  if (fromSentence) return fromSentence

  // The decline sentences ride one arm: the companion's dismissal wording and
  // qodercli's "did not answer" sentence (an unanswered native ask), which is
  // the whole result. Anywhere else it is just text, e.g. a typed answer.
  if (
    /\bdismissed the question/i.test(body) ||
    DID_NOT_ANSWER_RE.test(body.trim())
  ) {
    return { declined: true, answers: [] }
  }

  const answers: AskQuestionAnswer[] = []
  let current: AskQuestionAnswer | null = null
  for (const line of body.split(/\r?\n/)) {
    const header = line.match(HEADER_LINE_RE)
    if (header) {
      current = {
        header: header[1].trim(),
        question: header[2].trim(),
        selected: [],
      }
      answers.push(current)
      continue
    }
    const selectedLine = line.match(SELECTED_LINE_RE)
    if (selectedLine && current) {
      const joined = selectedLine[1].trim()
      current.selected =
        joined && joined !== NO_SELECTION ? joined.split(", ") : []
      current = null
    }
  }
  return { declined: false, answers }
}

/**
 * Partition the user's raw picks into the offered option labels they chose
 * (`selected`) and any free-text "Other" answers (`other`), order-preserving.
 * Each pick is already a whole value (one array entry), so a label that itself
 * contains a comma matches cleanly — no fragile text splitting required.
 */
export function matchSelections(
  values: string[],
  optionLabels: string[]
): { selected: string[]; other: string[] } {
  const labels = new Set(optionLabels.filter(Boolean))
  const selected: string[] = []
  const other: string[] = []
  for (const raw of values) {
    const value = raw.trim()
    if (!value || value === NO_SELECTION) continue
    if (labels.has(value)) selected.push(value)
    else other.push(value)
  }
  return { selected, other }
}
