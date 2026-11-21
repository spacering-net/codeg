export function handle(method, input) {
  if (method === "before-open") {
    return /[/\\]workspace-alias$/.test(input.path)
      ? { path: input.path.replace(/workspace-alias$/, "workspace-real") }
      : null
  }
  if (method === "before-create") {
    return /[/\\]workspace-create-alias$/.test(input.path)
      ? {
          path: input.path.replace(/workspace-create-alias$/, "workspace-real"),
        }
      : null
  }
  if (method === "before-worktree") {
    return input.path.endsWith("-request")
      ? { path: input.path.replace(/-request$/, "-checkout") }
      : null
  }
  if (method === "before-agent-create") {
    return input.title === "Plugin creation demo"
      ? { title: "Plugin-created agent" }
      : null
  }
  if (method === "before-agent-open") {
    return /[/\\]plugin-launch-demo$/.test(input.workingDirectory ?? "")
      ? { env: { ...input.env, CODEG_PLUGIN_WORKSPACE_LABEL: "Launch demo" } }
      : null
  }
  if (method === "turn-completed") {
    return { folderId: input.folderId, stopReason: input.detail.stopReason }
  }
  if (method === "tool-completed") {
    const { toolCallId, status, outputKind } = input.detail
    return { toolCallId, status, outputKind }
  }
  if (
    method === "after-create" ||
    method === "after-archive" ||
    method.startsWith("worktree-") ||
    method.startsWith("agent-")
  ) {
    return input
  }
  return { folderId: input.folderId }
}
