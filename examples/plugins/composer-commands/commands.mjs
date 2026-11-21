export function handle(method, { args, folderId, conversationId }) {
  if (method !== "show-context") throw new Error("Unknown method")
  const context =
    conversationId === null ? `Workspace ${folderId}` : `Session ${conversationId}`
  const label = Array.from(args.replace(/\s+/g, " ")).slice(0, 80).join("")
  return { message: label ? `${context} — ${label}` : context }
}
