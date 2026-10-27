/* Generated from pi-adapter/vendor (MIT); see pi-adapter/provenance.json. */
import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);

// pi-adapter/mcp-bridge.mjs
import { existsSync, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// pi-adapter/vendor/src/pi-extension/mcp-bridge.ts
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
var CONFIG_ENV = "PI_ACP_BRIDGE_CONFIG";
function mcpBridge(pi) {
  const configPath = process.env[CONFIG_ENV];
  delete process.env[CONFIG_ENV];
  if (!configPath) return;
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return;
  } finally {
    try {
      unlinkSync(configPath);
    } catch {
    }
  }
  const status = {
    version: 1,
    unsupported: false,
    registered: [],
    failed: []
  };
  if (typeof pi?.registerMcpServer !== "function") {
    status.unsupported = true;
  } else {
    for (const server of config.servers ?? []) {
      const name = typeof server?.name === "string" ? server.name : "";
      if (!name) continue;
      try {
        pi.registerMcpServer(name, server.config);
        status.registered.push(name);
      } catch (error) {
        status.failed.push({
          name,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }
  if (typeof config.statusPath === "string" && config.statusPath) {
    try {
      writeFileSync(config.statusPath, JSON.stringify(status), { mode: 384 });
    } catch {
    }
  }
}

// pi-adapter/mcp-bridge.mjs
var namespace = (name) => name.replace(/[^A-Za-z0-9_]/g, "_").toLowerCase();
function bridge(pi, options = {}) {
  const path = process.env.PI_ACP_BRIDGE_CONFIG;
  if (!path) return;
  let config;
  try {
    config = JSON.parse(readFileSync2(path, "utf8"));
  } catch {
    mcpBridge(pi);
    return;
  }
  const nativePaths = options.nativePaths ?? [
    join(
      process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
      "mcp.json"
    ),
    join(process.cwd(), ".pi", "mcp.json")
  ];
  const reserved = /* @__PURE__ */ new Set();
  let unreadable = false;
  for (const file of nativePaths) {
    if (!existsSync(file)) continue;
    try {
      const native = JSON.parse(readFileSync2(file, "utf8"));
      for (const name of Object.keys(native.mcpServers ?? {}))
        reserved.add(namespace(name));
    } catch {
      unreadable = true;
    }
  }
  const conflicts = /* @__PURE__ */ new Set();
  mcpBridge({
    registerMcpServer: typeof pi.registerMcpServer === "function" ? (name, value) => {
      if (unreadable || reserved.has(namespace(name))) {
        conflicts.add(name);
        throw new Error(
          "Native MCP configuration conflicts with session registration"
        );
      }
      pi.registerMcpServer(name, value);
      reserved.add(namespace(name));
    } : void 0
  });
  let status;
  try {
    status = JSON.parse(readFileSync2(config.statusPath, "utf8"));
  } catch {
    return;
  }
  status.failed = status.failed.map(({ name }) => ({
    name,
    error: conflicts.has(name) ? "Native MCP configuration conflicts with session registration" : "Pi rejected the MCP registration"
  }));
  const attempted = status.registered.splice(0);
  status.pending = attempted.length > 0;
  const save = () => {
    try {
      writeFileSync2(config.statusPath, JSON.stringify(status), { mode: 384 });
    } catch {
    }
  };
  save();
  if (!status.pending) return;
  if (typeof pi.on !== "function" || typeof pi.getAllTools !== "function" || typeof pi.getActiveTools !== "function") {
    status.pending = false;
    status.failed.push(
      ...attempted.map((name) => ({
        name,
        error: "Pi cannot confirm active MCP tools"
      }))
    );
    save();
    return;
  }
  pi.on("session_start", () => {
    void (async () => {
      const deadline = Date.now() + (options.timeoutMs ?? 1e4);
      const waiting = new Set(attempted);
      do {
        const active = new Set(pi.getActiveTools());
        const tools = pi.getAllTools();
        for (const name of waiting) {
          const prefix = `mcp__${name.replace(/[^A-Za-z0-9_]/g, "_")}__`;
          if (tools.some(
            (tool) => tool.name.startsWith(prefix) && active.has(tool.name)
          )) {
            status.registered.push(name);
            waiting.delete(name);
          }
        }
        if (!waiting.size || Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      } while (true);
      for (const name of waiting)
        status.failed.push({
          name,
          error: "Pi did not make MCP tools available before the startup deadline"
        });
    })().catch(() => {
      status.registered = [];
      status.failed.push(
        ...attempted.map((name) => ({
          name,
          error: "Pi MCP tool confirmation failed"
        }))
      );
    }).finally(() => {
      status.pending = false;
      save();
    });
  });
}
export {
  bridge as default
};
