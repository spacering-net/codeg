# ZCode

Codeg connects to [official ZCode](https://github.com/zai-org/ZCode) through the community [zcode-acp-server](https://github.com/william0wang/zcode-acp) bridge. The bundled registry pins the bridge to `0.76.2`.

## Setup

1. Install official ZCode and sign in there.
2. Install Node.js 22 or newer with `node:sqlite` available.
3. In Codeg Agent Settings, select ZCode and install its ACP adapter. The adapter installation does not install or update official ZCode.
4. Check the preflight results, then select ZCode in a workspace.

Codeg discovers the official desktop bundle or the `zcode` command on PATH, and uses the first Node.js on PATH or in a Node version manager that can load `node:sqlite`. For a nonstandard installation, set `ZCODE_BIN` to the official JavaScript entry (`resources/glm/zcode.cjs` inside the ZCode installation) and `ZCODE_NODE` to a Node executable in the agent environment editor. Use absolute paths or command names on PATH; a relative path is refused because each workspace would resolve it differently. Paths with spaces are supported; do not put extra shell quotes around values. An invalid explicit override fails instead of selecting another installation. npm and pnpm launchers and Unix links are resolved to their JavaScript target, for both the CLI and the bridge.

Codeg runs the bridge and the official CLI on that same Node. The bridge would otherwise move itself to Bun 1.4 or newer when it finds one; set `ZCODE_ACP_RUNTIME` in the agent environment to choose its runtime yourself.

The bridge reuses ZCode's existing authentication. Codeg does not copy credentials or create legacy ZCode configuration files. Sign-in errors should be resolved in official ZCode; the agent stderr diagnostics show startup failures.

ZCode Start Plan accounts cannot run through the bridge. Their model requests need a captcha that only the ZCode desktop app can solve, so each prompt fails with a message saying so. GLM Coding Plan providers are not affected.

## Attachments

Images and embedded resources follow the bridge's negotiated ACP capabilities. Pasted, dropped and uploaded images are sent as image blocks, including uploads hydrated by the Codeg server. Embedded PDFs retain their bytes even when their URI has no local file. File links remain references for native tools; remote links are not downloaded. Audio transcription is not supported.

The bridge accepts up to 100 content blocks and 50 MiB of decoded content per prompt, with a 10 MiB limit per image. Image attachments must be PNG, JPEG, WebP, GIF, BMP or SVG. Other image formats, invalid base64 and oversized prompts return an error. Pause any native goal loop before sending binary attachments; queued goal prompts accept only text.

## Sessions and tools

A new session explicitly confirms Build mode before sending its first prompt. A valid saved mode, including Yolo, takes precedence. Confirming the mode makes the bridge create the ZCode backend session when the conversation connects rather than at its first prompt. Existing sessions use the normal restore and preference flow. Model and thought selectors follow ACP configuration updates rather than a hardcoded model list.

The bridge writes a disabled sandbox template to `.zcode/acp/sandbox.json` in a workspace only while its sandbox is enabled globally, through `sandbox.enabled` in the bridge's user configuration or `ZCODE_ACP_SANDBOX=1`. Codeg sets neither, so unless you enable the sandbox yourself, the bridge does not create that file.

Codeg records its own ACP transcripts for ZCode, including messages, thoughts, tools and usage. These transcripts support history and reconnecting to sessions created in Codeg. Existing custom ZCode entries keep their registration, launch configuration and history; the built-in option records its history separately. This integration does not scan ZCode's native SQLite sessions.

Completed replies retain the bridge's per-turn token usage (including cache reads and writes) and wall time, so their footer and session totals survive reopening. A prompt the bridge works through in several rounds, such as an `/auto` loop or a sandbox continuation, totals every round's usage and keeps Codeg's measured duration. Context-window occupancy remains a separate reading, not additional billable tokens. When the bridge supplies no turn measurements, Codeg keeps its measured duration without inventing token counts. A cancelled reply records no usage, because the bridge reports it only after Codeg has stopped the turn. Older transcripts without those measurements are not retroactively filled.

Manage stdio MCP servers through Codeg's MCP settings and assign them to ZCode. The configuration is stored in Codeg's data directory and forwarded when creating or restoring a session; it is not written into official ZCode's provider or credential files. When multi-agent delegation is enabled, Codeg injects its per-launch `codeg-mcp` companion using the same path.

## Current scope

The integration covers ACP conversations, permission requests, cancellation, Codeg transcript history, stdio MCP, images and embedded resources. Message-level fork is disabled while the bridge's fork response and checkpoint behavior are incompatible with Codeg's typed flow. Native history import, a ZCode provider/configuration panel, HTTP MCP, audio, native Goal/queue extensions and remote hub are outside this phase. Initial runtime validation with official ZCode used bridge 0.69.2 on Windows; image and embedded-resource validation also covers 0.72.0. macOS and Linux discovery paths still need platform testing.
