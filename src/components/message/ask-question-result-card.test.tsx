import { type ReactElement } from "react"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it } from "vitest"

import { AskQuestionResultCard } from "./ask-question-result-card"
import enMessages from "@/i18n/messages/en.json"

function renderWithIntl(ui: ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

/** Expand the collapsed capsule so the read-only card is in the DOM. */
function expand() {
  fireEvent.click(screen.getByTestId("ask-question-result-card"))
}

const SINGLE_INPUT = JSON.stringify({
  questions: [
    {
      question: "Which approach?",
      header: "Approach",
      multiSelect: false,
      options: [
        { label: "Incremental (Recommended)", description: "Smaller steps" },
        { label: "Rewrite", description: "Start fresh" },
      ],
    },
  ],
})

// The real on-disk tool result: the structured envelope, `selected` an array.
const SINGLE_OUTPUT = JSON.stringify({
  answers: [
    {
      header: "Approach",
      question: "Which approach?",
      selected: ["Incremental (Recommended)"],
    },
  ],
  declined: false,
})

const result = enMessages.Folder.chat.askQuestionResult

describe("AskQuestionResultCard", () => {
  it("is collapsed by default into a capsule summarizing the picks", () => {
    renderWithIntl(
      <AskQuestionResultCard
        input={SINGLE_INPUT}
        output={SINGLE_OUTPUT}
        state="output-available"
      />
    )

    // Capsule shows the localized label + the chosen value; the full option
    // controls stay hidden.
    expect(screen.getByText(result.answeredLabel)).toBeInTheDocument()
    expect(screen.getByText("Incremental (Recommended)")).toBeInTheDocument()
    expect(screen.queryByRole("radio")).toBeNull()
    expect(screen.queryByText("Which approach?")).toBeNull()
  })

  it("expands to the read-only card, with the choice checked and disabled", () => {
    renderWithIntl(
      <AskQuestionResultCard
        input={SINGLE_INPUT}
        output={SINGLE_OUTPUT}
        state="output-available"
      />
    )
    expand()

    expect(screen.getByText("Which approach?")).toBeInTheDocument()
    const chosen = screen.getByRole("radio", { name: /Incremental/ })
    expect(chosen).toBeChecked()
    expect(chosen).toBeDisabled()
    expect(screen.getByRole("radio", { name: /Rewrite/ })).not.toBeChecked()
    // "(Recommended)" is split off into a badge; the chosen description shows.
    expect(screen.getByText("Recommended")).toBeInTheDocument()
    expect(screen.getByText("Smaller steps")).toBeInTheDocument()
    // No footer actions in the read-only record.
    expect(screen.queryByRole("button", { name: "Submit" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull()
  })

  it("checks the picked options and surfaces a free-text Other answer in multi-select", () => {
    const input = JSON.stringify({
      questions: [
        {
          question: "Pick any",
          header: "Pick",
          multiSelect: true,
          options: [
            { label: "Alpha", description: "" },
            { label: "Beta", description: "" },
          ],
        },
      ],
    })
    const output = JSON.stringify({
      answers: [
        {
          header: "Pick",
          question: "Pick any",
          selected: ["Alpha", "Custom thing"],
        },
      ],
      declined: false,
    })
    renderWithIntl(
      <AskQuestionResultCard
        input={input}
        output={output}
        state="output-available"
      />
    )
    expand()

    expect(screen.getByRole("checkbox", { name: "Alpha" })).toBeChecked()
    expect(screen.getByRole("checkbox", { name: "Beta" })).not.toBeChecked()
    // The pick that isn't an option is the free-text "Other" answer.
    expect(screen.getByRole("checkbox", { name: "Other" })).toBeChecked()
    expect(screen.getByDisplayValue("Custom thing")).toBeInTheDocument()
  })

  it("matches an option label that itself contains a comma", () => {
    const input = JSON.stringify({
      questions: [
        {
          question: "Pick",
          header: "Pick",
          multiSelect: true,
          options: [
            { label: "Rewrite, then test", description: "" },
            { label: "Incremental", description: "" },
          ],
        },
      ],
    })
    const output = JSON.stringify({
      answers: [
        { header: "Pick", question: "Pick", selected: ["Rewrite, then test"] },
      ],
      declined: false,
    })
    renderWithIntl(
      <AskQuestionResultCard
        input={input}
        output={output}
        state="output-available"
      />
    )
    expand()

    // The pick is one whole array entry, so the comma is no obstacle: the real
    // option is checked and "Incremental" stays unchosen.
    expect(
      screen.getByRole("checkbox", { name: "Rewrite, then test" })
    ).toBeChecked()
    expect(
      screen.getByRole("checkbox", { name: "Incremental" })
    ).not.toBeChecked()
  })

  it("shows the dismissed note and checks nothing when declined", () => {
    renderWithIntl(
      <AskQuestionResultCard
        input={SINGLE_INPUT}
        output={JSON.stringify({ answers: [], declined: true })}
        state="output-available"
      />
    )

    // Collapsed capsule carries the dismissed note.
    expect(screen.getByText(result.declined)).toBeInTheDocument()
    expand()
    for (const radio of screen.getAllByRole("radio")) {
      expect(radio).not.toBeChecked()
    }
    expect(screen.queryByRole("button", { name: "Submit" })).toBeNull()
  })

  it("lays multiple questions out as tabs once expanded", () => {
    const input = JSON.stringify({
      questions: [
        {
          question: "First?",
          header: "First",
          multiSelect: false,
          options: [{ label: "X" }, { label: "Y" }],
        },
        {
          question: "Second?",
          header: "Second",
          multiSelect: false,
          options: [{ label: "P" }, { label: "Q" }],
        },
      ],
    })
    const output = JSON.stringify({
      answers: [
        { header: "First", question: "First?", selected: ["X"] },
        { header: "Second", question: "Second?", selected: ["Q"] },
      ],
      declined: false,
    })
    renderWithIntl(
      <AskQuestionResultCard
        input={input}
        output={output}
        state="output-available"
      />
    )
    expand()

    const tabs = screen.getAllByRole("tab")
    expect(tabs).toHaveLength(2)
    expect(within(tabs[0]).getByText("First")).toBeInTheDocument()
    expect(within(tabs[1]).getByText("Second")).toBeInTheDocument()
  })

  it("shows an awaiting state with question chips while in flight", () => {
    renderWithIntl(
      <AskQuestionResultCard input={SINGLE_INPUT} state="input-available" />
    )

    expect(screen.getByText(result.awaiting)).toBeInTheDocument()
    // Compact in-flight view: header chip only, no option controls.
    expect(screen.getByText("Approach")).toBeInTheDocument()
    expect(screen.queryByRole("radio")).toBeNull()
  })

  it("renders nothing for an in-flight question whose input hasn't streamed in", () => {
    // claude-agent-acp's arg-less initial tool_call leaves the input empty, so no
    // question parses. The live question is answered via the pinned card, so this
    // in-stream placeholder is pure noise — it must not render an anonymous
    // "awaiting your answer" card (they stacked into visible duplicates).
    const { container } = renderWithIntl(
      <AskQuestionResultCard input="{}" state="input-available" />
    )
    expect(container.firstChild).toBeNull()
    expect(screen.queryByText(result.awaiting)).not.toBeInTheDocument()
  })

  it("matches grok's header-less questions to their empty-header answers", () => {
    // Grok's native ask carries no `header`; the connection bridge (live) and the
    // history parser both emit header-less questions + answers with `header: ""`.
    // The answer↔question match key (header + question) must still align so the
    // capsule shows the pick, not the "no selection" fallback. Regression guard
    // for the in-stream grok card (both the live and reloaded paths).
    const input = JSON.stringify({
      questions: [
        {
          question: "你更喜欢哪种演示方式？",
          multiSelect: false,
          options: [
            { label: "单选示例", description: "" },
            { label: "多选示例", description: "" },
            { label: "随便看看", description: "" },
          ],
        },
      ],
    })
    const output = JSON.stringify({
      answers: [
        {
          header: "",
          question: "你更喜欢哪种演示方式？",
          selected: ["随便看看"],
        },
      ],
      declined: false,
    })
    renderWithIntl(
      <AskQuestionResultCard
        input={input}
        output={output}
        state="output-available"
      />
    )

    // Collapsed capsule shows the pick — NOT the noSelection fallback.
    expect(screen.getByText("随便看看")).toBeInTheDocument()
    expect(screen.queryByText(result.noSelection)).toBeNull()
    // Expanded: the question renders and the chosen option is checked + disabled.
    expand()
    const chosen = screen.getByRole("radio", { name: "随便看看" })
    expect(chosen).toBeChecked()
    expect(chosen).toBeDisabled()
  })

  it("shows the pick for pi's extension-UI select (#644)", () => {
    // pi asks through `session/request_permission`, so nothing about the answer
    // reaches the transcript on its own — the connection bridge synthesizes this
    // completed tool call once the user submits (`try_bridge_pi_select_ask`).
    // Captured verbatim from a live pi-acp 0.0.33 run; the option labels carry
    // pi's own "N. " numbering. Regression guard for "after picking you can't
    // see which one you chose".
    const question =
      "[未提交改动] 当前分支有未提交的 AddIOP.cs 修改；创建热修复分支时应如何处理？"
    const picked = "2. 独立 worktree — 保留当前工作区不动"
    const input = JSON.stringify({
      questions: [
        {
          multiSelect: false,
          question,
          options: [
            {
              description: "",
              label:
                "1. 暂存后切分支 (Recommended) — 把当前改动保存到具名 stash",
            },
            { description: "", label: picked },
            { description: "", label: "3. 携带改动切换 — 直接创建并切换分支" },
            { description: "", label: "4. Type something." },
          ],
        },
      ],
    })
    const output = JSON.stringify({
      answers: [
        { header: "", multi_select: false, question, selected: [picked] },
      ],
      declined: false,
    })
    renderWithIntl(
      <AskQuestionResultCard
        input={input}
        output={output}
        state="output-available"
      />
    )

    expect(screen.getByText(picked)).toBeInTheDocument()
    expect(screen.queryByText(result.noSelection)).toBeNull()
    expand()
    const chosen = screen.getByRole("radio", { name: picked })
    expect(chosen).toBeChecked()
    expect(chosen).toBeDisabled()
  })

  it("echoes opencode's answer, which arrives only as the result text", () => {
    // OpenCode drops the MCP `structuredContent` and keeps just the companion's
    // human-readable text — the same string on the live ACP wire and in
    // opencode.db, so the text fallback is this agent's ONLY path to the pick.
    // (Live, that string reaches here only because the backend unwraps
    // OpenCode's `{output, metadata}` envelope — see `opencode_live_tool_output`;
    // shipping the envelope rendered this answered question as "no selection".)
    const input = JSON.stringify({
      questions: [
        {
          question: "选一个前端框架",
          header: "框架",
          multiSelect: false,
          options: [
            { label: "选项 A", description: "a" },
            { label: "选项 B", description: "b" },
          ],
        },
      ],
    })
    const output =
      "The user answered your question(s):\n" +
      "1. [框架] 选一个前端框架\n" +
      "   → 选项 A\n"
    renderWithIntl(
      <AskQuestionResultCard
        input={input}
        output={output}
        state="output-available"
      />
    )

    expect(screen.getByText("选项 A")).toBeInTheDocument()
    expect(screen.queryByText(result.noSelection)).toBeNull()
    expand()
    // Accessible name is the option label + its description.
    const chosen = screen.getByRole("radio", { name: "选项 A a" })
    expect(chosen).toBeChecked()
    expect(screen.getByRole("radio", { name: "选项 B b" })).not.toBeChecked()
    expect(chosen).toBeDisabled()
  })

  it("echoes kimi's answers keyed by bare question text", () => {
    // The reported bug: Kimi Code's native AskUserQuestion persists
    // {"answers":{"<question text>":"<label>"}} — string values keyed by the
    // question TEXT, no header. The card showed "no selection" (live and
    // reloaded) because the string values parsed to empty selections and the
    // header+question signature never matched. Input/output verbatim from a
    // real kimi wire.jsonl.
    const input = JSON.stringify({
      questions: [
        {
          question: "你最近在用哪种编程语言最多？",
          header: "编程",
          options: [
            { label: "Rust", description: "系统级编程语言" },
            { label: "TypeScript", description: "前端/全栈开发" },
            { label: "Python", description: "脚本/数据/AI" },
            { label: "Go", description: "后端/云原生" },
          ],
        },
      ],
    })
    const output = JSON.stringify({
      answers: { "你最近在用哪种编程语言最多？": "Rust" },
    })
    renderWithIntl(
      <AskQuestionResultCard
        input={input}
        output={output}
        state="output-available"
      />
    )

    // Collapsed capsule echoes the pick — NOT the noSelection fallback.
    expect(screen.getByText("Rust")).toBeInTheDocument()
    expect(screen.queryByText(result.noSelection)).toBeNull()
    // Expanded: the answer (keyed by question text alone) still seeds the
    // header-carrying question; the chosen option is checked + disabled.
    expand()
    const chosen = screen.getByRole("radio", { name: /Rust/ })
    expect(chosen).toBeChecked()
    expect(chosen).toBeDisabled()
    expect(screen.getByRole("radio", { name: /Python/ })).not.toBeChecked()
  })

  it("echoes codex request_user_input answers keyed by question id", () => {
    // The reported bug: codex Plan-mode `request_user_input` rendered "no
    // selection" because its answer envelope is keyed by the question id
    // ({answers:{<id>:{answers:[label]}}}), not the codeg-mcp array shape. The
    // card must match the answer to the question by that id and echo the pick.
    const input = JSON.stringify({
      questions: [
        {
          id: "drink_preference",
          header: "饮品偏好",
          question: "工作时你更喜欢喝哪一种饮品？",
          options: [
            { label: "咖啡（推荐）", description: "浓郁提神" },
            { label: "茶", description: "清爽温和" },
            { label: "果汁", description: "甜味水果" },
          ],
        },
      ],
    })
    const output = JSON.stringify({
      answers: { drink_preference: { answers: ["咖啡（推荐）"] } },
    })
    renderWithIntl(
      <AskQuestionResultCard
        input={input}
        output={output}
        state="output-available"
      />
    )

    // Collapsed capsule echoes the pick — NOT the noSelection fallback.
    expect(screen.getByText("咖啡（推荐）")).toBeInTheDocument()
    expect(screen.queryByText(result.noSelection)).toBeNull()
    // Expanded: the chosen option is checked + disabled, others not. (The radio's
    // accessible name folds in its description, so match on the label substring.)
    expand()
    const chosen = screen.getByRole("radio", { name: /咖啡/ })
    expect(chosen).toBeChecked()
    expect(chosen).toBeDisabled()
    expect(screen.getByRole("radio", { name: /茶/ })).not.toBeChecked()
  })
})
