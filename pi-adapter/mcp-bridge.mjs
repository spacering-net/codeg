// Local lifecycle guard around the unchanged, pinned upstream extension.
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import upstreamBridge from "./vendor/src/pi-extension/mcp-bridge.ts"

const namespace = (name) => name.replace(/[^A-Za-z0-9_]/g, "_").toLowerCase()

export default function bridge(pi, options = {}) {
  const path = process.env.PI_ACP_BRIDGE_CONFIG
  if (!path) return
  let config
  try {
    config = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    upstreamBridge(pi)
    return
  }
  const nativePaths = options.nativePaths ?? [
    join(
      process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
      "mcp.json"
    ),
    join(process.cwd(), ".pi", "mcp.json"),
  ]
  const reserved = new Set()
  let unreadable = false
  for (const file of nativePaths) {
    if (!existsSync(file)) continue
    try {
      const native = JSON.parse(readFileSync(file, "utf8"))
      for (const name of Object.keys(native.mcpServers ?? {}))
        reserved.add(namespace(name))
    } catch {
      // We cannot prove that a native configuration will not override us.
      unreadable = true
    }
  }
  const conflicts = new Set()
  upstreamBridge({
    registerMcpServer:
      typeof pi.registerMcpServer === "function"
        ? (name, value) => {
            if (unreadable || reserved.has(namespace(name))) {
              conflicts.add(name)
              throw new Error(
                "Native MCP configuration conflicts with session registration"
              )
            }
            pi.registerMcpServer(name, value)
            reserved.add(namespace(name))
          }
        : undefined,
  })
  let status
  try {
    status = JSON.parse(readFileSync(config.statusPath, "utf8"))
  } catch {
    return
  }
  // The upstream extension reports that registerMcpServer returned. Pi still
  // has to connect and publish tools. Do not expose credentials from errors.
  status.failed = status.failed.map(({ name }) => ({
    name,
    error: conflicts.has(name)
      ? "Native MCP configuration conflicts with session registration"
      : "Pi rejected the MCP registration",
  }))
  const attempted = status.registered.splice(0)
  status.pending = attempted.length > 0
  const save = () => {
    try {
      writeFileSync(config.statusPath, JSON.stringify(status), { mode: 0o600 })
    } catch {
      /* adapter may have closed */
    }
  }
  save()
  if (!status.pending) return
  if (
    typeof pi.on !== "function" ||
    typeof pi.getAllTools !== "function" ||
    typeof pi.getActiveTools !== "function"
  ) {
    status.pending = false
    status.failed.push(
      ...attempted.map((name) => ({
        name,
        error: "Pi cannot confirm active MCP tools",
      }))
    )
    save()
    return
  }
  pi.on("session_start", () => {
    // Do not await inside the event: other extensions' session_start handlers
    // must run before their asynchronous MCP connections can become ready.
    void (async () => {
      const deadline = Date.now() + (options.timeoutMs ?? 10000)
      const waiting = new Set(attempted)
      do {
        const active = new Set(pi.getActiveTools())
        const tools = pi.getAllTools()
        for (const name of waiting) {
          const prefix = `mcp__${name.replace(/[^A-Za-z0-9_]/g, "_")}__`
          if (
            tools.some(
              (tool) => tool.name.startsWith(prefix) && active.has(tool.name)
            )
          ) {
            status.registered.push(name)
            waiting.delete(name)
          }
        }
        if (!waiting.size || Date.now() >= deadline) break
        await new Promise((resolve) => setTimeout(resolve, 25))
      } while (true)
      for (const name of waiting)
        status.failed.push({
          name,
          error:
            "Pi did not make MCP tools available before the startup deadline",
        })
    })()
      .catch(() => {
        status.registered = []
        status.failed.push(
          ...attempted.map((name) => ({
            name,
            error: "Pi MCP tool confirmation failed",
          }))
        )
      })
      .finally(() => {
        status.pending = false
        save()
      })
  })
}
