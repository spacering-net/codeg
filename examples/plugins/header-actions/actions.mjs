export function handle(method, input) {
  const folderId = input?.folderId
  if (method !== "describe" || !Number.isInteger(folderId)) {
    throw new Error("Expected a workspace folder ID")
  }
  return `Workspace #${folderId} is active.`
}
