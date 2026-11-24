/**
 * "No matches" for a search that ran as an ordinary shell command.
 *
 * rg, grep, egrep and fgrep share one exit contract: 0 when a line was
 * selected, 1 when none was, and 2 when anything went wrong. An error outranks
 * "no match", so exit 1 only ever means "searched fine, found nothing". codex
 * derives an ACP tool status from the exit code alone, so a healthy negative
 * search arrives as a FAILED tool call. (`git grep` is left out: with
 * `--open-files-in-pager` its status is the pager's.)
 *
 * The searches codex itself classifies as one (a single `search` command
 * action) become grep cards, and `isCodexGrepNoMatchEnvelope` plus the
 * search-action marker cover them. Anything codex cannot reduce to ONE action
 * — `rg --files src | rg foo` is a list-files action plus a search action,
 * `cat f | grep foo` a read plus a search — reaches codeg as a plain shell
 * command instead (codex-acp's `usesTerminal`), on a `bash` card. The only
 * record of that process's exit is the line the backend appends to its output,
 * so this module reads exactly that: the exit line, with nothing else printed,
 * on a command whose exit status is a grep-like search's own.
 */

/**
 * The line the backend appends when a process exits 1 and no signal killed it:
 * `[terminal exited: <format_terminal_exit_status>]`, written by
 * `hosted_terminal_exit_line` (codex / pi) and `poll_terminal_tool_call_output`
 * (terminals codeg hosts) in `src-tauri/src/acp/connection.rs`.
 */
export const EXIT_ONE_LINE = "[terminal exited: exit code: 1]"

const GREP_COMMANDS = new Set(["rg", "grep", "egrep", "fgrep"])
const SHELLS = new Set(["sh", "bash", "zsh"])
/** `NAME=value` words in front of a command (`LC_ALL=C grep …`). */
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/
/**
 * A command word the shell runs exactly as written. Anything else can expand
 * into another program — `${IFS:+false$IFS}/grep` runs `false` — so the name
 * read off it would not be the program that set the status.
 */
const PLAIN_WORD_RE = /^[\w./+-]+$/
/** How many `sh -c '…'` wrappers to look through (`/bin/zsh -lc "bash -c …"`). */
const MAX_WRAPPERS = 3

/**
 * True when a failed shell tool call is a search that simply matched nothing:
 * the command's exit status is a grep-like search's own (see
 * `endsInGrepSearch`), it is 1, and the call printed nothing but the exit line.
 * Requiring silence is what keeps a broken path or pattern upstream of the
 * search red: `rg --files no_such_dir | rg x` also exits 1, but only after rg
 * reported the missing directory.
 */
export function isGrepNoMatchCommandResult(
  input: string | null | undefined,
  output: string | null | undefined
): boolean {
  if (output?.trim() !== EXIT_ONE_LINE) return false
  const command = commandFromToolInput(input)
  return command !== null && endsInGrepSearch(command)
}

/**
 * The command a shell tool call ran: `{command}` / `{cmd}` (a script or an
 * argv), a bare JSON string or argv, or the raw text itself when the input is
 * not JSON at all.
 */
function commandFromToolInput(
  input: string | null | undefined
): string | readonly string[] | null {
  const trimmed = input?.trim()
  if (!trimmed) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return trimmed
  }
  if (typeof parsed === "string" || isStringArray(parsed)) return parsed
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null
  }
  const record = parsed as Record<string, unknown>
  for (const key of ["command", "cmd"]) {
    const value = record[key]
    if (typeof value === "string" || isStringArray(value)) return value
  }
  return null
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "string")
  )
}

/**
 * Whether `command` exits with the status of a grep-like search: ONE pipeline
 * whose last stage runs rg / grep / egrep / fgrep, read through any
 * `sh|bash|zsh -c` / `-lc` wrapper. A pipeline exits with its last stage's
 * status, so exit 1 there is the search's own "nothing selected" whatever the
 * stages before it did — one that failed quietly just gave the search nothing
 * to select from. A leading `!` inverts that status and is refused.
 */
export function endsInGrepSearch(command: string | readonly string[]): boolean {
  let stages: readonly (readonly string[])[] | null =
    typeof command === "string" ? pipelineStages(command) : [command]
  for (let unwrapped = 0; stages && unwrapped <= MAX_WRAPPERS; unwrapped++) {
    const script = stages.length === 1 ? shellWrapperScript(stages[0]) : null
    if (script === null) {
      return stages[0][0] !== "!" && isGrepInvocation(stages[stages.length - 1])
    }
    stages = pipelineStages(script)
  }
  return false
}

/** `<script>` of `bash -lc '<script>'`, `/bin/zsh -lc "<script>"`, `sh -c …`. */
function shellWrapperScript(words: readonly string[]): string | null {
  if (words.length !== 3) return null
  const [shell, flag, script] = words
  const name = programName(shell)
  return name !== null && SHELLS.has(name) && /^-l?c$/.test(flag)
    ? script
    : null
}

function isGrepInvocation(words: readonly string[]): boolean {
  let index = 0
  while (index < words.length && ASSIGNMENT_RE.test(words[index])) index++
  if (index >= words.length) return false
  const name = programName(words[index])
  return name !== null && GREP_COMMANDS.has(name)
}

/** The program a command word runs (`/opt/homebrew/bin/rg` → `rg`), or null
 *  when the word is not plain (see `PLAIN_WORD_RE`). */
function programName(word: string): string | null {
  return PLAIN_WORD_RE.test(word) ? word.slice(word.lastIndexOf("/") + 1) : null
}

/**
 * What a redirection does with its target: open it for output, copy a
 * descriptor onto it (`>&`), or open it for input (`<`, `<>`, `<&`).
 */
type RedirectKind = "output" | "duplicate" | "input"

/**
 * Whether the shell can fail to set up a redirection. When it does, it reports
 * the error and gives the command status 1 without running it — and a
 * `2>/dev/null` earlier on the line swallows the report, which leaves the
 * failure exactly as silent as a search that found nothing. Writing to
 * /dev/null and copying stdout / stderr cannot fail; opening anything else can.
 */
function redirectionCanFail(kind: RedirectKind, target: string): boolean {
  switch (kind) {
    case "output":
      return target !== "/dev/null"
    case "duplicate":
      return target !== "1" && target !== "2" && target !== "/dev/null"
    case "input":
      return true
  }
}

/**
 * The words of each stage of `script` when it is ONE pipeline of simple
 * commands, or null when it is anything else.
 *
 * A recognizer for that one shape, not a shell parser. Whatever could make the
 * exit status come from somewhere other than the last stage's command — `&&`,
 * `||`, `;`, `&`, a newline, a subshell, `|&`, or a redirection on that stage
 * the shell could fail to set up (see `redirectionCanFail`) — and whatever this
 * reader cannot follow — command and process substitution, `$'…'` quoting, a
 * heredoc, a comment, an unterminated quote — answers null. Quotes and
 * backslashes are resolved the POSIX way, so a `|` inside a quoted pattern
 * stays part of it. Redirections are otherwise dropped: on an earlier stage
 * even a failing one only leaves the search with nothing to read.
 */
export function pipelineStages(script: string): string[][] | null {
  const stages: string[][] = [[]]
  let word = ""
  let inWord = false
  // Set while the next word is a redirection's target, not an argument.
  let pendingRedirect: RedirectKind | null = null
  // The current stage has a redirection the shell could fail to set up.
  let stageRedirectCanFail = false

  const endWord = () => {
    if (!inWord) return
    if (pendingRedirect) {
      if (redirectionCanFail(pendingRedirect, word)) {
        stageRedirectCanFail = true
      }
      pendingRedirect = null
    } else {
      stages[stages.length - 1].push(word)
    }
    word = ""
    inWord = false
  }

  for (let index = 0; index < script.length; index++) {
    const char = script[index]
    const next = script[index + 1]
    switch (char) {
      case " ":
      case "\t":
        endWord()
        continue
      case "'": {
        const close = script.indexOf("'", index + 1)
        if (close < 0) return null
        word += script.slice(index + 1, close)
        inWord = true
        index = close
        continue
      }
      case '"': {
        let cursor = index + 1
        for (; cursor < script.length && script[cursor] !== '"'; cursor++) {
          const quoted = script[cursor]
          const after = script[cursor + 1]
          if (quoted === "`" || (quoted === "$" && after === "(")) return null
          if (
            quoted === "\\" &&
            after !== undefined &&
            '$`"\\\n'.includes(after)
          ) {
            cursor++
            if (after !== "\n") word += after
            continue
          }
          word += quoted
        }
        if (cursor >= script.length) return null
        inWord = true
        index = cursor
        continue
      }
      case "\\":
        if (next === undefined) return null
        index++
        if (next !== "\n") {
          word += next
          inWord = true
        }
        continue
      case "|":
        if (next === "|" || next === "&") return null
        endWord()
        if (pendingRedirect || stages[stages.length - 1].length === 0) {
          return null
        }
        stages.push([])
        stageRedirectCanFail = false
        continue
      case "<":
      case ">":
        if (next === "(" || (char === "<" && next === "<")) return null
        // A bare number right before the operator is its descriptor (`2>`).
        if (inWord && !pendingRedirect && /^\d+$/.test(word)) {
          word = ""
          inWord = false
        } else {
          endWord()
        }
        // Still waiting for a target: two operators in a row.
        if (pendingRedirect) return null
        if (char === "<") pendingRedirect = "input"
        else pendingRedirect = next === "&" ? "duplicate" : "output"
        // The rest of a two-character operator: `>>`, `>&`, `>|`, `<>`, `<&`.
        if (next === ">" || next === "&" || (char === ">" && next === "|")) {
          index++
        }
        continue
      case "&":
        // `&>file` / `&>>file`; any other `&` is `&&` or a background job.
        if (next !== ">") return null
        endWord()
        if (pendingRedirect) return null
        index += script[index + 2] === ">" ? 2 : 1
        pendingRedirect = "output"
        continue
      case "$":
        // `$(…)` runs a command; `$'…'` quotes by rules of its own.
        if (next === "(" || next === "'") return null
        word += char
        inWord = true
        continue
      case "#":
        if (!inWord) return null
        word += char
        continue
      case ";":
      case "\n":
      case "\r":
      case "(":
      case ")":
      case "`":
        return null
      default:
        word += char
        inWord = true
    }
  }
  endWord()
  if (pendingRedirect || stageRedirectCanFail) return null
  if (stages.some((stage) => stage.length === 0)) return null
  return stages
}
