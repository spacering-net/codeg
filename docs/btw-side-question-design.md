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
because a btw transcript showing the history up to the fork point is the
feature, not a bug — that is what the side question is asked against. How the
history gets there differs per engine and needs no shared bookkeeping:
claude's fork copies the persisted JSONL prefix into the child's own file,
and codex's child rollout carries a `forked_from_id` reference the parser
follows back to the cut (`CodexParser`, tested by
`a_by_reference_fork_inherits_the_parent_history_up_to_the_cut`); either way
the ordinary detail path renders it. Promote/destroy become single field
updates in one transaction instead of metadata patches with rollback
compensation.

## Behavior

### Creating

1. The user types `/btw <question>`. The command is registered locally: where
   the agent supports it, Codeg synthesizes a `btw` row into the advertised-
   command list carrying a `client: true` flag, and the composer's menu shows
   it (description localized client-side). The intercept fires on that flag,
   not on the name — an agent advertising its own native `btw` wins the name
   and keeps receiving the prompt. The intercept also skips drafts carrying
   anything but text (the fork request has nowhere to put an attachment) and
   ignores Enter presses while a fork is still in flight, so one question
   makes one fork.
2. The backend (`commands/btw.rs`, RPC `POST /api/btw_create`) runs one path,
   identical for every agent: verify the named connection is live, serves the
   named parent conversation (a web caller passing two unrelated ids must not
   get one conversation's history parented under another's row), and is gated
   `fork && resume`; call `session/fork` with no fork point (tail fork),
   insert a child conversation row
   (`kind = btw`, `parent_id` = parent, `folder_id` = parent's), open its ACP
   connection, and send the question with an internal frame identifying the
   copied history as context. The side conversation uses the ordinary tools,
   delegation, and workspace permissions. The title is `btw: <question>`, truncated.
3. The fork copies whatever the engine has settled at that instant. No
   in-flight snapshot is taken and no fork point is pinned: an in-progress
   turn's streamed assistant content is never in the copy, and on claude and
   opencode the in-progress turn's user message and finished items may be.
   The user's requests in the side conversation direct the work. They can
   ask the agent to continue a task from the copied history.
   The fork RPC runs on a spawned task inside the parent's connection, so the
   parent's event pump never stalls for it — a streaming answer keeps
   forwarding tokens while the side question forks.

### The panel

Sending a side question opens the fork in the existing Ask drawer. If the
drawer is holding an unsent question, the fork opens in a conversation tab.

### The sidebar `btw` group

One global group between Chat and Recent, shown only while it has members:
every `kind = btw` conversation, newest first, each row offering promote and
destroy. It is not per-folder: the row is found by its question, and the
parent is one click away from the strip or the row itself; folder filters
and counts leave btw rows alone (they never render inside a folder's list).
Collapse state persists with the other sidebar UI settings. The group
replaces per-parent nesting: multiple concurrent btws (one per parent, or
several from the same parent) need no special case.

### Endings

- **Destroy**: delete the conversation row, close its connection, clear the
  parent's panel state. The parent is untouched.
- **Promote**: one transaction sets `kind = regular` and clears `parent_id`
  and arms `btw_promoted` (migration `m20261121_000001_conversation_btw_promoted`).
  The row moves out of the btw group into the normal list on its own. The
  next user message carries the current side-session instructions once.
  The upgrade also sets this flag on existing side conversations to replace
  the older instructions.

### Failure policy

A btw that cannot be made is erased: every failing step after the row exists
disconnects the child and soft-deletes the row (so no half-dead entry sits in
the section), and the composer reports the error as a toast while the question
stays in the input — asking again IS the retry. The parent is never touched
(fork happens before any parent-side write). A retry after the parent's
current turn completes is the fallback for whatever an adapter turns out to
reject mid-stream.

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
   misleads the model, update the instruction identifying the copied history.
2. Cold-start timing of the forked session per agent (claude's
   post-fork `session/load` is ~1.9 s on current versions), to set the strip's
   `starting` affordances.
3. The bundled OpenCode ACP's actual fork support (upstream dev exposes it;
   check the pinned build).

Scope estimate: 6–7 person-days for phase 1 (migration 0.5, copy-fork
orchestration 2, promote/destroy 0.5, command injection 0.5, sidebar group
1–1.5, strip and detail-view reuse 1, i18n and tests 1).
