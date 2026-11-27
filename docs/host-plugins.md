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
