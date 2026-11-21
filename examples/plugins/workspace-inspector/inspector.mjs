export function handle(method, { folderId, locale }) {
  if (method !== "describe" || !Number.isInteger(folderId)) {
    throw new Error("Expected a workspace folder ID")
  }
  return `Workspace #${folderId} · ${locale}`
}
