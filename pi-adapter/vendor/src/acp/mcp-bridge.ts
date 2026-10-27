import type { McpServer } from '@agentclientprotocol/sdk'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Hand the session's ACP `mcpServers` to pi.
 *
 * pi (0.99+) has native MCP, but its only ways in are `mcp.json` files it reads
 * itself and `pi.registerMcpServer()` from an extension. The adapter therefore
 * loads a tiny bundled extension (`mcp-bridge.mjs`, see
 * `src/pi-extension/mcp-bridge.ts`) with `-e`, and passes it the servers
 * through a private file: the path goes in an env var the extension deletes on
 * load, and the extension unlinks the file after reading it. An env var holding
 * the servers themselves would be inherited by every bash command and MCP
 * child pi starts, and their headers/env can carry credentials.
 *
 * Every server is registered with `exposure: "direct"`: a client that hands a
 * session its MCP servers means for the model to call them, and pi's default
 * (`codemode`) would hide them behind script-only access.
 */

/** Env var naming the bridge config file for the pi child. */
export const BRIDGE_CONFIG_ENV = 'PI_ACP_BRIDGE_CONFIG'

/** Test/dev override for the extension's location. */
const BRIDGE_EXTENSION_ENV = 'PI_ACP_BRIDGE_EXTENSION'

export type PiMcpServerConfig =
  | {
      command: string
      args?: string[]
      env?: Record<string, string>
      exposure: 'direct'
    }
  | {
      url: string
      headers?: Record<string, string>
      exposure: 'direct'
    }

export type BridgeServer = { name: string; config: PiMcpServerConfig }
export type BridgeSkip = { name: string; reason: string }

export type BridgeConfig = {
  version: 1
  servers: BridgeServer[]
  statusPath: string
}

/** What the extension reports after trying to register the servers. */
export type BridgeStatus = {
  version: 1
  /** pi has no `registerMcpServer` (older than 0.99). */
  unsupported: boolean
  registered: string[]
  failed: Array<{ name: string; error: string }>
}

/** What the adapter tells the client about MCP delivery for one session. */
export type McpDeliveryReport = {
  /** Servers pi accepted. */
  registered: string[]
  /** Servers that never reached pi, with the reason. */
  skipped: BridgeSkip[]
  /** pi is too old for MCP; nothing was delivered. */
  unsupported: boolean
}

/**
 * Escape a literal for a pi config value. pi resolves `env` and `headers`
 * values: a leading `!` runs the rest as a shell command, and `$NAME` /
 * `${NAME}` interpolate the environment. ACP values are literal, so every `$`
 * becomes `$$` and a leading `!` becomes `$!` — pi's two escapes.
 */
export function escapePiConfigValue(value: string): string {
  const escaped = value.replace(/\$/g, () => '$$')
  return escaped.startsWith('!') ? `$${escaped}` : escaped
}

/**
 * pi accepts server names made of letters, digits, `_` and `-`, and treats two
 * names that differ only in `-` vs `_` as the same server (the second is
 * rejected). Map anything else to `_` and suffix collisions.
 */
function piServerName(raw: string, taken: Set<string>): string {
  let base = raw.trim().replace(/[^A-Za-z0-9_-]/g, '_')
  if (!base) base = 'server'
  let name = base
  let n = 2
  while (taken.has(name.replace(/-/g, '_').toLowerCase())) {
    name = `${base}_${n}`
    n += 1
  }
  taken.add(name.replace(/-/g, '_').toLowerCase())
  return name
}

function record(pairs: Array<{ name: string; value: string }> | undefined): Record<string, string> | undefined {
  if (!pairs?.length) return undefined
  const out: Record<string, string> = {}
  for (const { name, value } of pairs) out[name] = escapePiConfigValue(value)
  return out
}

/** Translate ACP `mcpServers` into pi registrations, reporting what cannot go. */
export function toBridgeServers(servers: McpServer[] | undefined): {
  servers: BridgeServer[]
  skipped: BridgeSkip[]
} {
  const out: BridgeServer[] = []
  const skipped: BridgeSkip[] = []
  const taken = new Set<string>()

  for (const server of servers ?? []) {
    const type = (server as { type?: unknown }).type
    if (type === 'sse') {
      skipped.push({
        name: server.name,
        reason: 'pi does not support the SSE transport'
      })
      continue
    }
    if (type === 'http') {
      const http = server as Extract<McpServer, { type: 'http' }>
      const headers = record(http.headers)
      out.push({
        name: piServerName(http.name, taken),
        config: {
          url: http.url,
          ...(headers ? { headers } : {}),
          exposure: 'direct'
        }
      })
      continue
    }
    if (type !== undefined && type !== 'stdio') {
      skipped.push({
        name: server.name,
        reason: `unsupported MCP transport: ${String(type)}`
      })
      continue
    }
    const stdio = server as Extract<McpServer, { command: string }>
    if (typeof stdio.command !== 'string' || !stdio.command) {
      skipped.push({
        name: server.name,
        reason: 'stdio server without a command'
      })
      continue
    }
    const env = record(stdio.env)
    out.push({
      name: piServerName(stdio.name, taken),
      config: {
        command: stdio.command,
        ...(stdio.args?.length ? { args: stdio.args } : {}),
        ...(env ? { env } : {}),
        exposure: 'direct'
      }
    })
  }

  return { servers: out, skipped }
}

/** Where the bundled extension lives: next to this bundle in `dist/`. */
export function bridgeExtensionPath(): string {
  const override = process.env[BRIDGE_EXTENSION_ENV]
  if (override) return override
  return fileURLToPath(new URL('./mcp-bridge.mjs', import.meta.url))
}

/**
 * The oldest pi this adapter serves: native MCP (`pi.registerMcpServer`) and the
 * prompt `disposition` RPC field both arrived in pi 0.99.0.
 */
export const MIN_PI_VERSION = '0.99.0'

/**
 * Stable marker in the error a session open fails with on an older pi, so a
 * client can recognize it (codeg maps it to "update pi" with a settings link).
 */
export const PI_TOO_OLD_MARKER = 'pi runtime is too old for pi-acp'

export function piTooOldMessage(): string {
  return (
    `${PI_TOO_OLD_MARKER}: it needs pi ${MIN_PI_VERSION} or newer (native MCP support). ` +
    'Update it with `npm install -g @earendil-works/pi-coding-agent`.'
  )
}

/** What one launch learned from the bridge extension. */
export type BridgeOutcome = {
  /** For the session/new|load response; `null` when the session had no servers. */
  report: McpDeliveryReport | null
  /**
   * Whether this pi has native MCP: `false` proves it is older than
   * {@link MIN_PI_VERSION}; `null` means the extension never reported (it did
   * not load), which proves nothing either way.
   */
  piSupportsMcp: boolean | null
}

/**
 * One pi launch's bridge: the private files plus what to add to the spawn.
 * The extension loads on EVERY launch, servers or not — its report is also the
 * cheapest proof of the pi version (it costs no extra process, unlike
 * `pi --version`). `collect()` reads the report and removes the files.
 */
export class McpBridgeLaunch {
  private constructor(
    private readonly dir: string,
    private readonly statusPath: string,
    readonly extensionPath: string,
    readonly env: Record<string, string>,
    readonly skipped: BridgeSkip[],
    readonly servers: BridgeServer[],
    private readonly hadServers: boolean
  ) {}

  static prepare(servers: McpServer[] | undefined): McpBridgeLaunch {
    const { servers: bridged, skipped } = toBridgeServers(servers)
    const dir = mkdtempSync(join(tmpdir(), 'pi-acp-bridge-'))
    const configPath = join(dir, 'bridge.json')
    const statusPath = join(dir, 'status.json')
    const config: BridgeConfig = { version: 1, servers: bridged, statusPath }
    try {
      writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 })
    } catch (error) {
      // Never leave a partial copy of the servers' credentials behind.
      rmSync(dir, { recursive: true, force: true })
      throw error
    }
    return new McpBridgeLaunch(
      dir,
      statusPath,
      bridgeExtensionPath(),
      { [BRIDGE_CONFIG_ENV]: configPath },
      skipped,
      bridged,
      (servers?.length ?? 0) > 0
    )
  }

  /** Extensions to pass to `pi -e`. */
  get extensions(): string[] {
    return [this.extensionPath]
  }

  /** Read the extension's status (after pi answered its handshake) and clean up. */
  collect(): BridgeOutcome {
    let status: BridgeStatus | null = null
    try {
      status = JSON.parse(readFileSync(this.statusPath, 'utf8')) as BridgeStatus
    } catch {
      status = null
    }
    this.cleanup()

    const piSupportsMcp = status ? !status.unsupported : null
    if (!this.hadServers) return { report: null, piSupportsMcp }

    const skipped = [...this.skipped]
    if (!status) {
      // The extension never ran (pi refused `-e`, or crashed while loading it).
      for (const s of this.servers)
        skipped.push({
          name: s.name,
          reason: 'the pi bridge extension did not load'
        })
      return {
        report: { registered: [], skipped, unsupported: false },
        piSupportsMcp
      }
    }
    if (status.unsupported) {
      for (const s of this.servers)
        skipped.push({
          name: s.name,
          reason: `pi is too old for MCP (needs ${MIN_PI_VERSION}+)`
        })
      return {
        report: { registered: [], skipped, unsupported: true },
        piSupportsMcp
      }
    }
    for (const f of status.failed ?? []) skipped.push({ name: f.name, reason: f.error })
    return {
      report: {
        registered: status.registered ?? [],
        skipped,
        unsupported: false
      },
      piSupportsMcp
    }
  }

  cleanup(): void {
    try {
      rmSync(this.dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
}
