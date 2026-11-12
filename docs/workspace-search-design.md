# Native workspace search

Search surfaces never enumerate an entire workspace in the renderer. The
desktop and HTTP commands rank natively and return at most 200 entries. The
ranking tiers, UTF-16 offsets, deterministic tie order, ignore rules and
authorized linked-directory behavior match the previous file search.

## Discovery belongs to a query

Mounting a composer or picker starts no discovery. The legacy prepare command
is a compatibility no-op. Empty queries return a bounded traversal prefix using
two listing permits, independently of index discovery and nonempty scoring.

Nonempty queries share a process-wide `IndexService`. A short-held registry
mutex protects an LRU of complete snapshots, in-progress discovery jobs, and
temporary failures. Traversal, file I/O and scoring run on blocking workers
outside this lock. Discovery has two permits, scoring four, and empty listings
two: one large discovery cannot block a small-root discovery or an empty
listing. Permit acquisition is cancellable and bounded by the query deadline.
There are no background jobs competing with foreground requests.

Queries for the same root attach to one discovery job. Each waiting query owns
a lease. Closing one consumer removes that lease without interrupting another
consumer. When the last leaves, the job lingers for three seconds: a picker
aborts its previous query on every keystroke before the debounced next one
arrives, and that query re-attaches instead of restarting the walk. If nobody
attaches within the linger, the discovery cancellation token is signalled.
Queued work exits without acquiring a permit. Running work checks cancellation
between entries and never publishes a partial snapshot. A cancelled worker
cannot publish over a newer job for the same root: publication checks the job
identity under the registry lock. Dropping an async search also drops its lease.

Consumer IDs and generations reject stale requests and handle cancellation that
arrives before its query. The consumer registry and failure backoff map are
bounded to 128 entries. A five-minute cooperative deadline covers admission,
discovery and scoring; the transport allows 330 seconds for the response.

## Multiple roots share total budgets

The LRU holds at most eight complete roots. Keys use the canonical workspace
path, current authorized link names/targets, and root/linked-root ignore-file
metadata. Aliases share a snapshot. Authorization and root-ignore changes select
a different snapshot immediately; a configuration change during discovery
invalidates that build. In a workspace that is open, file changes reach the
snapshot through its watcher (next section). Otherwise they become visible
after a five-minute TTL or explicit refresh. Refresh publishes only after a complete
successful discovery and does not move the timestamp on each query. A query
may instead pass `maxAgeMs`: the search dialog sends the time since it opened,
so each opening sees files as they are then (as the full re-list it replaced
did), while its later keystrokes reuse the snapshot the first one built.

Compact in-memory snapshots deduplicate basenames and store integer parent
references. All roots share a 128 MiB retained-index budget. Each of the two
discovery workers can use at most half the 192 MiB compact-builder budget,
including its interning table. The cache reserves space before publication.
Evicted snapshots still held by active queries remain charged until their final
lease drops, so eviction cannot admit more than the total budget. Admission
evicts only snapshots charged to the quota it needs: a disk reservation never
discards a warm memory index, nor a memory reservation a disk snapshot. When memory
admission is unavailable, the complete disk snapshot remains usable instead.

Scoring retains only top-k candidates. The compact scorer's basename memoization
is limited to 4,096 entries per worker, rather than allocating one score for
every unique name in every concurrent query. The limits describe index-owned
allocations; filesystem walkers, OS page cache, thread stacks and the app's other
subsystems have separate overhead and are not represented as a total RSS limit.

## Open workspaces stay current from file events

The workspace state stream already keeps one recursive watcher per open
workspace root. While it is live, it registers that root with search and
passes each debounced batch along, marking which paths were created, removed
or renamed. Content and metadata edits do not change the name list.

A snapshot whose discovery began while the watch was live is *covered*. Its
changed paths are re-read on a dedicated thread, in arrival order, with a walk
restricted to those paths and their ancestors. Descending through each
ancestor applies its ignore files exactly as a full walk would. A path below a
directory the walk does not enter (ignored, or skipped like `.git`) produces
no change, so build output and dependency installs in ignored trees cost
nothing. Each change becomes an overlay entry: a removed path hides itself and
its subtree in the snapshot, and an existing path is replaced by everything
visible at and below it now. Queries hide removed entries before they can take
a top-k slot and offer added entries after the snapshot. Re-reading is
idempotent, so a change seen twice is harmless.

Changes that arrive while a discovery walk runs are recorded on its job and
re-read once it publishes. If the walk itself sees one of the events below,
its waiters still get its result but it is not cached. A nested `.gitignore` or `.ignore` edit, a batch the
watcher overflowed or failed to deliver, a change log past 4,096 paths, or an
overlay past 20,000 entries drops the root's snapshot. The next query then
rebuilds it. Root ignore files are also part of the cache key.

A covered snapshot satisfies `refresh`/`maxAgeMs` without a rebuild and is
exempt from the five-minute TTL. It is still rebuilt 30 minutes after its walk
began. That longer TTL is a backstop for events a watcher loses without
reporting it: notify's Windows backend drops an overflowed change buffer
silently, inotify skips a new directory once the watch limit is reached, and
network filesystems report only local changes. When the workspace closes, its
watch ends. The snapshot is then treated as current up to that moment, minus
the stream's unflushed batch window, and the five-minute TTL starts from there.
Snapshots built without a live watch keep the plain TTL. Some dependencies are
outside what the watch can follow, so these roots are never covered:
- Roots with authorized linked directories, because link targets lie outside
  the watched tree.
- Roots whose walk applied a nested `.gitignore` or `.ignore` that is a
  symlink, because edits to the target raise no event for the link. A change
  that brings such a file in drops the snapshot instead. The LRU and the memory and disk budgets still bound every root, watched
or not. Overlays are bounded by their entry limit rather than charged to the
memory budget.

## Oversized roots reuse a complete disk snapshot

Discovery writes a length-prefixed binary snapshot in traversal order while
optionally building the compact memory index. Once the compact budget is
exhausted, it drops that builder and continues the same walk to disk. Every
entry remains searchable, including late/deep exact matches. There is no
full-workspace payload or fallback list allocated in the renderer.

The disk format contains UTF-8 basename/path lengths, directory kind and their
bytes. A query reads records in 64 KiB buffered pages and keeps only the best
matches. Independent positional-read cursors allow concurrent queries on one
snapshot without shared-seek races. No database dependency, migration, persistent
index directory or full-path array is needed.

All roots and active disk builds share a 2 GiB disk quota, with up to 1 GiB
reserved for each discovery. Successful snapshots shrink their reservation to
their actual bytes. LRU eviction releases ownership; active leases continue to
count until close. A record is capped at 1 MiB. Quota or I/O failure yields an
error and a five-second retry backoff. It never publishes an incomplete index or
silently rescans the filesystem for each keystroke after a failed build.

Snapshots use `tempfile::tempfile`: unlinked at creation on Unix and
delete-on-close on Windows. Cancellation, construction errors, eviction and
process exit close them automatically, including abrupt termination without an
application-managed stale-file sweep. Successful compact-index publication
closes the temporary disk copy as well.

Disk scoring remains O(N) in snapshot records; initial discovery still walks
the filesystem. This change removes repeated filesystem discovery within the
TTL and bounds retained data, rather than claiming constant-time search in
multi-million-entry workspaces. Incremental updates and a secondary text index
can be evaluated separately using measured latency.

## UI lifecycle

Keyboard and pointer navigation pin the suggestion group. Selection follows
reference identity across progressive updates, with a valid fallback after
deletion. Delayed file results cannot turn a selected session into a file or
invalidate Enter. Focus clears lazy session/commit caches for the next query
while keeping the current in-flight search valid.

Picker closure, root changes, newer typing and hook unmount abort queries.
Frontend state retains only the current bounded results; the previous
keystroke's results stay visible, re-ranked locally, until the next response
lands, and only a workspace switch clears them. There is no
Array.at dependency beyond the project's ES2020 target.

## Regression coverage

`workspace_file_search/index_cache/tests.rs` uses independent services and
controlled workers, including:

- A blocked large-root discovery while a small-root query and empty listing
  complete, plus empty listing with both discovery permits held.
- Same-root coalescing, one of two consumers closing, last-consumer and queued
  cancellation, dropped queries, deadlines, and cancelled old-generation
  completion racing its successor.
- A -> B -> A reuse, canonical aliases, authorization changes, ignore metadata,
  TTL, refresh and LRU eviction.
- Tiny forced memory budgets with complete late matches from disk, one walk
  across repeated queries, and concurrent positional reads.
- Memory and disk quotas with active evicted leases, disk overflow cleanup,
  retry backoff, cancelled disk scoring, Unicode/path ranking and stable ties.
- Watched snapshots following creates, deletes and directory renames without
  a rewalk, in memory and on disk; churn under ignored trees; nested ignore
  edits and lost events forcing a rebuild; changes during a walk replayed onto
  its result; and coverage only for watches live for the whole walk, ending
  when the watch stops.

The frontend tests cover bounded/cancelled transport requests, no eager
prewarm, picker closure, delayed groups, selection reorder/deletion and focus.
An ignored `large_workspace_memory_probe` can be run with
`CODEG_MEMORY_WORKSPACE` to report counts, response bytes, memory/disk accounting,
walk counts and query timings without printing workspace filenames.
