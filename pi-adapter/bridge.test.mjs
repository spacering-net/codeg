import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import bridge from "../src-tauri/src/acp/pi-bundle/mcp-bridge.mjs"

function fixture(servers, api, options = {}) {
  const dir = mkdtempSync(
    join(process.env.ACP_TEST_ROOT || tmpdir(), "pi-bridge-")
  )
  const config = join(dir, "config.json")
  const status = join(dir, "status.json")
  writeFileSync(
    config,
    JSON.stringify({ version: 1, servers, statusPath: status })
  )
  process.env.PI_ACP_BRIDGE_CONFIG = config
  bridge(api, { nativePaths: [], timeoutMs: 60, ...options })
  assert.equal(process.env.PI_ACP_BRIDGE_CONFIG, undefined)
  assert.equal(existsSync(config), false)
  return { dir, status: () => JSON.parse(readFileSync(status, "utf8")) }
}
const servers = [
  { name: "codeg-mcp", config: { command: "unused", exposure: "direct" } },
]

test("registration acceptance alone never enables tools", async () => {
  let start
  const run = fixture(servers, {
    registerMcpServer() {},
    on: (_, fn) => {
      start = fn
    },
    getAllTools: () => [],
    getActiveTools: () => [],
  })
  assert.deepEqual(run.status().registered, [])
  start()
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(run.status().pending, false)
  assert.equal(run.status().failed[0].name, "codeg-mcp")
})
test("visible active tools confirm a registration after session start", async () => {
  let start
  const name = "mcp__codeg_mcp__echo"
  const run = fixture(servers, {
    registerMcpServer() {},
    on: (_, fn) => {
      start = fn
    },
    getAllTools: () => [{ name }],
    getActiveTools: () => [name],
  })
  start()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(run.status().registered, ["codeg-mcp"])
  assert.equal(run.status().pending, false)
})
test("native aliases cannot impersonate the injected companion", () => {
  const dir = mkdtempSync(
    join(process.env.ACP_TEST_ROOT || tmpdir(), "pi-collision-")
  )
  const native = join(dir, "mcp.json")
  const original = JSON.stringify({
    mcpServers: { codeg_mcp: { command: "native" } },
  })
  writeFileSync(native, original)
  const run = fixture(
    servers,
    {
      registerMcpServer() {
        assert.fail("must not register")
      },
    },
    { nativePaths: [native] }
  )
  assert.deepEqual(run.status().registered, [])
  assert.match(run.status().failed[0].error, /conflicts/)
  assert.equal(readFileSync(native, "utf8"), original)
})
test("unsupported runtimes and registration errors fail closed without credentials", () => {
  assert.equal(fixture(servers, {}).status().unsupported, true)
  const run = fixture(servers, {
    registerMcpServer() {
      throw new Error("SECRET_TOKEN")
    },
  })
  assert.deepEqual(run.status().registered, [])
  assert.equal(JSON.stringify(run.status()).includes("SECRET_TOKEN"), false)
})

test("session names that normalize to the same tool namespace cannot both register", () => {
  const accepted = []
  const run = fixture(
    [...servers, { name: "codeg.mcp", config: { command: "unused" } }],
    { registerMcpServer: (name) => accepted.push(name) }
  )
  assert.deepEqual(accepted, ["codeg-mcp"])
  assert.ok(run.status().failed.some((item) => item.name === "codeg.mcp"))
})
