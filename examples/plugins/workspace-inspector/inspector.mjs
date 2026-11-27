export function handle(method, { folderId, locale }, settings) {
  if (method !== "describe" || !Number.isInteger(folderId)) {
    throw new Error("Expected a workspace folder ID")
  }
  return `${settings.label} #${folderId} · ${locale}`
}
