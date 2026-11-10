/**
 * Shell-command display and output normalization, shared by the command step
 * descriptor and the command row/card bodies.
 *
 * Agents wrap commands (`/bin/zsh -lc 'bash -lc "<cmd>"'`), hand them over as
 * strings, argv arrays or nested `{command}` objects, and return output inside
 * JSON envelopes or codex's text framing. Everything here reduces those shapes
 * to the command a person typed and the text the process printed.
 */

import { parseCodexCommandEnvelope } from "@/lib/codex-command-action"
import { tryParseJson } from "./json"

function unwrapQuotedCommand(command: string): string {
  const trimmed = command.trim()
  if (trimmed.length < 2) return trimmed

  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1)
  }

  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\n/g, "\n")
      .replace(/\\\\/g, "\\")
  }

  return trimmed
}

export function simplifyShellCommand(command: string): string {
  let current = command.trim()
  const wrapperRe =
    /^(?:\/usr\/bin\/env\s+)?(?:(?:\/[^\s]+\/)?(?:bash|zsh|sh))\s+-(?:l?c)\s+(.+)$/i

  // Strip nested shell wrappers like "/bin/zsh -lc bash -lc '<cmd>'".
  for (let i = 0; i < 6; i += 1) {
    const wrapped = current.match(wrapperRe)
    if (!wrapped) break
    const next = unwrapQuotedCommand(wrapped[1] ?? "").trim()
    if (!next || next === current) break
    current = next
  }

  return current
}

export function extractCommandFromUnknownInput(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (typeof parsed === "string") {
      return parsed
    }
    if (Array.isArray(parsed)) {
      const parts = parsed.filter((p): p is string => typeof p === "string")
      if (parts.length > 0) return parts.join(" ")
    }
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>
      const direct = obj.command ?? obj.cmd ?? obj.script
      if (typeof direct === "string") {
        return direct
      }
      if (Array.isArray(direct)) {
        const parts = direct.filter((p): p is string => typeof p === "string")
        if (parts.length > 0) return parts.join(" ")
      }
    }
  } catch {
    // Non-JSON command text is handled below.
  }

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return null
  }
  return trimmed
}

export function commandFromUnknownValue(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((item) => (typeof item === "string" ? item : null))
      .filter((item): item is string => item !== null && item.length > 0)
    if (parts.length > 0) {
      return parts.join(" ")
    }
    return null
  }

  if (!value || typeof value !== "object") {
    return null
  }

  const obj = value as Record<string, unknown>
  const directKeys = [
    "command",
    "cmd",
    "script",
    // Antigravity's terminal arguments — `command_line` on the executed call,
    // PascalCase `CommandLine` on the model's own envelope (the shape a
    // permission-prompt frame and the stored trajectory both carry). Ahead of
    // the argv-style keys so an envelope that has both keeps the full command
    // line. See `inferFromInput` in `tool-call-normalization.ts`.
    "command_line",
    "CommandLine",
    "args",
    "argv",
    "command_args",
  ]
  for (const key of directKeys) {
    const found = commandFromUnknownValue(obj[key])
    if (found) return found
  }

  const nestedKeys = ["input", "arguments", "params", "payload"]
  for (const key of nestedKeys) {
    const found = commandFromUnknownValue(obj[key])
    if (found) return found
  }

  return null
}

export function extractDisplayCommandFromToolInput(
  input: string | null | undefined
): string | null {
  if (!input) return null
  const parsed = tryParseJson(input)
  const command =
    (parsed ? commandFromUnknownValue(parsed) : null) ??
    extractCommandFromUnknownInput(input)
  if (!command) return null
  const simplified = simplifyShellCommand(command).trim()
  return simplified.length > 0 ? simplified : null
}

export function commandOutputFromJsonString(output: string): string | null {
  try {
    const parsed: unknown = JSON.parse(output)
    if (typeof parsed === "string") {
      return parsed
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null
    }

    const obj = parsed as Record<string, unknown>
    const isCommandEnvelope =
      "command" in obj ||
      "parsed_cmd" in obj ||
      "cwd" in obj ||
      "exit_code" in obj ||
      "stdout" in obj ||
      "stderr" in obj ||
      "formatted_output" in obj ||
      "aggregated_output" in obj
    // Prefer raw stdout/stderr when present (more likely to preserve ANSI colors).
    const stdout = typeof obj.stdout === "string" ? obj.stdout : ""
    const stderr = typeof obj.stderr === "string" ? obj.stderr : ""
    if (stdout.length > 0 || stderr.length > 0) {
      if (stdout.length > 0 && stderr.length > 0) {
        return `${stdout}\n[stderr]\n${stderr}`
      }
      return stdout || stderr
    }

    const preferredKeys = [
      "formatted_output",
      "aggregated_output",
      "output",
      "text",
      "result",
    ]
    for (const key of preferredKeys) {
      const value = obj[key]
      if (typeof value === "string" && value.length > 0) {
        return value
      }
    }

    // Some command results are metadata-only envelopes (command/cwd/exit_code).
    // Returning empty string avoids rendering raw JSON as terminal output.
    if (isCommandEnvelope) {
      return ""
    }

    return null
  } catch {
    return null
  }
}

export function stripMarkdownCodeFence(text: string): string {
  let result = text
  // Remove leading fenced-code line like ```sh / ```bash / ```
  result = result.replace(/^\s*```[\w-]*\s*\n?/, "")
  // Remove trailing closing fence if present
  result = result.replace(/\n?\s*```\s*$/, "")
  return result
}

/** Regex matching metadata lines in CLI execution output envelopes. */
export const CLI_META_LINE_RE =
  /^(exit code\s*[:=]|wall time\s*[:=]|chunk id\s*[:=]|original token count\s*[:=]|total output lines\s*[:=]|process exited with code\s)/i

/**
 * Parse a CLI execution envelope, stripping all metadata and the "Output:"
 * separator, returning only the actual command output and the wall time.
 *
 * Handles formats like:
 *   Chunk ID: 065b2b
 *   Wall time: 0.05s
 *   Process exited with code 0
 *   Original token count: 27006
 *   Output:
 *   Total output lines: 1134
 *   <actual output here>
 */
export function parseCliExecutionEnvelope(text: string): {
  output: string
  wallTime: string | null
} {
  const lines = text.split("\n")
  let wallTime: string | null = null

  // Look for "Output:" separator and extract wall time from header
  let outputSepIndex = -1
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    const wtMatch = trimmed.match(/^wall time\s*:\s*(.+)/i)
    if (wtMatch) wallTime = wtMatch[1].trim()
    if (/^output:\s*$/i.test(trimmed)) {
      outputSepIndex = i
      break
    }
    // Stop scanning if we hit a non-metadata, non-blank line (actual content)
    if (!CLI_META_LINE_RE.test(trimmed) && trimmed.length > 0) break
  }

  // If "Output:" separator found, skip everything before it plus any
  // remaining metadata/blank lines after it
  if (outputSepIndex >= 0) {
    let start = outputSepIndex + 1
    while (start < lines.length) {
      const trimmed = lines[start].trim()
      if (CLI_META_LINE_RE.test(trimmed) || trimmed.length === 0) {
        start++
        continue
      }
      break
    }
    return { output: lines.slice(start).join("\n"), wallTime }
  }

  // No "Output:" separator — strip leading metadata lines
  let index = 0
  let sawMeta = false
  while (index < lines.length) {
    const trimmed = lines[index].trim()
    if (CLI_META_LINE_RE.test(trimmed)) {
      sawMeta = true
      if (!wallTime) {
        const wtMatch = trimmed.match(/^wall time\s*:\s*(.+)/i)
        if (wtMatch) wallTime = wtMatch[1].trim()
      }
      index++
      continue
    }
    if (sawMeta && trimmed.length === 0) {
      index++
      continue
    }
    break
  }

  if (!sawMeta) return { output: text, wallTime: null }

  while (index < lines.length && lines[index].trim().length === 0) index++
  return { output: lines.slice(index).join("\n"), wallTime }
}

/**
 * The text a command printed, with every wrapper agents put around it removed:
 * a JSON envelope (`{stdout, stderr}`, codex's `{formatted_output,
 * exit_code}`), codex's "Chunk ID / Wall time / Output:" framing, and a
 * Markdown fence.
 */
export function normalizeCommandOutput(source: string): string {
  const normalized = commandOutputFromJsonString(source) ?? source
  const envelope = parseCliExecutionEnvelope(normalized)
  return stripMarkdownCodeFence(envelope.output)
}

/** The raw "Wall time:" value codex reports, e.g. `0.0519 seconds`. */
function rawWallTime(source: string): string | null {
  const normalized = commandOutputFromJsonString(source) ?? source
  const match = normalized.match(/^wall time\s*:\s*(.+)/im)
  return match ? match[1].trim() : null
}

/** Codex's wall time in milliseconds, or null when absent or unreadable. */
export function extractWallTimeMs(
  source: string | null | undefined
): number | null {
  if (!source) return null
  const raw = rawWallTime(source)
  const numMatch = raw?.match(/^([\d.]+)\s*s/)
  if (!numMatch) return null
  const sec = parseFloat(numMatch[1])
  return Number.isFinite(sec) ? Math.round(sec * 1000) : null
}

// ── heredoc ─────────────────────────────────────────────────────────────

export interface HeredocCommand {
  /** The command's first line, ending in the `<<'PY'` opener. */
  head: string
  /** Program the script is fed to (`python`, `node`, `bash`), basename only. */
  interpreter: string | null
  /** Lines between the opener and the closing delimiter. */
  bodyLines: number
}

/** `<<PY`, `<<'PY'`, `<<"EOF"`, `<<-EOF` at the end of the first line. */
const HEREDOC_OPENER_RE = /<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1\s*$/

/**
 * A command whose first line opens a heredoc — `python - <<'PY'` followed by
 * the script — so the row can say "18-line script" instead of wrapping the
 * whole program into the header.
 */
export function detectHeredoc(command: string): HeredocCommand | null {
  const lines = command.split("\n")
  if (lines.length < 2) return null
  const head = lines[0]!.trimEnd()
  const opener = head.match(HEREDOC_OPENER_RE)
  if (!opener) return null
  const delimiter = opener[2]!
  let close = -1
  for (let i = lines.length - 1; i >= 1; i--) {
    if (lines[i]!.trim() === delimiter) {
      close = i
      break
    }
  }
  const bodyLines = (close > 0 ? close : lines.length) - 1
  if (bodyLines <= 0) return null
  return { head, interpreter: interpreterOf(head), bodyLines }
}

/** First program word of a command line, skipping `VAR=value` assignments. */
function interpreterOf(line: string): string | null {
  for (const word of line.trim().split(/\s+/)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue
    if (word === "env" || word === "/usr/bin/env") continue
    if (word.startsWith("<<")) return null
    const name = word.slice(word.lastIndexOf("/") + 1)
    return name.length > 0 ? name : null
  }
  return null
}

// ── exit status ─────────────────────────────────────────────────────────

export interface CommandExit {
  /** Process exit code, when one was reported. */
  code: number | null
  /** Terminating signal (`SIGKILL`), when the process was killed by one. */
  signal: string | null
}

/** `[terminal exited: exit code: 1]`, `…: signal: SIGKILL]`, `…: finished]`. */
const TERMINAL_EXIT_RE = /\[terminal exited: ([^\]]*)\]\s*$/
/** Claude Code / OpenCode 1.x: an `Exit code 1` line opening or closing the
 *  output. */
const EXIT_CODE_LINE_RE = /^exit code[:\s]\s*(-?\d+)\s*$/i
/** Codex CLI framing: `Process exited with code 1` among the metadata lines. */
const PROCESS_EXITED_RE = /^process exited with code\s+(-?\d+)\s*$/i
/**
 * OpenCode 2's shell notice, a result block of its own after the output:
 * `Exited with code 1`, or `Killed by SIGTERM` (packages/core/src/shell/
 * result.ts `notice`, unchanged since 2.0.28). OpenCode completes such a
 * command successfully, so the notice is the result's only word on it.
 */
const OPENCODE_EXITED_RE = /^exited with code\s+(-?\d+)\s*$/i
const OPENCODE_KILLED_RE = /^killed by\s+(SIG[A-Z0-9]+)\s*$/i

/**
 * `_meta` key carrying a command's exit code where the agent reports it as a
 * field (OpenCode 2's `rawOutput.metadata.exit`, lifted by the backend).
 * Backend twin: `EXIT_CODE_META_KEY` in `src-tauri/src/acp/connection.rs`.
 */
export const EXIT_CODE_META_KEY = "codeg.exitCode"

/** The exit code a call's `_meta` reports (see {@link EXIT_CODE_META_KEY}). */
export function exitFromMeta(meta: unknown): CommandExit | null {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null
  const code = (meta as Record<string, unknown>)[EXIT_CODE_META_KEY]
  return typeof code === "number" && Number.isInteger(code)
    ? { code, signal: null }
    : null
}

/**
 * The exit the AGENT reported in its framing of a command's result, as
 * opposed to anything the program printed: OpenCode 2's closing notice (see
 * {@link OPENCODE_EXITED_RE}). Only the result's last line is read — anywhere
 * else the same words are the program's own output.
 */
export function extractAgentReportedExit(
  source: string | null | undefined
): CommandExit | null {
  if (!source) return null
  const lines = source.split("\n").map((line) => line.trim())
  const last = lines.filter((line) => line.length > 0).pop()
  if (!last) return null
  const exited = last.match(OPENCODE_EXITED_RE)
  if (exited) return { code: Number(exited[1]), signal: null }
  const killed = last.match(OPENCODE_KILLED_RE)
  if (killed) return { code: null, signal: killed[1]! }
  return null
}

function exitFromTerminalLine(text: string): CommandExit | null {
  const match = text.trimEnd().match(TERMINAL_EXIT_RE)
  if (!match) return null
  const body = match[1]!
  const code = body.match(/exit code:\s*(-?\d+)/)
  const signal = body.match(/signal:\s*([^,\]]+)/)
  if (!code && !signal) return null
  return {
    code: code ? Number(code[1]) : null,
    signal: signal ? signal[1]!.trim() : null,
  }
}

function exitFromFramingLines(text: string): CommandExit | null {
  const lines = text.split("\n")
  const nonEmpty = lines.map((l) => l.trim()).filter((l) => l.length > 0)
  if (nonEmpty.length === 0) return null
  // The opening metadata block (codex framing) and the first / last line
  // (Claude Code, OpenCode) are the only places these appear; a match in the
  // middle of the output is the program's own text.
  for (const line of nonEmpty.slice(0, 8)) {
    const exited =
      line.match(PROCESS_EXITED_RE) ?? line.match(EXIT_CODE_LINE_RE)
    if (exited) return { code: Number(exited[1]), signal: null }
    if (!CLI_META_LINE_RE.test(line)) break
  }
  const last = nonEmpty[nonEmpty.length - 1]!.match(EXIT_CODE_LINE_RE)
  if (last) return { code: Number(last[1]), signal: null }
  return extractAgentReportedExit(text)
}

/**
 * The exit status a command's result reports, read in order of reliability:
 * codex's `{exit_code}` envelope, the `[terminal exited: …]` line the backend
 * appends for terminals it hosts, then the `Exit code N` / `Process exited with
 * code N` text agents put around the output. Null when none is present — a
 * failed call without one is reported as plainly "failed", never with an
 * invented code.
 */
export function extractCommandExit(
  source: string | null | undefined
): CommandExit | null {
  if (!source) return null
  const envelope = parseCodexCommandEnvelope(source)
  if (envelope) return { code: envelope.exitCode, signal: null }
  const parsed = source.trimStart().startsWith("{")
    ? tryParseJson(source)
    : null
  const reported = parsed?.exit_code ?? parsed?.exitCode
  if (typeof reported === "number" && Number.isInteger(reported)) {
    return { code: reported, signal: null }
  }
  const text = commandOutputFromJsonString(source) ?? source
  // claude-agent-acp fences a failed result for clients without a terminal
  // channel, which pushes its `Exit code N` line down to the second.
  const body = text.trimStart().startsWith("```")
    ? stripMarkdownCodeFence(text)
    : text
  return exitFromTerminalLine(body) ?? exitFromFramingLines(body)
}
