import { describe, expect, it } from "vitest"

import {
  matchSelections,
  parseAskQuestionInput,
  parseAskQuestionOutcome,
  splitRecommended,
} from "./ask-question"

describe("splitRecommended", () => {
  it("strips a trailing (Recommended) suffix, case-insensitively", () => {
    expect(splitRecommended("Incremental (Recommended)")).toEqual({
      text: "Incremental",
      recommended: true,
    })
    expect(splitRecommended("Incremental (recommended)")).toEqual({
      text: "Incremental",
      recommended: true,
    })
  })

  it("leaves plain labels untouched", () => {
    expect(splitRecommended("Rewrite")).toEqual({
      text: "Rewrite",
      recommended: false,
    })
  })

  it("keeps a bare (Recommended) literal rather than rendering empty", () => {
    expect(splitRecommended("(Recommended)")).toEqual({
      text: "(Recommended)",
      recommended: false,
    })
  })

  // Google Antigravity's ask_question tells the model to PREFIX a recommended
  // option with "(Recommended)".
  it("strips a leading (Recommended) prefix, case-insensitively", () => {
    expect(splitRecommended("(Recommended) Backend API")).toEqual({
      text: "Backend API",
      recommended: true,
    })
    expect(splitRecommended("  (recommended)核心业务功能")).toEqual({
      text: "核心业务功能",
      recommended: true,
    })
  })
})

describe("Google Antigravity ask_question", () => {
  // `arguments_json` and the history parser's envelope for the same call,
  // recorded from antigravity-acp 1.4.1 (options are plain strings, the kind
  // is snake_case `is_multi_select`, there is no header).
  const input = JSON.stringify({
    questions: [
      {
        is_multi_select: false,
        options: [
          "(Recommended) Backend API",
          "Frontend UI",
          "Database schema",
        ],
        question: "Which area first?",
      },
      {
        is_multi_select: true,
        options: ["Alpha", "Beta", "Gamma"],
        question: "Pick tags",
      },
    ],
    toolAction: "Asking user",
    toolSummary: "Priorities",
  })

  it("reads string options and is_multi_select", () => {
    expect(parseAskQuestionInput(input)).toEqual([
      {
        question: "Which area first?",
        header: "",
        multiSelect: false,
        options: [
          { label: "(Recommended) Backend API", description: "" },
          { label: "Frontend UI", description: "" },
          { label: "Database schema", description: "" },
        ],
        isSecret: false,
        id: undefined,
      },
      {
        question: "Pick tags",
        header: "",
        multiSelect: true,
        options: [
          { label: "Alpha", description: "" },
          { label: "Beta", description: "" },
          { label: "Gamma", description: "" },
        ],
        isSecret: false,
        id: undefined,
      },
    ])
  })

  it("matches the parser's answers back to the offered options", () => {
    const questions = parseAskQuestionInput(input)
    const outcome = parseAskQuestionOutcome(
      JSON.stringify({
        answers: [
          {
            header: "",
            question: "Which area first?",
            multi_select: false,
            selected: ["(Recommended) Backend API"],
          },
          {
            header: "",
            question: "Pick tags",
            multi_select: true,
            selected: ["Gamma"],
          },
        ],
        declined: false,
      }),
      questions
    )
    expect(outcome?.declined).toBe(false)
    expect(
      matchSelections(
        outcome?.answers[0].selected ?? [],
        questions[0].options.map((o) => o.label)
      )
    ).toEqual({ selected: ["(Recommended) Backend API"], other: [] })
    expect(
      matchSelections(
        outcome?.answers[1].selected ?? [],
        questions[1].options.map((o) => o.label)
      )
    ).toEqual({ selected: ["Gamma"], other: [] })
  })
})

describe("parseAskQuestionInput", () => {
  it("parses questions with options and the camelCase multiSelect field", () => {
    const input = JSON.stringify({
      questions: [
        {
          question: "Which approach?",
          header: "Approach",
          multiSelect: false,
          options: [
            { label: "Incremental", description: "Smaller steps" },
            { label: "Rewrite", description: "Start fresh" },
          ],
        },
      ],
    })
    expect(parseAskQuestionInput(input)).toEqual([
      {
        question: "Which approach?",
        header: "Approach",
        multiSelect: false,
        options: [
          { label: "Incremental", description: "Smaller steps" },
          { label: "Rewrite", description: "Start fresh" },
        ],
        isSecret: false,
      },
    ])
  })

  it("also accepts the snake_case multi_select field", () => {
    const input = JSON.stringify({
      questions: [
        {
          question: "Pick many",
          header: "Multi",
          multi_select: true,
          options: [],
        },
      ],
    })
    expect(parseAskQuestionInput(input)[0].multiSelect).toBe(true)
  })

  it("tolerates missing options and missing descriptions", () => {
    const input = JSON.stringify({
      questions: [{ question: "Q", header: "H", options: [{ label: "A" }] }],
    })
    expect(parseAskQuestionInput(input)).toEqual([
      {
        question: "Q",
        header: "H",
        multiSelect: false,
        options: [{ label: "A", description: "" }],
        isSecret: false,
      },
    ])
  })

  it("drops options without a label and entries that are entirely empty", () => {
    const input = JSON.stringify({
      questions: [
        {
          question: "Q",
          header: "H",
          options: [{ description: "no label" }, { label: "Keep" }],
        },
        { question: "", header: "", options: [] },
      ],
    })
    const result = parseAskQuestionInput(input)
    expect(result).toHaveLength(1)
    expect(result[0].options).toEqual([{ label: "Keep", description: "" }])
  })

  it("unwraps the codex MCP envelope where questions are nested under arguments", () => {
    // codex-acp 1.0.0 wraps MCP input as { server, tool, arguments } — see
    // CodexToolCallMapper.ts::createMcpToolCallUpdate. The questions live under
    // `arguments`, not the top level.
    const input = JSON.stringify({
      server: "codeg-mcp",
      tool: "ask_user_question",
      arguments: {
        questions: [
          {
            question: "Which approach?",
            header: "Approach",
            multiSelect: false,
            options: [{ label: "Incremental", description: "Smaller steps" }],
          },
        ],
      },
    })
    expect(parseAskQuestionInput(input)).toEqual([
      {
        question: "Which approach?",
        header: "Approach",
        multiSelect: false,
        options: [{ label: "Incremental", description: "Smaller steps" }],
        isSecret: false,
      },
    ])
  })

  it("reads codex's isSecret marker (and the snake_case variant)", () => {
    const input = JSON.stringify({
      questions: [
        { question: "API key?", header: "Key", options: [], isSecret: true },
        { question: "Token?", header: "Tok", options: [], is_secret: true },
        { question: "Name?", header: "Name", options: [] },
      ],
    })
    const result = parseAskQuestionInput(input)
    expect(result.map((q) => q.isSecret)).toEqual([true, true, false])
  })

  it("captures codex's per-question id (and leaves it undefined otherwise)", () => {
    // codex `request_user_input` keys each question with a stable id; its answer
    // envelope is keyed by that id (see parseAskQuestionOutcome below).
    const input = JSON.stringify({
      questions: [
        {
          id: "drink_preference",
          header: "饮品偏好",
          question: "工作时你更喜欢喝哪一种饮品？",
          options: [{ label: "咖啡（推荐）" }, { label: "茶" }],
        },
        { question: "No id here", header: "H", options: [{ label: "A" }] },
      ],
    })
    const result = parseAskQuestionInput(input)
    expect(result.map((q) => q.id)).toEqual(["drink_preference", undefined])
  })

  it("returns [] for malformed JSON, missing questions, or nullish input", () => {
    expect(parseAskQuestionInput("not json")).toEqual([])
    expect(parseAskQuestionInput(JSON.stringify({ foo: 1 }))).toEqual([])
    expect(parseAskQuestionInput(null)).toEqual([])
    expect(parseAskQuestionInput(undefined)).toEqual([])
  })
})

describe("parseAskQuestionOutcome", () => {
  it("returns null when there is no output yet (call in flight)", () => {
    expect(parseAskQuestionOutcome(null)).toBeNull()
    expect(parseAskQuestionOutcome("")).toBeNull()
    expect(parseAskQuestionOutcome("   ")).toBeNull()
  })

  it("parses the structured JSON envelope the CLI persists", () => {
    // The real on-disk shape: each answer's `selected` is already an array.
    const output = JSON.stringify({
      answers: [
        {
          header: "Approach",
          question: "Which approach?",
          selected: ["Incremental", "Rewrite"],
        },
        { header: "Format", question: "Output format?", selected: [] },
      ],
      declined: false,
    })
    expect(parseAskQuestionOutcome(output)).toEqual({
      declined: false,
      answers: [
        {
          header: "Approach",
          question: "Which approach?",
          selected: ["Incremental", "Rewrite"],
        },
        { header: "Format", question: "Output format?", selected: [] },
      ],
    })
  })

  it("reads a declined envelope from the JSON", () => {
    expect(
      parseAskQuestionOutcome(JSON.stringify({ answers: [], declined: true }))
    ).toEqual({ declined: true, answers: [] })
  })

  it("unwraps the envelope when nested under structuredContent", () => {
    const output = JSON.stringify({
      content: [{ type: "text", text: "…" }],
      structuredContent: {
        answers: [{ header: "H", question: "Q", selected: ["A"] }],
        declined: false,
      },
    })
    expect(parseAskQuestionOutcome(output)?.answers[0].selected).toEqual(["A"])
  })

  it("keeps a valid top-level structuredContent over an unrelated result key", () => {
    // Defensive: a bare envelope that also carries a `result` key must resolve
    // from the top level, not unwrap into `result` and lose the answers.
    const output = JSON.stringify({
      content: [],
      structuredContent: {
        answers: [{ header: "H", question: "Q", selected: ["A"] }],
        declined: false,
      },
      result: {},
    })
    expect(parseAskQuestionOutcome(output)?.answers[0].selected).toEqual(["A"])
  })

  it("unwraps the codex MCP result envelope ({ result, error })", () => {
    // codex-acp 1.0.0 wraps MCP output as { result: CallToolResult, error };
    // the { answers, declined } sits under result.structuredContent.
    const output = JSON.stringify({
      result: {
        content: [{ type: "text", text: "The user answered…" }],
        structuredContent: {
          answers: [{ header: "H", question: "Q", selected: ["A"] }],
          declined: false,
        },
      },
      error: null,
    })
    expect(parseAskQuestionOutcome(output)).toEqual({
      declined: false,
      answers: [{ header: "H", question: "Q", selected: ["A"] }],
    })
  })

  it("reads a declined codex MCP result envelope", () => {
    const output = JSON.stringify({
      result: {
        content: [{ type: "text", text: "dismissed" }],
        structuredContent: { answers: [], declined: true },
      },
      error: null,
    })
    expect(parseAskQuestionOutcome(output)).toEqual({
      declined: true,
      answers: [],
    })
  })

  it("parses the real codex rollout output (Wall time / Output wrapper)", () => {
    // Verbatim shape from ~/.codex/sessions rollout `function_call_output.output`:
    // codex wraps the MCP result as `Wall time: <n> seconds\nOutput:\n<json>`,
    // where <json> is the bare { answers, declined } envelope. Without stripping
    // the wrapper the whole string fails JSON.parse and the selected value is lost.
    const output =
      "Wall time: 41.1908 seconds\nOutput:\n" +
      JSON.stringify({
        answers: [
          {
            header: "目标平台",
            multi_select: false,
            question: "最终工具主要要在哪个平台运行？",
            selected: ["Windows .exe (Recommended)"],
          },
        ],
        declined: false,
      })
    expect(parseAskQuestionOutcome(output)).toEqual({
      declined: false,
      answers: [
        {
          header: "目标平台",
          question: "最终工具主要要在哪个平台运行？",
          selected: ["Windows .exe (Recommended)"],
        },
      ],
    })
  })

  it("unwraps an Ok-tagged codex result envelope", () => {
    const output = JSON.stringify({
      result: {
        Ok: {
          content: [{ type: "text", text: "The user answered…" }],
          structuredContent: {
            answers: [{ header: "H", question: "Q", selected: ["A"] }],
            declined: false,
          },
          isError: false,
        },
      },
      error: null,
    })
    expect(parseAskQuestionOutcome(output)?.answers[0].selected).toEqual(["A"])
  })

  it("parses codex request_user_input's object-keyed answers", () => {
    // Verbatim function_call_output shape from ~/.codex/sessions: answers are
    // keyed by the question id, each carrying its own `answers` array — NOT the
    // codeg-mcp `{answers:[{…,selected}]}` envelope. Without this the card shows
    // "no selection" (the reported bug).
    const output = JSON.stringify({
      answers: { drink_preference: { answers: ["咖啡（推荐）"] } },
    })
    expect(parseAskQuestionOutcome(output)).toEqual({
      declined: false,
      answers: [
        {
          id: "drink_preference",
          header: "",
          question: "",
          selected: ["咖啡（推荐）"],
        },
      ],
    })
  })

  it("parses a multi-question codex answer envelope", () => {
    const output = JSON.stringify({
      answers: {
        q1: { answers: ["A"] },
        q2: { answers: ["X", "Y"] },
      },
    })
    const parsed = parseAskQuestionOutcome(output)
    expect(parsed?.declined).toBe(false)
    expect(parsed?.answers).toEqual([
      { id: "q1", header: "", question: "", selected: ["A"] },
      { id: "q2", header: "", question: "", selected: ["X", "Y"] },
    ])
  })

  it("decodes codex's note encoding to the text the user chose", () => {
    // codex writes a free-form note as a `user_note: ` entry next to the
    // option labels. codex-acp 2.1.0 hands codex the free text codeg's card
    // sends as ["None of the above", "user_note: <text>"] (recorded on the
    // adapter with codeg's capabilities). Codex's own TUI writes the same pair
    // for its "None of the above" + notes, an option plus a note, and a
    // free-form question as the note alone.
    const output = JSON.stringify({
      answers: {
        typed_other: {
          answers: ["None of the above", "user_note: Inspect flaky logs"],
        },
        option_and_note: {
          answers: ["Option 2", "user_note: Notes for option 2"],
        },
        free_form: { answers: ["user_note: feat/x"] },
        bare_other: { answers: ["None of the above"] },
        plain_option: { answers: ["Run tests"] },
        empty_note: { answers: ["None of the above", "user_note:  "] },
      },
    })
    expect(parseAskQuestionOutcome(output)?.answers).toEqual([
      {
        id: "typed_other",
        header: "",
        question: "",
        selected: ["Inspect flaky logs"],
      },
      {
        id: "option_and_note",
        header: "",
        question: "",
        selected: ["Option 2", "Notes for option 2"],
      },
      { id: "free_form", header: "", question: "", selected: ["feat/x"] },
      // Picked with nothing typed: that IS the answer, so it stays.
      {
        id: "bare_other",
        header: "",
        question: "",
        selected: ["None of the above"],
      },
      {
        id: "plain_option",
        header: "",
        question: "",
        selected: ["Run tests"],
      },
      // A blank note says nothing, so the pick it came with stands alone.
      {
        id: "empty_note",
        header: "",
        question: "",
        selected: ["None of the above"],
      },
    ])
  })

  it("parses kimi's string-valued answers keyed by question text", () => {
    // Verbatim tool.result output from a Kimi Code wire.jsonl: the native
    // AskUserQuestion keys `answers` by the QUESTION TEXT with the chosen
    // option label as a plain string — NOT codex's `{answers:[…]}` records.
    // Without this the card showed "no selection" (the reported bug).
    const output = JSON.stringify({
      answers: { "你最近在用哪种编程语言最多？": "Rust" },
    })
    expect(parseAskQuestionOutcome(output)).toEqual({
      declined: false,
      answers: [
        {
          header: "",
          question: "你最近在用哪种编程语言最多？",
          selected: ["Rust"],
        },
      ],
    })
  })

  it("splits kimi's ', '-joined multi-select value into one pick per label", () => {
    // kimi-code joins multi-select picks (and a free-text other) with ", " —
    // the same documented lossiness as the human-readable text fallback.
    const output = JSON.stringify({
      answers: { "Pick any": "Alpha, Beta" },
    })
    expect(parseAskQuestionOutcome(output)?.answers[0].selected).toEqual([
      "Alpha",
      "Beta",
    ])
  })

  it("treats kimi's empty string value as an answered-but-empty selection", () => {
    const output = JSON.stringify({ answers: { "Pick any": "" } })
    expect(parseAskQuestionOutcome(output)).toEqual({
      declined: false,
      answers: [{ header: "", question: "Pick any", selected: [] }],
    })
  })

  it("reads kimi's dismissal (empty answers map + note) as declined", () => {
    const output = JSON.stringify({
      answers: {},
      note: "User dismissed the question without answering.",
    })
    expect(parseAskQuestionOutcome(output)).toEqual({
      declined: true,
      answers: [],
    })
  })

  it("keeps an option label containing a comma intact as one entry", () => {
    const output = JSON.stringify({
      answers: [
        { header: "H", question: "Q", selected: ["Rewrite, then test"] },
      ],
      declined: false,
    })
    expect(parseAskQuestionOutcome(output)?.answers[0].selected).toEqual([
      "Rewrite, then test",
    ])
  })

  it("reads qoder's decline sentence as declined", () => {
    // qodercli's native AskUserQuestion persists the decline as a bare
    // sentence (the Claude-Code lineage llmContent), not a JSON envelope.
    expect(
      parseAskQuestionOutcome("The user did not answer the questions.")
    ).toEqual({
      declined: true,
      answers: [],
    })
  })

  it("parses qoder's answered sentence into one answer per quoted pair", () => {
    // Verbatim llmContent from a real qoder session (ef841d1d…, line 22): the
    // native AskUserQuestion result is a sentence of "Q"="A" pairs, values
    // double-quoted — not the companion's JSON envelope. Without this the card
    // showed "no selection" for a genuinely answered ask.
    const output =
      'Your questions have been answered: "你订阅主要拿来干什么？"="AI 编程 Agent 日常主力", ' +
      '"预算大概什么范围？"="100-200 元/月". You can now continue with these answers in mind.'
    expect(parseAskQuestionOutcome(output)).toEqual({
      declined: false,
      answers: [
        {
          header: "",
          question: "你订阅主要拿来干什么？",
          selected: ["AI 编程 Agent 日常主力"],
        },
        {
          header: "",
          question: "预算大概什么范围？",
          selected: ["100-200 元/月"],
        },
      ],
    })
  })

  it("keeps a comma-bearing value whole and ignores trailing preview/notes blocks", () => {
    // Pair values may contain commas, so pairs are regex-extracted rather than
    // split on ", "; an entry can trail a ` selected preview:` block and
    // ` notes:` (before the closing sentence) — neither may leak into the picks.
    const output =
      'Your questions have been answered: "Pick one"="Alpha, beta, and more" ' +
      'selected preview:\nsome preview "text" here notes: user wrote a note. ' +
      "You can now continue with these answers in mind."
    expect(parseAskQuestionOutcome(output)).toEqual({
      declined: false,
      answers: [
        {
          header: "",
          question: "Pick one",
          selected: ["Alpha, beta, and more"],
        },
      ],
    })
  })

  describe("a CLI answer sentence read against the asked questions", () => {
    const sentence = (...entries: string[]) =>
      `Your questions have been answered: ${entries.join(", ")}. ` +
      "You can now continue with these answers in mind."
    const asked = (
      ...questions: { question: string; labels: string[]; multi?: boolean }[]
    ) =>
      parseAskQuestionInput(
        JSON.stringify({
          questions: questions.map((q) => ({
            question: q.question,
            header: "",
            multiSelect: q.multi === true,
            options: q.labels.map((label) => ({ label, description: "" })),
          })),
        })
      )

    it("splits a multi-select answer back into the labels it joins", () => {
      // Every producer joins a multi-select answer's labels with ", " (the
      // CLI's own `answers` schema: "multi-select answers are comma-separated").
      const questions = asked({
        question: "Which features?",
        labels: ["Auth", "Billing", "Search"],
        multi: true,
      })
      expect(
        parseAskQuestionOutcome(
          sentence('"Which features?"="Auth, Search"'),
          questions
        )
      ).toEqual({
        declined: false,
        answers: [
          {
            header: "",
            question: "Which features?",
            selected: ["Auth", "Search"],
          },
        ],
      })
    })

    it("keeps comma-bearing labels whole and the typed rest as one answer", () => {
      // Two such labels side by side: read part by part, they would merge
      // into one typed answer instead.
      const questions = asked({
        question: "Pick any",
        labels: ["Rewrite, then test", "Ship, then fix", "Incremental"],
        multi: true,
      })
      expect(
        parseAskQuestionOutcome(
          sentence(
            '"Pick any"="Rewrite, then test, Ship, then fix, my own, idea"'
          ),
          questions
        )?.answers
      ).toEqual([
        {
          header: "",
          question: "Pick any",
          selected: ["Rewrite, then test", "Ship, then fix", "my own, idea"],
        },
      ])
    })

    it("takes the longest label when one label starts another", () => {
      const questions = asked({
        question: "Pick any",
        labels: ["Alpha", "Alpha, Beta", "Gamma"],
        multi: true,
      })
      expect(
        parseAskQuestionOutcome(
          sentence('"Pick any"="Alpha, Beta, Gamma"'),
          questions
        )?.answers
      ).toEqual([
        {
          header: "",
          question: "Pick any",
          selected: ["Alpha, Beta", "Gamma"],
        },
      ])
    })

    it("keeps a single-select answer whole even when it reads like a list", () => {
      const questions = asked({
        question: "Pick one",
        labels: ["Alpha", "Beta"],
      })
      expect(
        parseAskQuestionOutcome(sentence('"Pick one"="Alpha, Beta"'), questions)
          ?.answers
      ).toEqual([
        { header: "", question: "Pick one", selected: ["Alpha, Beta"] },
      ])
    })

    it("reads a question and an answer that contain double quotes", () => {
      // The sentence escapes nothing. Read without its questions, the pair
      // regex cuts the first answer at its inner quote and takes `?` for the
      // second question.
      const questions = asked(
        { question: "Tagline?", labels: ["Short", "Long"] },
        { question: 'Name it "codeg"?', labels: ["Yes", "No"] }
      )
      const output = sentence(
        '"Tagline?"="say "a", "b""',
        '"Name it "codeg"?"="Yes"'
      )
      expect(parseAskQuestionOutcome(output, questions)?.answers).toEqual([
        { header: "", question: "Tagline?", selected: ['say "a", "b"'] },
        { header: "", question: 'Name it "codeg"?', selected: ["Yes"] },
      ])
    })

    it("does not take a key quoted inside an earlier answer for that question", () => {
      const questions = asked(
        { question: "Style?", labels: ["Bold", "Plain"] },
        { question: "Size?", labels: ["Large", "Small"] }
      )
      const output = sentence(
        '"Style?"="like "Size?"="Small" but bolder"',
        '"Size?"="Large"'
      )
      expect(parseAskQuestionOutcome(output, questions)?.answers).toEqual([
        {
          header: "",
          question: "Style?",
          selected: ['like "Size?"="Small" but bolder'],
        },
        { header: "", question: "Size?", selected: ["Large"] },
      ])
    })

    it("drops any entry's preview and notes, reads notes alone as no pick, and skips the unanswered", () => {
      const questions = asked(
        { question: "Layout?", labels: ["Grid", "List"] },
        { question: "Skipped?", labels: ["Yes", "No"] },
        { question: "Theme?", labels: ["Dark", "Light"] },
        { question: "Size?", labels: ["Large", "Small"] }
      )
      const output = sentence(
        '"Layout?"="Grid" selected preview:\n<div class="g">"x"="y"</div> notes: keep it tight',
        '"Theme?"=(no option selected) notes: whatever fits',
        '"Size?"="Large"'
      )
      expect(parseAskQuestionOutcome(output, questions)?.answers).toEqual([
        { header: "", question: "Layout?", selected: ["Grid"] },
        { header: "", question: "Theme?", selected: [] },
        { header: "", question: "Size?", selected: ["Large"] },
      ])
    })

    it("never reads a pair typed into a note as an answer", () => {
      // The real pick is A; the note merely quotes the sentence's shape.
      const questions = asked({ question: "Which?", labels: ["A", "B"] })
      expect(
        parseAskQuestionOutcome(
          sentence('"Which?"="A" notes: example "Which?"="B"'),
          questions
        )?.answers
      ).toEqual([{ header: "", question: "Which?", selected: ["A"] }])
    })

    it("skips a key in a note whose value is not a well-formed entry", () => {
      // `(no option selected)` is only ever written before notes, so the
      // note's `, "Q2"=(no option selected)` cannot be Q2's entry.
      const questions = asked(
        { question: "Q1", labels: ["A", "B"] },
        { question: "Q2", labels: ["A", "B"] }
      )
      const output = sentence(
        '"Q1"="A" notes: example, "Q2"=(no option selected)',
        '"Q2"="B"'
      )
      expect(parseAskQuestionOutcome(output, questions)?.answers).toEqual([
        { header: "", question: "Q1", selected: ["A"] },
        { header: "", question: "Q2", selected: ["B"] },
      ])
    })

    it("falls back to the quoted pairs when no asked question is in the sentence", () => {
      const questions = asked({ question: "Something else?", labels: ["A"] })
      expect(
        parseAskQuestionOutcome(sentence('"Pick one"="A"'), questions)?.answers
      ).toEqual([{ header: "", question: "Pick one", selected: ["A"] }])
    })
  })

  it("without the questions, takes only the pairs that open an entry", () => {
    // A note's quoted `"Which?"="B"` follows note text, not ", ": not an entry.
    const output =
      'Your questions have been answered: "Which?"="A" notes: example ' +
      '"Which?"="B". You can now continue with these answers in mind.'
    expect(parseAskQuestionOutcome(output)?.answers).toEqual([
      { header: "", question: "Which?", selected: ["A"] },
    ])
  })

  it("reads the answered sentence only when the result opens with it", () => {
    // A typed answer quoting the sentence stays that answer's text.
    const output =
      "The user answered your question(s):\n" +
      "1. [Reply] What should I tell them?\n" +
      '   → Your questions have been answered: "a"="b"'
    expect(parseAskQuestionOutcome(output)).toEqual({
      declined: false,
      answers: [
        {
          header: "Reply",
          question: "What should I tell them?",
          selected: ['Your questions have been answered: "a"="b"'],
        },
      ],
    })
  })

  it("reads 'did not answer' as declined only when it is the whole result", () => {
    const output =
      "The user answered your question(s):\n" +
      "1. [Reply] What should I tell them?\n" +
      "   → The user did not answer the questions."
    expect(parseAskQuestionOutcome(output)).toEqual({
      declined: false,
      answers: [
        {
          header: "Reply",
          question: "What should I tell them?",
          selected: ["The user did not answer the questions."],
        },
      ],
    })
  })

  it("falls back to the human-readable text when there is no JSON", () => {
    const output =
      "The user answered your question(s):\n" +
      "1. [Approach] Which approach?\n" +
      "   → Incremental, Rewrite\n" +
      "2. [Format] Output format?\n" +
      "   → (no selection)\n"
    expect(parseAskQuestionOutcome(output)).toEqual({
      declined: false,
      answers: [
        {
          header: "Approach",
          question: "Which approach?",
          selected: ["Incremental", "Rewrite"],
        },
        { header: "Format", question: "Output format?", selected: [] },
      ],
    })
  })

  it("detects a declined / dismissed outcome from the text fallback", () => {
    const output =
      "The user dismissed the question(s) without choosing an answer. " +
      "Proceed using your best judgment and reasonable defaults."
    expect(parseAskQuestionOutcome(output)).toEqual({
      declined: true,
      answers: [],
    })
  })

  // codeg-mcp mirrors its "do not ask again to confirm" instruction into the
  // structured envelope as `hint` (issue #861) and appends it to the text.
  // Neither may change what the card reads.
  const PROCEED_INSTRUCTION =
    "Proceed with your task using these answers now. Do not call " +
    "ask_user_question again to confirm that you should proceed."

  it("ignores the companion's hint key on the structured envelope", () => {
    const output = JSON.stringify({
      answers: [
        { header: "Go", question: "Start?", selected: ["Start (Recommended)"] },
      ],
      declined: false,
      hint: PROCEED_INSTRUCTION,
    })
    expect(parseAskQuestionOutcome(output)).toEqual({
      declined: false,
      answers: [
        { header: "Go", question: "Start?", selected: ["Start (Recommended)"] },
      ],
    })
  })

  it("does not read the trailing proceed instruction as another answer", () => {
    const output =
      "The user answered your question(s):\n" +
      "1. [Go] Start?\n" +
      "   → Start (Recommended)\n" +
      `${PROCEED_INSTRUCTION}\n`
    expect(parseAskQuestionOutcome(output)).toEqual({
      declined: false,
      answers: [
        { header: "Go", question: "Start?", selected: ["Start (Recommended)"] },
      ],
    })
  })

  it("still detects a dismissal that ends with the confirm-again warning", () => {
    const output =
      "The user dismissed the question(s) without choosing an answer. " +
      "Proceed using your best judgment and reasonable defaults. Do not call " +
      "ask_user_question again to confirm that you should proceed."
    expect(parseAskQuestionOutcome(output)).toEqual({
      declined: true,
      answers: [],
    })
  })
})

describe("matchSelections", () => {
  it("partitions picks into chosen options and free-text Other answers", () => {
    expect(
      matchSelections(["Incremental", "Rewrite"], ["Incremental", "Rewrite"])
    ).toEqual({ selected: ["Incremental", "Rewrite"], other: [] })
  })

  it("matches an option label that itself contains a comma", () => {
    // The pick arrives as one whole array entry, so the comma is no obstacle.
    expect(
      matchSelections(
        ["Rewrite, then test", "Incremental"],
        ["Incremental", "Rewrite, then test"]
      )
    ).toEqual({ selected: ["Rewrite, then test", "Incremental"], other: [] })
  })

  it("returns unmatched picks as free-text Other answers", () => {
    expect(
      matchSelections(["Alpha", "Custom thing"], ["Alpha", "Beta"])
    ).toEqual({ selected: ["Alpha"], other: ["Custom thing"] })
  })

  it("ignores empty / (no selection) entries", () => {
    expect(matchSelections([], ["A"])).toEqual({ selected: [], other: [] })
    expect(matchSelections(["(no selection)"], ["A"])).toEqual({
      selected: [],
      other: [],
    })
  })

  it("with no options, every pick is an Other answer", () => {
    expect(matchSelections(["foo", "bar"], [])).toEqual({
      selected: [],
      other: ["foo", "bar"],
    })
  })
})
