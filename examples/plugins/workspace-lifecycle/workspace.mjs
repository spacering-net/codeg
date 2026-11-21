export function handle(method, input) {
  if (method === "before-open") {
    return /[/\\]workspace-alias$/.test(input.path)
      ? { path: input.path.replace(/workspace-alias$/, "workspace-real") }
      : null
  }
  return { folderId: input.folderId }
}
