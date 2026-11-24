import type { ForgeIssueRow, ForgeLabel } from "./types"

/**
 * The row a mutation answered with, with the label colours it could not carry.
 *
 * A close/reopen hands back the item as the forge now serves it, and that copy
 * is authoritative — it is how a pull request merged in the browser a moment
 * ago comes back `merged` instead of the `closed` a local flip would have
 * assumed. But a SINGLE item's payload is not identical to a list row on
 * GitLab: `with_labels_details` is a list-endpoint parameter, so one item
 * answers with bare label NAMES and every chip in the panel would drop to grey
 * the instant somebody pressed Close.
 *
 * So the forge's row wins on everything it actually knows, and a colour is
 * restored only where the new row has none and the previous row had one for a
 * label of the same name. A label whose colour genuinely changed on the forge
 * keeps its stale swatch until the next list refresh, which is a far cheaper
 * wrong than repainting the whole row.
 */
export function mergeForgeRowUpdate(
  previous: ForgeIssueRow | null,
  updated: ForgeIssueRow
): ForgeIssueRow {
  if (previous == null) return updated
  return {
    ...updated,
    labels: withKnownColors(previous.labels, updated.labels),
  }
}

function withKnownColors(
  previous: ForgeLabel[],
  incoming: ForgeLabel[]
): ForgeLabel[] {
  // Nothing to restore — GitHub answers with full label objects, which is the
  // common case and must not pay for a lookup table.
  if (!incoming.some((label) => label.color == null)) return incoming
  const known = new Map(
    previous
      .filter((label) => label.color != null)
      .map((label) => [label.name, label.color])
  )
  return incoming.map((label) =>
    label.color == null && known.has(label.name)
      ? { ...label, color: known.get(label.name) ?? null }
      : label
  )
}
