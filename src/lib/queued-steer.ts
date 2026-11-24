import { isNoActiveTurnRejection } from "@/lib/turn-busy"

export async function deliverQueuedSteer(
  steer: () => Promise<unknown>,
  prioritize: () => void
): Promise<boolean> {
  try {
    await steer()
    return true
  } catch (error) {
    if (
      !isNoActiveTurnRejection(error) &&
      !String(
        typeof error === "object" && error && "message" in error
          ? error.message
          : error
      ).includes("restarting turn with the selected Codex settings")
    ) {
      throw error
    }
    // Keep the row queued. The existing flush owns readiness, mode selection,
    // optimistic messages and busy retries; this path must not send a prompt.
    prioritize()
    return false
  }
}
