# URL scheme

The desktop app registers the custom URL scheme `codeg://` so another program
can bring Codeg forward and open a specific conversation.

This is the OS handler for the same `codeg://session/<id>` form already used
as an in-app markdown mention. Mention badges (`codeg://agent/…`,
`codeg://commit/…`, `codeg://embedded/…`) stay in-process and are **not**
OS navigation.

## Forms

| URL | Effect |
| --- | --- |
| `codeg://session/214` | Open conversation **214** (Codeg's numeric id) |
| `codeg://session/<external-id>` | Open by the agent's own session id (Grok UUID, Codex thread id, …) |
| `codeg://workspace?conversationId=214` | Same lookup. `folderId` and `agent` are optional; when omitted they are read from the row |
| `codeg://workspace?folderId=3&conversationId=214&agent=grok` | Same, but rejected if folder or agent do not match the row |
| `codeg://open` / `codeg://` | Show the workspace, no tab change |

A missing or deleted conversation is a no-op besides showing the workspace.

## Examples

```bash
# macOS / Linux
open "codeg://session/214"
xdg-open "codeg://session/214"

# Windows
start codeg://session/214
```

From a local web app (the custom scheme cannot be `fetch`'d; assign it):

```js
window.location.href = "codeg://session/214"
```

## Cold start vs already running

A resolved link cannot simply be emitted to the workspace: Tauri delivers an
event only to webviews that have **already** registered a JS listener, and
queues nothing for the rest. During boot that is every window. So the backend
parks the resolved target in a single slot and sends a payload-less
`workspace://deep-link-pending` nudge; the frontend takes the slot (an atomic
take, so exactly one caller can ever get a given target) both on the nudge and
once on mount, right after subscribing.

- **Already running:** the link reaches the live process (macOS Apple Event, or
  Windows/Linux argv through the single-instance plugin). The nudge arrives at
  a listening workspace, which drains the slot and opens the tab without
  reloading.
- **Cold start:** the nudge is dropped — nobody is listening yet — and the
  mount drain picks the target up instead.
- **Windows / Linux cold start** additionally has the URL available in argv
  before the main window is even created (the deep-link plugin parses it during
  its own setup), so the window is pointed straight at
  `/workspace?folderId=…&conversationId=…&agent=…` and `DeepLinkBootstrap`
  opens the tab once folders, tabs **and** the conversation list have loaded.
  The two never both fire: whichever delivery reached the plugin before the
  `on_open_url` listener existed is the one that wins.

## Scheme registration

The desktop installer registers the scheme — `CFBundleURLTypes` on macOS,
protocol handler on Windows, `x-scheme-handler/codeg` on Linux — but the Linux
half needs two extra pieces, because Tauri's bundler renders the `.desktop`
`Exec` line with no field code ([tauri#15928], [tauri#16014]). Without one, the
freedesktop spec says the launcher passes no URL, so the app is advertised as
the scheme owner and then started empty.

- `src-tauri/linux/main.desktop` is a copy of the bundler's template with
  `Exec={{exec}} %u`, wired in through `bundle.linux.deb.desktopTemplate` and
  `bundle.linux.rpm.desktopTemplate` (AppImage reuses the deb entry). Keep it
  in sync with the bundler's `main.desktop` when Tauri is upgraded.
- Windows and Linux **release** builds also call the plugin's `register_all()`
  at startup. On Linux that writes a `NoDisplay=true` handler entry that passes
  `%u` — a second chance for an AppImage that was never registered, though some
  portals skip `NoDisplay` entries, which is why the packaged entry above still
  has to be right. On Windows it adds the `HKCU` class key a portable/zip copy
  never gets from the installer. Debug builds are skipped so a dev run cannot
  take the scheme away from an installed Codeg.

Not available in `codeg-server` / browser-only mode — use the
`/workspace?folderId=&conversationId=&agent=` query string there.

[tauri#15928]: https://github.com/tauri-apps/tauri/issues/15928
[tauri#16014]: https://github.com/tauri-apps/tauri/issues/16014
