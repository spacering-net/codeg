# Edit and resend user messages

[English](edit-user-messages.md) | [简体中文](edit-user-messages.zh-CN.md)

User messages in connected Codex, Claude Code and DeepSeek conversations now
offer **Edit message**. **Save and resend** starts from the history immediately
before the selected message. The existing conversation row follows the edited
branch; the original full conversation remains available as a sibling.

The editor preserves text, file references and image attachments. Cancel leaves
the conversation and the main composer draft untouched. A failed request keeps
the edited draft. If the fork succeeds but the send fails, retry sends into the
same edited branch without forking again. By default workspace files stay unchanged.
Opt in to **Also restore files to before this message** to preview the checkpointed
file changes before saving.

## Implementation

- `acp_edit_fork` is a dedicated desktop/HTTP command. Older servers reject it
  instead of interpreting an unknown edit argument as an ordinary tail fork.
- The request names the expected session and includes the selected parsed user
  turn. The backend validates its ID, role, timestamp and content before acting.
- The first message opens a fresh session. Later messages fork at the preceding
  assistant boundary, then verify that the child contains exactly the retained
  prefix. The connection keeps its model/mode selectors and MCP configuration.
- Local messages carry durable client-message receipts bound to the exact
  preceding history, session and workspace. Provider text normalization is shared
  with the parsers. No timestamp window or text search chooses a target.
  Unflushed repeated prompts are ambiguous and require reloading native history.
  Patch preview positions derived from current files do not change the receipt.
- Switching the runtime history invalidates old fetches and clears old live,
  optimistic, background and metadata buffers together.
- Edited prompts include `expectedSessionId`; the prompt lock protects the
  destination check against concurrent session changes.

## Current boundaries

- Editing requires an idle owned connection, no pending local send and an empty
  send queue. Stop an active reply before editing.
- Exact historical forks require Claude ACP >= 0.75.1, Codex ACP >= 1.8.0 or
  DeepSeek ACP >= 0.8.0, with the provider advertising session/fork.
- Consecutive user messages, system boundaries, unavailable message identities
  and native forks that retain a larger agent turn are rejected with the draft
  retained. There is deliberately no fallback to the full old conversation.
- Missing attachment bytes must be recovered before resending.

## Validation

Validation commands and the opt-in real-adapter harness are included with this
change. The harness uses temporary workspaces and an in-memory Codeg database;
it does not replace the installed app. Native adapters use their existing auth
and leave their small test sessions in native history. Live runs consume model
usage, so they require both `--ignored` and `CODEG_MESSAGE_EDIT_LIVE=1`.

From `src-tauri`, compile/run the deterministic suite with
`cargo test --no-default-features --features server-bin --lib acp::`.
For the real providers, enable `CODEG_MESSAGE_EDIT_LIVE=1`,
`CODEG_MESSAGE_EDIT_LIVE_PROVIDERS=claude,codex`,
`CODEG_MESSAGE_EDIT_LIVE_RESTORE=1`, then run
`cargo test --no-default-features --features test-utils --test message_edit_live -- --ignored --test-threads=1 --nocapture`.
`CODEG_MESSAGE_EDIT_LIVE_CANCEL=1` additionally checks cancellation settlement,
file restoration, and 35 seconds without further writes after restoration.
The sanitized Claude fork-timestamp regression runs without live opt-in.

The full frontend suite passed 8,460 tests; subsequent receipt-normalization
regressions passed seven targeted tests and the final UI/identity/transport/i18n
run passed 84 tests. TypeScript, changed-file ESLint and the Next.js static build
passed. Complete frontend lint passed with LF checkout line endings as in CI.
Windows server library tests passed 4,635 tests
(including 1,867 ACP regressions) and Linux
checkpoint regressions passed 58 tests. Real Claude Code and Codex scenarios
verified durable identity, first/history edits, discarded context, original
history preservation, stale-session rejection/retry and exact file restoration.
The Codex cancellation scenario also passed: its native command settled after
about 31 seconds, restoration remained blocked meanwhile, both written files
were restored, and no new writes occurred during the 35-second observation.
macOS is covered by the existing CI matrix but was not executed locally. DeepSeek
was not exercised against a real model. Strict server Clippy passes with
`-D warnings`, without lint exceptions.
The desktop CI command `cargo clippy --all-targets --features test-utils -- -D warnings`
also passes. Four Tauri command boundaries have documented, local
`too_many_arguments` allowances to preserve the existing flat IPC payload;
all other reported findings were fixed. Sidecar build-script placeholders used
for these compile checks are not a packaged installer.

The debug-build capture benchmark is explicitly runnable via
`cargo test --no-default-features --features server-bin --lib capture_performance_reports_small_and_large_fixtures -- --ignored --nocapture`.
On this Windows host, 24 files/96 KiB took about 148 ms before and 82 ms after;
520 files/34 MiB took 4.36 s before and 3.93 s after with the benchmark's extended
budget. The latter exceeds the production two-second budget and would have
unavailable coverage. These are local debug timings, not a universal speed claim.

Run the checkout using `pnpm tauri dev`, or build an installer using
`pnpm tauri build`; the configured hooks prepare the required sidecars.


## File restoration

Checkpoint recording is disabled by default. Enable it in the edit dialog for
future Claude Code, Codex or DeepSeek prompts. Disabling recording keeps retained
coverage available for restoration. Status shows counts, storage and the latest
capture error; cleanup removes expired and abandoned records.

Codeg captures bounded before/after workspace checkpoints. It uses content-addressed byte snapshots
outside the workspace, without changing the Git index, HEAD or branch. An edited
message can restore the files before that prompt, including deleted files,
original dirty or untracked contents, binary bytes and file modes. Files newly
created during the selected turns are removed only if their contents still match.

Restoration is optional. Selecting the checkbox loads a file preview; conflicts
or missing coverage disable the combined action. The backend verifies the preview
token against fresh files before writing. Changes to affected files made between
turns or after the last checkpoint are rejected. Unaffected files are preserved.
These are snapshots of worktree changes during a turn; edits by an external editor
**during the same turn cannot be attributed separately**.

Normal sends remain parallel. Known overlapping turns in the same or nested
workspace invalidate their checkpoint coverage. Restores require no active
foreground/background work in overlapping Codeg connections and block new sends
for the duration of the operation. Do not run another Codeg process or external
writer against the same files during restoration; filesystem path checks do not
provide a sandbox against hostile concurrent OS modifications.

Coverage starts after recording is enabled. A canceled or failed turn can have
coverage once the native provider has actually settled and background work is idle.
Native shell cancellation may be delayed by the adapter. After a cancellation
response, the connection continues consuming background events and keeps restore
admission blocked until known background work settles and the event stream is
quiet for one second. Activity during the final capture rejects publication.
Waiting is bounded at two minutes; timeout or overlapping work leaves coverage
unavailable. This relies on the adapter reporting its native background work;
unreported external processes cannot be proven stopped by ACP.
Stopping before dispatch removes the unused checkpoint and receipt reservations.
Old messages, mid-turn steering, overlapping turns and resource/resource-link
payloads without lossless transcript identity have no usable checkpoint. Retained
messages inherit available checkpoint coverage on a successful edit fork.
Ordinary inline file references and image attachments remain supported.

Only regular workspace files are covered. Workspace `.gitignore`, Git internals,
nested repositories and common dependency/build directories are excluded.
Changes to nested repository boundaries invalidate coverage. Global
Git ignore configuration and `.git/info/exclude` are not used. A symlink, junction,
hard link, nonregular entry, non-UTF8 path, changed ignore policy or size overflow
makes the checkpoint unavailable instead of silently producing partial coverage.
Limits: 16 MiB/file, 128 MiB/snapshot, 20,000 files and 512 MiB of objects per
canonical workspace. Automatic collection retains up to 100 recent completed
turns, no older than 30 days, and evicts older coverage under quota pressure.
Copying a fork prefix temporarily allows up to 201 metadata records; cleanup or
the next capture restores the normal retention limit. Pending capture objects and
both sides of a recovery journal are protected from collection.

Before/after scans have separate two-second cooperative budgets. Stop cancels
preparation before dispatch. Oversized, slow or canceled scans report unavailable
coverage instead of a partial checkpoint; operating-system calls themselves cannot
be interrupted. Disabled recording never scans workspace file contents.

Snapshots are stored in `file-checkpoints/<workspace-hash>` under `CODEG_HOME`,
otherwise `CODEG_DATA_DIR` in server mode, otherwise `~/.codeg`. Each root has an OS
lock, hashed immutable objects, atomic metadata and a durable recovery journal.
The immutable restore plan is written once; a small transaction-bound progress
record advances before each file write. Failed transactions remove their tentative
inherited metadata. Legacy recovery journals remain readable.
The journal records the original/forked session and conversation row before writes.
If interrupted, **Recover interrupted restore** uses the database to distinguish
committed restoration from work needing compensation. Changed files or an ambiguous
conversation state are retained for manual reconciliation. After a successful fork
but failed resend, retry sends only; it does not restore files twice.

### Official references and scope

- [Claude Code checkpointing](https://code.claude.com/docs/en/checkpointing):
  checkpoints before prompts, optional code/conversation restoration, exclusions
  for Bash, most subagents, mid-turn messages and linked paths.
- [Claude Agent SDK file checkpointing](https://code.claude.com/docs/en/agent-sdk/file-checkpointing):
  `enableFileCheckpointing`, user-message UUIDs and `rewindFiles`; file restoration
  is separate from conversation rewind.
- [Codex App review](https://developers.openai.com/codex/app/review/): file/hunk
  revert actions are Git actions.
- [Codex app-server](https://developers.openai.com/codex/app-server/): conversation
  rollback is separate from file restoration.
- Historical official Codex [UndoTask](https://github.com/openai/codex/blob/rust-v0.104.0/codex-rs/core/src/tasks/undo.rs)
  and [ghost snapshots](https://github.com/openai/codex/blob/rust-v0.104.0/codex-rs/utils/git/src/ghost_commits.rs)
  informed the worktree-checkpoint approach. They are references to that tagged
  version, not a claim about current Codex App internals.

The installed ACP adapters expose no common file-rewind request. This implementation
adopts the official checkpoint semantics in Codeg itself; it does not modify their
packages or pretend to call a native rewind API. Workspace snapshots can include
shell-produced changes that Claude's tool-only checkpoints do not cover.
