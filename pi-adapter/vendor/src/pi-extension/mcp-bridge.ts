/**
 * pi extension loaded by pi-acp with `pi -e <this file>`.
 *
 * It registers the ACP session's MCP servers with pi's native MCP support
 * (`pi.registerMcpServer`, pi 0.99+). The adapter passes them through a private
 * file named by `PI_ACP_BRIDGE_CONFIG`; this extension removes the env var
 * before anything can inherit it, deletes the file, and writes a status report
 * the adapter reads back once pi answered its first RPC.
 *
 * Bundled standalone (no imports beyond node built-ins) so pi can load it
 * without resolving packages. See `src/acp/mcp-bridge.ts` for the other half.
 */
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'

const CONFIG_ENV = 'PI_ACP_BRIDGE_CONFIG'

type BridgeConfig = {
  version?: number
  servers?: Array<{ name?: unknown; config?: unknown }>
  statusPath?: unknown
}

type PiExtensionApi = {
  registerMcpServer?: (name: string, config: unknown) => void
}

export default function mcpBridge(pi: PiExtensionApi): void {
  const configPath = process.env[CONFIG_ENV]
  delete process.env[CONFIG_ENV]
  if (!configPath) return

  let config: BridgeConfig
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8')) as BridgeConfig
  } catch {
    return
  } finally {
    try {
      unlinkSync(configPath)
    } catch {
      // already gone
    }
  }

  const status = {
    version: 1,
    unsupported: false,
    registered: [] as string[],
    failed: [] as Array<{ name: string; error: string }>
  }

  if (typeof pi?.registerMcpServer !== 'function') {
    status.unsupported = true
  } else {
    for (const server of config.servers ?? []) {
      const name = typeof server?.name === 'string' ? server.name : ''
      if (!name) continue
      try {
        pi.registerMcpServer(name, server.config)
        status.registered.push(name)
      } catch (error) {
        status.failed.push({
          name,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }

  if (typeof config.statusPath === 'string' && config.statusPath) {
    try {
      writeFileSync(config.statusPath, JSON.stringify(status), { mode: 0o600 })
    } catch {
      // the adapter reports a missing status as "did not load"
    }
  }
}
