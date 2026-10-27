// Deterministic integration: real pinned Pi + ACP adapter; local model/MCP only.
import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { createServer } from "node:http"
import { createInterface } from "node:readline"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const literal = "!not-a-command ${SHOULD_NOT_EXPAND} $HOME $$"
function mcp(request) {
  const { id, method, params } = request
  if (id === undefined) return null
  let result
  if (method === "initialize")
    result = {
      protocolVersion: "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "local-fixture", version: "1.0.0" },
    }
  else if (method === "tools/list")
    result = {
      tools: [
        {
          name: "echo",
          description: "Return the isolated fixture value",
          inputSchema: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
          },
        },
      ],
    }
  else if (method === "tools/call")
    result = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            value: params.arguments.value,
            literal: process.env.PROBE_LITERAL ?? "http",
          }),
        },
      ],
    }
  else if (method === "ping") result = {}
  else
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: "Fixture method not found" },
    }
  return { jsonrpc: "2.0", id, result }
}
if (process.argv.includes("--stdio")) {
  createInterface({ input: process.stdin }).on("line", (line) => {
    const reply = mcp(JSON.parse(line))
    if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`)
  })
} else {
  await probe()
}

function client(env, cwd) {
  const child = spawn(
    process.execPath,
    [resolve(here, "../src-tauri/src/acp/pi-bundle/adapter.mjs")],
    { env, cwd, windowsHide: true, stdio: "pipe" }
  )
  let next = 0
  const waiting = new Map()
  const updates = []
  let stderr = ""
  child.stderr.on("data", (data) => {
    stderr = (stderr + data).slice(-12000)
  })
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`)
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line)
    if (message.method === "session/request_permission") {
      const option = message.params.options.find(
        (value) => value.kind === "allow_once"
      )
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { outcome: { outcome: "selected", optionId: option.optionId } },
      })
    } else if (message.method) updates.push(message)
    else if (waiting.has(message.id)) {
      waiting.get(message.id)(message)
      waiting.delete(message.id)
    }
  })
  return {
    updates,
    async request(method, params) {
      const id = ++next
      return new Promise((resolveRequest, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(id)
          reject(new Error(`${method} timed out: ${stderr}`))
        }, 45000)
        waiting.set(id, (message) => {
          clearTimeout(timer)
          if (message.error)
            reject(
              new Error(`${method}: ${JSON.stringify(message.error)} ${stderr}`)
            )
          else resolveRequest(message.result)
        })
        send({ jsonrpc: "2.0", id, method, params })
      })
    },
    async close() {
      if (child.exitCode === null) {
        if (process.platform === "win32") {
          try {
            execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
              windowsHide: true,
              stdio: "ignore",
            })
          } catch {
            /* already exited */
          }
        } else child.kill("SIGTERM")
      }
    },
  }
}

async function probe() {
  const scenario = process.argv.includes("--failure")
    ? "failure"
    : process.argv.includes("--collision")
      ? "collision"
      : "success"
  const root = mkdtempSync(
    join(process.env.ACP_TEST_ROOT || tmpdir(), "pi-real-")
  )
  const profile = join(root, "profile")
  const cwd = join(root, "workspace")
  mkdirSync(profile)
  mkdirSync(cwd)
  const port = Number(process.env.PROBE_PORT || 13443)
  const calls = []
  const models = []
  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET") {
        res.writeHead(405)
        res.end()
        return
      }
      let body = ""
      for await (const chunk of req) body += chunk
      const input = JSON.parse(body || "{}")
      if (req.url === "/mcp") {
        assert.equal(req.headers["x-literal"], literal)
        if (input.method === "tools/call") calls.push(input.params)
        const reply = mcp(input)
        res.writeHead(reply ? 200 : 202, { "content-type": "application/json" })
        res.end(reply ? JSON.stringify(reply) : "")
        return
      }
      assert.equal(req.url, "/v1/chat/completions")
      models.push(input)
      const last = input.messages.at(-1)
      const afterTool = last.role === "tool"
      const names = (input.tools ?? []).map((tool) => tool.function.name)
      const selected = names.filter((name) =>
        ["mcp__codeg_mcp__echo", "mcp__http_fixture__echo"].includes(name)
      )
      const delta = afterTool
        ? { content: "LOCAL_FIXTURE_OK" }
        : selected.length
          ? {
              tool_calls: selected.map((name, index) => ({
                index,
                id: `call_${models.length}_${index}`,
                type: "function",
                function: { name, arguments: JSON.stringify({ value: name }) },
              })),
            }
          : { content: "LOCAL_FIXTURE_NO_TOOLS" }
      if (afterTool) {
        const stdio = input.messages.findLast(
          (message) =>
            message.role === "tool" &&
            String(message.content).includes("PROBE_LITERAL")
        )
        void stdio
      }
      const chunk = (delta, finish_reason) => ({
        id: `response-${models.length}`,
        object: "chat.completion.chunk",
        created: 1,
        model: "fixture",
        choices: [{ index: 0, delta, finish_reason }],
      })
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write(
        `data: ${JSON.stringify(chunk({ role: "assistant", ...delta }, null))}\n\n`
      )
      res.write(
        `data: ${JSON.stringify(chunk({}, delta.tool_calls ? "tool_calls" : "stop"))}\n\n`
      )
      res.end("data: [DONE]\n\n")
    } catch (error) {
      res.writeHead(500)
      res.end(String(error))
      console.error(error)
    }
  })
  await new Promise((resolveListen, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", resolveListen)
  })
  const write = (name, value) =>
    writeFileSync(join(profile, name), JSON.stringify(value))
  write("models.json", {
    providers: {
      fixture: {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        api: "openai-completions",
        apiKey: "isolated-fixture",
        models: [
          {
            id: "fixture",
            name: "Fixture",
            reasoning: true,
            input: ["text", "image"],
            contextWindow: 64000,
            maxTokens: 4096,
          },
        ],
      },
    },
  })
  const extension = join(profile, "fixture-extension.mjs")
  writeFileSync(
    extension,
    `export default function(pi) {
    pi.registerCommand("fixture-command", {
      description: "Local extension probe",
      handler: async (_args, ctx) => ctx.ui.notify("LOCAL_EXTENSION_OK", "info"),
    })
  }`
  )
  write("settings.json", {
    defaultProvider: "fixture",
    defaultModel: "fixture",
    defaultThinkingLevel: "medium",
    extensions: [extension],
  })
  write("mcp.json", {
    mcpServers: {
      [scenario === "collision" ? "codeg_mcp" : "native"]: {
        command: process.execPath,
        args: [fileURLToPath(import.meta.url), "--stdio"],
        exposure: "direct",
      },
    },
  })
  const original = readFileSync(join(profile, "mcp.json"), "utf8")
  const piCommand = join(
    here,
    "fixtures/node_modules/.bin",
    process.platform === "win32" ? "pi.cmd" : "pi"
  )
  const env = {
    ...process.env,
    PI_ACP_PI_COMMAND: piCommand,
    PI_CODING_AGENT_DIR: profile,
    PI_SKIP_VERSION_CHECK: "1",
    PI_ACP_ENABLE_EMBEDDED_CONTEXT: "true",
  }
  // No real provider keys or user configurations enter this child.
  for (const key of Object.keys(env))
    if (/API_KEY|AUTH_TOKEN/.test(key)) delete env[key]
  const acp = client(env, cwd)
  const servers = [
    {
      name: "codeg-mcp",
      command: process.execPath,
      args: [fileURLToPath(import.meta.url), "--stdio"],
      env: [{ name: "PROBE_LITERAL", value: literal }],
    },
    {
      name: "http-fixture",
      type: "http",
      url: `http://127.0.0.1:${port}/mcp`,
      headers: [{ name: "x-literal", value: literal }],
    },
    {
      name: "unsupported-sse",
      type: "sse",
      url: `http://127.0.0.1:${port}/sse`,
      headers: [],
    },
  ]
  if (scenario === "failure")
    servers[0].command = join(root, "missing-mcp-executable")
  try {
    const init = await acp.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "fixture", version: "1.0.0" },
    })
    assert.equal(init.agentInfo.name, "pi-acp")
    const session = await acp.request("session/new", {
      cwd,
      mcpServers: servers,
    })
    console.log(
      "PI_SESSION",
      JSON.stringify({
        info: init.agentInfo,
        meta: session._meta,
        options: session.configOptions?.map((option) => option.id),
      })
    )
    const registered =
      scenario === "success" ? ["codeg-mcp", "http-fixture"] : ["http-fixture"]
    assert.deepEqual(session._meta.piAcp.mcp.registered.sort(), registered)
    assert.match(
      session._meta.piAcp.mcp.skipped.find(
        (item) => item.name === "unsupported-sse"
      ).reason,
      /SSE/
    )
    if (scenario !== "success") {
      assert.ok(
        session._meta.piAcp.mcp.skipped.some(
          (item) => item.name === "codeg-mcp"
        )
      )
      const loaded = await acp.request("session/load", {
        sessionId: session.sessionId,
        cwd,
        mcpServers: servers,
      })
      assert.deepEqual(loaded._meta.piAcp.mcp.registered.sort(), registered)
      assert.equal(readFileSync(join(profile, "mcp.json"), "utf8"), original)
      console.log(
        "PI_PROBE_PASS",
        JSON.stringify({ root, scenario, registered })
      )
      return
    }
    const configured = await acp.request("session/set_config_option", {
      sessionId: session.sessionId,
      configId: "thought_level",
      value: "high",
    })
    assert.equal(
      configured.configOptions.find((o) => o.id === "thought_level")
        .currentValue,
      "high"
    )
    const extensionResult = await acp.request("session/prompt", {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "/fixture-command" }],
    })
    assert.equal(extensionResult._meta.piAcp.disposition, "handled")
    assert.equal(models.length, 0)
    assert.ok(
      acp.updates.some(
        (message) =>
          message.params?.update?.content?.text === "LOCAL_EXTENSION_OK"
      )
    )
    assert.ok(
      acp.updates.some((message) =>
        message.params?.update?.availableCommands?.some(
          (command) => command.name === "session"
        )
      )
    )
    const result = await acp.request("session/prompt", {
      sessionId: session.sessionId,
      prompt: [
        { type: "text", text: "Call both fixture echo tools then respond." },
      ],
    })
    assert.equal(result.stopReason, "end_turn")
    assert.equal(calls.length, 1)
    assert.ok(
      models.some((input) =>
        input.tools.some((tool) => tool.function.name === "mcp__native__echo")
      )
    )
    const toolReplies = models.flatMap((input) =>
      input.messages.filter((message) => message.role === "tool")
    )
    assert.ok(
      toolReplies.some((message) => String(message.content).includes(literal)),
      "stdio credential value must remain literal"
    )
    assert.ok(
      acp.updates.some((message) =>
        message.params?.update?.content?.text?.includes("LOCAL_FIXTURE_OK")
      )
    )
    const loaded = await acp.request("session/load", {
      sessionId: session.sessionId,
      cwd,
      mcpServers: servers,
    })
    assert.equal(loaded._meta.piAcp.mcp.registered.length, 2)
    assert.equal(
      loaded.configOptions.find((o) => o.id === "thought_level").currentValue,
      "high"
    )
    assert.equal(
      loaded.configOptions.find((o) => o.id === "model").currentValue,
      session.configOptions.find((o) => o.id === "model").currentValue
    )
    assert.equal(readFileSync(join(profile, "mcp.json"), "utf8"), original)
    console.log(
      "PI_PROBE_PASS",
      JSON.stringify({
        root,
        modelRequests: models.length,
        httpToolCalls: calls.length,
        historyUpdates: acp.updates.length,
      })
    )
  } finally {
    await acp.close()
    await new Promise((resolveClose) => server.close(resolveClose))
  }
}
