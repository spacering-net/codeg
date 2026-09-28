import { type ReactNode } from "react"
import { render } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

/**
 * codex-acp 1.10 moves a shell into the background and NEVER completes the tool
 * call that launched it — the turn ends `end_turn` with the card still
 * `in_progress`, and the process outlives the connection's idea of the turn. The
 * only thing that says so is a `tool_call_update` carrying nothing but the id
 * and `_meta.jetbrains.air.asyncTasks.backgrounded`, so the badge derived from
 * it is the difference between "running detached" and "apparently hung".
 *
 * The badge is deliberately the SAME copy Claude's parsed launch notice uses:
 * one claim, two wire sources.
 */

vi.mock("@/components/ai-elements/link-safety", () => ({
  FilePathLink: ({ children }: { children: ReactNode }) => (
    <span>{children}</span>
  ),
  useStreamdownLinkSafety: () => ({ enabled: false }),
}))

vi.mock("@/components/ai-elements/code-block", () => ({
  CodeBlock: ({ code }: { code: string }) => <pre>{code}</pre>,
}))

vi.mock("@/components/ai-elements/message", () => ({
  MessageResponse: ({ children }: { children: string }) => (
    <div>{children}</div>
  ),
}))

import { ContentPartsRenderer } from "./content-parts-renderer"
import enMessages from "@/i18n/messages/en.json"
import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"

const BADGE = enMessages.Folder.chat.contentParts.backgroundTask
  .runningInBackground as string

type AdaptedToolCallPart = Extract<AdaptedContentPart, { type: "tool-call" }>

/** The live shape of codex's backgrounded `sleep 400`, merged as the reducer
 *  would: the opening `tool_call` plus the `_meta` from its lone update. */
function codexBackgroundedExec(
  meta: Record<string, unknown> | null
): AdaptedToolCallPart {
  return {
    type: "tool-call",
    toolCallId: "exec-74096479-1a0d-4c6d-bbfa-ae10fce94da2",
    toolName: "bash",
    displayTitle: "sleep 400",
    input: JSON.stringify({ command: "sleep 400", cwd: "/tmp/work" }),
    // Still in flight, and it stays that way — that is the whole problem.
    state: "input-available",
    toolStatus: "in_progress",
    meta,
  }
}

function renderPart(part: AdaptedContentPart) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ContentPartsRenderer parts={[part]} role="assistant" />
    </NextIntlClientProvider>
  )
}

const AIR_BACKGROUNDED = {
  jetbrains: { air: { asyncTasks: { backgrounded: true } } },
}

describe("command card — AIR backgrounded marker", () => {
  it("badges a codex call that was moved to the background", () => {
    const { container } = renderPart(codexBackgroundedExec(AIR_BACKGROUNDED))
    expect(container.textContent).toContain(BADGE)
  })

  it("keeps the badge through COMPLETE_TURN promotion", () => {
    // Promotion re-adapts the part with `isStreaming=false`, flipping `state` to
    // `output-available` while the forwarded ACP status stays `in_progress`.
    // The process is still running, so the badge must survive that flip — which
    // a bare `state` check would not.
    const { container } = renderPart({
      ...codexBackgroundedExec(AIR_BACKGROUNDED),
      state: "output-available",
      toolStatus: "in_progress",
    })
    expect(container.textContent).toContain(BADGE)
  })

  it("drops the badge once the call settles", () => {
    // codex settles the launching call when the process finally exits (or a
    // `_session/async_task/stop` lands: `status:"failed"`, exit -1). The reducer
    // keeps the stored meta when an update carries none, so the stale marker can
    // still be attached here — "Background" on a finished command would be a
    // lie, and the strip has already dropped its row.
    //
    // Reached when the settle lands inside the turn, or after a detail reload;
    // an out-of-turn settle is routed to `outOfTurnToolCalls` and never revises
    // this part at all (pre-existing reducer behaviour, not the marker's).
    const { container } = renderPart({
      ...codexBackgroundedExec(AIR_BACKGROUNDED),
      state: "output-available",
      toolStatus: "failed",
      output: "",
    })
    expect(container.textContent).not.toContain(BADGE)
  })

  it("leaves an ordinary in-flight command unbadged", () => {
    const { container } = renderPart(codexBackgroundedExec(null))
    expect(container.textContent).not.toContain(BADGE)
  })

  it("does not badge on the AIR session-failure block that shares the envelope", () => {
    // `jetbrains.air` also carries `sessionFailure`. Matching the envelope
    // rather than the `asyncTasks.backgrounded` leaf would badge every command
    // in a turn that hit a rate limit.
    const { container } = renderPart(
      codexBackgroundedExec({
        jetbrains: {
          air: {
            version: 1,
            sessionFailure: { id: "t:error", revision: 1, severity: "warning" },
          },
        },
      })
    )
    expect(container.textContent).not.toContain(BADGE)
  })
})

describe("command card — claude's parsed launch badge is unaffected", () => {
  /**
   * The two arms share one badge but not one gate: claude's launch call
   * COMPLETES the moment it hands back the task id, so gating that arm on
   * "unsettled" — as the AIR arm is — would delete a badge that has been correct
   * since it shipped.
   */
  it("badges a settled Bash(run_in_background) launch", () => {
    const { container } = renderPart({
      type: "tool-call",
      toolCallId: "toolu_01",
      toolName: "bash",
      displayTitle: "pnpm dev",
      input: JSON.stringify({ command: "pnpm dev", run_in_background: true }),
      state: "output-available",
      toolStatus: "completed",
      output:
        "Command running in background with ID: bash_1. Output is being " +
        "written to: /tmp/tasks/bash_1.output",
    })
    expect(container.textContent).toContain(BADGE)
  })
})
