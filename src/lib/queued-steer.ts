import { isNoActiveTurnRejection } from "@/lib/turn-busy"

export async function deliverQueuedSteer(
  steer: () => Promise<unknown>,
  prioritize: () => void
): Promise<boolean> {
  try {
    await steer()
    return true
  } catch (error) {
    if (!isNoActiveTurnRejection(error)) throw error
    // Keep the row queued. The existing flush owns readiness, mode selection,
    // optimistic messages and busy retries; this path must not send a prompt.
    prioritize()
    return false
  }
}
