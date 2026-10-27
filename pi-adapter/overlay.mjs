// Small, audited build-time adaptations; vendored source bytes remain intact.
export function applyOverlay(path, source) {
  const replace = (from, to) => {
    if (source.split(from).length !== 2)
      throw new Error(`Pi overlay drift: ${path}`)
    source = source.replace(from, to)
  }
  if (path.endsWith("/acp/agent.ts") || path.endsWith("/acp/session.ts")) {
    replace(
      "const bridged = bridge.collect()",
      "const bridged = await bridge.collect()"
    )
  }
  if (path.endsWith("/acp/mcp-bridge.ts")) {
    replace(
      "collect(): BridgeOutcome {",
      `async collect(): Promise<BridgeOutcome> {
    // The local extension confirms actual active tools after session_start.
    const deadline = Date.now() + 12000
    while (Date.now() < deadline) {
      try {
        const report = JSON.parse(readFileSync(this.statusPath, 'utf8'))
        if (!report.pending) break
      } catch { break }
      await new Promise(resolve => setTimeout(resolve, 25))
    }`
    )
    replace(
      "    this.cleanup()",
      `    if (status && (status as BridgeStatus & { pending?: boolean }).pending) {
      status.registered = []
      status.failed = this.servers.map(server => ({
        name: server.name, error: 'Pi MCP tool confirmation did not finish'
      }))
    }
    this.cleanup()`
    )
  }
  return source
}
