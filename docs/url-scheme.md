# URL scheme

The desktop app registers the custom URL scheme `codeg://` so another program
can bring Codeg forward and open a specific conversation, or a SpaceRing
Harness item (see [Harness links](#harness-links)).

This is the OS handler for the same `codeg://session/<id>` form already used
as an in-app markdown mention. Mention badges (`codeg://agent/…`,
`codeg://assistant/…`, `codeg://commit/…`, `codeg://embedded/…`) stay
in-process and are **not** OS navigation.

## Forms

| URL | Effect |
| --- | --- |
| `codeg://session/214` | Open conversation **214** (Codeg's numeric id) |
| `codeg://session/<external-id>` | Open by the agent's own session id (Grok UUID, Codex thread id, …) |
| `codeg://workspace?conversationId=214` | Same lookup. `folderId` and `agent` are optional; when omitted they are read from the row |
| `codeg://workspace?folderId=3&conversationId=214&agent=grok` | Same, but rejected if folder or agent do not match the row |
| `codeg://harness/install?ref=<publisher>/<name>` | Open that Harness item on the Harness page's Discover section — opens, never installs ([below](#harness-links)) |
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

## Harness links

The SpaceRing website's item pages have an "Open in Codeg" chooser that sends
people to a Harness item in one of two ways:

| Address | Where |
| --- | --- |
| `codeg://harness/install?ref=<publisher>/<name>` | The desktop app |
| `https://<instance>/workspace?harness=<publisher>/<name>` | A Codeg Web instance (the server serves `/workspace`) |

Both have the same effect: Codeg comes forward on the Harness page's Discover
section with that item's detail open. Every kind of item opens its detail,
items that are only listed included.

- **Opens, never installs.** Any web page can send either address, so a link
  only ever opens the item. Installing is always the user's decision, made in
  Codeg. The request carries `intent: "install"` so that the install steps can
  offer the confirmation over the detail; until they exist, Discover ignores
  it.
- **Validation.** The ref is checked with the Harness rules
  (`parseItemRef`, `src/lib/harness/item-ref.ts`): publisher
  `[a-z0-9][a-z0-9.-]{0,252}`, name `[a-z0-9-]{1,64}`, so the length is
  capped. Surrounding space and capitals are forgiven, nothing else. A ref
  that is not one only shows the workspace, silently, and so does any other
  `codeg://harness…` link. Other parameters are ignored. The desktop app
  reads `ref` as `URLSearchParams` reads `?harness=` — the first one, `+` as
  a space, percent-escapes decoded — and checks it by the same rules
  (`src-tauri/src/deep_link.rs`), so both addresses take exactly the same
  refs.
- **Discover switched off** (`CODEG_HARNESS=off` on the host): the Harness page
  opens where it last was, and a message says the item cannot be opened there.

### Desktop

- The backend parks the validated ref in a slot of its own — the conversation
  slot holds conversation targets only — and sends the same payload-less
  `workspace://deep-link-pending` nudge to the main window. `PetFocusBridge`
  drains both slots on every nudge and once on mount; the Harness one with the
  command `take_pending_harness_link` (no arguments, returns the ref in its
  lower-case form or `null`; an atomic take, like `take_pending_deep_link`).
  One slot: a newer link replaces one not yet claimed. The ref is checked
  again on arrival, waits for the workspace to load, and opens once.
- Only the local workspace window (`main`) claims. A remote workspace window
  never calls `take_pending_harness_link`: a link opens the item on this
  computer. To install on a remote host, open Harness in the remote window.
- **Cold start on macOS:** the link arrives as a parked slot plus the nudge,
  as conversation links do; the mount drain picks it up.
- **Cold start on Windows and Linux:** the main window is pointed at
  `/workspace?harness=<url-encoded ref>`, the path the Web address uses.
  Nothing is parked as well, so the item opens once.
- A frontend built before the command existed treats "command not found" as
  "nothing parked".

### `/workspace?harness=`

- Read once, as the workspace loads, and removed from the address with
  `history.replaceState`; every other parameter and the hash stay as they
  were. A reload, a remount or the back button cannot read it again.
- The item opens once the folders and tabs have loaded, so a link that
  arrives while the workspace is still loading is not lost.
- **Before the instance login (Codeg Web):** while this browser is turned
  away, the item waits. "Go to login" (`redirectToCodegLogin`) keeps the ref
  in `sessionStorage` — this tab only, gone with the tab — and the login
  page sends a successful login to `/workspace?harness=<ref>`, once. A kept
  ref is cleared when it is used, when the workspace loads, and by the next
  redirect to the login page, and is not used after 10 minutes.

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
`/workspace?folderId=&conversationId=&agent=` query string there, and
`/workspace?harness=<publisher>/<name>` for a Harness item.

[tauri#15928]: https://github.com/tauri-apps/tauri/issues/15928
[tauri#16014]: https://github.com/tauri-apps/tauri/issues/16014
