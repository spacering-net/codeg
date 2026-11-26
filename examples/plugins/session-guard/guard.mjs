export function handle(method, input) {
  if (method === "guard-prompt") {
    if (input.prompt.includes("EXAMPLE_SECRET_PLACEHOLDER")) {
      return { reject: "Remove EXAMPLE_SECRET_PLACEHOLDER before sending." }
    }
    return null
  }

  if (method === "guard-permission") {
    if (input.toolKind === "delete") {
      const deny = input.options.find((option) => option.kind === "reject_once")
      return deny
        ? { action: "select", optionId: deny.optionId }
        : { action: "cancel" }
    }
    return null
  }
}
