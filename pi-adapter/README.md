# Managed Pi adapter

The built-in Pi entry runs an application-bundled adapter, using the user's
Node.js and Pi executables. The verified runtime baseline is Pi **1.4.0** and
Node.js **22.19.0**. Installation pins that Pi version. `PI_ACP_PI_COMMAND` and
`PI_CODING_AGENT_DIR` remain supported. Global adapters are not removed or
modified; Custom agent launch recipes continue to use their configured adapter.

## Source and reproducible build

`vendor/` is the MIT-licensed adapter from
[xintaofei/pi-acp](https://github.com/xintaofei/pi-acp/tree/fc1a99260c345ffca6ff2cb40db58d1bddf452e7),
commit `fc1a99260c345ffca6ff2cb40db58d1bddf452e7` (adapter version 0.1.0).
The package was not published when this integration was prepared. Each vendored
file's Git blob digest is recorded in `provenance.json`; the original source and
lockfile are retained unchanged.

With the repository's locked build dependencies installed:

```sh
npm ci --ignore-scripts --prefix pi-adapter/vendor
node scripts/build-pi-adapter.mjs
node scripts/build-pi-adapter.mjs --check
node --test pi-adapter/bridge.test.mjs
```

The build checks source digests, bundles with the root's locked esbuild, includes
the adapter license and licenses of bundled dependencies, and records SHA-256
digests of output and local adaptations. `--check` rebuilds and compares bytes.
The native host verifies embedded digests and extracts an immutable,
manifest-addressed bundle. No adapter download is required at runtime.

`overlay.mjs` makes bridge collection asynchronous. `mcp-bridge.mjs` wraps the
upstream extension: registration acceptance is followed by confirmation that Pi
has published active tools. Both local changes are included in the manifest.

## MCP ownership

Settings manage the effective `PI_CODING_AGENT_DIR/mcp.json`, retaining Pi-only
server fields and root extension configuration. Pi reads those native files;
the host does not inject a second copy. Native configuration keeps Pi's native
expression syntax. Session-injected environment/header strings are literal and
escaped by the adapter; they travel through private temporary bridge files,
which are removed, and are never written into the user's native configuration.

The session bridge supports stdio and Streamable HTTP. SSE is rejected explicitly.
Missing runtime APIs, startup connection failure, inactive tools and conflicting
native/session names cannot enable companion capabilities. The bridge waits up
to ten seconds for tools, with a twelve-second collection bound. A server that
publishes no tools is not considered tool-ready. Very long tool namespaces that
Pi truncates cannot be proven by the prefix check and fail closed.

Existing extensions are preserved. Pi's native MCP extension must remain enabled;
an extension replacing it can prevent confirmation. Extension commands can be
typed explicitly; the adapter intentionally does not advertise them as safe
headless commands. Unsupported interactive extension UI reports cancellation.
Models and reasoning levels use the adapter's session configuration, including
restored sessions. The original project-trust checks remain in force.

## Deterministic integration probes

```sh
npm ci --ignore-scripts --prefix pi-adapter/fixtures
node pi-adapter/probe.mjs
node pi-adapter/probe.mjs --failure
node pi-adapter/probe.mjs --collision
```

The fixture lockfile pins Pi 1.4.0. Probes use isolated
profiles, a local model endpoint and local MCP services. `ACP_TEST_ROOT` selects
the evidence directory; `PROBE_PORT` overrides port 13443. They exercise actual
stdio/HTTP tool calls, literal secret-like strings, native configuration
preservation, bridge failures, aliases, extensions, reasoning and session restore.
They do not contact real model providers or change a user's profile.

In managed workspaces, dependency installation and native builds must use the
workspace's controlled execution queue.
