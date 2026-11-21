export function handle(method, input) {
  if (method === "before-open") {
    return /[/\\]workspace-alias$/.test(input.path)
      ? { path: input.path.replace(/workspace-alias$/, "workspace-real") }
      : null
  }
  if (method === "turn-completed") {
    return { folderId: input.folderId, stopReason: input.detail.stopReason }
  }
  if (method === "worktree-created" || method === "worktree-archived") {
    return input
  }
  return { folderId: input.folderId }
}
