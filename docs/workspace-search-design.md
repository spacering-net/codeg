# Workspace search: scheduling and cache revision (proposal)

This is the fourth, **draft** split of #1097. The current compact native index,
query cancellation, server/desktop APIs, and bounded result transfer remain here
for review. This branch is not ready to merge or install. The single-root cache
and traversal under a global mutex are still present; the proposed replacement
below must land and pass the acceptance tests before this PR becomes ready.
The WebKit, Tauri callback, and highlighting splits are independent of this work.

## Current experiment: no eager discovery

The 0.42.2 experiment initially included only the other three splits. It still
issued full `list_workspace_files` requests when composers mounted. An isolated
read-only client issued eight of those requests during startup; a previous
measurement of the user's workspace counted 5,308,089 entries and a 970,417,831
byte response. That path is sufficient to multiply gigabytes of path strings
and objects across composers.

The experimental integration now uses this draft's bounded native queries.
Mounting a composer or picker never schedules a prewarm. The legacy prepare
endpoint is a no-op for compatibility; only an actual query owns a discovery
and cancellation token. Closed search dialogs do not request results.

This removes eager full-workspace payloads from the renderer. It does not
resolve this draft's remaining single-root cache, global query admission, or
repeated over-budget traversal issues. Those remain merge blockers. Reintroduce
background prewarming only after the lifecycle/scheduling design below is
implemented and validated.

## Foreground work must not wait for background traversal

Separate the short-held cache/registry mutex from traversal and scoring. The
registry holds per-canonical-root state and shared immutable snapshots; a worker
never retains its mutex while touching the filesystem. Canonical roots include
the authorized linked-root/ignore configuration in their cache identity.

Use a dispatcher with at most two discovery workers: one foreground-reserved
slot and one shared slot. Admit at most one background prewarm, and preempt its
cancellation token when foreground discovery needs capacity. Empty queries only
read and return a bounded top-level listing; they do not wait for a full index.
Scoring an already built snapshot does not wait for discovery admission.
Coalesce discovery for the same root. Queries attach to that root's discovery,
while cancellation removes only that consumer; it cancels the traversal when
no consumer or explicit retained refresh remains. A small-root foreground query
can proceed even while a large root is being prepared.

Preemption can discard an incomplete snapshot. Only successful, complete walks
are published. Worker completion must verify the root generation before updating
the registry, so a late cancelled build cannot replace a newer snapshot. Keep
cancellation/deadline checks in discovery and scoring, and cancel queued jobs
before acquiring a worker permit.

## Prewarm belongs to a visible consumer

Give prepare requests the same consumer ID/generation contract as queries, plus
a dedicated prepare cancellation endpoint for desktop and server modes. The
file picker and mention panel own an AbortController for their prepare lifecycle;
close, disable, unmount, root change, or a new generation detaches it. A consumer
query can promote an existing prewarm to foreground rather than repeat its walk.
Use bounded registry tombstones to reject a cancelled request that arrives late.
Prewarm is an optimization and must never outlive all of its consumers.

## Reuse roots within one global budget

Replace the single cache slot with an LRU of snapshots keyed by canonical root.
Retain at most 128 MiB across **all** root snapshots and at most eight roots; do
not assign 128 MiB to each root. Include deduplicated strings, node arrays, and
metadata in accounting. Queries hold an Arc lease; eviction removes its cache
ownership, while active leases continue counting against the process-wide
budget until released. Budget reservations therefore precede construction, not
only publication. Cap simultaneous discovery allocations globally at 192 MiB
and bound foreground scoring scratch space by result limit.

A -> B -> A within the TTL should reuse both complete snapshots if they fit the
total budget. Refresh timestamps change only after a real successful discovery,
not after fallback queries. Root/config invalidation creates a new generation;
stale refresh results cannot overwrite it. Disk and memory expiry are explicit.

## Oversized roots reuse a disk snapshot

While walking, incrementally write a temporary SQLite snapshot (rusqlite is
already a dependency). Keep a compact memory index only while its reservation
permits. When the memory builder reaches its share of the global build budget,
drop that builder and continue the same discovery into the disk snapshot. This
produces complete results without rescanning the filesystem on each keystroke.
Publish the disk snapshot atomically only on successful completion. Bind its
temporary-file lifetime to the snapshot lease and remove abandoned files on
startup. Use a bounded global SQLite page cache and a disk quota/LRU as well;
never convert a disk result into a full renderer-side file list.

Repeated oversized-root queries scan the cached rows in bounded pages and keep
only top-k scores. They remain cancellable between pages. This still has O(N)
scoring cost, which should be measured; it removes repeated filesystem discovery
and bounds retained RAM. If disk quota/storage prevents a complete snapshot,
return a retriable index-unavailable error with backoff, rather than marking a
partial tree complete or silently restarting a full walk for every keypress.
Incremental updates and a trigram index can be evaluated later if measurements
justify them.

## UI regressions fixed in this draft

Keyboard and pointer navigation pin the active suggestion group. Selection
tracks reference identity within that group across progressive updates, with a
valid fallback when an item is removed. Delayed file arrival cannot reinterpret
a selected session as a file or invalidate Enter. Window focus invalidates the
lazy session/commit caches for the next query while keeping the valid current
request alive. The ES2020 test helper no longer uses Array.at.

## Required acceptance before marking ready

- Block a large root's prewarm inside discovery; a small-root foreground and an
  empty listing must complete before that block is released.
- Close the only consumer during queued and active prewarm. Assert cancellation,
  no partial snapshot publication, no stale event delivery, and released permits.
  With two consumers, closing one must preserve the other's work.
- Query A, B, A; count one discovery per root, including root aliases/config
  changes and LRU eviction. Assert the *total* retained and active-lease budgets.
- Force the memory budget small; issue several oversized-root queries and assert
  one filesystem walk, complete late-file matches, bounded SQLite/cache memory,
  cancellation during scoring, and temporary-file cleanup on failure/eviction.
- Race cancellation, root change, foreground promotion, and TTL refresh; verify
  registry generations and no starvation. Instrument queue time separately from
  discovery/scoring time for a realistic large workspace.
- Keep the keyboard progressive-result and window-focus regressions green.
  Run full TypeScript including tests, ESLint, Vitest, production build, and
  desktop/server Rust checks/tests/clippy against the final implementation.

The remaining backend design/implementation is a merge blocker **only for this
draft**. The other three split PRs can be reviewed and released independently.
