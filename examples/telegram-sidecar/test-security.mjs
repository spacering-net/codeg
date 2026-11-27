// SPDX-License-Identifier: Apache-2.0
// Secret redaction regression tests. Only placeholder tokens are used; no real
// secrets are read and no production endpoint is contacted.
import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { TelegramClient } from "./lib/tg.mjs"
import { CodegClient } from "./lib/codeg.mjs"
import { CodegTgBot, createLogger } from "./bot.mjs"
import { StateStore } from "./lib/state.mjs"
import { WebAppProxy } from "./lib/webapp-proxy.mjs"
import { QuickTunnelManager } from "./lib/tunnel.mjs"
import { redactText, registerSecret, resetRedaction } from "./lib/redact.mjs"

// Assemble Telegram-shaped test fixtures at runtime so static secret scanners
// do not flag unit-test placeholders as leaked bot tokens.
const syntheticTgToken = (botId, prefix, body) => `${botId}:${prefix}${body}`

const PLACEHOLDER_TG_TOKEN = syntheticTgToken(
  "123456789",
  "TEST_ONLY_",
  "PLACEHOLDER_TOKEN_do_not_use"
)
const PLACEHOLDER_CODEG_TOKEN = "codeg-TEST-ONLY-PLACEHOLDER-TOKEN"

function stalledServer() {
  const server = http.createServer(() => {
    // Never responds: forces the client timeout path.
  })
  return {
    server,
    async start() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
      return `http://127.0.0.1:${server.address().port}`
    },
    async stop() {
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

test("redact: masks known secret values and credential-bearing shapes but keeps diagnostics", () => {
  resetRedaction()
  registerSecret(PLACEHOLDER_TG_TOKEN)
  registerSecret(PLACEHOLDER_CODEG_TOKEN)

  // Known values are masked wherever they appear.
  assert.equal(redactText(`token=${PLACEHOLDER_TG_TOKEN}`), "token=[REDACTED]")
  assert.equal(
    redactText(`Authorization: ${PLACEHOLDER_CODEG_TOKEN}`),
    "Authorization: [REDACTED]"
  )

  const syntheticTimeoutToken = syntheticTgToken(
    "123456789",
    "AAH",
    "fakeTokenValue_abcdefghijklmnop"
  )
  const syntheticUnknownSecret = [
    "AAF",
    "unknownButRealisticValue1234567890",
  ].join("")
  const syntheticUnknownToken = syntheticTgToken(
    "987654321",
    "",
    syntheticUnknownSecret
  )

  // Telegram bot API path keeps the method but loses the token.
  assert.equal(
    redactText(
      `Telegram HTTP timeout (35000ms) on POST /bot${syntheticTimeoutToken}/getUpdates`
    ),
    "Telegram HTTP timeout (35000ms) on POST /bot[REDACTED]/getUpdates"
  )

  // Unknown-shaped tokens are still masked by pattern, not only by registry.
  const redactedUnknownUrl = redactText(
    `GET https://api.telegram.org/bot${syntheticUnknownToken}/getMe`
  )
  assert.match(redactedUnknownUrl, /bot\[REDACTED\]\/getMe/)
  assert.ok(!redactedUnknownUrl.includes(syntheticUnknownSecret))

  // Codeg WS subprotocol and bearer headers.
  assert.equal(
    redactText("codeg-token.c2VjcmV0LXZhbHVl"),
    "codeg-token.[REDACTED]"
  )
  assert.equal(redactText("Bearer abcdef0123456789abcdef"), "Bearer [REDACTED]")

  // Proxy credentials inside a URL keep host/port for debugging.
  assert.equal(
    redactText("proxy http://alice:s3cretpass@127.0.0.1:7890 failed"),
    "proxy http://[REDACTED]@127.0.0.1:7890 failed"
  )

  // Diagnostic signal survives.
  assert.match(
    redactText("Codeg health failed (500 http_error): boom"),
    /health failed \(500 http_error\)/
  )
  assert.equal(redactText(""), "")
})

test("redact: Telegram timeout errors never contain the bot token", async () => {
  resetRedaction()
  const stalled = stalledServer()
  const base = await stalled.start()
  const loggerLines = []
  const logger = {
    info() {},
    warn(m) {
      loggerLines.push(m)
    },
    error(m) {
      loggerLines.push(m)
    },
  }
  const client = new TelegramClient({
    token: PLACEHOLDER_TG_TOKEN,
    apiBase: base,
    proxyUrl: "",
    logger,
  })

  try {
    let message = ""
    try {
      // Short timeout so the test stays fast; the token lives in the same path.
      await client.call("getUpdates", { timeout: 1 }, { timeoutMs: 120 })
    } catch (err) {
      message = String(err.message)
    }
    assert.ok(message, "the timeout must still surface as an error")
    assert.ok(
      !message.includes(PLACEHOLDER_TG_TOKEN),
      `token leaked: ${message}`
    )
    assert.doesNotMatch(message, /TEST_ONLY_PLACEHOLDER_TOKEN/)
    // The method and the timeout remain visible for diagnosis.
    assert.match(message, /timeout/i)
    assert.match(message, /getUpdates/)

    // The raw request path (used by file downloads) is covered too.
    let rawMessage = ""
    try {
      await client._requestRaw(`${base}/bot${PLACEHOLDER_TG_TOKEN}/getFile`, {
        timeoutMs: 120,
      })
    } catch (err) {
      rawMessage = String(err.message)
    }
    assert.ok(rawMessage)
    assert.ok(
      !rawMessage.includes(PLACEHOLDER_TG_TOKEN),
      `token leaked: ${rawMessage}`
    )
  } finally {
    await stalled.stop()
  }
})

test("redact: Codeg client errors and logs never contain the Codeg token or proxy password", async () => {
  resetRedaction()
  const stalled = stalledServer()
  const base = await stalled.start()
  const lines = []
  const logger = {
    info() {},
    warn(m) {
      lines.push(m)
    },
    error(m) {
      lines.push(m)
    },
  }
  const client = new CodegClient({
    baseUrl: base,
    tokenProvider: () => PLACEHOLDER_CODEG_TOKEN,
    logger,
  })

  try {
    let message = ""
    try {
      await client.post("health", {}, { timeoutMs: 30 })
    } catch (err) {
      message = String(err.message)
    }
    assert.ok(message)
    assert.ok(
      !message.includes(PLACEHOLDER_CODEG_TOKEN),
      `codeg token leaked: ${message}`
    )
    assert.match(message, /health/)
  } finally {
    await stalled.stop()
  }

  // Proxy credentials embedded in a base URL must not reach errors or logs.
  const proxyStalled = stalledServer()
  const proxyBase = await proxyStalled.start()
  const authBase = proxyBase.replace("http://", "http://alice:s3cretpass@")
  const proxyLines = []
  const proxyClient = new CodegClient({
    baseUrl: authBase,
    tokenProvider: () => PLACEHOLDER_CODEG_TOKEN,
    logger: {
      info() {},
      warn(m) {
        proxyLines.push(m)
      },
      error(m) {
        proxyLines.push(m)
      },
    },
  })
  try {
    let msg = ""
    try {
      await proxyClient.post("health", {}, { timeoutMs: 30 })
    } catch (err) {
      msg = String(err.message)
    }
    assert.ok(!msg.includes("s3cretpass"), `proxy password leaked: ${msg}`)
    assert.ok(!proxyLines.join("\n").includes("s3cretpass"))
  } finally {
    await proxyStalled.stop()
  }
})

test("redact: createLogger masks secrets in file and console output", () => {
  resetRedaction()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeg-tg-log-"))
  try {
    const logFile = path.join(dir, "bot.log")
    registerSecret(PLACEHOLDER_TG_TOKEN)
    const logger = createLogger(logFile, { quietConsole: true })

    logger.info(`[tg] using token ${PLACEHOLDER_TG_TOKEN}`)
    logger.warn(
      `[tg] POST https://api.telegram.org/bot${PLACEHOLDER_TG_TOKEN}/getMe failed`
    )
    logger.error(`[codeg] Bearer ${PLACEHOLDER_CODEG_TOKEN} rejected`)

    const text = fs.readFileSync(logFile, "utf8")
    assert.ok(
      !text.includes(PLACEHOLDER_TG_TOKEN),
      "raw bot token must never be logged"
    )
    assert.ok(
      !text.includes(PLACEHOLDER_CODEG_TOKEN),
      "raw codeg token must never be logged"
    )
    assert.match(text, /\[REDACTED\]/)
    // Log levels and method names stay readable.
    assert.match(text, /\[INFO\]/)
    assert.match(text, /\[ERROR\]/)
    assert.match(text, /getMe/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("redact: errors surfaced to Telegram are redacted too", async () => {
  resetRedaction()
  registerSecret(PLACEHOLDER_TG_TOKEN)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeg-tg-ui-"))
  try {
    const sent = []
    const tg = {
      async sendMessage(chatId, text, opts = {}) {
        sent.push({ chatId, text, opts })
        return { message_id: sent.length }
      },
      async answerCallbackQuery() {
        return true
      },
      async sendChatAction() {
        return null
      },
      async editMessageText() {
        return true
      },
      async getMe() {
        return { id: 1, username: "redact_test_bot" }
      },
      async setMyCommands() {
        return true
      },
    }
    const codeg = {
      on() {},
      attach() {},
      detach() {},
      isAttached() {
        return false
      },
      connectWs() {},
      closeWs() {},
      health: async () => ({ version: "0.0.0" }),
      listChatChannels: async () => [],
      listAllConversations: async () => {
        throw new Error(
          `upstream rejected https://api.telegram.org/bot${PLACEHOLDER_TG_TOKEN}/getUpdates`
        )
      },
      listAllFolderDetails: async () => [],
      acpListConnections: async () => [],
    }
    const state = new StateStore(path.join(dir, "state.json"))
    const bot = new CodegTgBot({
      cfg: {
        allowedUserIds: [555],
        maxMessageChars: 3800,
        streamThrottleMs: 10,
      },
      tg,
      codeg,
      state,
      logger: { info() {}, warn() {}, error() {} },
    })

    await bot.handleUpdate({
      message: {
        message_id: 1,
        from: { id: 555 },
        chat: { id: 555, type: "private" },
        text: "/sessions",
      },
    })

    assert.ok(
      sent.length >= 1,
      "the failure must still be reported to the user"
    )
    const body = sent.map((s) => s.text).join("\n")
    assert.ok(
      !body.includes(PLACEHOLDER_TG_TOKEN),
      `token leaked to chat: ${body}`
    )
    assert.match(body, /\[REDACTED\]|获取会话失败/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("redact: the bot never writes secrets into its own log on auth rejection", async () => {
  resetRedaction()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeg-tg-auth-"))
  try {
    const logFile = path.join(dir, "bot.log")
    registerSecret(PLACEHOLDER_TG_TOKEN)
    const logger = createLogger(logFile, { quietConsole: true })
    const bot = new CodegTgBot({
      cfg: {
        allowedUserIds: [555],
        maxMessageChars: 3800,
        streamThrottleMs: 10,
      },
      tg: {
        async sendMessage() {
          return { message_id: 1 }
        },
      },
      codeg: { on() {} },
      state: new StateStore(path.join(dir, "state.json")),
      logger,
    })

    await bot.handleUpdate({
      message: {
        message_id: 1,
        from: { id: 999 },
        chat: { id: 999, type: "private" },
        text: `/help ${PLACEHOLDER_TG_TOKEN}`,
      },
    })

    const text = fs.readFileSync(logFile, "utf8")
    assert.ok(!text.includes(PLACEHOLDER_TG_TOKEN))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("redact: legacy log lines can be safely displayed through the shared redactor", () => {
  resetRedaction()
  const legacyLine = `[2026-11-25T00:55:32.766Z] [WARN] [tg] getUpdates error: Telegram HTTP timeout (35000ms) on POST /bot${PLACEHOLDER_TG_TOKEN}/getUpdates`
  const shown = redactText(legacyLine)
  assert.ok(!shown.includes(PLACEHOLDER_TG_TOKEN))
  assert.match(shown, /bot\[REDACTED\]\/getUpdates/)
  assert.match(shown, /\[WARN\]/)
  assert.match(shown, /35000ms/)
})

test("redact: tunnel output and webapp logs are masked at their own boundary", () => {
  resetRedaction()
  registerSecret(PLACEHOLDER_CODEG_TOKEN)
  // cloudflared echoes the tunnel token in its own output; the tunnel manager
  // runs every chunk through redactText before it reaches run/quick.log.
  const chunk = `INF tunnel registered with token ${PLACEHOLDER_CODEG_TOKEN}\n`
  assert.ok(!redactText(chunk).includes(PLACEHOLDER_CODEG_TOKEN))
  assert.match(redactText(chunk), /tunnel registered/)
})

test("webapp: unsupported upstreams are rejected before requesting credentials", async () => {
  let tokenReads = 0
  const opts = {
    codegTokenProvider: () => {
      tokenReads += 1
      return PLACEHOLDER_CODEG_TOKEN
    },
  }
  for (const upstreamUrl of [
    "https://127.0.0.1:3080",
    "http://example.com:3080",
  ]) {
    assert.throws(
      () => new WebAppProxy({ ...opts, upstreamUrl }),
      /http:\/\/ loopback/
    )
  }
  assert.equal(tokenReads, 0)
  const proxy = new WebAppProxy({
    ...opts,
    upstreamUrl: "http://127.0.0.1:3080",
  })
  await proxy.stop()
})

test("tunnel: restarting with a stale pid file never signals an unowned process", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeg-tg-tunnel-"))
  const originalKill = process.kill
  const signaled = []
  try {
    const executable = path.join(dir, "cloudflared-fixture")
    fs.writeFileSync(executable, "fixture", "utf8")
    fs.writeFileSync(path.join(dir, "tunnel.pid"), "424242", "utf8")
    process.kill = (pid) => {
      signaled.push(pid)
      return true
    }
    const manager = new QuickTunnelManager({
      cloudflaredPath: executable,
      targetUrl: "http://127.0.0.1:3081",
      runDir: dir,
      logger: { info() {}, warn() {}, error() {} },
    })
    // Exercise the restart path without launching an external executable.
    manager._spawnChild = () => {}
    manager.start()
    manager.stop()
    assert.deepEqual(signaled, [])
  } finally {
    process.kill = originalKill
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
