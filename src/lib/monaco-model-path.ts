// Monaco model URI for a file tab. Model identity must be collision-free
// across tabs: two distinct absolute paths must never map to the same URI,
// or Monaco would share one text model (and undo stack) between them.

/**
 * Build the Monaco model path for a tab. Pathless tabs (diffs) key on the
 * tab id. Absolute paths yield `file:///…`; a UNC `//server/share/…` keeps
 * its authority (`file://server/share/…`) so it can never collide with the
 * single-slash POSIX form of the same tail.
 */
export function buildMonacoModelPath(path: string | null, id: string): string {
  if (!path) return `inmemory://model/${encodeURIComponent(id)}`
  const normalized = path.replace(/\\/g, "/")
  if (normalized.startsWith("//")) {
    const encoded = normalized
      .slice(2)
      .split("/")
      .map(encodeURIComponent)
      .join("/")
    return `file://${encoded}`
  }
  // Trim the leading slashes of an absolute path — the scheme supplies
  // them; keeping them would yield "file:////…".
  const encoded = normalized
    .replace(/^\/+/, "")
    .split("/")
    .map(encodeURIComponent)
    .join("/")
  return `file:///${encoded}`
}

/**
 * Model URIs of every open tab — the keep-set for reconciling Monaco's model
 * registry against the tab list (models whose tab has closed get disposed).
 * Every tab is included regardless of kind: tabs that never materialize a
 * model (rich diffs render their own editor) just never match a registry
 * entry.
 */
export function collectLiveModelPaths(
  tabs: ReadonlyArray<{ id: string; path: string | null }>
): string[] {
  const uris = new Set<string>()
  for (const tab of tabs) {
    uris.add(buildMonacoModelPath(tab.path, tab.id))
  }
  return [...uris]
}

/** Release only models whose last open buffer closed, never a hidden scope. */
export function disposeClosedEditorModels(
  tracked: Set<string>,
  live: ReadonlySet<string>,
  getModel: (
    uri: string
  ) => { isAttachedToEditor: () => boolean; dispose: () => void } | null
): void {
  for (const uri of [...tracked]) {
    if (live.has(uri)) continue
    const model = getModel(uri)
    if (model?.isAttachedToEditor()) continue
    model?.dispose()
    tracked.delete(uri)
  }
}
