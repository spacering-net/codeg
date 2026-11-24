/**
 * The tab view's agent pickers lock once the tab is bound to a conversation
 * row — a saved conversation keeps the agent it was created with — and never
 * because the agent is still connecting: a draft can be switched while its
 * first agent spawns, and `connect()` replaces the abandoned attempt with the
 * agent picked last.
 *
 * `ConversationTabView` is too heavy to render here (see
 * tab-first-show-auto-connect.test.tsx), so this pins the wiring in its source.
 * The canvas card's picker is covered by a render test of its own
 * (canvas-conversation-surface.test.tsx).
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

describe("ConversationTabView agent pickers", () => {
  const panel = readFileSync(
    resolve(
      process.cwd(),
      "src/components/conversations/conversation-detail-panel.tsx"
    ),
    "utf8"
  )
  const pickers = panel.match(/<AgentSelector\b[\s\S]*?\/>/g) ?? []

  it("locks both pickers on the conversation row alone", () => {
    // The welcome-mode picker and the docked composer's.
    expect(pickers).toHaveLength(2)
    for (const picker of pickers) {
      expect(picker.match(/\bdisabled=\{([^}]*)\}/)?.[1]).toBe(
        "dbConversationId != null"
      )
    }
  })

  it("ignores a pick once the tab is bound, whatever the picker shows", () => {
    expect(panel).toMatch(
      /const handleAgentSelect = useCallback\(\s+\(nextAgentType: AgentType\) => \{\s+if \(nextAgentType === selectedAgentRef\.current\) return\s+if \(dbConvIdRef\.current\) return/
    )
  })
})
