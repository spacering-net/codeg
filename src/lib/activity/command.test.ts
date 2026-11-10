import { describe, expect, it } from "vitest"

import {
  detectHeredoc,
  exitFromMeta,
  extractAgentReportedExit,
  extractCommandExit,
  extractDisplayCommandFromToolInput,
  extractWallTimeMs,
  normalizeCommandOutput,
  simplifyShellCommand,
} from "./command"

describe("simplifyShellCommand", () => {
  it("strips nested shell wrappers", () => {
    expect(simplifyShellCommand(`/bin/zsh -lc "bash -lc 'pnpm test'"`)).toBe(
      "pnpm test"
    )
  })

  it("leaves a plain command alone", () => {
    expect(simplifyShellCommand("git status --short")).toBe(
      "git status --short"
    )
  })
})

describe("extractDisplayCommandFromToolInput", () => {
  it("reads command, cmd, argv and Antigravity's CommandLine", () => {
    expect(extractDisplayCommandFromToolInput('{"command":"ls -la"}')).toBe(
      "ls -la"
    )
    expect(
      extractDisplayCommandFromToolInput('{"cmd":["bash","-lc","make"]}')
    ).toBe("make")
    expect(
      extractDisplayCommandFromToolInput('{"CommandLine":"pnpm build"}')
    ).toBe("pnpm build")
    expect(extractDisplayCommandFromToolInput("echo hi")).toBe("echo hi")
  })
})

describe("detectHeredoc", () => {
  it("names the interpreter and counts the script lines", () => {
    const command = [
      "agent/.venv/bin/python - <<'PY'",
      "import json",
      "print(json.dumps({}))",
      "PY",
    ].join("\n")
    expect(detectHeredoc(command)).toEqual({
      head: "agent/.venv/bin/python - <<'PY'",
      interpreter: "python",
      bodyLines: 2,
    })
  })

  it("skips env assignments when finding the interpreter", () => {
    const heredoc = detectHeredoc("FOO=1 node <<EOF\nconsole.log(1)\nEOF")
    expect(heredoc?.interpreter).toBe("node")
    expect(heredoc?.bodyLines).toBe(1)
  })

  it("counts to the end when the closing delimiter is missing", () => {
    expect(detectHeredoc("cat <<-'END'\na\nb")?.bodyLines).toBe(2)
  })

  it("ignores single-line commands and multi-line commands without one", () => {
    expect(detectHeredoc("cat <<EOF")).toBeNull()
    expect(detectHeredoc("cd web &&\n  pnpm test")).toBeNull()
  })
})

describe("extractCommandExit", () => {
  it("reads codex's command envelope", () => {
    expect(
      extractCommandExit('{"formatted_output":"boom","exit_code":2}')
    ).toEqual({ code: 2, signal: null })
  })

  it("reads a numeric exit_code on other JSON envelopes", () => {
    expect(extractCommandExit('{"stdout":"","exit_code":127}')).toEqual({
      code: 127,
      signal: null,
    })
  })

  it("reads the backend's terminal exit line, including signals", () => {
    expect(
      extractCommandExit("npm ERR!\n[terminal exited: exit code: 1]\n")
    ).toEqual({ code: 1, signal: null })
    expect(extractCommandExit("[terminal exited: signal: SIGKILL]")).toEqual({
      code: null,
      signal: "SIGKILL",
    })
    expect(extractCommandExit("[terminal exited: finished]")).toBeNull()
  })

  it("reads the Exit code line inside the fence claude-agent-acp puts around a failure", () => {
    // Without a terminal channel the adapter sends a failed result fenced for
    // Markdown; history (the transcript) keeps it bare. Both read the same.
    expect(
      extractCommandExit(
        "```\nExit code 1\nls: /missing: No such file or directory\n```"
      )
    ).toEqual({ code: 1, signal: null })
    expect(extractCommandExit("```\nboom\n```")).toBeNull()
  })

  it("reads Claude Code's leading and OpenCode's trailing Exit code line", () => {
    expect(extractCommandExit("Exit code 1\nFAIL src/a.test.ts")).toEqual({
      code: 1,
      signal: null,
    })
    expect(extractCommandExit("boom\n\nExit code 3")).toEqual({
      code: 3,
      signal: null,
    })
  })

  it("reads codex's CLI framing", () => {
    const framed = [
      "Chunk ID: 065b2b",
      "Wall time: 0.05 seconds",
      "Process exited with code 4",
      "Output:",
      "nope",
    ].join("\n")
    expect(extractCommandExit(framed)).toEqual({ code: 4, signal: null })
  })

  it("does not invent a code from text in the middle of the output", () => {
    expect(
      extractCommandExit("starting\nExit code 9 is reserved\ndone")
    ).toBeNull()
    expect(extractCommandExit("")).toBeNull()
    expect(extractCommandExit(null)).toBeNull()
  })

  // OpenCode 2 closes a command's result with a notice block of its own
  // (packages/core/src/shell/result.ts `notice`): the live 2.2.0 completion
  // joins its blocks, history keeps them apart — the last line reads alike.
  it("reads OpenCode 2's closing exit notice", () => {
    const live =
      "ls: /definitely-not-here: No such file or directory\n\nExited with code 1"
    expect(extractCommandExit(live)).toEqual({ code: 1, signal: null })
    expect(extractAgentReportedExit(live)).toEqual({ code: 1, signal: null })
    expect(extractAgentReportedExit("out\n\nKilled by SIGTERM")).toEqual({
      code: null,
      signal: "SIGTERM",
    })
    expect(
      extractAgentReportedExit("Exited with code 3\nstill printing")
    ).toBeNull()
    expect(extractAgentReportedExit("Timed out before completion")).toBeNull()
  })
})

describe("exitFromMeta", () => {
  it("reads the exit code a live call carries on its meta", () => {
    expect(exitFromMeta({ "codeg.exitCode": 2 })).toEqual({
      code: 2,
      signal: null,
    })
    expect(exitFromMeta({ "codeg.exitCode": "2" })).toBeNull()
    expect(exitFromMeta(null)).toBeNull()
  })
})

describe("wall time", () => {
  const framed = "Chunk ID: x\nWall time: 12.5 seconds\nOutput:\nok"

  it("reports milliseconds", () => {
    expect(extractWallTimeMs(framed)).toBe(12500)
    expect(extractWallTimeMs("no wall time")).toBeNull()
  })
})

describe("normalizeCommandOutput", () => {
  it("unwraps JSON envelopes, CLI framing and fences", () => {
    expect(normalizeCommandOutput('{"stdout":"a\\nb"}')).toBe("a\nb")
    expect(
      normalizeCommandOutput("Chunk ID: 1\nWall time: 1s\nOutput:\nhello")
    ).toBe("hello")
    expect(normalizeCommandOutput("```sh\nls\n```")).toBe("ls")
  })
})
