// Deterministic wire probe: real Codex ACP 2.3.0 and a local Responses server.
import { spawn, execFileSync } from "node:child_process"
import { createServer } from "node:http"
import { createInterface } from "node:readline"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import assert from "node:assert/strict"
const root = mkdtempSync(
  join(process.env.ACP_TEST_ROOT || tmpdir(), "codex-real-")
)
const port = Number(process.env.PROBE_PORT || 13444)
const cwd = join(root, "workspace"),
  home = join(root, "codex")
mkdirSync(cwd)
mkdirSync(home)
let requests = []
let holdNext = false
let waitModel
const firstModel = new Promise((r) => (waitModel = r))
const server = createServer(async (req, res) => {
  let body = ""
  for await (const b of req) body += b
  if (req.method !== "POST") {
    res.writeHead(404)
    res.end()
    return
  }
  let input = JSON.parse(body)
  requests.push(input)
  const hold = holdNext
  holdNext = false
  console.log("MODEL", req.url, requests.length)
  waitModel()
  res.writeHead(200, { "content-type": "text/event-stream" })
  const id = `response_${requests.length}`,
    itemId = `message_${requests.length}`
  const event = (type, data) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  const response = {
    id,
    object: "response",
    created_at: 1,
    status: "in_progress",
    model: "gpt-5.4",
    output: [],
  }
  event("response.created", { response })
  event("response.output_item.added", {
    output_index: 0,
    item: {
      type: "message",
      id: itemId,
      role: "assistant",
      status: "in_progress",
      content: [],
    },
  })
  event("response.content_part.added", {
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "", annotations: [] },
  })
  event("response.output_text.delta", {
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    delta: "LOCAL_CODEX_",
  })
  await new Promise((r) =>
    setTimeout(r, requests.length === 1 || hold ? 1500 : 100)
  )
  event("response.output_text.delta", {
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    delta: "OK",
  })
  const part = { type: "output_text", text: "LOCAL_CODEX_OK", annotations: [] }
  const item = {
    type: "message",
    id: itemId,
    role: "assistant",
    status: "completed",
    content: [part],
  }
  event("response.output_text.done", {
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    text: part.text,
  })
  event("response.content_part.done", {
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    part,
  })
  event("response.output_item.done", { output_index: 0, item })
  event("response.completed", {
    response: {
      ...response,
      status: "completed",
      output: [item],
      usage: {
        input_tokens: 10,
        output_tokens: 3,
        total_tokens: 13,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    },
  })
  res.end()
})
await new Promise((r, j) => {
  server.once("error", j)
  server.listen(port, "127.0.0.1", r)
})
const config = {
  model: "gpt-5.4",
  model_provider: "fixture",
  model_providers: {
    fixture: {
      name: "Fixture",
      base_url: `http://127.0.0.1:${port}/v1`,
      wire_api: "responses",
      requires_openai_auth: false,
      env_key: "FIXTURE_API_KEY",
    },
  },
  features: { shell_tool: false, web_search_request: false },
}
writeFileSync(
  join(home, "config.toml"),
  `model = "gpt-5.4"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname="Fixture"\nbase_url="http://127.0.0.1:${port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nenv_key="FIXTURE_API_KEY"\n`
)
const env = {
  ...process.env,
  CODEX_HOME: home,
  CODEX_CONFIG: JSON.stringify(config),
  MODEL_PROVIDER: "fixture",
  FIXTURE_API_KEY: "fixture",
  NO_BROWSER: "1",
  INITIAL_AGENT_MODE: "read-only",
}
for (const name of [
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "DEFAULT_AUTH_REQUEST",
  "CODEX_PATH",
])
  delete env[name]
const child = spawn(
  process.execPath,
  [
    process.env.CODEX_ACP_PROBE_ENTRY ||
      resolve(
        "scripts/fixtures/codex/node_modules/@agentclientprotocol/codex-acp/dist/index.js"
      ),
  ],
  { cwd, env, stdio: "pipe", windowsHide: true }
)
let next = 0,
  waiting = new Map(),
  updates = [],
  stderr = ""
child.stderr.on("data", (data) => (stderr = (stderr + data).slice(-10000)))
const send = (m) => child.stdin.write(JSON.stringify(m) + "\n")
createInterface({ input: child.stdout }).on("line", (line) => {
  let m = JSON.parse(line)
  if (m.method) {
    updates.push(m)
    if (m.params?.update?.sessionUpdate === "state_update")
      console.log("STATE", JSON.stringify(m.params.update))
    if (m.id)
      send({
        jsonrpc: "2.0",
        id: m.id,
        result: { outcome: { outcome: "cancelled" } },
      })
  } else if (waiting.has(m.id)) {
    waiting.get(m.id)(m)
    waiting.delete(m.id)
  }
})
const request = (method, params) =>
  new Promise((r, j) => {
    let id = ++next
    let timer = setTimeout(() => {
      waiting.delete(id)
      j(Error(method + " timeout " + stderr))
    }, 30000)
    waiting.set(id, (m) => {
      clearTimeout(timer)
      if (m.error) j(Error(JSON.stringify(m.error) + " " + stderr))
      else r(m.result)
    })
    send({ jsonrpc: "2.0", id, method, params })
  })
try {
  let init = await request("initialize", {
    protocolVersion: 2,
    info: { name: "fixture", version: "1.0.0" },
    capabilities: {},
  })
  console.log("INIT", JSON.stringify(init))
  assert.equal(init.info.version, "2.3.0")
  assert.equal(init.protocolVersion, 2)
  let session = await request("session/new", { cwd, mcpServers: [] })
  console.log("SESSION", session.sessionId)
  let accepted = await request("session/prompt", {
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: "Say local fixture OK." }],
  })
  console.log("ACCEPTED", JSON.stringify(accepted))
  assert.equal(typeof accepted.messageId, "string")
  await firstModel
  let steer = await request("_session/steering", {
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: "Also acknowledge the inserted note." }],
    _meta: { steering: { idleBehavior: "promptRequired" } },
  })
  console.log("STEER", JSON.stringify(steer))
  assert.equal(steer.outcome, "injected")
  const deadline = Date.now() + 15000
  while (
    Date.now() < deadline &&
    !updates.some((m) => m.params?.update?.state === "idle")
  )
    await new Promise((r) => setTimeout(r, 50))
  assert.ok(updates.some((m) => m.params?.update?.state === "idle"))
  assert.ok(requests.length)
  assert.ok(
    updates.some((m) =>
      m.params?.update?.content?.text?.includes("LOCAL_CODEX")
    )
  )
  const idleBefore = updates.filter(
    (m) => m.params?.update?.state === "idle"
  ).length
  let fallback = await request("_session/steering", {
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: "Start after the previous turn ended." }],
  })
  assert.equal(fallback.outcome, "startedNewTurn")
  const fallbackDeadline = Date.now() + 15000
  while (
    Date.now() < fallbackDeadline &&
    updates.filter((m) => m.params?.update?.state === "idle").length ===
      idleBefore
  )
    await new Promise((r) => setTimeout(r, 25))
  assert.ok(
    updates.filter((m) => m.params?.update?.state === "idle").length >
      idleBefore
  )
  let loaded = await request("session/resume", {
    sessionId: session.sessionId,
    cwd,
    mcpServers: [],
    replayFrom: { type: "start" },
  })
  assert.equal(loaded.sessionId ?? session.sessionId, session.sessionId)
  console.log("FALLBACK_RESUME_PASS", fallback.outcome)
  const cancelStart = updates.length
  const requestsBefore = requests.length
  holdNext = true
  await request("session/prompt", {
    sessionId: session.sessionId,
    prompt: [
      { type: "text", text: "Describe the attached fixture image." },
      {
        type: "image",
        mimeType: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NsQ0AAAzCMP5/un0CNkuZ41wybXsHAAAAAAAAAAAAxR4yw/wuPL6QkAAAAABJRU5ErkJggg==",
      },
    ],
  })
  const requestDeadline = Date.now() + 10000
  while (requests.length === requestsBefore && Date.now() < requestDeadline)
    await new Promise((r) => setTimeout(r, 10))
  assert.ok(requests.length > requestsBefore)
  send({
    jsonrpc: "2.0",
    method: "session/cancel",
    params: { sessionId: session.sessionId },
  })
  const cancelDeadline = Date.now() + 10000
  while (
    !updates
      .slice(cancelStart)
      .some((m) => m.params?.update?.state === "idle") &&
    Date.now() < cancelDeadline
  )
    await new Promise((r) => setTimeout(r, 10))
  assert.ok(
    updates
      .slice(cancelStart)
      .some((m) => m.params?.update?.stopReason === "cancelled")
  )
  assert.ok(
    JSON.stringify(requests.slice(requestsBefore)).includes("input_image")
  )
  console.log(
    "CODEX_PROBE_PASS",
    JSON.stringify({
      root,
      requests: requests.length,
      updates: updates.length,
      steer,
    })
  )
} finally {
  if (child.exitCode === null) {
    try {
      if (process.platform === "win32") {
        execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
          stdio: "ignore",
          windowsHide: true,
        })
      } else {
        child.kill("SIGTERM")
      }
    } catch {}
  }
  server.closeAllConnections()
  await new Promise((r) => server.close(r))
}
