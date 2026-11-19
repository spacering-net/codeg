import { describe, expect, it } from "vitest"

import { extractLatestPlanEntriesFromMessages } from "./agent-plan"
import type { AdaptedMessage } from "@/lib/adapters/ai-elements-adapter"

describe("extractLatestPlanEntriesFromMessages", () => {
  it("finds plan updates nested inside a goal run", () => {
    const messages: AdaptedMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        timestamp: "2026-06-02T00:00:00.000Z",
        content: [
          {
            type: "goal-run",
            start: {
              type: "tool-call",
              toolCallId: "create-goal",
              toolName: "create_goal",
              input: JSON.stringify({ objective: "Analyze README" }),
              state: "output-available",
            },
            end: null,
            items: [
              {
                type: "tool-call",
                toolCallId: "plan",
                toolName: "update_plan",
                input: JSON.stringify({
                  plan: [{ content: "Read README", status: "completed" }],
                }),
                state: "output-available",
              },
            ],
            isRunning: true,
          },
        ],
      },
    ]

    expect(extractLatestPlanEntriesFromMessages(messages)).toEqual([
      {
        content: "Read README",
        status: "completed",
        priority: "medium",
      },
    ])
  })

  function planToolCall(
    id: string,
    entries: { content: string; status: string }[]
  ): AdaptedMessage {
    return {
      id,
      role: "assistant",
      timestamp: "2026-06-02T00:00:00.000Z",
      content: [
        {
          type: "tool-call",
          toolCallId: `${id}-plan`,
          toolName: "TodoWrite",
          input: JSON.stringify({ todos: entries }),
          state: "output-available",
        },
      ],
    } as AdaptedMessage
  }

  function userMessage(id: string): AdaptedMessage {
    return {
      id,
      role: "user",
      timestamp: "2026-06-02T00:00:00.000Z",
      content: [{ type: "text", text: "do it" }],
    } as AdaptedMessage
  }

  function assistantText(id: string): AdaptedMessage {
    return {
      id,
      role: "assistant",
      timestamp: "2026-06-02T00:00:00.000Z",
      content: [{ type: "text", text: "done" }],
    } as AdaptedMessage
  }

  it("hides a completed plan once the user has replied after it", () => {
    const messages: AdaptedMessage[] = [
      planToolCall("a1", [
        { content: "Step one", status: "completed" },
        { content: "Step two", status: "completed" },
      ]),
      userMessage("u1"),
      assistantText("a2"),
    ]
    expect(extractLatestPlanEntriesFromMessages(messages)).toEqual([])
  })

  it("keeps a completed plan that belongs to the latest agent reply", () => {
    const messages: AdaptedMessage[] = [
      userMessage("u1"),
      planToolCall("a1", [{ content: "Step one", status: "completed" }]),
    ]
    expect(extractLatestPlanEntriesFromMessages(messages)).toEqual([
      { content: "Step one", status: "completed", priority: "medium" },
    ])
  })

  it("keeps a completed plan when only assistant messages follow it", () => {
    // Consecutive assistant messages (no user message between) are the same
    // reply, so the completed plan stays visible.
    const messages: AdaptedMessage[] = [
      planToolCall("a1", [{ content: "Step one", status: "completed" }]),
      assistantText("a2"),
    ]
    expect(extractLatestPlanEntriesFromMessages(messages)).toEqual([
      { content: "Step one", status: "completed", priority: "medium" },
    ])
  })

  it("keeps an incomplete plan even after a later user message", () => {
    // Only fully completed plans are treated as stale.
    const messages: AdaptedMessage[] = [
      planToolCall("a1", [
        { content: "Step one", status: "completed" },
        { content: "Step two", status: "in_progress" },
      ]),
      userMessage("u1"),
      assistantText("a2"),
    ]
    expect(extractLatestPlanEntriesFromMessages(messages)).toEqual([
      { content: "Step one", status: "completed", priority: "medium" },
      { content: "Step two", status: "in_progress", priority: "medium" },
    ])
  })
})

// Claude Code under the SDK keeps its checklist with the Task tools, not
// TodoWrite. Live, the adapter folds them into ACP `plan` updates; a reopened
// (or just-settled) conversation is parsed from the CLI's JSONL, where they are
// plain tool calls with the result texts below (CLI 2.1.x).
describe("extractLatestPlanEntriesFromMessages — Claude Code Task tools", () => {
  function call(
    name: string,
    input: unknown,
    output: string | null,
    state: "output-available" | "output-error" = "output-available"
  ) {
    return {
      type: "tool-call" as const,
      toolCallId: `${name}-${Math.random()}`,
      toolName: name,
      input: JSON.stringify(input),
      state,
      output,
    }
  }
  function assistant(
    id: string,
    ...content: ReturnType<typeof call>[]
  ): AdaptedMessage {
    return {
      id,
      role: "assistant",
      timestamp: "2026-11-19T00:00:00.000Z",
      content,
    } as AdaptedMessage
  }
  function user(id: string): AdaptedMessage {
    return {
      id,
      role: "user",
      timestamp: "2026-11-19T00:00:00.000Z",
      content: [{ type: "text", text: "go on" }],
    } as AdaptedMessage
  }
  const create = (id: string, subject: string, activeForm?: string) =>
    call(
      "TaskCreate",
      { subject, description: `${subject} in detail`, activeForm },
      `Task #${id} created successfully: ${subject}`
    )
  const update = (taskId: string, fields: Record<string, unknown>) =>
    call(
      "TaskUpdate",
      { taskId, ...fields },
      `Updated task #${taskId} ${Object.keys(fields).join(", ")}`
    )

  it("builds the checklist from TaskCreate and TaskUpdate across messages", () => {
    const messages = [
      user("u1"),
      assistant(
        "a1",
        create("1", "Read the parser", "Reading the parser"),
        create("2", "Fix the bug")
      ),
      assistant("a2", update("1", { status: "completed" })),
      assistant("a3", update("2", { status: "in_progress" })),
    ]
    expect(extractLatestPlanEntriesFromMessages(messages)).toEqual([
      { content: "Read the parser", status: "completed", priority: "medium" },
      { content: "Fix the bug", status: "in_progress", priority: "medium" },
    ])
  })

  it("shows activeForm for the task in progress, like the live plan", () => {
    const messages = [
      assistant(
        "a1",
        create("1", "Run tests", "Running tests"),
        update("1", { status: "in_progress" })
      ),
    ]
    expect(extractLatestPlanEntriesFromMessages(messages)).toEqual([
      { content: "Running tests", status: "in_progress", priority: "medium" },
    ])
  })

  it("drops deleted tasks and ignores failed or unconfirmed calls", () => {
    const messages = [
      assistant(
        "a1",
        create("1", "Keep me"),
        create("2", "Delete me"),
        // No result yet (interrupted): no task id, so no task.
        call("TaskCreate", { subject: "Never created" }, null),
        call("TaskCreate", { subject: "Errored" }, "boom", "output-error"),
        update("2", { status: "deleted" }),
        call(
          "TaskUpdate",
          { taskId: "9", subject: "Ghost", status: "in_progress" },
          "Task #9 not found"
        )
      ),
    ]
    expect(extractLatestPlanEntriesFromMessages(messages)).toEqual([
      { content: "Keep me", status: "pending", priority: "medium" },
    ])
  })

  it("ignores a TaskUpdate whose result is a refusal", () => {
    const refused = (text: string) =>
      call(
        "TaskUpdate",
        { taskId: "1", subject: "Renamed", status: "completed" },
        text
      )
    const messages = [
      assistant(
        "a1",
        create("1", "Original"),
        // The CLI's `error || "Task #N not found"`: any refusal text.
        refused("Task not found"),
        refused("Finish the tests before completing this task."),
        refused("Updated task #12 status"),
        call(
          "TaskUpdate",
          { taskId: "7", subject: "Never saved" },
          "Task not found"
        )
      ),
    ]
    expect(extractLatestPlanEntriesFromMessages(messages)).toEqual([
      { content: "Original", status: "pending", priority: "medium" },
    ])
  })

  it("keeps tasks whose TaskCreate is outside the loaded turns", () => {
    // A reopened long session: the creates are in older, not-yet-loaded turns.
    const messages = [
      assistant("a40", create("3", "Write docs")),
      assistant("a41", update("1", { status: "completed" })),
      assistant(
        "a42",
        update("2", { status: "in_progress", activeForm: "Fixing the bug" })
      ),
    ]
    expect(extractLatestPlanEntriesFromMessages(messages)).toEqual([
      { content: "Task #1", status: "completed", priority: "medium" },
      { content: "Fixing the bug", status: "in_progress", priority: "medium" },
      { content: "Write docs", status: "pending", priority: "medium" },
    ])
    // An update that states no status says nothing about an unseen task: it
    // may well be done already.
    expect(
      extractLatestPlanEntriesFromMessages([
        assistant("a40", update("1", { description: "More detail" })),
      ])
    ).toEqual([])
    // …but its labels are kept for the update that does.
    expect(
      extractLatestPlanEntriesFromMessages([
        assistant(
          "a40",
          update("1", { subject: "Fix login", activeForm: "Fixing login" })
        ),
        assistant("a41", update("1", { status: "in_progress" })),
      ])
    ).toEqual([
      { content: "Fixing login", status: "in_progress", priority: "medium" },
    ])
  })

  it("lets TaskList replace the accumulated list", () => {
    const messages = [
      assistant("a1", create("1", "Stale")),
      assistant(
        "a2",
        call(
          "TaskList",
          {},
          "#2 [in_progress] Fresh (main) [blocked by #3]\n#3 [pending] Next"
        )
      ),
    ]
    expect(extractLatestPlanEntriesFromMessages(messages)).toEqual([
      { content: "Fresh", status: "in_progress", priority: "medium" },
      { content: "Next", status: "pending", priority: "medium" },
    ])
    const cleared = [
      ...messages,
      assistant("a3", call("TaskList", {}, "No tasks found")),
    ]
    expect(extractLatestPlanEntriesFromMessages(cleared)).toEqual([])
  })

  it("the later checklist wins between Task tools and TodoWrite", () => {
    const todoWrite = (id: string, content: string) =>
      ({
        id,
        role: "assistant",
        timestamp: "2026-11-19T00:00:00.000Z",
        content: [
          {
            type: "tool-call",
            toolCallId: `${id}-todo`,
            toolName: "TodoWrite",
            input: JSON.stringify({ todos: [{ content, status: "pending" }] }),
            state: "output-available",
          },
        ],
      }) as AdaptedMessage
    expect(
      extractLatestPlanEntriesFromMessages([
        assistant("a1", create("1", "From tasks")),
        todoWrite("a2", "From TodoWrite"),
      ])
    ).toEqual([
      { content: "From TodoWrite", status: "pending", priority: "medium" },
    ])
    expect(
      extractLatestPlanEntriesFromMessages([
        todoWrite("a1", "From TodoWrite"),
        assistant("a2", create("1", "From tasks")),
      ])
    ).toEqual([
      { content: "From tasks", status: "pending", priority: "medium" },
    ])
  })

  it("hides a fully completed task list once the user has replied", () => {
    const messages = [
      assistant(
        "a1",
        create("1", "Only step"),
        update("1", { status: "completed" })
      ),
      user("u2"),
    ]
    expect(extractLatestPlanEntriesFromMessages(messages)).toEqual([])
  })
})
