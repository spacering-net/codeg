import type { SessionConfigOptionInfo } from "@/lib/types"

/**
 * Each model's reasoning-effort range, for the model list: `Low–Ultra`, keyed
 * by the model's value.
 *
 * The effort option lists only the CURRENT model's levels, so the list could
 * not say what picking another model does to them. claude-agent-acp 0.110.0
 * and codex-acp 2.10.0 name every model's levels on its entry of the model
 * option (`reasoning_efforts`), and codex's models do differ: GPT-5.5 stops at
 * xhigh, the Lunas at max, the rest at ultra.
 *
 * `null` — nothing to show — when no entry names its efforts, or when every
 * entry would show the same range: then it tells the models apart no better
 * than their names do (every Claude 5.5 model lists low–max). A model whose
 * entry names nothing gets no range.
 *
 * A level is named the way the effort option names it, when that option lists
 * it; otherwise (a level only another model has) by its id with the first
 * letter raised, which is how both adapters name their levels (`xhigh` →
 * "Xhigh", `ultra` → "Ultra").
 */
export function modelEffortRanges(
  modelOption: SessionConfigOptionInfo,
  effortOption: SessionConfigOptionInfo | null
): ReadonlyMap<string, string> | null {
  if (modelOption.kind.type !== "select") return null
  const levelNames = new Map<string, string>()
  if (effortOption?.kind.type === "select") {
    for (const level of effortOption.kind.options) {
      levelNames.set(level.value, level.name)
    }
  }
  const nameOf = (level: string) =>
    levelNames.get(level) ?? level.charAt(0).toUpperCase() + level.slice(1)

  const entries = modelOption.kind.options
  const ranges = new Map<string, string>()
  let unnamed = 0
  for (const entry of entries) {
    const values = entry.reasoning_efforts?.values ?? []
    if (values.length === 0) {
      unnamed += 1
      continue
    }
    const low = nameOf(values[0]!)
    const high = nameOf(values[values.length - 1]!)
    ranges.set(entry.value, values.length === 1 ? low : `${low}–${high}`)
  }
  if (ranges.size === 0) return null
  const shown = new Set(ranges.values())
  if (unnamed === 0 && shown.size === 1) return null
  return ranges
}
