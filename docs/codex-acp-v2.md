# Codex ACP v2 and live insertion

The built-in Codex adapter is pinned to **2.3.0**. Its v2 prompt response
acknowledges acceptance; the session's idle state completes the host turn.
`src-tauri/src/acp/codex_v2.rs` translates v2 messages, tools, approvals,
configuration, history replay and terminal updates into the existing host schema.
Other agents keep their existing protocol path.

The host owns all accepted insertion work. A pending steer holds completion even
if the original turn becomes idle. A `startedNewTurn` response is already
consumed and is never resubmitted: the codec requires the subsequent running/idle
generation, then settles the original host request. Returning from an approval
is not a new generation. Cancellation stays attached through late fallback work;
late permission requests are declined and subsequent running work is cancelled.
Connection teardown fails outstanding work rather than reporting completion.

The connection loop polls steering requests alongside permission, update and
cancel commands. Queue dispatch cannot precede completion of accepted work.
Native insertion is gated by the actual adapter identity/version, advertised
steering support and the codec's lifecycle proof. A legacy adapter cannot supply
that proof itself. Legacy and Custom launch recipes retain their compatibility
path without claiming native insertion.

The normal and canvas composers enqueue by default during a response. Their
send menu offers insertion when the connected adapter proves support. Native
insertion does not depend on the optional tool-feedback switch. Drafts and
attachments remain in the composer or queue until consumption is known;
unknown delivery is held for review and never automatically resent. Matching
live user echoes are suppressed while replayed history and synthetic messages
remain visible.

## Checks

Codec tests cover prompt acceptance/idle ordering, turn-end races, consecutive
steers, cancellation, approval transitions, attachments, replay, error envelopes
and process exit. Connection-loop tests cover cancellation while a steer is
waiting. Frontend tests cover capability hydration, normal/canvas insertion,
attachments and queue ordering.

`scripts/probe-codex-v2.mjs` runs the real pinned adapter against a local Responses
server with an isolated Codex home. It verifies active insertion, idle fallback
and replay without using provider credentials. Set `CODEX_ACP_PROBE_ENTRY` to the
adapter's JavaScript entry (defaults to the fixture installation under
`scripts/fixtures/codex`; install with `npm ci --prefix scripts/fixtures/codex`), `ACP_TEST_ROOT` for evidence, and `PROBE_PORT` to override
13444. This wire probe complements host tests; it is not a desktop UI test.
