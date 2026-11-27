export function handle(method, input, _settings, ctx) {
  if (method !== "refresh") {
    throw new Error(`Unknown method: ${method}`)
  }

  const { fileCount, folderId } = input
  const summary = ctx.services.call("workspace.metrics", "summarize", {
    fileCount,
  })
  ctx.events.emit("metrics.summary", summary, { folderId })
  return summary
}
