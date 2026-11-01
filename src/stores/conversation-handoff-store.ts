import { create } from "zustand"
import { registerBackendScopedStoreReset } from "@/stores/backend-scoped-store-reset"

/** All entry points pause the same open conversation during a handoff. */
export const useConversationHandoffStore = create<{
  busy: Record<number, boolean>
  tickets: Record<number, object>
}>(() => ({ busy: {}, tickets: {} }))

export function beginConversationHandoff(id: number) {
  const ticket = {}
  useConversationHandoffStore.setState((state) => ({
    busy: { ...state.busy, [id]: true },
    tickets: { ...state.tickets, [id]: ticket },
  }))
  return () => {
    if (useConversationHandoffStore.getState().tickets[id] !== ticket) return
    useConversationHandoffStore.setState((state) => ({
      busy: { ...state.busy, [id]: false },
    }))
  }
}

registerBackendScopedStoreReset(() =>
  useConversationHandoffStore.setState({ busy: {}, tickets: {} })
)
