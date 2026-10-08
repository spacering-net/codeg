# Edit and resend user messages

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
- Local messages are matched to persisted users in order, from a verified
  history anchor. An unflushed repeated prompt cannot match an earlier copy.
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

The conversation-edit implementation was checked with TypeScript, changed-file ESLint, a Next.js
production static build, the full frontend suite (8,418 tests), and subsequent
focused frontend regressions (258 tests after review fixes). Both desktop and
server Rust `cargo check` passed. The Rust fork regression filter passed 69
tests, including strict boundary checks and existing fork/session transitions.

No installed application was replaced and no model-billed live conversation was
used for testing. Run the checkout using `pnpm tauri dev`, or build an installer
using `pnpm tauri build`; the configured hooks prepare the required sidecars.


## File restoration

The extension passed the desktop and server Rust checks, frontend production
build, TypeScript and changed-file ESLint. Focused frontend suites cover file
preview, conflicts, retained drafts, interrupted-restore recovery and all ten
locales. Strict Clippy reports four pre-existing warnings in unrelated modules;
the run allowing only `nonminimal_bool` and `collapsible_match` passes. The final
file-related Rust regression run passed 136 tests, including the DB-publication
handshake and nested-repository boundary regressions. The final UI/transport/i18n
run passed 56 tests (31 dialog, 6 transport, 19 locale).


Codeg captures a bounded before/after workspace checkpoint for each completed
Claude Code, Codex or DeepSeek prompt. It uses content-addressed byte snapshots
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

Coverage starts after this build is running. Old messages, canceled/failed turns,
mid-turn steering, overlapping turns and resource/resource-link payloads without
lossless transcript identity have no usable checkpoint. Retained messages inherited
by a fork currently keep no checkpoint lineage; new turns in that fork are captured.
Ordinary inline file references and image attachments remain supported.

Only regular workspace files are covered. Workspace `.gitignore`, Git internals,
nested repositories and common dependency/build directories are excluded.
Changes to nested repository boundaries invalidate coverage. Global
Git ignore configuration and `.git/info/exclude` are not used. A symlink, junction,
hard link, nonregular entry, non-UTF8 path, changed ignore policy or size overflow
makes the checkpoint unavailable instead of silently producing partial coverage.
Limits: 16 MiB/file, 128 MiB/snapshot, 20,000 files; 512 MiB of objects and 512 turn
records per canonical workspace. Quota exhaustion disables new coverage without
evicting existing records.

Snapshots are stored in `file-checkpoints/<workspace-hash>` under `CODEG_HOME`,
otherwise `CODEG_DATA_DIR` in server mode, otherwise `~/.codeg`. Each root has an OS
lock, hashed immutable objects, atomic metadata and a durable recovery journal.
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
