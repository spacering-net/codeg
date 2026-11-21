# `/btw` side conversations

A `/btw` command forks the current conversation at its settled history, asks a
side question in the fork while the parent keeps running, and gives the fork
two endings: destroy it, or promote it into a normal conversation. The pattern
comes from OpenChamber (see
`packages/ui/src/lib/btw.ts` in openchamber/openchamber); this design
re-derives it for Codeg's data model and drops the parts that Codeg does not
need.

## Why this is cheap in Codeg

OpenChamber builds btw on four OpenCode engine primitives: session fork,
session metadata, synthetic message parts, and delete. Codeg already has an
equivalent for each:

| Need | Codeg today |
| --- | --- |
| Fork | ACP `session/fork` (`acp/fork.rs`), already wired to a Rust command and the UI |
| btw marking | `ConversationKind` enum (the unused `loop` value is the precedent for adding one) |
| Hidden context injected into a prompt | internal frames in `acp/agent_mentions.rs`: appended on send, stripped on render |
| Parent↔fork link | `parent_id` column + the delegate conversation tree |
| UI dock under the composer | `ComposerDockStrip`; sidebar kind-driven grouping |

Two OpenChamber mechanisms disappear outright. The boundary message id (which
trims inherited history out of the fork's visible transcript) is unnecessary
because Codeg renders a conversation from its own native transcript, and the
inherited history never enters the fork's file. Promote/destroy become single
field updates in one transaction instead of metadata patches with rollback
compensation.

## Behavior

### Creating

1. The user types `/btw <question>` (or uses the selection menu entry, phase 2).
   The command is registered locally — Codeg synthesizes it into the
   advertised-command list and the composer intercepts it before send; it must
   never reach the agent as a prompt.
2. The backend runs one path, identical for every agent: call `session/fork`
   with no fork point (tail fork), insert a child conversation row
   (`kind = btw`, `parent_id` = parent, `folder_id` = parent's), open its ACP
   connection, and send the first message: the btw boundary instruction
   (internal frame, adapted from OpenChamber's `BTW_BOUNDARY_INSTRUCTION`)
   plus the question. The title is `btw: <question>`, truncated.
3. The fork copies whatever the engine has settled at that instant. No
   in-flight snapshot is taken and no fork point is pinned: an in-progress
   turn's streamed assistant content is never in the copy, and on claude and
   opencode the in-progress turn's user message and finished items may be.
   This drift is accepted; the boundary instruction's "inherited history is
   reference only, do not continue any task in it" already covers the
   misreading risk, including a copy that ends on a tool_use without a result.

### The panel

The fork is a real conversation, so phase 1 does not build a custom transcript
renderer:

- A `btw` dock strip (new `info` tone on `ComposerDockStrip`) lives under the
  composer while the parent has an active fork: question, state
  (starting/answering/done/failed), dismiss affordance. Collapse returns the
  composer to the parent; the strip yields its slot to blocking parent
  permission and question cards, so the parent never waits on an invisible
  panel.
- Clicking the strip opens the fork in the ordinary conversation detail view,
  with a breadcrumb back to the parent. The view already streams, already
  routes permissions, and already needs no new states.

### The sidebar `btw` group

Each folder gets a virtual group, shown only while it has members: every
`kind = btw` conversation in that folder, newest first, each row offering
promote and destroy. Collapse state persists with the other sidebar UI
settings. The group replaces per-parent nesting: a btw belongs to the folder
in the user's mental model, and multiple concurrent btws (one per parent, or
several from the same parent) need no special case.

### Endings

- **Destroy**: delete the conversation row, close its connection, clear the
  parent's panel state. The parent is untouched.
- **Promote**: one transaction sets `kind = regular` and clears `parent_id`;
  the row moves out of the btw group into the normal list on its own. The
  connection injects a one-shot promotion notice (OpenChamber's
  `BTW_PROMOTION_NOTICE` wording, adapted) as an internal frame on the next
  user message, so the model learns the btw constraints are lifted.

### Failure policy

`session/fork` failing or the new connection failing to start leaves the strip
in a failed state with a retry; the parent is never touched (fork happens
before any parent-side write). A retry after the parent's current turn
completes is the fallback for whatever an adapter turns out to reject
mid-stream.

## Engine behavior (source-verified, 2026-11)

| Agent | `session/fork` mid-turn | Copy boundary |
| --- | --- | --- |
| Codex (codex-acp) | accepted, no guard | turn-granular: `lastTurnId`, in-progress turn excluded entirely |
| Claude (claude-agent-acp) | accepted, no guard | entry-granular: persisted JSONL prefix; fork point on an unsettled message → `-32602` |
| OpenCode (ACP mode) | accepted, no guard | max seq at the instant; `cursorId`/`before` not handled (tail only) |

The ACP spec deliberately leaves mid-turn fork to implementations (the same
schema specifies archive-while-active rules and says nothing for fork). Codeg's
`supports_fork` gate already reads `sessionCapabilities.fork` from
`initialize`, so each agent opt-in is negotiated at runtime.

## Out of scope for phase 1

- The floating mini-panel overlay (sub-agent-overlay family) embedding a
  lightweight transcript and an input box, so follow-up questions never leave
  the parent view. Phase 2.
- Steering into a btw conversation. The side question tolerates slow; the
  queue-and-steer machinery is a bad fit for its first use.
- OpenCode builds whose ACP predates fork: the snapshot-delegation variant
  (compose a text summary from the parser, send into a fresh child) is the
  designed fallback, gated on what version Codeg ships against.

## Verification before implementation

1. A manual claude test forking while a tool call executes, the case the ACP
   session-cursors RFD itself leaves open; if a trailing unresolved tool_use
   misleads the model, fix it with one added line in the boundary instruction.
2. Cold-start timing of the forked session per agent (claude's
   post-fork `session/load` is ~1.9 s on current versions), to set the strip's
   `starting` affordances.
3. The bundled OpenCode ACP's actual fork support (upstream dev exposes it;
   check the pinned build).

Scope estimate: 6–7 person-days for phase 1 (migration 0.5, copy-fork
orchestration 2, promote/destroy 0.5, command injection 0.5, sidebar group
1–1.5, strip and detail-view reuse 1, i18n and tests 1).
