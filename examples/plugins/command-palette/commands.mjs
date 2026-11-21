export function handle(method, input) {
  if (method !== "describe-context") {
    throw new Error(`Unknown command method: ${method}`)
  }

  const { scope, folderId, conversationId } = input ?? {}
  switch (scope) {
    case "workspace":
      if (!Number.isInteger(folderId)) {
        throw new Error("Expected a workspace folder ID")
      }
      return `Workspace #${folderId}`
    case "session":
      if (
        !Number.isInteger(conversationId) ||
        (folderId !== null && !Number.isInteger(folderId))
      ) {
        throw new Error("Expected a conversation ID and a workspace ID or null")
      }
      return folderId === null
        ? `Conversation #${conversationId} without a workspace`
        : `Conversation #${conversationId} in workspace #${folderId}`
    default:
      throw new Error("Expected workspace or session command scope")
  }
}
