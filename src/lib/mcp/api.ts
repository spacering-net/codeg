/**
 * The MCP engine's commands and its event.
 *
 * Everything goes through the window's transport, so it reads and writes the
 * agent configuration of whatever host that transport reaches: this computer,
 * a remote workspace's host, or the server behind a browser.
 *
 * `mcp_apply` and `mcp_parse_snippet` answer every outcome in their result —
 * a busy lock, a file changed elsewhere, a failed write — and reject only when
 * the request never reached the engine (see `./errors.ts`). Callers check
 * `outcome` and `ok`, never rely on a throw.
 */
import { getTransport, type UnsubscribeFn } from "@/lib/transport"
import {
  normalizeApplyResult,
  normalizeChanged,
  normalizeInventory,
  normalizeSnippet,
} from "./normalize"
import {
  MCP_CHANGED_EVENT,
  type McpApplyArgs,
  type McpApplyResult,
  type McpChanged,
  type McpInventory,
  type McpSnippet,
} from "./types"

/** Every agent's configuration, read afresh. Writes nothing. */
export async function mcpInventory(): Promise<McpInventory> {
  return normalizeInventory(await getTransport().call("mcp_inventory"))
}

/**
 * Carry out `ops` — all of them or none — or, with `preflight`, only check
 * them. `basis` is each agent's `config.basis` as the caller last saw it; a
 * real run needs one for every agent it names.
 */
export async function mcpApply(params: McpApplyArgs): Promise<McpApplyResult> {
  return normalizeApplyResult(
    await getTransport().call("mcp_apply", {
      basis: params.basis ?? {},
      ops: params.ops,
      preflight: params.preflight ?? false,
    })
  )
}

/** The servers a pasted piece of configuration names. Writes nothing. */
export async function mcpParseSnippet(text: string): Promise<McpSnippet> {
  return normalizeSnippet(
    await getTransport().call("mcp_parse_snippet", { text })
  )
}

/**
 * `mcp://changed`: some agent's configuration was written by Codeg — by this
 * window or any other, or by another client of the same server. It names the
 * agents, nothing else; the answer to it is a fresh `mcp_inventory`.
 */
export function onMcpChanged(
  handler: (payload: McpChanged) => void
): Promise<UnsubscribeFn> {
  return getTransport().subscribe<unknown>(MCP_CHANGED_EVENT, (payload) =>
    handler(normalizeChanged(payload))
  )
}
