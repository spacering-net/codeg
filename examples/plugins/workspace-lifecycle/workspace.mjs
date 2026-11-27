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
  if (method === "turn-completed") {
    return { folderId: input.folderId, stopReason: input.detail.stopReason }
  }
  if (
    method === "after-create" ||
    method === "after-archive" ||
    method.startsWith("worktree-")
  ) {
    return input
  }
  return { folderId: input.folderId }
}
