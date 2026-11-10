/**
 * What a command's non-zero exit says, read off the command that set it.
 *
 * A handful of commands answer a question with exit 1: a search that matched
 * nothing, a test that came out false, two files that differ, a name or a path
 * that is not there. That is the answer, not a failure — Claude Code's Bash
 * tool reads exit 1 from grep / rg / diff / test the same way, and Codex
 * greys a search's exit 1 rather than calling it failed — so such a command
 * settles as done, its figure saying what it found.
 *
 * Read conservatively, since a wrong guess hides a real failure: the status
 * must come from that command — the last of a pipeline or a list, or the one
 * before an `&& echo …` it stopped — anything chained ahead of it with `&&`
 * must be setup that complains when it fails (`cd`), what it printed must fit
 * the answer (a search that found nothing prints nothing), and a line that
 * does anything this reader does not follow — a substitution, a subshell, a
 * heredoc, `set -e` — keeps its exit a failure.
 *
 * A failure stays one, in words where the shell has them, as shell prompts
 * (Starship, Powerlevel10k, fish) spell the codes out: 127 is a command not
 * found, 126 one that cannot run, 128 + n a kill by signal n.
 */

import type { CommandExit } from "./command"
import { CLI_META_LINE_RE } from "./command"

/** An exit that answers the command's question: the command succeeded. */
export type ExitAnswer = "noMatch" | "false" | "differs" | "notFound"

/** A failure the exit code names. */
export type ExitCause = "commandNotFound" | "notExecutable" | "timedOut"

export type ExitMeaning = ExitAnswer | ExitCause

const ANSWERS: ReadonlySet<ExitMeaning> = new Set([
  "noMatch",
  "false",
  "differs",
  "notFound",
])

export function isExitAnswer(meaning: ExitMeaning | null): boolean {
  return meaning !== null && ANSWERS.has(meaning)
}

/** 128 + n for the signals numbered alike on Linux and macOS. */
const SIGNAL_BY_CODE: ReadonlyMap<number, string> = new Map([
  [129, "SIGHUP"],
  [130, "SIGINT"],
  [131, "SIGQUIT"],
  [134, "SIGABRT"],
  [137, "SIGKILL"],
  [139, "SIGSEGV"],
  [141, "SIGPIPE"],
  [142, "SIGALRM"],
  [143, "SIGTERM"],
])

/** The signal a 128 + n exit code stands for, when it is one of those. */
export function signalOfExitCode(code: number | null): string | null {
  return code === null ? null : (SIGNAL_BY_CODE.get(code) ?? null)
}

// ── reading the command line ────────────────────────────────────────────

type Joiner = "&&" | "||" | "|" | ";"

interface SimpleCommand {
  words: string[]
  /** How it is joined to the command before it; null for the first. */
  after: Joiner | null
}

/**
 * The line split into simple commands at its top-level operators, quotes
 * resolved, or null when it does something this reader does not follow.
 */
function splitCommandLine(line: string): SimpleCommand[] | null {
  const commands: SimpleCommand[] = []
  let words: string[] = []
  let word = ""
  let inWord = false
  let after: Joiner | null = null
  const endWord = () => {
    if (inWord) words.push(word)
    word = ""
    inWord = false
  }
  // An operator with no command before it (`; ;`, a leading `|`) is not a
  // line this reader follows.
  const endCommand = (joiner: Joiner): boolean => {
    endWord()
    if (words.length === 0) return joiner === ";" && commands.length === 0
    commands.push({ words, after })
    words = []
    after = joiner
    return true
  }

  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    const next = line[i + 1]
    if (c === "'") {
      const close = line.indexOf("'", i + 1)
      if (close < 0) return null
      word += line.slice(i + 1, close)
      inWord = true
      i = close
      continue
    }
    if (c === '"') {
      let j = i + 1
      for (; j < line.length && line[j] !== '"'; j++) {
        const d = line[j]!
        if (d === "`" || (d === "$" && line[j + 1] === "(")) return null
        if (d === "\\" && j + 1 < line.length) j++
        word += line[j]
      }
      if (j >= line.length) return null
      inWord = true
      i = j
      continue
    }
    if (c === "\\") {
      if (next === "\n") {
        i++
      } else if (next !== undefined) {
        word += next
        inWord = true
        i++
      }
      continue
    }
    if (c === "`" || c === "(" || c === ")") return null
    if (c === "$" && next === "(") return null
    if (c === "<" && next === "<") return null
    if (c === "#" && !inWord) {
      // A comment runs to the end of its line.
      const end = line.indexOf("\n", i)
      if (end < 0) break
      i = end - 1
      continue
    }
    if (c === "&") {
      if (next === "&") {
        if (!endCommand("&&")) return null
        i++
        continue
      }
      // `2>&1`, `>&2`, `&>log`: a redirection, part of the word.
      if (next === ">" || line[i - 1] === ">" || line[i - 1] === "<") {
        word += c
        inWord = true
        continue
      }
      // A command sent to the background: its status is not the line's.
      return null
    }
    if (c === "|") {
      if (next === "|") {
        if (!endCommand("||")) return null
        i++
      } else {
        if (!endCommand("|")) return null
        if (next === "&") i++
      }
      continue
    }
    if (c === ";") {
      if (next === ";") return null
      if (!endCommand(";")) return null
      continue
    }
    if (c === "\n") {
      endWord()
      if (words.length > 0 && !endCommand(";")) return null
      continue
    }
    if (c === " " || c === "\t") {
      endWord()
      continue
    }
    // A `{ …; }` group; `{a,b}` and `${x}` are words.
    if (
      (c === "{" || c === "}") &&
      !inWord &&
      (next === undefined || /\s/.test(next))
    ) {
      return null
    }
    word += c
    inWord = true
  }
  endWord()
  if (words.length > 0) commands.push({ words, after })
  else if (after !== null && after !== ";") return null
  return commands.length > 0 ? commands : null
}

const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/
/** A redirection operator alone (its target is the next word). */
const REDIRECT_OP_RE = /^(?:\d*|&)(?:>>?|<|>&|<&|>\|)$/
/** A redirection with its target attached. */
const REDIRECT_RE = /^(?:\d*|&)(?:>>?|<|>&|<&|>\|)\S/

/** The words a command runs with: assignments, redirections and pass-through
 *  wrappers (`env`, `command`, `time`, `timeout 30`…) set aside; the program
 *  named by its basename. Null for a command this reader does not follow. */
function argv(command: SimpleCommand): string[] | null {
  const words: string[] = []
  for (let i = 0; i < command.words.length; i++) {
    const word = command.words[i]!
    if (REDIRECT_OP_RE.test(word)) {
      i++
      continue
    }
    if (REDIRECT_RE.test(word)) continue
    words.push(word)
  }
  let at = 0
  for (;;) {
    while (at < words.length && ASSIGNMENT_RE.test(words[at]!)) at++
    const head = words[at]
    if (head === undefined) return null
    if (head === "!" || head === "set" || head === "eval") return null
    if (head === "env") {
      at++
      while (at < words.length && words[at]!.startsWith("-")) at++
      continue
    }
    if (head === "time" || head === "nohup" || head === "builtin") {
      at++
      while (at < words.length && words[at] === "-p") at++
      continue
    }
    if (head === "command" && !/^-[vV]$/.test(words[at + 1] ?? "")) {
      at++
      continue
    }
    break
  }
  const rest = words.slice(at)
  rest[0] = rest[0]!.replace(/^.*\//, "")
  return rest
}

/** What a simple command's own name is, once its words are read. */
function nameOf(command: SimpleCommand): string | null {
  return argv(command)?.[0] ?? null
}

/** Commands whose status is 0 whenever they run — `printf` is not one: a
 *  bad number in its arguments fails it. */
const NEVER_FAILS = new Set(["echo", "true", ":"])

/** Whether a command redirects anything: its error can go unprinted, its
 *  own output can fail to land. */
function redirects(command: SimpleCommand): boolean {
  return command.words.some(
    (word) => REDIRECT_OP_RE.test(word) || REDIRECT_RE.test(word)
  )
}

function neverFails(command: SimpleCommand): boolean {
  return NEVER_FAILS.has(nameOf(command) ?? "") && !redirects(command)
}

/** Builtins that end the line, or hand it to something else, before the
 *  commands after them run. */
const ENDS_LINE = new Set(["exit", "return", "exec", "logout", "source", "."])

/** What may run ahead of the deciding command with `&&`: setup that says so
 *  when it fails, which an answer's quiet output then rules out. */
const SETUP = new Set(["cd", "pushd", "export"])

/** The words of the command whose status the line returns, or null when the
 *  line could have taken it from somewhere this reader cannot tell. */
function decidingCommand(
  commands: SimpleCommand[]
): { words: string[]; afterSetup: boolean } | null {
  // `set -e` and `pipefail` change whose status a list or a pipeline
  // returns; an `exit` (or a sourced script that may hold one) can end the
  // line before its last command runs.
  for (const command of commands) {
    const words = command.words.filter((w) => !ASSIGNMENT_RE.test(w))
    if (words[0] === "set" || ENDS_LINE.has(words[0] ?? "")) return null
  }
  let k = commands.length - 1
  // `… && echo found`: the echo cannot fail, so a non-zero status came from
  // the command it was waiting on.
  while (k > 0 && neverFails(commands[k]!)) {
    if (commands[k]!.after !== "&&") return null
    k--
  }
  if (NEVER_FAILS.has(nameOf(commands[k]!) ?? "")) return null
  // A pipeline's status is its last command's; what ran ahead of the
  // pipeline with `&&` could have stopped the line before it ran at all.
  let start = k
  while (start > 0 && commands[start]!.after === "|") start--
  let afterSetup = false
  for (let i = start; i > 0 && commands[i]!.after === "&&"; i--) {
    const setup = commands[i - 1]!
    // Setup whose complaint is sent away fails without a word.
    if (!SETUP.has(nameOf(setup) ?? "") || redirects(setup)) return null
    afterSetup = true
  }
  const words = argv(commands[k]!)
  return words ? { words, afterSetup } : null
}

// ── reading what it printed ─────────────────────────────────────────────

/** `zsh:1: no matches found: *.rs`, `bash: foo: command not found`: the
 *  shell's own complaint, which no answer prints. */
const SHELL_COMPLAINT_RE =
  /^(?:\(eval\)|(?:[\w./-]*\/)?-?(?:ba|z|da|k)?sh)(?::\s*(?:line\s+)?\d+)?:/
const NO_SUCH_FILE_RE = /no such file or directory/i
const NOT_FOUND_RE = /\bnot found\b|^which: no \S/i
const TIMED_OUT_RE = /\btimed out\b/i
/** `grep -c` with nothing matched still prints its counts: `0`, `f.ts:0`. */
const ZERO_COUNT_RE = /^(?:.*:)?0$/
/** git's own diagnostics: `error: Could not access 'x'`, `fatal: …`. */
const GIT_DIAGNOSTIC_RE = /^(?:error|fatal|usage|warning):/i
/** The one sed script that only prints: a line or a range of them. */
const SED_PRINT_RE = /^(?:\d+|\$)(?:,(?:\d+|\$))?p$/

/** The agents' framing around what a command printed: Claude Code's `Exit
 *  code 1` (and the fence it may wrap the result in), OpenCode 2's closing
 *  `Exited with code 1` / `Killed by SIGTERM` notice, codex's `Wall time: …`
 *  lines, the backend's `[terminal exited: …]`. */
const FRAMING_RE =
  /^(?:exit code[:\s]\s*-?\d+$|exited with code\s+-?\d+$|killed by\s+SIG[A-Z0-9]+$|\[terminal exited:|```)/i

/** The lines the command printed, the framing left out. */
function printedLines(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !CLI_META_LINE_RE.test(line) &&
        !FRAMING_RE.test(line)
    )
}

// ── what each command's exit 1 answers ──────────────────────────────────

const SEARCHES = new Set([
  "grep",
  "egrep",
  "fgrep",
  "zgrep",
  "rg",
  "ag",
  "ack",
  "pgrep",
  "pidof",
  // Nothing has the file or port open.
  "lsof",
])
const TESTS = new Set(["test", "[", "[["])
const LOOKUPS = new Set(["which", "type", "whereis"])
/** Silent when what they look up is not set. */
const QUIET_LOOKUPS = new Set(["printenv"])
/** Commands that only look at a path: a missing one is not there to see. */
const LOOKS = new Set([
  "ls",
  "stat",
  "cat",
  "head",
  "tail",
  "wc",
  "file",
  "nl",
  "readlink",
  "realpath",
  "du",
  "sed",
])

/** Git's global options ahead of its subcommand, and how many words each
 *  takes. */
function gitSubcommand(words: string[]): { name: string; args: string[] } {
  let at = 1
  while (at < words.length && words[at]!.startsWith("-")) {
    at += /^-[Cc]$/.test(words[at]!) ? 2 : 1
  }
  return { name: words[at] ?? "", args: words.slice(at + 1) }
}

/** `sed -n '1,40p' file…`: quiet, one script that prints a line or a range,
 *  nothing else that could make it write. */
function printsLines(words: string[]): boolean {
  const options = words.slice(1).filter((word) => word.startsWith("-"))
  const operands = words.slice(1).filter((word) => !word.startsWith("-"))
  return (
    options.length > 0 &&
    options.every((option) => option === "-n" || option === "--quiet") &&
    operands.length >= 2 &&
    SED_PRINT_RE.test(operands[0]!)
  )
}

/** What git's exit 1 answers, by subcommand. */
function gitAnswer(
  sub: { name: string; args: string[] },
  quiet: boolean,
  complaint: boolean
): ExitAnswer | null {
  const has = (re: RegExp) => sub.args.some((arg) => re.test(arg))
  switch (sub.name) {
    case "grep":
    // No path given is ignored.
    case "check-ignore":
      return quiet ? "noMatch" : null
    case "diff":
      return has(/^--(?:exit-code|quiet|no-index)$/) && !complaint
        ? "differs"
        : null
    // A key, a ref that is not there.
    case "config":
    case "show-ref":
      return quiet ? "notFound" : null
    case "rev-parse":
      return quiet && has(/^--verify$/) ? "notFound" : null
    case "merge-base":
      return quiet && has(/^--is-ancestor$/) ? "false" : null
    default:
      return null
  }
}

function answerOf(
  words: string[],
  code: number,
  lines: string[]
): ExitAnswer | null {
  const name = words[0]!
  const quiet = lines.length === 0
  // The shell's own complaint — a glob that matched nothing, a redirect to a
  // missing folder — exits 1 too, before or around the command.
  const complaint = lines.some((line) => SHELL_COMPLAINT_RE.test(line))
  if (code === 1) {
    if (SEARCHES.has(name)) {
      return quiet || lines.every((line) => ZERO_COUNT_RE.test(line))
        ? "noMatch"
        : null
    }
    if (TESTS.has(name)) return quiet ? "false" : null
    if (name === "diff" || name === "cmp") return complaint ? null : "differs"
    if (name === "git") {
      const diagnosed = lines.some((line) => GIT_DIAGNOSTIC_RE.test(line))
      return gitAnswer(gitSubcommand(words), quiet, complaint || diagnosed)
    }
    if (QUIET_LOOKUPS.has(name)) return quiet ? "notFound" : null
    // A shell's builtin says it with the shell's prefix: `bash: type: x: not
    // found`.
    if (
      LOOKUPS.has(name) ||
      (name === "command" && /^-[vV]$/.test(words[1] ?? ""))
    ) {
      return lines.every((line) => NOT_FOUND_RE.test(line)) ? "notFound" : null
    }
  }
  if ((code === 1 || code === 2) && LOOKS.has(name) && !complaint) {
    // sed can write (`-i`, a `w` command): only `sed -n '1,40p' file` looks.
    if (name === "sed" && !printsLines(words)) return null
    return !quiet && lines.every((line) => NO_SUCH_FILE_RE.test(line))
      ? "notFound"
      : null
  }
  return null
}

/**
 * What a command's non-zero exit says: an answer (the command did what it
 * was asked and the answer is "no"), a failure the code names, or null — a
 * plain failure.
 */
export function readCommandExit(
  commandLine: string,
  exit: CommandExit,
  output: string
): ExitMeaning | null {
  const code = exit.code
  if (code === null || code === 0) return null
  const lines = printedLines(output)
  const commands = splitCommandLine(commandLine)
  const deciding = commands ? decidingCommand(commands) : null
  if (deciding) {
    const answer = answerOf(deciding.words, code, lines)
    // Setup chained ahead with `&&` says so when it fails: past it, only an
    // answer that printed nothing is surely the deciding command's.
    if (answer && (!deciding.afterSetup || lines.length === 0)) return answer
  }
  if (code === 127) return "commandNotFound"
  if (code === 126) return "notExecutable"
  const timeout = deciding?.words[0]
  if (
    (code === 124 && (timeout === "timeout" || timeout === "gtimeout")) ||
    ((code === 124 || code === 143) && lines.some((l) => TIMED_OUT_RE.test(l)))
  ) {
    return "timedOut"
  }
  return null
}
