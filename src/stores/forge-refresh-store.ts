import { create } from "zustand"

/**
 * The forge page's reload button sits in the WINDOW CHROME — the top-right
 * cluster, immediately left of the settings gear (see
 * `WORKBENCH_ROUTE_CHROME_ACTIONS`) — while the fetch it triggers lives in the
 * page. Those are two different branches of the tree with no shared provider
 * between them, so the page publishes its handler here on mount and withdraws
 * it on unmount, and the button reads it.
 *
 * A store rather than a window event because the button needs BOTH directions.
 * An event carries "reload now" downwards perfectly well, but nothing comes
 * back — and without "there is nothing to reload yet" and "a reload is already
 * running" the button would enable itself over a folder with no remote and
 * never spin while it worked.
 */
interface ForgeRefreshState {
  /** Non-null only while a mounted forge page has a repository to reload. */
  refresh: (() => void) | null
  /** A fetch is in flight: the button is spinning and must not stack another. */
  busy: boolean
  publish: (next: { refresh: (() => void) | null; busy: boolean }) => void
  withdraw: () => void
}

export const useForgeRefreshStore = create<ForgeRefreshState>((set) => ({
  refresh: null,
  busy: false,
  publish: (next) =>
    set((s) => (s.refresh === next.refresh && s.busy === next.busy ? s : next)),
  withdraw: () =>
    set((s) =>
      s.refresh == null && !s.busy ? s : { refresh: null, busy: false }
    ),
}))
