// SPDX-License-Identifier: Apache-2.0
import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

import { loadTelegramToken, loadCodegToken } from "./lib/secrets.mjs"
import { StateStore } from "./lib/state.mjs"
import {
  escapeHtml,
  mdToTelegramHtml,
  splitMarkdownForTelegram,
  formatPermissionCard,
  formatQuestionCard,
  formatPlanApprovalCard,
} from "./lib/format.mjs"
import { TelegramClient } from "./lib/tg.mjs"
import { CodegClient } from "./lib/codeg.mjs"
import { SimpleWebSocket } from "./lib/ws-client.mjs"
import { verifyTelegramInitData, WebAppProxy } from "./lib/webapp-proxy.mjs"
import { CodegTgBot, createLogger } from "./bot.mjs"

function waitUntil(fn, timeoutMs = 4000, intervalMs = 20) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        const res = fn()
        if (res) return resolve(res)
      } catch (err) {
        return reject(err)
      }
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`waitUntil timed out after ${timeoutMs}ms`))
      }
      setTimeout(tick, intervalMs)
    }
    tick()
  })
}

// ─── Minimal RFC6455 WebSocket Frame Codec for Local Mock Codeg Server ───
function encodeWsTextFrame(text) {
  const payload = Buffer.from(text, "utf8")
  const len = payload.length
  let header
  if (len < 126) {
    header = Buffer.alloc(2)
    header[0] = 0x81
    header[1] = len
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([header, payload])
}

function tryDecodeWsFrame(buf) {
  if (buf.length < 2) return null
  const b0 = buf[0]
  const b1 = buf[1]
  const opcode = b0 & 0x0f
  const masked = (b1 & 0x80) !== 0
  let payloadLen = b1 & 0x7f
  let offset = 2
  if (payloadLen === 126) {
    if (buf.length < 4) return null
    payloadLen = buf.readUInt16BE(2)
    offset = 4
  } else if (payloadLen === 127) {
    if (buf.length < 10) return null
    payloadLen = Number(buf.readBigUInt64BE(2))
    offset = 10
  }
  const maskLen = masked ? 4 : 0
  if (buf.length < offset + maskLen + payloadLen) return null
  const maskKey = masked ? buf.subarray(offset, offset + 4) : null
  offset += maskLen
  const rawPayload = Buffer.from(buf.subarray(offset, offset + payloadLen))
  if (masked && maskKey) {
    for (let i = 0; i < rawPayload.length; i++) {
      rawPayload[i] ^= maskKey[i % 4]
    }
  }
  return {
    opcode,
    payload: rawPayload,
    bytesConsumed: offset + payloadLen,
  }
}

// ─── Mock Telegram HTTP API Server ───
function createMockTelegramServer() {
  const calls = []
  let nextMsgId = 100
  let nextThreadId = 500
  let topicsEnabled = true

  const server = http.createServer((req, res) => {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      const url = new URL(req.url, "http://127.0.0.1")
      const parts = url.pathname.split("/").filter(Boolean)
      const method = parts[parts.length - 1]
      const rawBody = Buffer.concat(chunks).toString("utf8")
      let params = {}
      if (req.headers["content-type"]?.includes("application/json")) {
        try {
          params = JSON.parse(rawBody || "{}")
        } catch {
          params = {}
        }
      } else {
        params = { _multipartRaw: rawBody }
      }
      calls.push({ method, params })

      const reply = (ok, resultOrError) => {
        res.writeHead(ok ? 200 : resultOrError.error_code || 400, {
          "Content-Type": "application/json",
        })
        if (ok) {
          res.end(JSON.stringify({ ok: true, result: resultOrError }))
        } else {
          res.end(JSON.stringify({ ok: false, ...resultOrError }))
        }
      }

      switch (method) {
        case "getMe":
          return reply(true, {
            id: 123456,
            is_bot: true,
            username: "test_codeg_bot",
          })
        case "setMyCommands":
        case "answerCallbackQuery":
        case "sendChatAction":
        case "editForumTopic":
        case "closeForumTopic":
        case "deleteForumTopic":
          return reply(true, true)
        case "createForumTopic":
          if (!topicsEnabled) {
            return reply(false, {
              error_code: 400,
              description: "Bad Request: topics are not enabled in this chat",
            })
          }
          nextThreadId += 1
          return reply(true, {
            message_thread_id: nextThreadId,
            name: params.name,
          })
        case "sendMessage":
        case "sendDocument":
          nextMsgId += 1
          return reply(true, {
            message_id: nextMsgId,
            chat: { id: Number(params.chat_id || 424242), type: "private" },
            message_thread_id: params.message_thread_id,
            text: params.text || "",
          })
        case "editMessageText":
        case "editMessageReplyMarkup":
          return reply(true, {
            message_id: params.message_id,
            chat: { id: Number(params.chat_id), type: "private" },
            text: params.text || "",
          })
        default:
          return reply(true, true)
      }
    })
  })

  return {
    server,
    calls,
    setTopicsEnabled: (v) => {
      topicsEnabled = v
    },
    async start() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
      const { port } = server.address()
      return `http://127.0.0.1:${port}`
    },
    async stop() {
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

// ─── Mock Codeg HTTP + WebSocket Server ───
function createMockCodegServer(expectedToken = "codeg-test-token") {
  const apiCalls = []
  const wsHandshakes = []
  const sockets = new Set()
  const subscriptions = new Map() // connectionId -> Set<{ socket, subscriptionId }>

  const folders = [
    {
      id: 10,
      name: "demo-project",
      path: "D:\\work\\demo-project",
      git_branch: "main",
      default_agent_type: "claude_code",
      kind: "regular",
      alias: "示例项目",
      last_opened_at: "2026-11-22T08:00:00Z",
    },
    {
      id: 11,
      name: "sample-app",
      path: "D:\\work\\sample-app",
      git_branch: "dev",
      default_agent_type: "codex",
      kind: "regular",
      alias: null,
      last_opened_at: "2026-11-21T08:00:00Z",
    },
  ]

  const agents = [
    {
      agent_type: "claude_code",
      name: "Claude Code",
      enabled: true,
      available: true,
    },
    { agent_type: "codex", name: "Codex CLI", enabled: true, available: true },
  ]

  const conversations = [
    {
      id: 201,
      folder_id: 10,
      title: "修复寻路 Bug",
      agent_type: "claude_code",
      status: "pending_review",
      kind: "regular",
      external_id: "ext-201",
      updated_at: "2026-11-22T07:50:00Z",
    },
  ]

  const connections = new Map()
  const snapshots = new Map()
  let nextConvId = 300
  let nextConnSeq = 1
  let eventSeq = 0

  function sendWs(socket, obj) {
    if (!socket.destroyed && socket.writable) {
      socket.write(encodeWsTextFrame(JSON.stringify(obj)))
    }
  }

  function pushGlobal(channel, payload) {
    for (const sock of sockets) {
      sendWs(sock, { channel, payload })
    }
  }

  function pushAcpEvent(connectionId, payload) {
    eventSeq += 1
    const subs = subscriptions.get(connectionId)
    if (!subs) return
    for (const entry of subs) {
      sendWs(entry.socket, {
        type: "event",
        subscription_id: entry.subscriptionId,
        envelope: {
          seq: eventSeq,
          connection_id: connectionId,
          ...payload,
        },
      })
    }
  }

  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization || ""
    if (auth !== `Bearer ${expectedToken}`) {
      res.writeHead(401, { "Content-Type": "text/plain" })
      res.end("Unauthorized")
      return
    }
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      if (req.method === "GET" && req.url === "/workspace") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        res.end(
          "<!DOCTYPE html><html><head><title>Codeg</title></head><body>ok</body></html>"
        )
        return
      }
      const endpoint = req.url.replace(/^\/api\//, "")
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
      apiCalls.push({ endpoint, body })

      const json = (status, data) => {
        res.writeHead(status, { "Content-Type": "application/json" })
        res.end(JSON.stringify(data))
      }

      switch (endpoint) {
        case "health":
          return json(200, { status: "ok", version: "0.45.0" })
        case "list_chat_channels":
          return json(200, [])
        case "list_open_folder_details":
        case "list_all_folder_details":
          return json(200, folders)
        case "acp_list_agents":
          return json(200, agents)
        case "list_all_conversations":
          return json(200, conversations)
        case "get_folder_conversation": {
          const conv = conversations.find((c) => c.id === body.conversationId)
          if (!conv)
            return json(404, { code: "not_found", message: "not found" })
          return json(200, {
            summary: conv,
            turns: [
              {
                id: "t1",
                role: "user",
                blocks: [{ type: "text", text: "排查一下寻路卡住问题" }],
              },
              {
                id: "t2",
                role: "assistant",
                blocks: [{ type: "text", text: "我已定位到 A* 边界条件。" }],
              },
            ],
          })
        }
        case "create_conversation": {
          nextConvId += 1
          const id = nextConvId
          conversations.push({
            id,
            folder_id: body.folderId,
            title: body.title || null,
            agent_type: body.agentType,
            status: "in_progress",
            kind: "regular",
            external_id: null,
            updated_at: new Date().toISOString(),
          })
          return json(200, id)
        }
        case "update_conversation_title": {
          const conv = conversations.find((c) => c.id === body.conversationId)
          if (conv) conv.title = body.title
          return json(200, null)
        }
        case "delete_conversation":
          return json(200, null)
        case "acp_list_connections":
          return json(200, Array.from(connections.values()))
        case "acp_find_connection_for_conversation": {
          for (const [cid, snap] of snapshots.entries()) {
            if (snap.conversation_id === body.conversationId) {
              return json(200, { connection_id: cid, event_seq: eventSeq })
            }
          }
          return json(200, null)
        }
        case "acp_get_session_snapshot":
          return json(200, snapshots.get(body.connectionId) || null)
        case "acp_connect": {
          const cid = `conn-${nextConnSeq++}`
          connections.set(cid, {
            id: cid,
            agent_type: body.agentType,
            status: "connected",
          })
          snapshots.set(cid, {
            connection_id: cid,
            conversation_id: null,
            folder_id: null,
            status: "connected",
            external_id: body.sessionId || `ext-${cid}`,
            modes: {
              current_mode_id: "default",
              available_modes: [
                { id: "default", name: "Default", description: "Ask on edits" },
                {
                  id: "bypassPermissions",
                  name: "Bypass",
                  description: "Auto allow",
                },
              ],
            },
            config_options: [
              {
                id: "model",
                name: "Model",
                kind: {
                  type: "select",
                  current_value: "claude-sonnet-4-5",
                  options: [
                    { value: "claude-sonnet-4-5", name: "Sonnet 4.5" },
                    { value: "claude-opus-4-5", name: "Opus 4.5" },
                  ],
                  groups: [],
                },
              },
            ],
            pending_permission: null,
            pending_question: null,
            pending_plan_approval: null,
          })
          return json(200, cid)
        }
        case "acp_disconnect":
          connections.delete(body.connectionId)
          return json(200, null)
        case "acp_prompt":
          return json(200, null)
        case "acp_cancel":
        case "acp_set_mode":
        case "acp_set_config_option":
        case "acp_respond_permission":
        case "acp_answer_question":
        case "acp_answer_plan_approval":
          return json(200, null)
        default:
          return json(404, {
            code: "not_found",
            message: `Unknown ${endpoint}`,
          })
      }
    })
  })

  server.on("upgrade", (req, socket) => {
    const protoHeader = req.headers["sec-websocket-protocol"] || ""
    const protocols = protoHeader.split(",").map((s) => s.trim())
    const expectedSub = `codeg-token.${Buffer.from(expectedToken, "utf8").toString("base64url")}`
    wsHandshakes.push({ url: req.url, protocols })

    if (
      !protocols.includes("codeg-events") ||
      !protocols.includes(expectedSub)
    ) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n")
      socket.destroy()
      return
    }

    const key = req.headers["sec-websocket-key"]
    const accept = crypto
      .createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64")

    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "Sec-WebSocket-Protocol: codeg-events",
        "",
        "",
      ].join("\r\n")
    )

    sockets.add(socket)
    sendWs(socket, { channel: "__ready__", payload: null })

    let rxBuf = Buffer.alloc(0)
    socket.on("data", (chunk) => {
      rxBuf = Buffer.concat([rxBuf, chunk])
      while (true) {
        const frame = tryDecodeWsFrame(rxBuf)
        if (!frame) break
        rxBuf = rxBuf.subarray(frame.bytesConsumed)
        if (frame.opcode === 0x8) {
          socket.end()
          return
        }
        if (frame.opcode !== 0x1) continue
        const msg = JSON.parse(frame.payload.toString("utf8"))
        if (msg.action === "ping") {
          sendWs(socket, { type: "pong" })
        } else if (msg.action === "attach") {
          let subs = subscriptions.get(msg.connection_id)
          if (!subs) {
            subs = new Set()
            subscriptions.set(msg.connection_id, subs)
          }
          subs.add({ socket, subscriptionId: msg.subscription_id })
          const snap = snapshots.get(msg.connection_id) || null
          sendWs(socket, {
            type: "snapshot",
            subscription_id: msg.subscription_id,
            connection_id: msg.connection_id,
            snapshot: snap,
            event_seq: eventSeq,
          })
        } else if (msg.action === "detach") {
          const subs = subscriptions.get(msg.connection_id)
          if (subs) {
            for (const entry of subs) {
              if (entry.subscriptionId === msg.subscription_id)
                subs.delete(entry)
            }
          }
        }
      }
    })

    socket.on("close", () => {
      sockets.delete(socket)
      for (const subs of subscriptions.values()) {
        for (const entry of subs) {
          if (entry.socket === socket) subs.delete(entry)
        }
      }
    })
  })

  return {
    server,
    apiCalls,
    wsHandshakes,
    connections,
    snapshots,
    pushGlobal,
    pushAcpEvent,
    async start() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
      const { port } = server.address()
      return `http://127.0.0.1:${port}`
    },
    async stop() {
      for (const sock of sockets) sock.destroy()
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

// ══════════════════════════════════════════════════════════
// Unit Tests
// ══════════════════════════════════════════════════════════

test("ws-client: SimpleWebSocket handles coalesced head, >70KB frames, fragmentation, and ping/pong", async () => {
  const receivedFrames = []
  const srvSockets = new Set()
  const srv = http.createServer()
  srv.on("upgrade", (req, socket) => {
    srvSockets.add(socket)
    const key = req.headers["sec-websocket-key"]
    const accept = crypto
      .createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64")

    const headers = Buffer.from(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "Sec-WebSocket-Protocol: codeg-events",
        "",
        "",
      ].join("\r\n"),
      "utf8"
    )
    const firstFrame = encodeWsTextFrame('{"coalesced":true}')
    // Write 101 headers and first WS frame in a single write to test `head` handling
    socket.write(Buffer.concat([headers, firstFrame]))

    // Send a >70KB frame (64-bit length field)
    const bigPayload = "X".repeat(72000)
    socket.write(encodeWsTextFrame(bigPayload))

    // Send a fragmented text message: frame 1 (FIN=0, opcode=0x1) + frame 2 (FIN=1, opcode=0x0)
    const part1 = Buffer.from("hello-", "utf8")
    const part2 = Buffer.from("fragmented", "utf8")
    socket.write(Buffer.concat([Buffer.from([0x01, part1.length]), part1]))
    // Interleave a server Ping frame (FIN=1, opcode=0x9) between fragments!
    const pingPayload = Buffer.from("ping-check", "utf8")
    socket.write(
      Buffer.concat([Buffer.from([0x89, pingPayload.length]), pingPayload])
    )
    socket.write(Buffer.concat([Buffer.from([0x80, part2.length]), part2]))

    let rx = Buffer.alloc(0)
    socket.on("data", (chunk) => {
      rx = Buffer.concat([rx, chunk])
      while (true) {
        const f = tryDecodeWsFrame(rx)
        if (!f) break
        rx = rx.subarray(f.bytesConsumed)
        receivedFrames.push({
          opcode: f.opcode,
          text: f.payload.toString("utf8"),
        })
      }
    })
  })

  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve))
  const { port } = srv.address()

  const messages = []
  const ws = new SimpleWebSocket(`ws://127.0.0.1:${port}/ws/events`, [
    "codeg-events",
    "codeg-token.test",
  ])
  ws.addEventListener("message", (ev) => messages.push(String(ev.data)))

  try {
    await waitUntil(() => messages.length === 3)
    assert.equal(ws.protocol, "codeg-events")
    assert.equal(messages[0], '{"coalesced":true}')
    assert.equal(messages[1].length, 72000)
    assert.equal(messages[2], "hello-fragmented")

    // Verify client echoed a masked Pong frame (opcode 0x0a)
    await waitUntil(() => receivedFrames.some((f) => f.opcode === 0x0a))
    const pong = receivedFrames.find((f) => f.opcode === 0x0a)
    assert.equal(pong.text, "ping-check")

    // Verify client can send a >126-byte masked text frame
    const clientMsg = "C".repeat(300)
    ws.send(clientMsg)
    await waitUntil(() =>
      receivedFrames.some((f) => f.opcode === 0x01 && f.text === clientMsg)
    )
  } finally {
    ws.close()
    for (const s of srvSockets) s.destroy()
    srv.closeAllConnections?.()
    await new Promise((resolve) => srv.close(resolve))
  }
})

test("format: markdown conversion and balanced chunk splitting", () => {
  assert.equal(escapeHtml("a < b & c > d"), "a &lt; b &amp; c &gt; d")
  const html = mdToTelegramHtml(
    "# 标题\n\n- 列表项 *斜体* ~~删除~~\n> 引用块\n\n看下 **加粗** 和 `code`:\n```js\nconst x = 1 < 2;\n```"
  )
  assert.match(html, /<b>标题<\/b>/)
  assert.match(html, /• 列表项 <i>斜体<\/i> <s>删除<\/s>/)
  assert.match(html, /<blockquote>引用块<\/blockquote>/)
  assert.match(html, /<b>加粗<\/b>/)
  assert.match(html, /<code>code<\/code>/)
  assert.match(
    html,
    /<pre><code class="language-js">const x = 1 &lt; 2;<\/code><\/pre>/
  )

  const longCode = [
    "```python",
    ...Array.from({ length: 120 }, (_, i) => `print("line_${i}")`),
    "```",
  ].join("\n")
  const chunks = splitMarkdownForTelegram(longCode, 600)
  assert.ok(chunks.length > 2)
  for (const ch of chunks) {
    const rendered = mdToTelegramHtml(ch)
    assert.ok(rendered.length <= 650)
    const opens = (rendered.match(/<pre>/g) || []).length
    const closes = (rendered.match(/<\/pre>/g) || []).length
    assert.equal(
      opens,
      closes,
      "each split chunk must keep balanced <pre> tags"
    )
  }
})

test("format: permission, question, and plan approval cards keep callback_data <= 64 bytes", () => {
  const perm = formatPermissionCard({
    toolCall: {
      title: "Run shell command",
      kind: "execute",
      rawInput: { command: "npm test" },
      locations: [{ path: "D:\\work\\test.js" }],
    },
    options: [
      {
        option_id: "allow-once",
        name: "Allow once",
        kind: "allow_once",
        meta: {
          permission: { changes: [{ description: "Run npm test once" }] },
        },
      },
      { option_id: "reject-once", name: "Reject", kind: "reject_once" },
    ],
    queued: 2,
    sessionLabel: "示例项目 · Claude",
    shortId: "a1b2c3d4",
  })
  assert.match(perm.html, /npm test/)
  assert.match(perm.html, /还有 2 个待批/)
  for (const row of perm.replyMarkup.inline_keyboard) {
    for (const btn of row) {
      assert.ok(Buffer.byteLength(btn.callback_data) <= 64)
    }
  }

  const q = formatQuestionCard({
    questions: [
      {
        id: "q1",
        header: "方式",
        question: "选择实现方案",
        multi_select: true,
        options: [
          { label: "方案A", description: "轻量" },
          { label: "方案B", description: "完整" },
        ],
      },
    ],
    currentIdx: 0,
    selectedMap: { q1: ["方案A"] },
    shortId: "deadbeef",
  })
  assert.match(q.html, /✓ <b>方案A<\/b>/)
  assert.match(q.html, /· <b>方案B<\/b>/)

  const plan = formatPlanApprovalCard({
    planMarkdown: "## Steps\n1. Edit `a.js`",
    sessionLabel: "sample-app · Codex",
    shortId: "cafebabe",
  })
  assert.match(plan.html, /执行计划确认/)
  assert.equal(plan.replyMarkup.inline_keyboard.length, 1)
})

test("secrets & state: MGSecrets priority, SQLite fallback, and StateStore persistence", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeg-tg-unit-"))
  try {
    const dbPath = path.join(tmpDir, "codeg.db")
    const db = new DatabaseSync(dbPath)
    db.exec("CREATE TABLE app_metadata (key TEXT PRIMARY KEY, value TEXT)")
    db.prepare("INSERT INTO app_metadata (key, value) VALUES (?, ?)").run(
      "web_service_token",
      "tok-from-sqlite"
    )
    db.close()

    const tgFile = path.join(tmpDir, "tg.txt")
    fs.writeFileSync(tgFile, "# comment\n  123:ABC-secret  \n", "utf8")
    const codegFile = path.join(tmpDir, "codeg.txt")

    const cfg = {
      telegramTokenFile: tgFile,
      codegTokenFile: codegFile,
      codegDbPath: dbPath,
    }

    assert.equal(loadTelegramToken(cfg, {}), "123:ABC-secret")
    assert.equal(loadCodegToken(cfg, {}), "tok-from-sqlite")

    fs.writeFileSync(codegFile, "tok-from-secrets-file\n", "utf8")
    assert.equal(
      loadCodegToken(cfg, { CODEG_WEB_TOKEN: "tok-from-env" }),
      "tok-from-secrets-file"
    )

    const statePath = path.join(tmpDir, "state.json")
    const s1 = new StateStore(statePath)
    s1.bindThread({
      threadId: 501,
      chatId: 424242,
      conversationId: 77,
      folderId: 10,
      folderName: "示例项目",
      workingDir: "D:\\work\\demo-project",
      agentType: "claude_code",
      connectionId: "conn-1",
    })
    const cbId = s1.registerCallback("perm", { requestId: "r1" })
    s1.saveNow()

    const s2 = new StateStore(statePath)
    assert.equal(s2.getThread(501).conversationId, 77)
    assert.equal(s2.findThreadByConversationId(77).threadId, 501)
    assert.equal(s2.findThreadByConnectionId("conn-1").threadId, 501)
    assert.equal(s2.getCallback(cbId).data.requestId, "r1")
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

// ══════════════════════════════════════════════════════════
// In-Process Mock E2E Integration Tests
// ══════════════════════════════════════════════════════════

test("E2E: auth gate, /new wizard, prompt streaming, permission/question/plan approvals, desktop sync & commands", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeg-tg-e2e-"))
  const mockTg = createMockTelegramServer()
  const mockCodeg = createMockCodegServer("secret-codeg-tok")

  const tgBase = await mockTg.start()
  const codegBase = await mockCodeg.start()

  const cfg = {
    codegUrl: codegBase,
    allowedUserIds: [424242],
    telegramApiBase: tgBase,
    telegramProxy: "",
    pollTimeoutSec: 5,
    streamThrottleMs: 40,
    maxMessageChars: 3800,
    stateFile: path.join(tmpDir, "state.json"),
    logFile: path.join(tmpDir, "bot.log"),
    proactiveWatchDesktop: true,
  }

  const logger = createLogger(cfg.logFile, { quietConsole: true })
  const tg = new TelegramClient({
    token: "mock-tg-token",
    apiBase: tgBase,
    logger,
  })
  const codeg = new CodegClient({
    baseUrl: codegBase,
    tokenProvider: () => "secret-codeg-tok",
    logger,
  })
  const state = new StateStore(cfg.stateFile)
  const bot = new CodegTgBot({ cfg, tg, codeg, state, logger })

  try {
    await bot.start({ skipPoll: true })
    await waitUntil(() => codeg.isWsOpen())
    assert.ok(mockCodeg.wsHandshakes.length >= 1)
    assert.ok(mockCodeg.wsHandshakes[0].protocols.includes("codeg-events"))

    // 1. Unauthorized user is ignored
    const beforeCalls = mockTg.calls.length
    await bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        from: { id: 999999 },
        chat: { id: 999999, type: "private" },
        text: "/start",
      },
    })
    assert.equal(mockTg.calls.length, beforeCalls)

    // 2. /new wizard -> folder -> agent -> topic + acp_connect
    await bot.handleUpdate({
      update_id: 2,
      message: {
        message_id: 2,
        from: { id: 424242 },
        chat: { id: 424242, type: "private" },
        text: "/new",
      },
    })
    const folderMsgCall = mockTg.calls.findLast(
      (c) => c.method === "sendMessage"
    )
    assert.match(folderMsgCall.params.text, /选择项目/)
    const folderBtnCb =
      folderMsgCall.params.reply_markup.inline_keyboard[0][0].callback_data

    await bot.handleUpdate({
      update_id: 3,
      callback_query: {
        id: "cq-folder",
        from: { id: 424242 },
        data: folderBtnCb,
        message: { message_id: 101, chat: { id: 424242, type: "private" } },
      },
    })
    const agentEditCall = mockTg.calls.findLast(
      (c) => c.method === "editMessageText"
    )
    assert.match(agentEditCall.params.text, /选择 Agent/)
    const agentBtnCb =
      agentEditCall.params.reply_markup.inline_keyboard[0][0].callback_data

    await bot.handleUpdate({
      update_id: 4,
      callback_query: {
        id: "cq-agent",
        from: { id: 424242 },
        data: agentBtnCb,
        message: { message_id: 101, chat: { id: 424242, type: "private" } },
      },
    })

    const topicCreatedCall = mockTg.calls.find(
      (c) => c.method === "createForumTopic"
    )
    assert.ok(topicCreatedCall)
    const binding = state.getThread(501)
    assert.ok(binding, "new topic 501 should be bound in state")
    assert.equal(binding.folderId, 10)
    assert.ok(binding.connectionId)
    const connId = binding.connectionId

    // 3. Send prompt in topic -> streaming -> permission approval -> turn_complete
    await bot.handleUpdate({
      update_id: 5,
      message: {
        message_id: 10,
        from: { id: 424242 },
        chat: { id: 424242, type: "private" },
        message_thread_id: 501,
        text: "修复寻路逻辑",
      },
    })
    const promptCall = mockCodeg.apiCalls.findLast(
      (c) => c.endpoint === "acp_prompt"
    )
    assert.equal(promptCall.body.connectionId, connId)
    assert.deepEqual(promptCall.body.blocks, [
      { type: "text", text: "修复寻路逻辑" },
    ])

    mockCodeg.pushAcpEvent(connId, { type: "content_delta", text: "正在检查 " })
    mockCodeg.pushAcpEvent(connId, {
      type: "tool_call",
      tool_call_id: "tc-1",
      title: "Read pathfinding.ts",
      kind: "read",
      status: "completed",
    })
    mockCodeg.pushAcpEvent(connId, {
      type: "permission_request",
      request_id: "req-1",
      tool_call: {
        title: "Bash",
        kind: "execute",
        rawInput: { command: "npm test" },
      },
      options: [
        { option_id: "allow_1", name: "Allow once", kind: "allow_once" },
        { option_id: "deny_1", name: "Deny", kind: "reject_once" },
      ],
      queued: 0,
    })

    const permMsg = await waitUntil(() =>
      mockTg.calls.findLast(
        (c) => c.method === "sendMessage" && /权限确认/.test(c.params.text)
      )
    )
    assert.equal(permMsg.params.message_thread_id, 501)
    const allowBtn =
      permMsg.params.reply_markup.inline_keyboard[0][0].callback_data
    assert.ok(Buffer.byteLength(allowBtn) <= 64)

    await bot.handleUpdate({
      update_id: 6,
      callback_query: {
        id: "cq-perm",
        from: { id: 424242 },
        data: allowBtn,
        message: {
          message_id: 105,
          chat: { id: 424242, type: "private" },
          message_thread_id: 501,
        },
      },
    })
    const respPermCall = mockCodeg.apiCalls.findLast(
      (c) => c.endpoint === "acp_respond_permission"
    )
    assert.deepEqual(respPermCall.body, {
      connectionId: connId,
      requestId: "req-1",
      optionId: "allow_1",
    })

    mockCodeg.pushAcpEvent(connId, {
      type: "content_delta",
      text: "修复完成！",
    })
    mockCodeg.pushAcpEvent(connId, {
      type: "turn_complete",
      session_id: "ext-1",
      stop_reason: "end_turn",
      agent_type: "claude_code",
    })

    const finalMsg = await waitUntil(() =>
      mockTg.calls.findLast(
        (c) =>
          (c.method === "sendMessage" || c.method === "editMessageText") &&
          /修复完成！/.test(c.params.text)
      )
    )
    assert.ok(finalMsg)

    // 4. Question & Plan approval flows
    mockCodeg.pushAcpEvent(connId, {
      type: "question_request",
      question_id: "q-req-1",
      questions: [
        {
          id: "q-item-1",
          header: "策略",
          question: "使用哪种算法？",
          multi_select: false,
          options: [
            { label: "A*", description: "启发式" },
            { label: "BFS", description: "广度优先" },
          ],
        },
      ],
    })
    const qMsg = await waitUntil(() =>
      mockTg.calls.findLast(
        (c) => c.method === "sendMessage" && /使用哪种算法/.test(c.params.text)
      )
    )
    await bot.handleUpdate({
      update_id: 7,
      callback_query: {
        id: "cq-q",
        from: { id: 424242 },
        data: qMsg.params.reply_markup.inline_keyboard[0][0].callback_data,
        message: {
          message_id: 106,
          chat: { id: 424242, type: "private" },
          message_thread_id: 501,
        },
      },
    })
    const ansQCall = mockCodeg.apiCalls.findLast(
      (c) => c.endpoint === "acp_answer_question"
    )
    assert.equal(ansQCall.body.questionId, "q-req-1")
    assert.deepEqual(ansQCall.body.answer.answers, [
      { questionId: "q-item-1", labels: ["A*"] },
    ])

    mockCodeg.pushAcpEvent(connId, {
      type: "plan_approval_request",
      approval_id: "plan-1",
      tool_call_id: "tc-plan",
      plan_markdown: "1. 修改寻路\n2. 跑测试",
    })
    const planMsg = await waitUntil(() =>
      mockTg.calls.findLast(
        (c) => c.method === "sendMessage" && /执行计划确认/.test(c.params.text)
      )
    )
    await bot.handleUpdate({
      update_id: 8,
      callback_query: {
        id: "cq-plan",
        from: { id: 424242 },
        data: planMsg.params.reply_markup.inline_keyboard[0][0].callback_data,
        message: {
          message_id: 107,
          chat: { id: 424242, type: "private" },
          message_thread_id: 501,
        },
      },
    })
    const ansPlanCall = mockCodeg.apiCalls.findLast(
      (c) => c.endpoint === "acp_answer_plan_approval"
    )
    assert.deepEqual(ansPlanCall.body, {
      connectionId: connId,
      approvalId: "plan-1",
      answer: { decision: "approve", feedback: null },
    })

    // 5. Desktop-initiated proactive watch & two-way resolution
    mockCodeg.connections.set("conn-desktop-99", {
      id: "conn-desktop-99",
      agent_type: "codex",
      status: "prompting",
    })
    mockCodeg.snapshots.set("conn-desktop-99", {
      connection_id: "conn-desktop-99",
      conversation_id: 201,
      folder_id: 10,
      status: "prompting",
      pending_permission: {
        request_id: "desk-req-1",
        tool_call_id: "tc-desk",
        tool_call: {
          title: "Write file",
          kind: "edit",
          rawInput: { file_path: "src/a.ts" },
        },
        options: [{ option_id: "allow", name: "Allow", kind: "allow_once" }],
        queued: 0,
      },
    })
    mockCodeg.pushGlobal("conversation://changed", {
      kind: "status",
      id: 201,
      status: "in_progress",
    })

    const deskCard = await waitUntil(() =>
      mockTg.calls.findLast(
        (c) =>
          c.method === "sendMessage" &&
          /src\\?\/?a\.ts|Write file/.test(c.params.text)
      )
    )
    assert.ok(deskCard.params.reply_markup.inline_keyboard.length >= 2)

    mockCodeg.pushAcpEvent("conn-desktop-99", {
      type: "permission_resolved",
      request_id: "desk-req-1",
      option_id: "allow",
      origin: { kind: "user" },
    })
    const deskResolvedEdit = await waitUntil(() =>
      mockTg.calls.findLast(
        (c) =>
          c.method === "editMessageText" && /桌面端已处理/.test(c.params.text)
      )
    )
    assert.deepEqual(deskResolvedEdit.params.reply_markup, {
      inline_keyboard: [],
    })

    // 6. /mode, /stop, /rename, /history
    await bot.handleUpdate({
      update_id: 9,
      message: {
        message_id: 20,
        from: { id: 424242 },
        chat: { id: 424242, type: "private" },
        message_thread_id: 501,
        text: "/mode",
      },
    })
    const modeMsg = mockTg.calls.findLast(
      (c) => c.method === "sendMessage" && /权限模式/.test(c.params.text)
    )
    await bot.handleUpdate({
      update_id: 10,
      callback_query: {
        id: "cq-mode",
        from: { id: 424242 },
        data: modeMsg.params.reply_markup.inline_keyboard[1][0].callback_data,
        message: {
          message_id: 108,
          chat: { id: 424242, type: "private" },
          message_thread_id: 501,
        },
      },
    })
    const setModeCall = mockCodeg.apiCalls.findLast(
      (c) => c.endpoint === "acp_set_mode"
    )
    assert.deepEqual(setModeCall.body, {
      connectionId: connId,
      modeId: "bypassPermissions",
    })

    await bot.handleUpdate({
      update_id: 11,
      message: {
        message_id: 21,
        from: { id: 424242 },
        chat: { id: 424242, type: "private" },
        message_thread_id: 501,
        text: "/rename 优化寻路算法",
      },
    })
    const renameApi = mockCodeg.apiCalls.findLast(
      (c) => c.endpoint === "update_conversation_title"
    )
    assert.equal(renameApi.body.title, "优化寻路算法")
    const renameTopic = mockTg.calls.findLast(
      (c) => c.method === "editForumTopic"
    )
    assert.equal(renameTopic.params.message_thread_id, 501)
    assert.match(renameTopic.params.name, /优化寻路算法/)

    await bot.handleUpdate({
      update_id: 12,
      message: {
        message_id: 22,
        from: { id: 424242 },
        chat: { id: 424242, type: "private" },
        message_thread_id: 501,
        text: "/stop",
      },
    })
    assert.equal(
      mockCodeg.apiCalls.findLast((c) => c.endpoint === "acp_cancel").body
        .connectionId,
      connId
    )

    // 7. /sessions deep link for bound session & graceful fallback when Threaded Mode is disabled
    mockTg.setTopicsEnabled(false)
    await bot.handleUpdate({
      update_id: 13,
      message: {
        message_id: 30,
        from: { id: 424242 },
        chat: { id: 424242, type: "private" },
        text: "/sessions",
      },
    })
    const sessMsg = mockTg.calls.findLast(
      (c) => c.method === "sendMessage" && /会话列表/.test(c.params.text)
    )
    const kb = sessMsg.params.reply_markup.inline_keyboard
    const boundBtn = kb.find(
      (row) => /示例项目/.test(row[0].text) && !/修复寻路 Bug/.test(row[0].text)
    )[0]
    const unboundBtn = kb.find((row) => /修复寻路 Bug/.test(row[0].text))[0]

    await bot.handleUpdate({
      update_id: 14,
      callback_query: {
        id: "cq-sess-bound",
        from: { id: 424242 },
        data: boundBtn.callback_data,
        message: { message_id: 109, chat: { id: 424242, type: "private" } },
      },
    })
    const deepLinkMsg = mockTg.calls.findLast(
      (c) =>
        c.method === "sendMessage" &&
        /t\.me\/test_codeg_bot\/501/.test(c.params.text)
    )
    assert.ok(deepLinkMsg)

    await bot.handleUpdate({
      update_id: 15,
      callback_query: {
        id: "cq-sess-fb",
        from: { id: 424242 },
        data: unboundBtn.callback_data,
        message: { message_id: 109, chat: { id: 424242, type: "private" } },
      },
    })
    assert.equal(state.getThreadedModeSupported(), false)
    assert.equal(state.getThread(0).conversationId, 201)
  } finally {
    bot.stop()
    await mockCodeg.stop()
    await mockTg.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

function buildSignedInitData({
  botToken,
  userId,
  authDate = Math.floor(Date.now() / 1000),
  username = "tester",
}) {
  const fields = {
    auth_date: String(authDate),
    query_id: "AAHdF6IQAAAAAN0XohDhrOrc",
    user: JSON.stringify({ id: userId, first_name: "Test", username }),
  }
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("\n")
  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest()
  const hash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex")
  const qs = new URLSearchParams({ ...fields, hash })
  return qs.toString()
}

function httpReq(urlStr, { method = "GET", headers = {}, body = null } = {}) {
  const url = new URL(urlStr)
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: `${url.pathname}${url.search}`,
        method,
        headers,
        agent: false,
      },
      (res) => {
        const chunks = []
        res.on("data", (c) => chunks.push(c))
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            text: Buffer.concat(chunks).toString("utf8"),
          })
        })
      }
    )
    req.on("error", reject)
    if (body !== null) req.write(body)
    req.end()
  })
}

test("webapp-proxy: Telegram initData HMAC verification, HttpOnly cookie gate, API & WS token injection, and revocation", async () => {
  const botToken = "999999:TEST_BOT_TOKEN_SECRET"
  const codegSecret = "codeg-super-secret-token"
  const nowSec = 1795350000

  // 1. Unit checks for verifyTelegramInitData
  const validInit = buildSignedInitData({
    botToken,
    userId: 424242,
    authDate: nowSec,
  })
  assert.equal(
    verifyTelegramInitData(validInit, botToken, {
      allowedUserIds: [424242],
      nowSec,
    }).ok,
    true
  )
  assert.equal(
    verifyTelegramInitData(
      validInit.replace("auth_date=", "auth_date=1"),
      botToken,
      {
        allowedUserIds: [424242],
        nowSec,
      }
    ).ok,
    false
  )
  const expiredInit = buildSignedInitData({
    botToken,
    userId: 424242,
    authDate: nowSec - 600,
  })
  assert.equal(
    verifyTelegramInitData(expiredInit, botToken, {
      allowedUserIds: [424242],
      nowSec,
    }).reason,
    "expired_auth_date"
  )
  const strangerInit = buildSignedInitData({
    botToken,
    userId: 12345678,
    authDate: nowSec,
  })
  assert.equal(
    verifyTelegramInitData(strangerInit, botToken, {
      allowedUserIds: [424242],
      nowSec,
    }).reason,
    "unauthorized_user"
  )

  // 2. Integration test with mock Codeg server (verifies Bearer token + WS subprotocol injection)
  const mockCodeg = createMockCodegServer(codegSecret)
  const codegBase = await mockCodeg.start()
  const proxy = new WebAppProxy({
    host: "127.0.0.1",
    port: 0,
    upstreamUrl: codegBase,
    botToken,
    botUsername: "test_codeg_bot",
    codegTokenProvider: () => codegSecret,
    allowedUserIds: [424242],
    logger: { info() {}, warn() {}, error() {} },
  })

  try {
    const { port } = await proxy.start()
    const proxyBase = `http://127.0.0.1:${port}`

    // Unauthenticated GET / serves gate page (not upstream Codeg)
    const gateRes = await httpReq(`${proxyBase}/`)
    assert.equal(gateRes.statusCode, 200)
    assert.match(gateRes.text, /\/__tg_auth__/)

    // Unauthenticated API & static chunks are blocked with 401
    const unauthApi = await httpReq(`${proxyBase}/api/health`, {
      method: "POST",
      body: "{}",
    })
    assert.equal(unauthApi.statusCode, 401)
    const unauthChunk = await httpReq(`${proxyBase}/_next/static/test.js`)
    assert.equal(unauthChunk.statusCode, 401)

    // Invalid initData is rejected with 403
    const badAuth = await httpReq(`${proxyBase}/__tg_auth__`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: strangerInit }),
    })
    assert.equal(badAuth.statusCode, 403)

    // Valid live initData passes and sets HttpOnly session cookie
    const liveInit = buildSignedInitData({ botToken, userId: 424242 })
    const okAuth = await httpReq(`${proxyBase}/__tg_auth__`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: liveInit }),
    })
    assert.equal(okAuth.statusCode, 200)
    const setCookie = Array.isArray(okAuth.headers["set-cookie"])
      ? okAuth.headers["set-cookie"][0]
      : okAuth.headers["set-cookie"]
    assert.match(setCookie, /codeg_tg_sess=[^;]+;.*HttpOnly/)
    const cookieHeader = setCookie.split(";")[0]

    // Authenticated POST /api/health proxies to upstream Codeg WITH Bearer token injected
    const apiRes = await httpReq(`${proxyBase}/api/health`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieHeader },
      body: "{}",
    })
    assert.equal(apiRes.statusCode, 200)
    assert.equal(JSON.parse(apiRes.text).version, "0.45.0")

    // Authenticated GET /workspace injects mobile Mini App polish CSS
    const wsPageRes = await httpReq(`${proxyBase}/workspace`, {
      headers: { Cookie: cookieHeader },
    })
    assert.equal(wsPageRes.statusCode, 200)
    assert.match(wsPageRes.text, /id="tg-miniapp-polish"/)
    assert.match(wsPageRes.text, /ws-surface-muted/)

    // Cross-origin CSRF POST to /api/* is blocked even with cookie
    const csrfRes = await httpReq(`${proxyBase}/api/health`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader,
        Host: `127.0.0.1:${port}`,
        Origin: "https://evil.example.com",
      },
      body: "{}",
    })
    assert.equal(csrfRes.statusCode, 403)

    // Authenticated WS /ws/events upgrade injects codeg-token.<b64url> and streams frames
    const wsMessages = []
    const wsRes = await new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString("base64")
      const req = http.request({
        hostname: "127.0.0.1",
        port,
        path: "/ws/events",
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Key": key,
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Protocol": "codeg-events",
          Cookie: cookieHeader,
        },
        agent: false,
      })
      req.on("upgrade", (res, socket, head) => {
        let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0)
        const check = () => {
          const f = tryDecodeWsFrame(buf)
          if (f) {
            wsMessages.push(f.payload.toString("utf8"))
            socket.destroy()
            resolve({ headers: res.headers })
          }
        }
        check()
        socket.on("data", (d) => {
          buf = Buffer.concat([buf, d])
          check()
        })
      })
      req.on("error", reject)
      req.end()
    })
    assert.equal(wsRes.headers["sec-websocket-protocol"], "codeg-events")
    assert.match(wsMessages[0], /__ready__/)

    // Revoking sessions immediately invalidates the cookie
    assert.equal(proxy.revokeAllSessions(), 1)
    const afterRevoke = await httpReq(`${proxyBase}/api/health`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieHeader },
      body: "{}",
    })
    assert.equal(afterRevoke.statusCode, 401)
  } finally {
    await proxy.stop()
    await mockCodeg.stop()
  }
})
