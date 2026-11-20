# Frontend memory diagnostics

These diagnostics require both the Rust `memory-diagnostics` feature and
`NEXT_PUBLIC_CODEG_MEMORY_DIAGNOSTICS=1` at frontend build time. Regular builds
create no renderer diagnostic timer/listener or native control store. The
renderer reports only in local desktop mode, through the local shell transport.

`GET /api/debug/frontend_memory` returns bounded, expiring numeric reports and
separate native app-command route counters. It does not measure physical
footprint, retained bytes, all IPC traffic, or a heap ownership graph. Weak
representative survival alone does not establish a leak.

## Runtime experiment controls

The authenticated `/api/debug/frontend_memory/control` endpoint supports:

- `GET`: `{ enabled, control, acknowledgements }`.
- `POST`: `{ reportingEnabled, browserCountersEnabled, sampleOnce? }`.
  The response is the desired control with a backend-assigned monotonic `epoch`
  and `sampleSequence`. Unknown fields and non-boolean requests are rejected.

The local desktop commands are `get_frontend_memory_control`,
`set_frontend_memory_control` (argument `{ request }`), and the reporter's
`ack_frontend_memory_control` (argument `{ ack }`). A disabled Rust build rejects
all three commands and the HTTP setter. Its HTTP snapshot has `enabled: false`,
`control: null`, and no acknowledgements.

Controls affect diagnostic work only:

- `reportingEnabled: false` skips periodic sampling and sending. The existing
  timer, provider/lifetime registrations, DOM mutation observer, and activity
  instrumentation remain installed, keeping those factors constant.
- `browserCountersEnabled: false` skips the optional browser reader. Legacy
  provider, iframe, document-state and activity counters retain their meanings.
- `sampleOnce: true` requests one explicit numeric sample, including while
  periodic reporting is paused. It does not restart periodic reporting. Each
  setter increments `epoch`; only an explicit sample increments `sampleSequence`.

The renderer subscribes before reading the initial control, ignores older
epochs, and waits for any existing report to settle before acknowledging a
mode. A failed registration/read leaves periodic reporting inactive. A failed
explicit sample produces no completion acknowledgement. A new setter can retry
through a newer epoch. Navigation releases the timer, listener and observer;
a subscription resolving after cleanup is immediately released. Persisted
`pagehide` preserves them for the back/forward cache.

**A successful setter is not evidence that the renderer applied the change.**
Save the intended control and an acknowledgement for the same ephemeral reporter
and epoch before attributing an observation phase. An acknowledgement records
`appliedAtMs` and native `receivedAtMs`. `sampledEpoch` and `sampleStartedAtMs`
identify the actual last successful explicit sample, so a later mode change
cannot relabel an older in-flight sample. A rapid series of controls is
coalesced to the latest desired mode; intermediate epochs need not be applied.

Native acknowledgement storage keeps one latest entry per reporter, at most
16 reporters, with a five-minute monotonic expiry. Old acknowledgements can
therefore remain visible after a setter; match the epoch explicitly. Paused
metric reports keep their original receipt time and expire normally. They are
not replaced with fresh zeros, and their absence cannot establish continuous
UI or session state during the pause.

Control state is process memory only and resets on restart. It performs no
database or session writes. Renderer wall timestamps and native receipt times
are separate from an external physical-footprint observation window. Record
actual process/build identity, sampling gaps, intervention times, user activity
and window visibility when interpreting trends. These controls neither invoke
GC nor create a heap snapshot or artificial memory pressure.
