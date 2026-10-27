# pi-acp

[![npm version](https://img.shields.io/npm/v/@spacering/pi-acp)](https://www.npmjs.com/package/@spacering/pi-acp)
[![CI status](https://github.com/xintaofei/pi-acp/actions/workflows/ci.yml/badge.svg)](https://github.com/xintaofei/pi-acp/actions/workflows/ci.yml)

An [Agent Client Protocol](https://agentclientprotocol.com) (ACP) adapter for the
[pi](https://github.com/earendil-works/pi) coding agent. It runs `pi --mode rpc` as a child process and translates
between pi's RPC records and ACP over stdio.

It is the adapter behind **[codeg](https://github.com/xintaofei/codeg)**'s Pi agent and works with any ACP client.
It is a fork of [svkozak/pi-acp](https://github.com/svkozak/pi-acp) 0.0.34 (MIT), brought up to pi 1.0, and is
published to npm as **`@spacering/pi-acp`**. Its command is `pi-acp`, the same as upstream's. This repository keeps
upstream's history, layout (`src/pi-rpc/` talks to pi, `src/acp/` speaks ACP) and formatting, so upstream changes can
still be merged.

## Requirements

- **pi 0.99.0 or newer** on your `PATH`, configured for your model provider:

  ```bash
  npm install -g @earendil-works/pi-coding-agent
  ```

  An older pi is refused when a session opens, with a message starting `pi runtime is too old for pi-acp`.

- **Node.js 22.19 or newer** (pi's own minimum).

## Use it

### codeg

codeg installs and updates this adapter for its Pi agent, replacing upstream's `pi-acp` that earlier codeg versions
installed. There is nothing to configure.

### Zed or another ACP client

```bash
npm install -g @spacering/pi-acp
```

It installs the same `pi-acp` command as upstream's `pi-acp` package, so npm will not install both globally: run
`npm uninstall -g pi-acp` first if you have upstream's.

```json
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "pi-acp",
      "args": [],
      "env": {}
    }
  }
```

Or without a global install: `"command": "npx", "args": ["-y", "@spacering/pi-acp"]`.

`pi-acp --version` prints the adapter's version.

## What differs from upstream

- **MCP reaches pi.** The `mcpServers` of `session/new` and `session/load` are handed to pi's native MCP (pi 0.99+) by
  a small pi extension (`src/pi-extension/mcp-bridge.ts`, built to `dist/mcp-bridge.mjs` and loaded with `pi -e`)
  that calls `pi.registerMcpServer()` with `exposure: "direct"`. The servers travel in a private file the extension
  deletes, and `env` / `headers` values are escaped so pi does not run `!command` or interpolate `$VAR` in them. stdio
  and streamable HTTP servers are supported; SSE servers are reported as skipped (pi rejects them). The response's
  `_meta.piAcp.mcp` lists what was registered and what was skipped. Servers pi reads from its own `mcp.json` files
  are unaffected.
- **pi 0.99.0 is the minimum.** The extension reports on every launch, which is how an older pi is detected.
- **Failed turns fail.** A turn whose final assistant message has `stopReason: "error"` rejects `session/prompt` with
  pi's error text instead of ending `end_turn`; `length` ends `max_tokens`.
- **Extension commands finish.** A prompt pi reports as `disposition: "handled"` settles at once (pi starts no run),
  and the response carries `_meta.piAcp.disposition: "handled"`.
- **Native steering.** `initialize` advertises `_meta.steering.supported`, and `_session/steering` puts the message
  on pi's own steering queue. It answers `injected` as soon as pi has queued it, so a client waiting for the answer is
  never held up by a long tool call. pi delivers it before its next model call; a steer that reaches pi after the run's
  last look at its queue is taken back and run as a continuation of the same `session/prompt`. It answers
  `promptRequired` (not consumed) when no turn is running, the turn is ending, or the steer has no text. It never
  starts a turn of its own.
- **Session extensions.** pi extension notifications are sent as session notices, and compaction as
  `compaction_update`, when the client advertises `clientCapabilities.session.notices` / `.compaction`; otherwise as
  text, as before.
- **codemode.** Calls a tool makes through `ctx.executeTool()` carry `_meta.piAcp.parentToolCallId`, and text-less
  partial results are not printed as JSON.
- **Robustness.** pi's stdout is framed on LF only (`readline` also splits on U+2028/U+2029, which are legal inside
  JSON strings); pi's stderr is passed through; a pi that exits mid-turn fails the turn with its exit status and the
  tail of its stderr, which is read before the exit is reported.
- **No startup banner.** Upstream ran `pi --version` and `npm view` on every `session/new` to build one;
  `_meta.piAcp.startupInfo` is always `null`.
- Built on `@agentclientprotocol/sdk` 1.5.1.

## Environment variables

- `PI_ACP_PI_COMMAND`: the pi executable to run. Default `pi` (`pi.cmd` on Windows).
- `PI_ACP_ENABLE_EMBEDDED_CONTEXT=true`: advertise ACP `promptCapabilities.embeddedContext`. Otherwise compliant
  clients should not send embedded `resource` blocks; any that arrive are still turned into plain-text context.
- `PI_CODING_AGENT_DIR`: pi's own setting for its agent directory (default `~/.pi/agent`), honored where the adapter
  reads pi's settings and session files.

## Slash commands

- **File-based commands** (pi prompts) from `~/.pi/agent/prompts/**/*.md` and `<cwd>/.pi/prompts/**/*.md`.
- **Skill commands**, when enabled in pi settings, as `/skill:<name>`.
- **Built-ins:** `/compact [instructions]`, `/autocompact on|off|toggle`, `/export` (HTML into the session cwd),
  `/session` (stats), `/name <name>`, `/steering` and `/follow-up` (pi's queue delivery modes), `/changelog`.
- Commands registered by pi extensions are not listed, but typing one sends it to pi, which runs it.

## Authentication

The agent advertises Terminal Auth. A client such as Zed shows an **Authenticate** button that runs:

```bash
pi-acp --terminal-login
```

which starts pi interactively so you can log in or set API keys.

## Development

```bash
npm ci
npm run typecheck
npm run lint
npm test               # no pi needed: tests fake pi at the RPC boundary
npm run build
npm run smoke:packed   # pack, install the tarball, and initialize the installed adapter
```

`npm run dev` builds and starts the adapter on stdio. To try a local build in a client, point it at
`node /path/to/pi-acp/dist/index.js`. See [CONTRIBUTING.md](CONTRIBUTING.md) for releases and for merging upstream.

## Limitations

- No ACP filesystem (`fs/*`) or terminal (`terminal/*`) delegation: pi reads, writes and runs commands itself.
- SSE MCP servers are skipped (pi supports stdio and streamable HTTP).
- Sessions map to pi's session files (`~/.pi/agent/sessions/`); the adapter keeps a small index in
  `~/.pi/pi-acp/session-map.json`, shared with upstream's adapter.

## License

MIT, see [LICENSE](LICENSE). Copyright Sergii Kozak (upstream pi-acp) and the @spacering/pi-acp contributors.
