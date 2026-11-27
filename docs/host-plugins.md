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

Include [the browser bridge types](host-plugin-client.d.ts) in your plugin's
TypeScript project to type-check calls to `window.codeg`. Codeg provides this
object when it opens the reviewed HTML.

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

### Plugin details and setup

A client bundle can contribute `contributes.pluginDetail` for its enabled
plugin details and `contributes.activationPanel` for setup after enablement.
Each contribution has an `id` and a `title`, and uses the reviewed
`client.entry`.

```json
{
  "pluginDetail": { "id": "details", "title": "About this plugin" },
  "activationPanel": { "id": "setup", "title": "Set up this plugin" }
}
```

Both contributions open on demand from Settings. The frame receives
`type: "pluginDetail"` or `type: "activationPanel"` from `window.codeg.ready`
and can use the same settings, server call, and event APIs as `settingsPanel`.

### Insert text into the composer

An open `composer` contribution can call
`await window.codeg.composer.insertText(text)` to insert plain text at the
caret or replace the current selection. Codeg updates the draft through its
usual editor path and leaves sending to the user. The API accepts up to 16 KiB
of UTF-8 text after normalizing line endings to `\n`. Empty text and NUL
characters are rejected. On success it returns `{ inserted: true, length }`,
where `length` is the normalized JavaScript string length.

```js
await window.codeg.ready
await window.codeg.composer.insertText("Summarize the changes in this workspace.")
```

The method is available only to the active composer contribution. Closing
the surface, hiding the session or changing the session, workspace, or connected
host revokes its access. It works for a conversation's composer and the
composer within its canvas card.

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
methods out of `server.methods`.

| Event | Input | Effect |
| --- | --- | --- |
| `workspace.open.before` | `{ path }` | Runs when a user opens by path. Return `null` to keep the path, or `{ path }` with an absolute replacement. |
| `workspace.open.after` | `{ folderId, path }` | Observes a completed open by path or reopening a saved folder by ID. |
| `workspace.close.after` | `{ folderId }` | Observes removing an open folder from the workspace. |
| `workspace.create.before` | `{ path }` | For a path first registered through the workspace UI, after `workspace.open.before`. Return `null` or an absolute replacement `{ path }`. |
| `workspace.create.after` | `{ folderId, path, name, parentId }` | Observes first registration of a workspace or an opened worktree workspace. |
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

Declare `worktree.create.after` to observe new checkouts made through the
desktop or Web workspace, per-run automations, work tasks, or `codeg-cli run
--worktree`. Recreating a task checkout from its saved branch also emits this
event. Declare `worktree.archive.after` to observe removals from the workspace
or task cleanup and the checkout removed after a failed CLI launch.

Both hooks receive `{ folderId, repositoryPath, path, branch, origin }`.
`folderId` identifies the owning project when known. `path` is the checkout
path, `branch` may be `null`, and `origin` is `workspace`, `automation`, `task`,
or `cli`. The archive event refers to the checkout. A branch can survive
archive. These are live observer hooks and use the same client event stream
as workspace hooks. Changes made directly in an external Git process are
outside this stream.

With the Workspace Lifecycle example enabled, create and remove a worktree
from a test repository. The example's settings panel shows the checkout path
for both events.

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

The permission hooks report state transitions. The user's permission decision
continues through the standard Codeg approval flow.

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
