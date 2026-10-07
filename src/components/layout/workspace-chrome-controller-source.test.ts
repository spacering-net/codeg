import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const controllerSource = readFileSync(
  resolve(
    process.cwd(),
    "src/components/layout/workspace-chrome-controller.tsx"
  ),
  "utf8"
)

const tabBarSource = readFileSync(
  resolve(process.cwd(), "src/components/tabs/tab-bar.tsx"),
  "utf8"
)

const fileTabBarSource = readFileSync(
  resolve(process.cwd(), "src/components/files/file-workspace-tab-bar.tsx"),
  "utf8"
)

describe("tab close/navigation shortcuts live in the always-mounted controller", () => {
  // Regression guard. mod+w / mod+tab / mod+shift+tab / close-all-file-tabs
  // used to be registered by a `window` keydown listener INSIDE the visible tab
  // strips (TabBar, FileWorkspaceTabBar). The mobile workspace no longer mounts
  // those strips (it shows the folder-title header instead), and the file strip
  // is desktop-only anyway — so listeners living there would silently die below
  // the 768px breakpoint. Worse, with the listener gone, mod+w falls through to
  // the native OS default and closes the whole Tauri/browser window instead of
  // the active tab. The shortcuts must therefore live in the headless,
  // always-mounted WorkspaceChromeController (mounted on BOTH platforms).
  it("registers the tab shortcuts in WorkspaceChromeController", () => {
    expect(controllerSource).toMatch(/shortcuts\.next_tab/)
    expect(controllerSource).toMatch(/shortcuts\.prev_tab/)
    expect(controllerSource).toMatch(/numberedTabIndexFromEvent/)
    expect(controllerSource).toMatch(/pickNumberedTabId/)
    expect(controllerSource).toMatch(/shortcuts\.close_current_tab/)
    expect(controllerSource).toMatch(/shortcuts\.reopen_last_closed_tab/)
    expect(controllerSource).toMatch(/popClosedTab/)
    expect(controllerSource).toMatch(/shortcuts\.close_all_file_tabs/)
    // ...and actually drives the tab / file-tab actions. The e.preventDefault()
    // calls next to these are what stop mod+w reaching the window-close default.
    expect(controllerSource).toMatch(/switchTab\(/)
    expect(controllerSource).toMatch(/switchFileTab\(/)
    expect(controllerSource).toMatch(/closeTab\(/)
    expect(controllerSource).toMatch(/closeFileTab\(/)
    expect(controllerSource).toMatch(/closeAllFileTabs\(/)
  })

  // A closed remote tab (an address of the remote codeg host) must reopen as
  // one: reopened as an ordinary tab it would load this machine's port.
  it("reopens a remote browser tab as remote", () => {
    expect(controllerSource).toMatch(
      /openBrowserTab\(closed\.url, \{[\s\S]*?closed\.remote === true \? \{ remote: true \}/
    )
  })

  // Ctrl+<digit> is a terminal control code (Ctrl+6 is vim's alternate-file
  // Ctrl+^), so the numbered jump has to decline inside the terminal region —
  // the same carve-out the zoom listener makes for Ctrl+-/Ctrl+=. Cmd+<digit>
  // carries no shell meaning and is deliberately NOT excluded.
  it("leaves Ctrl+<digit> to a focused terminal", () => {
    expect(controllerSource).toMatch(
      /data-terminal-panel-region="true"[\s\S]*?numberedIndex|numberedIndex[\s\S]{0,600}?data-terminal-panel-region="true"/
    )
  })

  // The stack is purged when a delete arrives, but a tab that was still open
  // then is recorded afterwards (a remote delete does not close it). Restoring
  // has to consult the tombstone, not just trust the entry.
  it("checks the delete tombstone before restoring a conversation", () => {
    expect(controllerSource).toMatch(
      /isConversationDeleted\(closed\.conversationId\)/
    )
  })

  // Each entry carries the slot it was closed from; every opener gets it, so
  // the tab goes back where it was (clamped) instead of at the end of the
  // strip. One per restorable kind: file, browser, conversation, draft.
  it("hands the closed tab's slot to each opener when restoring", () => {
    expect(controllerSource.match(/index: closed\.index/g)).toHaveLength(4)
  })

  it("removes the keydown shortcut listeners from both tab strips", () => {
    // The strips are conditionally mounted (desktop only; the file strip only
    // when a file tab is open), so they must not own any global shortcut.
    expect(tabBarSource).not.toContain('addEventListener("keydown"')
    expect(tabBarSource).not.toContain("matchShortcutEvent")
    expect(fileTabBarSource).not.toContain('addEventListener("keydown"')
    expect(fileTabBarSource).not.toContain("matchShortcutEvent")
  })
})
