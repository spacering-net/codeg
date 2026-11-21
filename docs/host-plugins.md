# Codeg host plugins

Codeg installs plugins on the host that owns the workspace. A local desktop,
its embedded Web Service, and a standalone server each expose a plugin catalog
through the same API. A remote desktop window reads the catalog from the
server it is connected to.

## Version 1 extension points

| Contribution | Placement | Contract |
| --- | --- | --- |
| `workspacePanels` | Plugins tab in the right workspace panel | Codeg renders a named view for the active workspace. Version 1 supports `text` with a plain `text` field and `turnActivity` with the turn hook. |
| `commands` | Workspace quick actions | A user-selected command opens a panel owned by the same plugin. |
| `hooks` | Codeg-managed ACP sessions | `session.turnCompleted` can record completion metadata for a workspace panel. |

The manifest is declarative. The host validates identifiers and panel
references before installation. Plugins can use the views, actions and events
declared for the current API version. Disabling or removing a plugin withdraws
its contributions and discards its in-memory data. Other connected clients
receive a catalog change notification.

The turn activity view collects completion time, agent type and stop reason
for active workspace sessions while the plugin is enabled. It retains the most
recent 128 records per plugin and starts empty after a host restart. Events come
from the live ACP event bus, so records are for display and carry no delivery
guarantee. Rendered text and command labels are plain text. The command runs
only when selected by the user.

See the [turn activity manifest](../examples/plugins/turn-activity/codeg-plugin.json)
for a complete example. Import it in **Settings → Plugins**, then enable it.
Open a workspace in Codeg to use the panel and command.

## Version 2 server modules

Install the [Workspace Summary example](../examples/plugins/workspace-summary)
using its directory on the connected host. Enable it, then run **Show Workspace
Summary** from workspace quick actions. Its panel displays text returned by the
plugin's JavaScript module.

Set `apiVersion` to `2` and declare `server.entry` and `server.methods` in
`codeg-plugin.json`. Bundle dependencies into one UTF-8 `.mjs` file of up to
256 KiB next to the manifest. The entry name uses lowercase letters, digits,
dashes and dots, starting with a letter. Export `handle(method, input)` and
return a JSON value or a promise that resolves to a JSON value. Codeg calls
only declared methods of enabled plugins. A `serverText` workspace panel
passes `{ folderId }` to its registered method and displays the returned
string as plain text.

Declare `server.rpc` to give public methods an input and output contract. Its
keys name methods from `server.methods`. Each value has `input` and `output`
JSON Schemas. Codeg validates the request before running the handler and
validates the handler result before returning it. References to definitions in
the same schema are supported. Methods without a schema continue to accept and
return JSON. The Workspace Summary example requires an integer `folderId` and
returns a string.

Each call runs in a fresh QuickJS context on the connected host. The context
provides ECMAScript built-ins. Files, processes, network requests, external
imports and Codeg credentials are unavailable. Calls have a 500 ms execution
budget, a 16 MiB engine memory limit and a 64 KiB limit per JSON message.
The host serves up to four concurrent module calls. Choose trusted sources
when installing modules.

Source review captures the module alongside its validated manifest. Confirming
installs that same snapshot, and editing the source directory afterwards has
no effect until an update. An update that changes the server entry, declared
methods or module contents disables a running plugin. Review the new version
before enabling it again.

## Client modules

The [Workspace Inspector example](../examples/plugins/workspace-inspector)
provides its own workspace and plugin settings panels. Install the example
directory on the connected host and enable it. Use **Show Workspace Inspector**
in workspace quick actions or open **About Workspace Inspector** on its row in
**Settings → Plugins**.

For a version 2 client contribution, set `client.entry` to a self-contained
HTML file next to `codeg-plugin.json`. Use a lowercase `.html` filename and keep
the file under 256 KiB. Set a workspace panel's `view` to `client`, or declare
`contributes.settingsPanel` with an ID and title. Both surfaces can use the
same client entry. The installation preview identifies the client file and
captures it in the reviewed snapshot. Changing the client file or its entry
on update requires re-enabling the plugin.

The client runs in a sandboxed frame with an opaque origin. Inline scripts,
inline styles, and data or blob images are available. The frame's content policy
blocks external resource loads. `window.codeg.ready` resolves with `type`, the
contribution `id`, the app `locale` and, for a workspace panel, `folderId`.
`window.codeg.call(method, input)` calls a declared server method on the same
plugin and connected host. `input` and the result use JSON. Codeg disconnects
the message port when the contribution closes or is disabled.

Declare `contributes.clientSurfaces` to add entries to the session header or
composer. Each entry has a unique `id`, a `title`, and `slot` set to
`sessionHeader` or `composer`. When a user opens the contribution,
`window.codeg.ready` resolves with `type: "clientSurface"`, the selected `slot`,
`folderId` if the session belongs to a workspace, and `conversationId` once
the conversation has been saved. The Workspace Inspector example declares one
entry in each slot.

## Persist plugin settings

Declare `settings` with a positive integer `version`, a JSON Schema whose root
has `type: "object"`, and a `defaults` object that satisfies that schema. Codeg
keeps one value per installed plugin on the connected host. Values may contain
up to 16 KiB of JSON. Schema references resolve within the supplied schema.

`await window.codeg.settings.read()` gives `{ version, revision, value }`.
Save an edited copy with `await window.codeg.settings.save(revision, value)`.
If another client saved first, read the latest revision and apply the edit to
that value. Server methods get the active settings as the third argument to
`handle(method, input, settings)`.

Increase `settings.version` when changing the shape. When the stored value
satisfies the new schema, Codeg can keep it directly. To transform an older
value, declare `settings.migrate: true` and handle `settings.migrate` in the
server entry. The method receives `{ fromVersion, toVersion, value }`. Return
the replacement settings object. Codeg calls the migration when the user
enables the update, then validates and stores the result together with
enablement. If it fails, the original value stays available for a later retry.

## Workspace lifecycle hooks

Declare `contributes.lifecycleHooks` as a list of `{ event, method }` entries.
The server entry receives these private methods through `handle`. Keep hook
methods out of `server.methods`. Use the [lifecycle TypeScript declarations](host-plugin-lifecycle.d.ts)
to type a handler and its result before bundling your server entry.

| Event | Input | Effect |
| --- | --- | --- |
| `workspace.open.before` | `{ path }` | Runs when a user opens by path. Return `null` to keep the path, or `{ path }` with an absolute replacement. |
| `workspace.open.after` | `{ folderId, path }` | Observes a completed open by path or reopening a saved folder by ID. |
| `workspace.close.after` | `{ folderId }` | Observes removing an open folder from the workspace. |
| `workspace.create.before` | `{ path }` | For a path first registered through the workspace UI, after `workspace.open.before`. Return `null` or an absolute replacement `{ path }`. |
| `workspace.create.after` | `{ folderId, path, name, parentId }` | Observes the first registration of a workspace, including closed workspaces and worktrees registered by CLI runs or delegated agents. |
| `workspace.archive.after` | `{ folderId, path, name, parentId }` | Observes removing the saved workspace record from history or archiving it through worktree cleanup. |

The host applies before hooks in plugin ID order and uses each replacement as
the next hook's input. An error, invalid response or timeout stops the open.
The create transformation runs when the path returned by the open hooks has
no saved workspace ID. A worktree is registered at the checkout's actual path.
Reopening a saved or previously archived folder reuses its workspace ID.
Closing a workspace keeps the record available in history.
After hooks run asynchronously. Return a JSON value to publish it to that
plugin's open client surfaces, or `null` to skip publishing. Subscribe with
`window.codeg.events.subscribe(({ event, folderId, data }) => { … })`. The call
returns an unsubscribe function. A workspace client surface receives events for
its own folder. The stream delivers live events without replay.

Install the [Workspace Lifecycle example](../examples/plugins/workspace-lifecycle)
and open its **Workspace Events** settings panel. Open or close a folder in a
second Codeg window connected to the same host to see the events. Opening
`workspace-alias` by path opens the sibling `workspace-real` directory.
For a first registration, the same example maps `workspace-create-alias` to
`workspace-real` in `workspace.create.before`.

## Worktree lifecycle hooks

Register `worktree.create.before` to choose the destination for a new worktree.
Codeg awaits the hook before creating the checkout for workspace actions,
per-run automations, work tasks, and CLI runs. Return `null` to keep the
proposed path or `{ path }` with a new absolute path. The destination must be
unused and outside Git metadata. Codeg runs enabled handlers in plugin ID
order. A handler error, invalid destination, or timeout aborts creation.
The source, branch and base commit come from the original operation.

The Workspace Lifecycle example places a path ending in `-request` at the
corresponding `-checkout` path. Clients calling `git_worktree_add` directly
can set `allowPluginDestination: true` and use the returned path for workspace
registration. The older request shape retains the requested path and `null`
response.

Declare `worktree.create.after` to observe new checkouts made through the
desktop or Web workspace, per-run automations, work tasks, or `codeg-cli run
--worktree`. Recreating a task checkout from its saved branch also emits this
event. Declare `worktree.archive.after` to observe removals from the workspace
or task cleanup and the checkout removed after a failed CLI launch.

All three hooks receive `{ folderId, repositoryPath, path, branch, origin }`.
`folderId` identifies the owning project when known. `path` is the proposed or
actual checkout path, `branch` may be `null`, and `origin` is `workspace`,
`automation`, `task`, or `cli`. The archive event refers to the checkout. A branch can survive
archive. The after hooks are live observers and use the same client event stream
as workspace hooks. Changes made directly in an external Git process are
outside this stream.

With the Workspace Lifecycle example enabled, create and remove a worktree
from a test repository. The example's settings panel shows the checkout path
for both events.

## Awaited session hooks

Declare these events in `contributes.lifecycleHooks` with private method names.
Codeg runs enabled handlers in plugin ID order, with a shared three-second
deadline for each chain and the usual per-invocation execution limit.
`conversationId` and `folderId` may be `null` before a session is linked.

### `session.prompt.before`

The hook receives `{ conversationId, folderId, agentType, prompt }` before
Codeg records or sends the user prompt. `prompt` joins user text blocks with
newlines and is empty for attachment-only input. Attachments and Codeg's
internal prompt suffix are outside the hook input.

Return `null` or `undefined` to carry the current prompt forward. Return
`{ prompt: string }` to pass replacement text to the next hook. The replacement
must contain non-whitespace text and fit in 128 KiB of UTF-8. NUL is invalid
and Codeg strips the reserved routing separator. When the chain supplies a
replacement, Codeg puts a single text block where the first text block was,
or at the start for attachment-only input, and preserves the attachment blocks.

Return `{ reject: string }` to block the send. Use a nonblank reason of up to
512 UTF-8 bytes without control characters. The command error includes the
plugin ID and reason. A thrown error, timeout, invalid response, or oversized
runtime message also blocks the send. The session stays available for retry
without a turn, transcript entry, or user-message event for the blocked prompt.

### `session.permission.before`

The hook receives `{ conversationId, folderId, agentType, requestId, title,
toolKind?, rawInputPreview?, options }` before Codeg queues a permission card.
Each option has `{ optionId, name, kind }`. The optional `rawInputPreview`
is a UTF-8 prefix of the tool input's JSON representation, up to 4 KiB.
A shortened preview may end inside a JSON value. ACP metadata and tool output
are outside the hook input.

- Return `null` or `undefined` to defer to the next hook. If each hook defers,
  Codeg queues the request in the normal approval flow.
- Return `{ action: "select", optionId }` to choose an exact option ID from
  this request, including a rejection option. Return `{ action: "cancel" }`
  to send ACP `Cancelled`. Either decision ends the chain and bypasses the
  permission card.
- A thrown error, timeout, unknown option ID, or invalid response ends
  automation for that request. Codeg logs the failure and queues the normal
  approval card. No later hook can approve the request after a failed hook.

A plugin decision emits `session.permission.resolved` for workspace sessions
with `origin: { kind: "host_plugin", plugin_id }` and the selected option ID
or `null` for cancellation. A selected option also records a tool approval when
the request identifies a tool call. Stopping the turn or withdrawing the ACP
request cancels pending policy evaluation. Codeg's interactive-question bridges
and explicit `codeg-cli` run policies keep their existing approval flows.
Disabling or removing a plugin excludes it from new hook chains and invalidates
its in-flight result.

Install the [Session Guard example](../examples/plugins/session-guard) to
reject a prompt containing `EXAMPLE_SECRET_PLACEHOLDER`. For a tool of kind
`delete`, it chooses an offered `reject_once` option or cancels the request.

## Live session hooks

Plugins can observe Codeg-managed ACP sessions associated with a workspace.
These hooks receive `folderId`, `connectionId`, `conversationId` when linked,
`agentType` and the event-specific `detail` below. Results use the same live
client event stream as workspace hooks.

| Event | `detail` |
| --- | --- |
| `session.started` | `{ sessionId }` from the agent when starting or loading a session. |
| `session.turn.started` | `null` when the connection enters its prompting state. |
| `session.turn.completed` | `{ stopReason }` from the completed turn. |
| `session.permission.requested` | `{ requestId, queued }` when a request becomes visible. |
| `session.permission.resolved` | `{ requestId, optionId, origin }` when the request is answered or withdrawn. |

### Tool result events

Register `session.tool.completed` to observe a live ACP tool call in a
saved conversation when its status first becomes `completed` or `failed`.
The handler receives the conversation and connection IDs, workspace ID when
available, agent type, and `detail` with `toolCallId`, `kind`, `status`, and
`outputKind`.

For text and errors, `outputPreview` contains up to 4 KiB of the recorded
UTF-8 text. `previewTruncated` marks a shortened preview. Structured
results use `outputKind: "structured"` with a null preview. The hook runs as
an observer and the original tool result continues to the agent.

The Workspace Lifecycle example emits the tool ID, status, and output kind
to its settings panel without including the preview.

## Agent creation, launch, close, and archive hooks

Register `agent.create.before` to set an initial conversation title. It
receives `agentType`, `folderId`, `kind`, `parentConversationId`, and the
proposed `title`. `kind` is `regular`, `chat`, or `delegate`. Folderless chat
has a `null` `folderId` at this stage. Return `null` to keep the proposed
title, or `{ title }` with up to 200 characters, at least one non-whitespace
character, and no control characters. Later hooks receive the preceding
hook's title. Invalid output, a failed handler, or a timeout aborts creation
before the conversation row is inserted. Codeg's normal automatic title
updates can still rename the conversation.

Register `agent.create.after` to observe the new conversation. It receives
the saved title and IDs, including `conversationId` and a `folderId` that
identifies the hidden folder for folderless chat. These hooks cover workspace
and folderless conversations, delegated agents, CLI runs, automation, work
tasks, and chat-channel tasks. A live ACP connection may already exist when
the first prompt creates the conversation. In that flow the after hook runs
once the connection is linked to the row. Importing or forking a conversation
uses its own lifecycle.

To try the Workspace Lifecycle example, pass `Plugin creation demo` as the
title to the create-conversation API. The plugin sets the title to
`Plugin-created agent` and displays the event in its settings panel.

Register `agent.open.before` to contribute environment variables before Codeg
launches a new ACP process or resumes a saved session in a fresh process. It
receives `agentType`, `workingDirectory`, `sessionId` when resuming, and the
`env` returned by earlier plugin handlers. Return `null` or `{ env }` with the
complete plugin environment. Codeg accepts up to 16 keys prefixed with
`CODEG_PLUGIN_`. Use uppercase letters, digits, and underscores after the
prefix. Values may contain up to 1,024 UTF-8 bytes without control characters.

Existing configured environment values take precedence. The handler receives
the plugin contributions only. Codeg skips this hook when returning a reused
connection. Throwing, returning an invalid result, or timing out aborts the
launch before the process starts. In the Workspace Lifecycle example, launches
from a directory named `plugin-launch-demo` get a `CODEG_PLUGIN_WORKSPACE_LABEL`.

Register `agent.close.after` to observe the teardown of an ACP connection
that had a live agent session. Its input has `agentType`, `sessionId`,
`connectionId`, optional `folderId` and `conversationId`, and an `outcome` of
`closed` or `error`. The payload comes from the connection's own session
state, including when Codeg has already removed it from the live map.

Register `agent.archive.after` to observe the normal conversation delete
operation after Codeg saves its archive state. Its input has `folderId`,
`conversationId`, `agentType` and `sessionId` when known. Concurrent delete
requests emit the archive hook once for the persisted transition.

## Install from a source

**Settings → Plugins → Add Plugin** accepts these public sources:

- An npm name such as `@scope/package`, with an optional exact version or tag.
  Publish `codeg-plugin.json` at the package root. Codeg reads the manifest
  from the SHA-512-verified tarball. The npm registry selector also offers the
  China mirror.
- A GitHub repository such as `owner/repo` or `https://github.com/owner/repo`.
  Append `#ref` to select a branch, tag, or commit. Codeg resolves the reference
  to a commit and reads `codeg-plugin.json` at that commit's repository root.
  For a manifest in a subdirectory, use a GitHub `/tree/<commit>/<directory>` URL.
- An absolute directory path containing `codeg-plugin.json`. The path is on the
  connected Codeg host, including when you use a remote workspace.

For a file on the browser's machine, use **Import Manifest**. The catalog stores
the manifest and its resolved source. Codeg starts each installed plugin
disabled. Contributions run through the host APIs described above.

## Review the installation

Select **Review installation** to load and validate the manifest on the
connected host. Check the plugin name, ID, version, and resolved source. For
GitHub the review shows the full commit, and for npm it shows the exact package
version and registry. When you select **Install**, the host commits the reviewed
manifest from memory. A preview is valid for up to five minutes and can be used
once. Codeg runs the manifest's declared contributions when you enable the plugin.

## Update an installed plugin

Use the update button next to a source-installed plugin in **Settings → Plugins**.
Codeg reads the manifest from the same host directory, GitHub reference, or npm
registry and version selector used at installation. An unqualified npm package
follows `latest`. A GitHub repository without a reference follows its default
branch. An exact npm version or GitHub commit stays pinned. Older catalog entries
with only a resolved version or commit stay pinned to it. For older npm entries
with no saved registry, Codeg uses the official npm registry.

Codeg verifies the same plugin ID and rejects older manifest or npm package
versions. A GitHub reference advancing to a new commit updates the stored source
even if the manifest is identical. A successful update keeps the enabled state
when the server module and its declaration are unchanged.
An update that changes the turn hook clears the plugin's in-memory turn activity.
Other connected clients receive a catalog change notification after the update.
For plugins imported as standalone files, remove the plugin and import the new
manifest to replace it.

## Discover plugins from an index

Select **Discover Plugins** in **Settings → Plugins** and enter an HTTPS URL to
a trusted index. Codeg validates the index before showing its entries. An index
uses this shape:

```json
{
  "apiVersion": 1,
  "plugins": [
    {
      "id": "codeg.turn-activity",
      "name": "Turn Activity",
      "description": "Show completed agent turns.",
      "versions": [
        {
          "version": "1.0.0",
          "source": "https://github.com/owner/repository#v1.0.0",
          "registry": "npm"
        }
      ]
    }
  ]
}
```

Index metadata is third-party content. Codeg resolves the selected source,
validates the `codeg-plugin.json` manifest, and checks its ID and version against
the index entry before showing the installation review. Index entries may
use exact npm versions or GitHub references, while absolute host directories
and floating npm selectors are rejected by the index validator.

See the [example index](../examples/plugins/index.json) for a complete file.
Codeg keeps up to eight successfully loaded index URLs in the browser profile so
they can be selected again from **Saved indexes**. The index content is fetched
again each time it is loaded.
