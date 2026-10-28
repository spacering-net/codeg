import { create } from "zustand"

export interface ConversationSearchTarget {
  conversationId: number
  turnId: string
  turnIndex: number
  role?: "user" | "assistant"
  token: number
}

let nextToken = 0

// 请求需保留到目标会话完成加载，不能依赖组件挂载时序发送一次性事件。
export const useConversationSearchStore = create<{
  target: ConversationSearchTarget | null
}>(() => ({ target: null }))

export function requestConversationSearchJump(
  conversationId: number,
  match: { turn_id: string; turn_index: number; role?: "user" | "assistant" }
): void {
  useConversationSearchStore.setState({
    target: {
      conversationId,
      turnId: match.turn_id,
      turnIndex: match.turn_index,
      role: match.role,
      token: ++nextToken,
    },
  })
}

export function clearConversationSearchJump(token: number): void {
  useConversationSearchStore.setState((state) =>
    state.target?.token === token ? { target: null } : state
  )
}
