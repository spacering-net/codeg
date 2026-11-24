/**
 * Servers worth offering by name rather than making someone find.
 *
 * One, and the reason for it is not convenience: the registry carries
 * lookalikes of `chrome-devtools-mcp` under the same name and description with
 * a different owner, and a person adding a browser tool by hand is exactly the
 * person who cannot tell them apart. This fills the draft with the official
 * package. It does not install it — the spec stays in front of the user, who
 * still chooses which agents get it — and the note beside it says what the
 * thing is and, just as much, what it is not.
 *
 * Moved here from the Settings window's former MCP page. `note` is a message
 * key under `Harness.mcp`.
 */
export const SUGGESTED_SERVERS = [
  {
    key: "chromeDevtools",
    id: "chrome-devtools",
    label: "Chrome DevTools",
    note: "local.suggestedChromeNote",
    spec: {
      type: "stdio",
      command: "npx",
      args: ["-y", "chrome-devtools-mcp@latest"],
    },
  },
] as const

export type SuggestedServer = (typeof SUGGESTED_SERVERS)[number]
