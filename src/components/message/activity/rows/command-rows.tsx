"use client"

import { memo, useMemo } from "react"
import Ansi from "ansi-to-react"
import { useTranslations } from "next-intl"

import {
  TokenSpan,
  useHighlightedTokens,
} from "@/components/ai-elements/code-block"
import { useElapsedLabel } from "@/hooks/use-elapsed-label"
import { useTruncation } from "@/hooks/use-truncation"
import { normalizeCommandOutput } from "@/lib/activity/command"
import {
  codeModeCalls,
  parseScriptCard,
  type CodeModeCall,
} from "@/lib/activity/code-mode"
import { parseCodexScriptMeta } from "@/lib/codex-code-mode"
import { countLines } from "@/lib/activity/format"
import type { StepStatus } from "@/lib/activity/types"
import { describeStdinChars } from "@/lib/shell-session-tool"
import { cn } from "@/lib/utils"
import { useActivityRender } from "../activity-context"
import { ActivityMembers, ActivityRow, useGroupPlace } from "../activity-row"
import { CopyAction, DetailBox, DetailScroll } from "../detail-box"
import { useDisclosure } from "../disclosure-store"
import { SlideSlot } from "../../slide-slot"
import { RailIcon } from "../rail-icon"
import {
  GROUP_ICON,
  ToolFigure,
  toolIcon,
  useStatusText,
} from "../step-visuals"
import {
  formatClock,
  LIVE_CLOCK_AFTER_MS,
  useLiveElapsed,
} from "../use-live-elapsed"
import type { ToolStep } from "./explore-rows"
import { useAwaitedStep, useLiveToolStep } from "../use-live-step"

/** Tail of a running command's output kept for display. */
const LIVE_OUTPUT_CHARS = 24_000
/** Settled output rendered in full up to this many lines; then only the end. */
const MAX_OUTPUT_LINES = 2_000
/** Lines of a running command shown under its folded row. */
const LIVE_TAIL_LINES = 3
/** Below this a command's duration is noise. */
const SHOW_DURATION_MS = 10_000

/**
 * Some runtimes deliver ANSI escapes as literal "\u001b" / "\x1b" text;
 * decode them so the colours render (same rule as the terminal card).
 */
function decodeEscapedAnsi(output: string): string {
  if (!/\\u001b|\\x1b|\\u009b/i.test(output)) return output
  return output
    .replace(/\\u001b/gi, "\u001b")
    .replace(/\\x1b/gi, "\u001b")
    .replace(/\\u009b/gi, "\u009b")
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
}

interface CommandOutput {
  text: string
  lines: number
  /** Lines dropped from the front to stay under the render cap. */
  truncated: number
}

function useCommandOutput(step: ToolStep): CommandOutput | null {
  const t = useTranslations("Folder.chat.contentParts")
  const { part, tool } = step
  return useMemo(() => {
    if (tool.background?.taskId && part.output) {
      // The result is the CLI's note to the model that the work went on in
      // the background; the reader gets which task it is.
      const text = t(
        tool.kind === "monitor"
          ? "backgroundTask.monitorNote"
          : "backgroundTask.launchNote",
        { id: tool.background.taskId }
      )
      return { text, lines: 1, truncated: 0 }
    }
    const source = part.output ?? part.errorText ?? null
    if (!source) return null
    let text = decodeEscapedAnsi(normalizeCommandOutput(source))
    const live = tool.status === "running" || tool.status === "pending"
    if (live && text.length > LIVE_OUTPUT_CHARS) {
      text = text.slice(-LIVE_OUTPUT_CHARS)
    }
    text = text.replace(/\n+$/, "")
    if (!text.trim()) return null
    const lines = countLines(text)
    if (lines > MAX_OUTPUT_LINES) {
      const all = text.split("\n")
      return {
        text: all.slice(-MAX_OUTPUT_LINES).join("\n"),
        lines,
        truncated: lines - MAX_OUTPUT_LINES,
      }
    }
    return { text, lines, truncated: 0 }
  }, [part.output, part.errorText, tool.background, tool.kind, tool.status, t])
}

/** What a command row says: a fixed "Command", then the agent's description
 *  of the command when it gave one, else the command line (a heredoc's opener
 *  for a heredoc); codex's session polls and scripts lead with their own verb.
 *  All of it in the label's light ink: a command line is long and dense, and
 *  in the body colour it would outweigh every other row. `commandRef`
 *  measures whether the line cuts the command short. */
function CommandLabel({
  step,
  commandRef,
}: {
  step: ToolStep
  commandRef?: (node: HTMLSpanElement | null) => void
}) {
  const t = useTranslations("Folder.chat.activity")
  const tParts = useTranslations("Folder.chat.contentParts")
  const command = step.tool.command
  const scriptMeta = useMemo(
    () => parseCodexScriptMeta(step.part.meta),
    [step.part.meta]
  )
  if (!command) return null

  if (command.session) {
    const verb =
      command.session.verb === "stdin"
        ? t("row.sessionStdin")
        : command.session.verb === "terminate"
          ? t("row.sessionTerminate")
          : t("row.sessionWait")
    const target = command.session.stdin
      ? describeStdinChars(command.session.stdin)
      : command.display ||
        (command.session.sessionId
          ? t("row.sessionCell", { id: command.session.sessionId })
          : "")
    return (
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="shrink-0 font-medium text-activity-secondary">
          {verb}
        </span>
        <span
          className="min-w-0 truncate font-mono text-[0.8125rem] text-activity-secondary"
          dir="ltr"
        >
          {target}
        </span>
      </span>
    )
  }

  if (step.tool.kind === "script") {
    return (
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="shrink-0 font-medium text-activity-secondary">
          {t("row.codexScript")}
        </span>
        {command.display ? (
          <span
            className="min-w-0 truncate font-mono text-[0.8125rem] text-activity-secondary"
            dir="ltr"
          >
            {command.display}
          </span>
        ) : null}
        {command.lineCount > 0 ? (
          <span className="shrink-0 text-activity-secondary">
            {t("row.script", { count: command.lineCount })}
          </span>
        ) : null}
      </span>
    )
  }

  const heredoc = command.heredoc
  const firstLine = heredoc ? heredoc.head : command.display.split("\n")[0]!
  const extraLines = heredoc ? 0 : command.lineCount - 1
  const live = step.tool.status === "running" || step.tool.status === "pending"
  // One line: the label, then the title, which gives way first (the panel and
  // the tooltip have it whole); its notes keep their room, and nothing runs
  // past the line's end. A description is words, with nothing about the
  // command's lines — the command is atop the panel.
  return (
    <span className="flex min-w-0 items-baseline gap-2 overflow-hidden">
      <span
        className={cn(
          "shrink-0 font-medium",
          live ? "activity-shimmer" : "text-activity-secondary"
        )}
      >
        {step.tool.kind === "monitor" ? t("row.monitor") : t("row.command")}
      </span>
      {command.description ? (
        <span dir="auto" className="min-w-0 truncate text-activity-secondary">
          {command.description}
        </span>
      ) : (
        <>
          <span
            ref={commandRef}
            className="min-w-0 truncate font-mono text-[0.8125rem] text-activity-secondary"
            dir="ltr"
          >
            {firstLine}
          </span>
          {heredoc ? (
            <span className="shrink-0 text-activity-secondary">
              {t("row.script", { count: heredoc.bodyLines })}
            </span>
          ) : extraLines > 0 ? (
            <span className="shrink-0 text-activity-secondary">
              {t("row.moreLines", { count: extraLines })}
            </span>
          ) : null}
        </>
      )}
      {scriptMeta?.label ? (
        <span className="shrink-0 self-center rounded-full bg-muted px-1.5 text-3xs leading-4 text-activity-muted-strong ws-msg-chip">
          {scriptMeta.label}
        </span>
      ) : null}
      {command.announcedSession ? (
        <span className="shrink-0 font-mono text-xs text-activity-secondary">
          {tParts("shellSession", { id: command.announcedSession })}
        </span>
      ) : null}
      {step.tool.background ? (
        <span className="shrink-0 self-center rounded-full bg-muted px-1.5 font-mono text-3xs leading-4 text-activity-muted-strong ws-msg-chip">
          {step.tool.background.taskId
            ? t("row.background", { id: step.tool.background.taskId })
            : t("row.backgroundShort")}
        </span>
      ) : null}
    </span>
  )
}

/** Columns to a tab stop: the app's `tab-size` (Tailwind's preflight). */
const TAB_SIZE = 4

/** A line with its tabs spelled out as the spaces to the next tab stop. A
 *  hanging indent moves where a line starts, and a browser sets tab stops
 *  from the block's edge, not the line's: a tab left in lands short. */
function expandTabs(line: string): string {
  if (!line.includes("\t")) return line
  let out = ""
  for (const char of line) {
    out += char === "\t" ? " ".repeat(TAB_SIZE - (out.length % TAB_SIZE)) : char
  }
  return out
}

/** Longest argument preview a script call's line shows. */
const CALL_INPUT_CHARS = 160

function callInputPreview(input: Record<string, unknown> | null): string {
  if (!input || Object.keys(input).length === 0) return ""
  const text = JSON.stringify(input)
  return text.length > CALL_INPUT_CHARS
    ? `${text.slice(0, CALL_INPUT_CHARS - 1)}…`
    : text
}

/** The tools a code-mode script called, one per line, with how each ended. */
function ScriptCalls({ calls }: { calls: CodeModeCall[] }) {
  return (
    <ul
      className="border-b border-foreground/5 px-4 py-2 font-mono text-[0.78125rem] leading-relaxed"
      dir="ltr"
    >
      {calls.map((call, index) => (
        <li key={index} className="flex min-w-0 items-baseline gap-2">
          <span
            aria-hidden
            className={cn(
              "shrink-0",
              call.status === "error"
                ? "text-destructive"
                : call.status === "running"
                  ? "text-muted-foreground"
                  : "text-emerald-500"
            )}
          >
            {call.status === "error"
              ? "✕"
              : call.status === "running"
                ? "…"
                : "✓"}
          </span>
          <span className="shrink-0 text-foreground">{call.tool}</span>
          <span className="min-w-0 truncate text-activity-secondary">
            {callInputPreview(call.input)}
          </span>
        </li>
      ))}
    </ul>
  )
}

/**
 * A code-mode script (codex's or OpenCode's), set in its panel the way a
 * command is: flush, at the output's size, in the colours of the app's code
 * blocks. Its lines wrap, as the command's and the output's do, so all of a
 * line reads without a sideways scroll; a wrapped line hangs two columns in
 * from its own indent, so it never reads as the next line. A long script
 * scrolls on its own under a lower cap than the output's, which keeps its
 * full height beneath it.
 */
function ScriptSource({ source }: { source: string }) {
  const code = useMemo(
    () => source.replace(/\n+$/, "").split("\n").map(expandTabs).join("\n"),
    [source]
  )
  const { tokens } = useHighlightedTokens(code, "javascript")
  const lines = useMemo(
    () =>
      tokens.map((line) => {
        const text = line.map((token) => token.content).join("")
        const indent = text.length - text.replace(/^ +/, "").length
        return { line, hang: `${indent + 2}ch` }
      }),
    [tokens]
  )
  return (
    <DetailScroll className="max-h-40 border-b border-foreground/5">
      <div
        className="px-4 py-3 font-mono text-[0.78125rem] leading-relaxed"
        dir="ltr"
      >
        {lines.map(({ line, hang }, index) => (
          <div
            key={index}
            className="whitespace-pre-wrap break-words"
            style={{ paddingLeft: hang, textIndent: `-${hang}` }}
          >
            {line.length === 0
              ? "\n"
              : line.map((token, at) => <TokenSpan key={at} token={token} />)}
          </div>
        ))}
      </div>
    </DetailScroll>
  )
}

function CommandDetail({
  step,
  output,
  commandCut,
}: {
  step: ToolStep
  output: CommandOutput | null
  /** The row's line cuts the command short: the panel shows it whole. */
  commandCut: boolean
}) {
  const t = useTranslations("Folder.chat.activity")
  const tParts = useTranslations("Folder.chat.contentParts")
  const { tool } = step
  const command = tool.command
  const failed = tool.status === "failed" || tool.status === "rejected"
  const live = tool.status === "running" || tool.status === "pending"
  const isScript = tool.kind === "script"
  // The command, whole, wherever the row does not show it so: under a
  // description, past its first line, or cut short.
  const showCommand =
    !isScript &&
    !!command &&
    !command.session &&
    (!!command.description || command.lineCount > 1 || commandCut) &&
    !!command.display
  const fullCommand = command?.display ?? ""
  const script = useMemo(
    () => (isScript ? parseScriptCard(step.part.input, step.part.meta) : null),
    [isScript, step.part.input, step.part.meta]
  )
  // The calls the script made, when the agent reports them (OpenCode's
  // `execute`; see `CODE_MODE_CALLS_META_KEY`).
  const calls = useMemo(
    () => (isScript ? codeModeCalls(step.part.meta) : []),
    [isScript, step.part.meta]
  )
  const scriptMeta = useMemo(
    () => parseCodexScriptMeta(step.part.meta),
    [step.part.meta]
  )
  // A script's panel copies the script; a command's, its command line.
  const copy = script
    ? { text: script.source, label: t("detail.copyScript") }
    : fullCommand && !command?.session
      ? { text: fullCommand, label: t("detail.copyCommand") }
      : null
  // Opened on a failure or a running command, the output shows its end,
  // where the error or the latest line is.
  const anchor = failed || live ? "end" : "start"
  const shownOutput = output ? (
    <>
      {output.truncated > 0 ? (
        <p className="px-4 pt-2 font-mono text-2xs text-muted-foreground">
          {t("detail.tailOnly", { count: MAX_OUTPUT_LINES })}
        </p>
      ) : null}
      <pre
        className="activity-ansi whitespace-pre-wrap break-words px-4 py-3 font-mono text-[0.78125rem] leading-relaxed"
        dir="ltr"
      >
        <Ansi>{output.text}</Ansi>
      </pre>
    </>
  ) : (
    <p className="px-4 py-3 text-xs text-muted-foreground">
      {t("detail.noOutput")}
    </p>
  )

  // A script and its output each scroll on their own, one above the other
  // (the box does not), so a long script never pushes the output out of the
  // panel, and neither's scrollbar runs along the other's.
  return (
    <DetailBox
      tone={failed ? "danger" : "neutral"}
      anchor={script ? "start" : anchor}
      unbounded={!!script}
      footer={output ? t("detail.lines", { count: output.lines }) : null}
      actions={
        copy || output ? (
          <>
            {copy ? <CopyAction text={copy.text} label={copy.label} /> : null}
            {output ? (
              <CopyAction
                text={() => stripAnsi(output.text)}
                label={t("detail.copyOutput")}
              />
            ) : null}
          </>
        ) : null
      }
    >
      {script ? <ScriptSource source={script.source} /> : null}
      {calls.length > 0 ? <ScriptCalls calls={calls} /> : null}
      {scriptMeta?.sharedWith.length ? (
        <p className="border-b border-foreground/5 px-4 py-2 text-xs text-muted-foreground">
          {tParts("codexScript.sharedWith", {
            commands: scriptMeta.sharedWith.join(", "),
          })}
        </p>
      ) : null}
      {scriptMeta?.outputMissing ? (
        <p className="border-b border-foreground/5 px-4 py-2 text-xs text-muted-foreground">
          {tParts("codexScript.outputMissing")}
        </p>
      ) : scriptMeta?.truncated && !scriptMeta.sharedWith.length ? (
        <p className="border-b border-foreground/5 px-4 py-2 text-xs text-muted-foreground">
          {tParts("codexScript.truncated")}
        </p>
      ) : null}
      {showCommand ? (
        <pre
          className="whitespace-pre-wrap break-words border-b border-foreground/5 px-4 py-3 font-mono text-[0.78125rem] leading-relaxed"
          dir="ltr"
        >
          {command?.websocket ? null : (
            <span className="select-none text-muted-foreground">$ </span>
          )}
          {fullCommand}
        </pre>
      ) : null}
      {script && output ? (
        <DetailScroll anchor={anchor}>{shownOutput}</DetailScroll>
      ) : (
        shownOutput
      )}
    </DetailBox>
  )
}

/** A running command's last lines show once it has had output for this long:
 *  one that prints as it ends (some agents hand a command's output over only
 *  with its last update) never opens a gap under its row only to close it. */
const LIVE_TAIL_AFTER_MS = 500

/** The last few lines of a running command, under its folded row. */
function LiveTail({ text }: { text: string }) {
  const tail = useMemo(() => {
    const lines = stripAnsi(text)
      .split("\n")
      .filter((line) => line.trim().length > 0)
    return lines.slice(-LIVE_TAIL_LINES).join("\n")
  }, [text])
  return (
    <pre
      aria-hidden="true"
      className="mt-0.5 overflow-hidden whitespace-pre-wrap break-all font-mono text-2xs leading-4 text-muted-foreground/70"
      dir="ltr"
    >
      {tail}
    </pre>
  )
}

/**
 * `Command  Run web unit tests   exit 1` — a shell command (or codex's
 * session polls and scripts). The row says what the command is for, in the
 * agent's own description of it, and the panel opens on the command itself;
 * with no description the row shows the command, `Command  pnpm --filter web
 * test`. Folded however it ended: a command that exits non-zero is routine
 * (a grep with no match, a test run mid-fix), so a failure says so in red on
 * its line — and opens, output anchored at the end where the error is, when
 * the reader asks. Only a command waiting on the user's approval opens
 * itself. A running command stays folded with its last lines showing beneath.
 */
export const CommandRow = memo(function CommandRow({
  step: given,
  inGroup = false,
}: {
  step: ToolStep
  inGroup?: boolean
}) {
  const t = useTranslations("Folder.chat.activity")
  const statusText = useStatusText()
  const elapsedLabel = useElapsedLabel()
  const step = useLiveToolStep(given)
  const { tool } = step
  const output = useCommandOutput(step)
  const live = tool.status === "running" || tool.status === "pending"
  const [open, setOpen] = useDisclosure(step.key, {
    defaultOpen: false,
    force: tool.status === "awaiting",
  })
  // A codex fan-out command can come with no output of its own and only a
  // note saying why (the truncated output lost its separator); that note is
  // reason enough to open the row.
  const scriptMeta = useMemo(
    () => parseCodexScriptMeta(step.part.meta),
    [step.part.meta]
  )
  // The command on one line; cut short there, it opens the row to be read
  // whole.
  const { ref: commandRef, truncated: commandCut } =
    useTruncation<HTMLSpanElement>(tool.command?.display)
  const expandable =
    !!output ||
    !!tool.command?.description ||
    (tool.command?.lineCount ?? 0) > 1 ||
    commandCut ||
    !!scriptMeta?.outputMissing ||
    !!scriptMeta?.sharedWith.length
  const elapsed = useLiveElapsed(step.key, live)
  // How long the running command has had output to show, counted like its
  // clock: per step, so a row the virtual list brings back shows its tail as
  // it stands instead of opening it again.
  const outputAge = useLiveElapsed(
    `${step.key}:output`,
    live && output !== null
  )
  const clock =
    elapsed !== null && elapsed >= LIVE_CLOCK_AFTER_MS
      ? formatClock(elapsed)
      : null
  const duration =
    tool.status === "succeeded" &&
    tool.command?.durationMs != null &&
    tool.command.durationMs >= SHOW_DURATION_MS
      ? elapsedLabel(tool.command.durationMs)
      : null

  return (
    <ActivityRow
      stepKey={step.key}
      status={tool.status}
      variant={inGroup ? "child" : "main"}
      marker={
        <RailIcon
          icon={toolIcon(tool)}
          status={tool.status}
          size={inGroup ? "sm" : "md"}
          label={`${t(tool.kind === "monitor" ? "kind.monitor" : "kind.command")}, ${statusText(tool.status, tool.exit)}`}
        />
      }
      expandable={expandable}
      expanded={open}
      onExpandedChange={setOpen}
      title={tool.command?.description ?? tool.command?.display ?? undefined}
      approval={tool.approval}
      trailing={
        duration ??
        (clock ? (
          <span aria-hidden="true">{clock}</span>
        ) : (
          <ToolFigure tool={tool} />
        ))
      }
      addon={
        // Slides open under the row and shut when the command is done,
        // holding its last lines as it closes.
        <SlideSlot
          show={
            !open &&
            output !== null &&
            outputAge !== null &&
            outputAge >= LIVE_TAIL_AFTER_MS
          }
        >
          {output ? <LiveTail text={output.text} /> : null}
        </SlideSlot>
      }
      detail={() => (
        <CommandDetail step={step} output={output} commandCut={commandCut} />
      )}
    >
      <CommandLabel step={step} commandRef={commandRef} />
    </ActivityRow>
  )
})

/**
 * "Ran 2 commands · all passed". While the reply is being written it lists its
 * commands, one row each, as they run — its header names none of them — and
 * folds, sliding shut, once it has ended: the reply has moved past it (a step
 * or the answer follows, so no command joins it now) and none of its commands
 * is still going. A reply that is done folds them all. A failed member keeps
 * it open no more than a passing one does — the header counts the failures in
 * red — and what the reader chose stands. Open, its commands end on a foot
 * that turns while more may join the group, then folds it (`Collapse 3
 * commands`) — even with a command moved to the background still running in
 * it, which its own row shows. Folded, the member waiting on the user shows
 * under the header, and so does the one running while the group is the
 * reply's last row; once the reply has moved past, a member still running
 * stays inside.
 */
export const CommandGroupRow = memo(function CommandGroupRow({
  groupKey,
  steps,
  status: given,
  followed = false,
}: {
  groupKey: string
  steps: ToolStep[]
  status: StepStatus
  /** Something follows the group in the reply: a row, or the answer. */
  followed?: boolean
}) {
  const t = useTranslations("Folder.chat.activity")
  const statusText = useStatusText()
  const { isStreaming } = useActivityRender()
  const failures = steps.filter(
    (s) => s.tool.status === "failed" || s.tool.status === "rejected"
  )
  const awaited = useAwaitedStep(steps)
  const status = awaited ? "awaiting" : given
  const live = status === "running" || status === "pending"
  const ended = followed && !live && !awaited
  const { current, going } = useGroupPlace(followed)
  const [open, setOpen] = useDisclosure(`group:${groupKey}`, {
    defaultOpen: isStreaming && !ended,
  })
  // Folded, the member that needs the user — or else, while the group is the
  // reply's current row, the one running — shows under the header, so the
  // current step is never hidden.
  const liveStep = open
    ? null
    : (awaited ??
      (current && live
        ? ([...steps]
            .reverse()
            .find(
              (s) => s.tool.status === "running" || s.tool.status === "pending"
            ) ?? null)
        : null))
  const allSucceeded = steps.every((s) => s.tool.status === "succeeded")

  return (
    <ActivityRow
      stepKey={groupKey}
      motionKey={`group:${groupKey}`}
      status={status}
      marker={
        <RailIcon
          icon={GROUP_ICON}
          status={status}
          label={`${t("kind.command")}, ${statusText(status)}`}
        />
      }
      expandable
      expanded={open}
      onExpandedChange={setOpen}
      slideShut={isStreaming && ended}
      trailing={
        failures.length > 0 ? (
          <span className="text-tone-danger">
            {t("metric.someFailed", { count: failures.length })}
          </span>
        ) : allSucceeded ? (
          t("metric.allPassed")
        ) : null
      }
      addon={
        liveStep ? (
          <ActivityMembers>
            <CommandRow step={liveStep} inGroup />
          </ActivityMembers>
        ) : null
      }
      detail={() => (
        <ActivityMembers
          foot={{
            working: going,
            after: "ring",
            motionScope: groupKey,
            what: t("header.commands", { count: steps.length }),
            onFold: () => setOpen(false),
          }}
        >
          {steps.map((step) => (
            <CommandRow key={step.key} step={step} inGroup />
          ))}
        </ActivityMembers>
      )}
    >
      <span
        className={cn(
          "font-medium",
          live ? "activity-shimmer" : "text-activity-secondary"
        )}
      >
        {live || awaited
          ? t("row.runningCommands", { count: steps.length })
          : t("row.ranCommands", { count: steps.length })}
      </span>
    </ActivityRow>
  )
})
