import { describe, expect, it } from "vitest"

import {
  EXIT_ONE_LINE,
  endsInGrepSearch,
  isGrepNoMatchCommandResult,
  pipelineStages,
} from "./grep-no-match"

/** The command from #877, as codex-acp 2.0.1 / 2.1.1 sent it in `rawInput`. */
const ISSUE_877_SCRIPT =
  "rg --files scripts src/grapal/phonics tests | rg 'sequence_(nested|rerank_candidate)'"
const ISSUE_877_INPUT = JSON.stringify({
  command: `/bin/zsh -lc "${ISSUE_877_SCRIPT}"`,
  cwd: "/private/tmp/t276-877/ws",
})

describe("pipelineStages", () => {
  it("splits a pipeline and keeps a `|` inside quotes", () => {
    expect(pipelineStages(ISSUE_877_SCRIPT)).toEqual([
      ["rg", "--files", "scripts", "src/grapal/phonics", "tests"],
      ["rg", "sequence_(nested|rerank_candidate)"],
    ])
  })

  it("resolves quotes and backslashes the POSIX way", () => {
    expect(pipelineStages(`grep -e "a \\"b\\" \\d" 'c'"d" e\\ f`)).toEqual([
      ["grep", "-e", 'a "b" \\d', "cd", "e f"],
    ])
    expect(pipelineStages("rg ''")).toEqual([["rg", ""]])
  })

  it("drops redirections the last stage cannot fail to set up", () => {
    // An earlier stage may redirect anywhere: if that fails, the search still
    // runs and finds nothing to select.
    expect(
      pipelineStages(
        "rg --files 2>err.log < in | rg -n x 2>/dev/null >/dev/null 2>&1 >&2 &>>/dev/null"
      )
    ).toEqual([
      ["rg", "--files"],
      ["rg", "-n", "x"],
    ])
  })

  // The shell sets these up before the command runs, and when one fails it
  // exits 1 without running it — silently, once `2>/dev/null` came first.
  it.each([
    [
      "an input file",
      "cat /dev/null | grep needle 2>/dev/null </dev/null/codeg-877",
    ],
    ["an output file", "rg x 2>/dev/null > out.txt"],
    ["an appended file", "rg x 2>/dev/null >> /tmp/log"],
    ["a read-write file", "rg x <> f"],
    ["an input copy", "rg x <&3"],
    ["a copy of an unopened descriptor", "rg x 2>/dev/null >&3"],
    ["a redirection ahead of the command", "< in grep x"],
  ])("refuses a last-stage redirection to %s", (_label, script) => {
    expect(pipelineStages(script)).toBeNull()
  })

  it.each([
    ["an AND list", "rg --files && rg x"],
    ["an OR list", "rg x || true"],
    ["a sequence", "rg a; rg b"],
    ["a newline", "rg a\nrg b"],
    ["a background job", "rg a & rg b"],
    ["a subshell", "(rg a) | rg b"],
    ["command substitution", "rg $(cat pattern)"],
    ["command substitution inside double quotes", 'rg "$(cat pattern)"'],
    ["backquotes", "rg `cat pattern`"],
    // bash and zsh read this as `false` with ONE argument: inside `$'…'` the
    // `\'` is an escaped quote, so the `|` is quoted text.
    ["$'…' quoting", "false $'\\' | grep -q x'\\'"],
    ["process substitution", "rg x <(ls)"],
    ["a heredoc", "grep x <<EOF"],
    ["a comment", "rg x # why"],
    ["`|&`", "rg --files |& rg x"],
    ["an empty stage", "rg --files | | rg x"],
    ["a trailing pipe", "rg --files |"],
    ["a redirection with no target", "rg x >"],
    ["two operators in a row", "rg x > > out"],
    ["an unterminated single quote", "rg 'x"],
    ["an unterminated double quote", 'rg "x'],
    ["a dangling backslash", "rg x\\"],
    ["nothing", "   "],
  ])("refuses %s", (_label, script) => {
    expect(pipelineStages(script)).toBeNull()
  })
})

describe("endsInGrepSearch", () => {
  it.each([
    ["the #877 pipeline", ISSUE_877_SCRIPT],
    ["a plain search", "rg -n '__absent__' README.md"],
    ["grep behind a read", "cat README.md | grep -n '__absent__'"],
    ["egrep / fgrep", "ls | egrep x"],
    ["fgrep", "fgrep -r x src"],
    ["an absolute path", "/opt/homebrew/bin/rg x"],
    ["leading assignments", "LC_ALL=C GREP_COLOR=1 grep x f"],
    ["a quoted command word", "'rg' x"],
    ["a bash -lc wrapper", "bash -lc 'rg --files | rg x'"],
    ["a zsh -lc wrapper", `/bin/zsh -lc "${ISSUE_877_SCRIPT}"`],
    ["a nested wrapper", `/bin/zsh -lc "bash -c 'rg x'"`],
  ])("accepts %s", (_label, command) => {
    expect(endsInGrepSearch(command)).toBe(true)
  })

  it("accepts an argv, with or without a shell wrapper", () => {
    expect(endsInGrepSearch(["rg", "-n", "x"])).toBe(true)
    expect(endsInGrepSearch(["bash", "-lc", ISSUE_877_SCRIPT])).toBe(true)
  })

  it.each([
    // exit 1 means something else for all of these
    ["a search that is not the last stage", "rg x | wc -l"],
    ["find", "find . -name x"],
    ["fd", "fd x"],
    ["diff", "diff a b"],
    ["test", "test -f x"],
    ["xargs grep (exits 123)", "rg --files | xargs grep x"],
    ["a negated pipeline", "! cat f | grep -q x"],
    ["a negated pipeline behind a wrapper", "bash -c '! cat f | grep -q x'"],
    ["git diff", "git diff --exit-code"],
    // its status is the pager's with `-O`: `false` here exits 1 on a match
    ["git grep", "git grep --no-index --open-files-in-pager=false x -- f"],
    ["assignments alone", "A=1"],
    // the program that runs is not the word as written
    ["an expanding command word", "${IFS:+false$IFS}/grep needle"],
    [
      "an expanding command word behind a wrapper",
      "bash -c '${IFS:+false$IFS}/grep needle'",
    ],
    ["an expanding shell word", "${IFS:+false$IFS}/bin/bash -lc 'rg x'"],
    ["a variable command word", "$PREFIX/rg x"],
    ["a tilde command word", "~/bin/rg x"],
    ["a glob command word", "/opt/*/bin/rg x"],
    // the status may not be the search's
    ["an AND list", "grep -q needle f && test -d out"],
    ["a wrapper with extra arguments", "bash -c 'rg x' zero one"],
    ["a wrapper with other flags", "bash -e -c 'rg x'"],
    ["PowerShell", "powershell.exe -Command 'rg x'"],
  ])("refuses %s", (_label, command) => {
    expect(endsInGrepSearch(command)).toBe(false)
  })
})

describe("isGrepNoMatchCommandResult", () => {
  it("is the #877 card: exit 1, nothing printed, a search pipeline", () => {
    expect(isGrepNoMatchCommandResult(ISSUE_877_INPUT, EXIT_ONE_LINE)).toBe(
      true
    )
    expect(
      isGrepNoMatchCommandResult(ISSUE_877_INPUT, `\n${EXIT_ONE_LINE}\n`)
    ).toBe(true)
  })

  it("reads `cmd`, a bare command string and a non-JSON command", () => {
    expect(
      isGrepNoMatchCommandResult(JSON.stringify({ cmd: "rg x" }), EXIT_ONE_LINE)
    ).toBe(true)
    expect(
      isGrepNoMatchCommandResult(JSON.stringify("rg x"), EXIT_ONE_LINE)
    ).toBe(true)
    expect(isGrepNoMatchCommandResult(ISSUE_877_SCRIPT, EXIT_ONE_LINE)).toBe(
      true
    )
    expect(
      isGrepNoMatchCommandResult(
        JSON.stringify({ command: ["bash", "-lc", "rg x"] }),
        EXIT_ONE_LINE
      )
    ).toBe(true)
  })

  it.each([
    [
      "a diagnostic from an earlier stage",
      "rg: no_such_dir: IO error for operation on no_such_dir: No such file or directory (os error 2)\n[terminal exited: exit code: 1]",
    ],
    ["exit 2", "[terminal exited: exit code: 2]"],
    ["a signal", "[terminal exited: exit code: 1, signal: SIGTERM]"],
    ["no exit line", ""],
    ["no output at all", null],
  ])("refuses %s", (_label, output) => {
    expect(isGrepNoMatchCommandResult(ISSUE_877_INPUT, output)).toBe(false)
  })

  it.each([
    ["no input", null],
    ["a non-search command", JSON.stringify({ command: "make test" })],
    ["an input with no command", JSON.stringify({ path: "src" })],
    ["a JSON scalar", "42"],
  ])("refuses %s", (_label, input) => {
    expect(isGrepNoMatchCommandResult(input, EXIT_ONE_LINE)).toBe(false)
  })
})
