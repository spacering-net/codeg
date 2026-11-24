import type { ForgeSourceItem, ForgeSourceMeta } from "@/lib/types"

/**
 * Every work item a forge-sourced task handles, lead first: the item list of
 * a task made from several related issues, or the one item the snapshot's own
 * fields name. Display only — which tasks handle an item is answered by the
 * backend's reverse lookup, never from here.
 */
export function sourceItems(meta: ForgeSourceMeta): ForgeSourceItem[] {
  if (meta.items != null && meta.items.length > 0) return meta.items
  return [{ number: meta.number, url: meta.url, title: meta.title }]
}

/** Whether the task was made from several related issues. */
export function isCombinedSource(
  meta: ForgeSourceMeta | null | undefined
): boolean {
  return (meta?.items?.length ?? 0) > 1
}
