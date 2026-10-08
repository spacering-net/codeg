# Edit and resend user messages

User messages in connected Codex, Claude Code and DeepSeek conversations now
offer **Edit message**. **Save and resend** starts from the history immediately
before the selected message. The existing conversation row follows the edited
branch; the original full conversation remains available as a sibling.

The editor preserves text, file references and image attachments. Cancel leaves
the conversation and the main composer draft untouched. A failed request keeps
the edited draft. If the fork succeeds but the send fails, retry sends into the
same edited branch without forking again. Workspace files are not reverted.

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

The implementation was checked with TypeScript, changed-file ESLint, a Next.js
production static build, the full frontend suite (8,418 tests), and subsequent
focused frontend regressions (258 tests after review fixes). Both desktop and
server Rust `cargo check` passed. The Rust fork regression filter passed 69
tests, including strict boundary checks and existing fork/session transitions.

No installed application was replaced and no model-billed live conversation was
used for testing. Run the checkout using `pnpm tauri dev`, or build an installer
using `pnpm tauri build`; the configured hooks prepare the required sidecars.
