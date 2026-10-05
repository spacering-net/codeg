import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

import { HERMES_MODEL_CONFIG_ID } from "@/hooks/use-hermes-model-option"

// Every surface that mounts the composer. A new one that forgets the routing
// would send codeg's synthetic id to the agent; a new one that forgets the
// option would silently drop the picker on that surface.
const SURFACES = [
  "src/components/conversations/conversation-detail-panel.tsx",
  "src/components/canvas/canvas-conversation-surface.tsx",
] as const

const sources = SURFACES.map(
  (path) => [path, readFileSync(resolve(process.cwd(), path), "utf8")] as const
)

describe("Hermes model option wiring", () => {
  /**
   * WHY: `configOptions` is the list the composer hands straight to the
   * backend's `session/set_config_option` on a pick. codeg's synthetic Hermes
   * model option is not one of those — Hermes never advertised it — so every
   * surface that offers the option MUST also intercept its id. A surface that
   * merges the option but routes it like an ACP one fails at the moment the
   * user picks a model: the agent rejects an id it does not know, and the model
   * silently stays where it was.
   */
  it.each(sources)(
    "%s intercepts the synthetic id instead of forwarding it to the agent",
    (_path, source) => {
      expect(source).toContain("useHermesModelOption")
      expect(source).toContain("hermesModelOption")
      expect(source).toContain(`if (configId === HERMES_MODEL_CONFIG_ID)`)
      // The composer must receive the intercepting handler, never the raw ACP one.
      expect(source).toContain(
        "onConfigOptionChange={handleConfigOptionChange}"
      )
      expect(source).not.toContain(
        "onConfigOptionChange={handleSetConfigOption}"
      )
    }
  )

  // The prefix is the whole reason the interception is recognisable. Renaming
  // the id without keeping it namespaced would make it indistinguishable from
  // an agent-advertised option.
  it("keeps the synthetic id namespaced to codeg", () => {
    expect(HERMES_MODEL_CONFIG_ID).toBe("codeg:hermes-model")
  })
})
