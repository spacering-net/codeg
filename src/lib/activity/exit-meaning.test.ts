import { describe, expect, it } from "vitest"

import {
  isExitAnswer,
  readCommandExit,
  signalOfExitCode,
  type ExitMeaning,
} from "./exit-meaning"

function read(
  command: string,
  code: number | null,
  output = ""
): ExitMeaning | null {
  return readCommandExit(command, { code, signal: null }, output)
}

describe("readCommandExit: exits that answer the command", () => {
  it.each([
    ["rg -n 'source_bindings' src", "noMatch"],
    ['grep -rn "TODO" .', "noMatch"],
    ["egrep -q 'a|b' notes.txt", "noMatch"],
    ["pgrep -f 'next dev'", "noMatch"],
    ["git grep -n 'useFoo'", "noMatch"],
    ["test -f package.json", "false"],
    ["[ -d node_modules ]", "false"],
    ['[[ -n "$CI" ]]', "false"],
    ["git diff --quiet", "differs"],
    ["git -C repo diff --exit-code -- src", "differs"],
    ["cmp -s a.bin b.bin", "differs"],
    ["which python2", "notFound"],
    ["command -v rustup", "notFound"],
    ["printenv CODEX_HOME", "notFound"],
    ["lsof -i :3000", "noMatch"],
    ["pidof node", "noMatch"],
    ["git check-ignore -v docs/spec.md", "noMatch"],
    ["git config --get user.signingkey", "notFound"],
    ["git rev-parse --verify --quiet refs/heads/topic", "notFound"],
    ["git show-ref --verify --quiet refs/heads/topic", "notFound"],
    ["git merge-base --is-ancestor main topic", "false"],
  ])("`%s` exiting 1 with nothing printed: %s", (command, meaning) => {
    expect(read(command, 1)).toBe(meaning)
  })

  it("reads a diff's exit 1 with the diff it printed", () => {
    expect(read("diff a.txt b.txt", 1, "1c1\n< a\n---\n> b")).toBe("differs")
  })

  it("reads grep -c's zero counts as no match", () => {
    expect(read("grep -c foo a.ts b.ts", 1, "a.ts:0\nb.ts:0")).toBe("noMatch")
  })

  it("reads a lookup's own not-found line, a builtin's shell prefix and all", () => {
    expect(read("which python2", 1, "python2 not found")).toBe("notFound")
    expect(read("type foo", 1, "bash: type: foo: not found")).toBe("notFound")
    expect(read("which foo", 1, "which: no foo in (/usr/bin:/bin)")).toBe(
      "notFound"
    )
  })

  it("reads a missing path a read-only command was pointed at", () => {
    expect(
      read("cat missing.txt", 1, "cat: missing.txt: No such file or directory")
    ).toBe("notFound")
    expect(
      read(
        "ls src/missing",
        2,
        "ls: cannot access 'src/missing': No such file or directory"
      )
    ).toBe("notFound")
    expect(
      read(
        "sed -n '1,40p' src/missing.ts",
        2,
        "sed: can't read src/missing.ts: No such file or directory"
      )
    ).toBe("notFound")
  })

  it("takes the status from the end of a pipeline", () => {
    expect(read("ps aux | grep '[n]ode server'", 1)).toBe("noMatch")
    expect(read("rg -l foo | head -20", 1)).toBeNull()
  })

  it("looks past an `&& echo` the failing command never reached", () => {
    expect(read("[ -f .env ] && echo present", 1)).toBe("false")
    expect(read("grep -q foo f && echo found && echo done", 1)).toBe("noMatch")
  })

  it("follows setup chained ahead when nothing was printed", () => {
    expect(read("cd /repo && rg -n foo", 1)).toBe("noMatch")
    expect(
      read(
        "cd /missing && rg -n foo",
        1,
        "cd: no such file or directory: /missing"
      )
    ).toBeNull()
  })

  it("does not guess past a command ahead of it that might have failed", () => {
    expect(read("git status --short && rg foo", 1)).toBeNull()
    expect(read("pnpm build && test -f out/index.html", 1)).toBeNull()
    // The `ls` stops the line before the pipeline runs: the missing path is
    // its, not the head's.
    expect(
      read(
        "ls .docs/p0 && grep -n A3 .docs/p0/list.md | head -5",
        1,
        "ls: .docs/p0: No such file or directory"
      )
    ).toBeNull()
    expect(read("cd repo && ps aux | grep '[n]ode'", 1)).toBe("noMatch")
  })

  it("reads lists, comments, assignments, wrappers and paths", () => {
    expect(read("cd repo\nrg foo", 1)).toBe("noMatch")
    expect(read("rg foo # where is it used", 1)).toBe("noMatch")
    expect(read("# first look\nrg foo", 1)).toBe("noMatch")
    expect(read("FOO=1 grep -q x f", 1)).toBe("noMatch")
    expect(read("env LC_ALL=C grep -q x f", 1)).toBe("noMatch")
    expect(read("/usr/bin/grep -q x f", 1)).toBe("noMatch")
    expect(read("rg foo 2>/dev/null", 1)).toBe("noMatch")
    expect(read("rg foo 2>&1", 1)).toBe("noMatch")
  })
})

describe("readCommandExit: exits that stay failures", () => {
  it.each([
    ["pnpm test", 1, "FAIL lib/report.test.ts\nTests: 1 failed"],
    ["rg foo src", 2, "rg: src: No such file or directory (os error 2)"],
    ["grep -rn foo .", 1, "grep: warning: recursive search of stdin"],
    ["test -f a.txt", 2, "test: too many arguments"],
    ["git diff", 1, ""],
    ["git rev-parse HEAD~3", 1, ""],
    ["git merge-base main topic", 1, ""],
    ["printenv HOME", 1, "printenv: write error"],
    ["sed -i 's/a/b/' missing", 2, "sed: missing: No such file or directory"],
    ["ls", 1, ""],
  ])("`%s` exiting %i", (command, code, output) => {
    expect(read(command, code, output)).toBeNull()
  })

  it("leaves an exit a failure when the deciding command may not have run", () => {
    // An `exit` ends the line before the grep.
    expect(
      read("node -e 'process.exit(1)' || exit 1; grep -q . package.json", 1)
    ).toBeNull()
    // The cd failed without a word: the grep never ran.
    expect(
      read("cd /missing 2>/dev/null && grep -q . package.json", 1)
    ).toBeNull()
    // printf fails on a bad number, after the test passed.
    expect(
      read("test -f package.json && printf '%d' oops 2>/dev/null >/dev/null", 1)
    ).toBeNull()
    // An echo whose output cannot land fails too.
    expect(read("test -f a && echo yes > /dev/full", 1)).toBeNull()
  })

  it("leaves a comparison that could not read its files a failure", () => {
    expect(
      read(
        "git diff --no-index missing-file package.json",
        1,
        "error: Could not access 'missing-file'"
      )
    ).toBeNull()
    // The shell, by its full path, could not open the redirect.
    expect(
      read(
        "diff - package.json < /missing",
        1,
        "/bin/bash: /missing: No such file or directory"
      )
    ).toBeNull()
    expect(
      read(
        "diff - package.json < /missing",
        1,
        "bash: line 1: /missing: No such file or directory"
      )
    ).toBeNull()
  })

  it("does not read a sed that may write as a look", () => {
    expect(
      read(
        "sed -n 'w missing-dir/result.txt' package.json",
        1,
        "sed: missing-dir/result.txt: No such file or directory"
      )
    ).toBeNull()
    expect(
      read(
        "sed -E -n '1,4p' missing.ts",
        1,
        "sed: missing.ts: No such file or directory"
      )
    ).toBeNull()
  })

  it("leaves the shell's own complaint a failure", () => {
    // A glob that matched nothing: zsh exits 1 before diff runs.
    expect(
      read("diff a *.snap", 1, "(eval):1: no matches found: *.snap")
    ).toBeNull()
    // A redirect into a folder that is not there.
    expect(
      read(
        "cat a > out/x.log",
        1,
        "zsh:1: no such file or directory: out/x.log"
      )
    ).toBeNull()
  })

  it("does not read a line it cannot follow", () => {
    expect(read("set -euo pipefail; rg foo | head", 1)).toBeNull()
    expect(read('rg "$(cat pattern)" src', 1)).toBeNull()
    expect(read("rg `cat pattern` src", 1)).toBeNull()
    expect(read("(cd sub && rg foo)", 1)).toBeNull()
    expect(read("{ rg foo; }", 1)).toBeNull()
    expect(read("python - <<'PY'\nimport sys\nPY", 1)).toBeNull()
    expect(read("grep foo f &", 1)).toBeNull()
    expect(read("! grep -q foo f", 1)).toBeNull()
    expect(read("rg 'unterminated", 1)).toBeNull()
  })

  it("names the failures the shell's codes stand for", () => {
    expect(read("pyhton x.py", 127, "zsh:1: command not found: pyhton")).toBe(
      "commandNotFound"
    )
    expect(read("./run.sh", 126, "zsh:1: permission denied: ./run.sh")).toBe(
      "notExecutable"
    )
    expect(read("timeout 5 sleep 10", 124)).toBe("timedOut")
    expect(read("sleep 300", 143, "Command timed out after 2m 0s")).toBe(
      "timedOut"
    )
    expect(read("npm test", 124)).toBeNull()
  })

  it("has nothing to say about a zero or unknown code", () => {
    expect(read("rg foo", 0)).toBeNull()
    expect(read("rg foo", null)).toBeNull()
  })
})

describe("exit meanings", () => {
  it("tells an answer from a failure", () => {
    expect(isExitAnswer("noMatch")).toBe(true)
    expect(isExitAnswer("notFound")).toBe(true)
    expect(isExitAnswer("commandNotFound")).toBe(false)
    expect(isExitAnswer(null)).toBe(false)
  })

  it("names the signal a 128 + n code stands for", () => {
    expect(signalOfExitCode(137)).toBe("SIGKILL")
    expect(signalOfExitCode(130)).toBe("SIGINT")
    expect(signalOfExitCode(143)).toBe("SIGTERM")
    expect(signalOfExitCode(1)).toBeNull()
    expect(signalOfExitCode(null)).toBeNull()
  })
})
