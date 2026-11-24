import { describe, expect, it } from "vitest"

import {
  KIMI_MCP_OAUTH_META,
  readKimiMcpOAuth,
  startKimiMcpOAuth,
  updateKimiMcpOAuth,
} from "./kimi-mcp-oauth"

const URL =
  "https://auth.example.test/authorize?state=a%2Bb&code_challenge=x_y&code_challenge_method=S256&redirect_uri=http%3A%2F%2F127.0.0.1%3A43127%2Fcallback"
const statusText = (url = URL, server = "notion") =>
  `Open this URL in your browser to authorize "${server}":\n\n${url}\n\nWaiting for the OAuth callback (timeout 15 min). If you cancel, call this tool again to restart the flow.`
const opening = () =>
  startKimiMcpOAuth("kimi_code", "mcp__notion__authenticate", { keep: 1 })
const update = (title: string | null, status: string | null = null) => ({
  title,
  status,
  content: null,
  raw_input: null,
  raw_output: null,
  meta: null,
})
const waiting = () =>
  updateKimiMcpOAuth(opening(), update(statusText()), "in_progress")

describe("Kimi ACP OAuth status compatibility", () => {
  it("keeps the original HTTPS URL bytes, and independent metadata, while waiting", () => {
    expect(readKimiMcpOAuth(waiting())).toEqual({
      toolName: "mcp__notion__authenticate",
      server: "notion",
      phase: "waiting",
      url: URL,
    })
    expect(waiting()?.keep).toBe(1)
  })

  it.each([
    ["kimi_code", "mcp__notion__fetch"],
    ["kimi_code", "authenticate"],
    ["codex", "mcp__notion__authenticate"],
    ["claude_code", "mcp__notion__authenticate"],
  ])("does not establish OAuth context for %s / %s", (agent, tool) => {
    const meta = startKimiMcpOAuth(agent, tool, null)
    expect(
      readKimiMcpOAuth(
        updateKimiMcpOAuth(meta, update(statusText()), "in_progress")
      )
    ).toBeNull()
  })

  it.each([
    "http://auth.example.test/authorize?state=x",
    "javascript:alert(1)",
    "file:///tmp/oauth",
    "https://user:password@auth.example.test/authorize",
    "https://auth.example.test/authorize\nhttps://evil.example.test",
    "https://auth.example.test/authorize oauth",
    "https://",
    "https://auth.example.test/authorize\u0000",
    "https://auth.example.test/authorize\u007f",
  ])("rejects an unsafe or malformed URL: %s", (url) => {
    expect(
      readKimiMcpOAuth(
        updateKimiMcpOAuth(opening(), update(statusText(url)), "in_progress")
      )?.url
    ).toBeNull()
  })

  it("never finds authorization URLs in a tool result, input or ordinary title", () => {
    for (const patch of [
      { title: "result", raw_output: statusText() },
      { title: "result", content: statusText() },
      { title: "result", raw_input: statusText() },
      { title: `Please open ${URL}` },
      { title: statusText(), status: "in_progress" },
      { title: statusText(), raw_output: "unrelated result" },
      { title: statusText(URL, "other-server") },
    ]) {
      const meta = updateKimiMcpOAuth(
        opening(),
        { ...update(null), ...patch },
        "in_progress"
      )
      expect(readKimiMcpOAuth(meta)?.url).toBeNull()
    }
  })

  it.each(["completed", "failed", "cancelled", "error"])(
    "retires URLs on %s and ignores late progress",
    (status) => {
      const ended = updateKimiMcpOAuth(
        waiting(),
        update(null, status),
        "in_progress"
      )
      expect(ended?.[KIMI_MCP_OAUTH_META]).toBeNull()
      expect(
        readKimiMcpOAuth(
          updateKimiMcpOAuth(ended, update(statusText()), status)
        )
      ).toBeNull()
    }
  )

  it("removes the link while reconnecting without declaring verified access", () => {
    const meta = updateKimiMcpOAuth(
      waiting(),
      update("Authorized — reconnecting notion…"),
      "in_progress"
    )
    expect(readKimiMcpOAuth(meta)).toMatchObject({
      phase: "reconnecting",
      url: null,
    })
    expect(
      readKimiMcpOAuth(
        updateKimiMcpOAuth(
          meta,
          update("Discovering OAuth metadata for notion…"),
          "in_progress"
        )
      )
    ).toMatchObject({ phase: "pending", url: null })
  })

  it("fails closed after context loss, and never imports a foreign binding from update metadata", () => {
    expect(
      readKimiMcpOAuth(
        updateKimiMcpOAuth(null, update(statusText()), "in_progress")
      )
    ).toBeNull()
    expect(
      readKimiMcpOAuth(
        updateKimiMcpOAuth(
          null,
          { ...update(statusText()), meta: waiting() },
          "in_progress"
        )
      )
    ).toBeNull()
    expect(
      readKimiMcpOAuth(
        startKimiMcpOAuth("codex", "mcp__notion__authenticate", waiting())
      )
    ).toBeNull()
  })

  it("does not borrow the URL of another parallel authenticate call", () => {
    const other = startKimiMcpOAuth(
      "kimi_code",
      "mcp__other__authenticate",
      null
    )
    expect(
      readKimiMcpOAuth(
        updateKimiMcpOAuth(other, update(statusText()), "in_progress")
      )?.url
    ).toBeNull()
    expect(readKimiMcpOAuth(waiting())?.url).toBe(URL)
  })
})

it("accepts the Rust ACP bridge's inprogress status spelling", () => {
  const running = updateKimiMcpOAuth(
    opening(),
    update("Authenticating notion", "inprogress"),
    "pending"
  )
  const meta = updateKimiMcpOAuth(running, update(statusText()), "inprogress")
  expect(readKimiMcpOAuth(meta)?.url).toBe(URL)
})

it("matches Kimi-sanitized tool names to raw server labels without borrowing another server", () => {
  const meta = startKimiMcpOAuth(
    "kimi_code",
    "mcp__my_notion__authenticate",
    null
  )
  const progress = updateKimiMcpOAuth(
    meta,
    update(statusText(URL, "my.notion")),
    "inprogress"
  )
  expect(readKimiMcpOAuth(progress)).toMatchObject({
    phase: "waiting",
    server: "my.notion",
    url: URL,
  })
})
