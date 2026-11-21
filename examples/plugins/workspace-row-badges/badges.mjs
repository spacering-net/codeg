export function handle(method, { workspaces }) {
  if (method !== "worktree-badges" || !Array.isArray(workspaces)) {
    throw new Error("Expected a batch of workspaces")
  }
  return workspaces
    .filter((workspace) => workspace.parentFolderId !== null)
    .map(({ folderId }) => ({ folderId, label: "Git", tone: "info" }))
}
