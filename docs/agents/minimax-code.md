# MiniMax Code

Codeg connects directly to [official MiniMax Code](https://github.com/MiniMax-AI/minimax-code) by running `mcode acp` over stdio. This is the native MiniMax Code agent, not MiniMax models routed through OpenCode or another adapter.

## Setup

Install MiniMax Code on the machine running Codeg's backend. For server deployments, installing it on the browser's machine is not sufficient.

macOS, Linux, or WSL:

```sh
curl -fsSL https://filecdn.minimax.chat/public/install.sh | bash
```

Windows PowerShell:

```powershell
irm https://filecdn.minimax.chat/public/install.ps1 | iex
```

These are MiniMax's official installation commands. Review their scripts before running them. The installer prepares a compatible Node.js runtime when needed; its one-command Linux installer does not support Alpine/musl. See the [official installation guide](https://github.com/MiniMax-AI/minimax-code/blob/da22f11c55d4748155d7162c1030414228a00565/docs/installation.md) for alternatives and requirements.

Reopen the terminal and restart Codeg if necessary so its backend inherits the updated PATH. When `mcode` is not on that PATH, Codeg also looks for the installer's launcher in `~/.minimax-code/bin`, or `%USERPROFILE%\.minimax-code` on Windows. Check `mcode --version` and `mcode --help`. Then sign in using the region of your account:

```sh
# Mainland China account
mcode login

# Global account
mcode login --region global
```

Complete sign-in in the browser. In MiniMax Code, `/status` checks the account and `/provider` selects a provider/model. A selected bring-your-own-key provider does not require a MiniMax login. Configure those providers through MiniMax Code's own `provider` commands or configuration, rather than generic OpenAI environment variables in Codeg.

Select MiniMax Code in Codeg's Agent Settings and then in a workspace. Codeg uses the installed `mcode` command; it does not install a second ACP bridge or copy your credentials. Authentication failures should be resolved in MiniMax Code on the backend machine.

## Configuration and models

MiniMax Code's installation directory and user data directory are different. The official installer normally uses `~/.minimax-code` for installation files. Current upstream source and the documented npm 0.6.9 release use `~/.minimax` for user data, or `~/.minimax-<profile>` for a selected profile. A nonempty `MINIMAX_DATA_DIR` takes precedence over `MAVIS_DATA_DIR`. Keep the same environment as your working MiniMax Code installation to reuse its authentication and provider configuration. Defaults may differ across releases; consult the installation guide before moving or editing data.

The native agent advertises model choices through ACP session configuration options. Codeg follows these advertised values rather than hardcoding MiniMax model names. Model option values encode the provider, model and optional variant and must be treated as opaque IDs. Reasoning-effort controls appear only when the selected model advertises them. The native agent handles model changes with `session/set_config_option`, not the legacy `session/set_model` method.

Native session modes are Default and, when available, Plan. Permission mode is a separate configuration option: Ask (`default`), Auto (`auto`), or Full access (`bypassPermissions`). Upstream marks permission mode as process-scoped, so a change can affect multiple sessions attached to the same agent process. Permission prompts use ACP allow-once, optional always-allow, and deny choices.

## Sessions and tools

Codeg records its own ACP transcripts for conversations started in Codeg. The native agent advertises session loading, and reconnecting requires the original session ID and matching workspace directory. This integration does not import or scan MiniMax Code's native session database. Existing custom agent registrations remain separate from the built-in MiniMax Code entry.

MiniMax Code reads native MCP servers from the active data directory's `mcp.json`, under a `mcpServers` object. It also supports workspace `.mcp.json` subject to native trust/configuration rules. ACP-provided servers are session-scoped overlays, not replacements for native configuration; same-name session entries take precedence. Codeg stores assigned MCP servers in `mcp/minimax_code.json` inside its own data directory and forwards them, together with its per-launch collaboration companion, as ACP session overlays. It does not modify MiniMax Code's native MCP, provider or credential files.

Manage skills through MiniMax Code itself. Codeg-managed skill installation is not enabled for this integration; native profile selection and external skill roots remain governed by MiniMax Code's own configuration.

## Attachments and current scope

Attachment support follows the installed agent's negotiated ACP capabilities. Published MiniMax Code 0.6.13 and 0.7.0 advertise image support, but not audio or embedded context. File links remain references for native tools. An advertised capability does not guarantee that the selected provider/model supports that input.

Upstream supports stdio, HTTP and SSE MCP transports; Codeg's supported configuration paths and transports are a separate integration concern. Native extensions, native history import, provider/credential editing, and desktop-app-only features are outside this integration.

## Validation baseline

An isolated, unauthenticated `initialize` smoke test passed with `@minimax-ai/code@0.6.13`. It confirmed ACP version 1, session loading, HTTP/SSE MCP, image capability, and session list/fork/resume/close declarations. No credentials or model requests were used. This verifies startup and capability negotiation only, not authenticated conversations, session restoration, tool execution, or end-to-end image processing.

An offline end-to-end run with `@minimax-ai/code@0.7.0` on macOS then drove the agent through Codeg's server. A bring-your-own-key provider pointed at a local OpenAI-compatible test endpoint, so no MiniMax account or real model was involved. It covered the sign-in-required error, shell, read, edit and write tool calls, a permission prompt, reopening a session without duplicated history, Codeg-assigned stdio MCP servers and the collaboration companion's questions, Plan mode, and switching models. Real MiniMax accounts, Windows and Linux were not tested.

## Upstream references

The protocol details above were inspected at upstream commit [`da22f11c55d4748155d7162c1030414228a00565`](https://github.com/MiniMax-AI/minimax-code/commit/da22f11c55d4748155d7162c1030414228a00565). Published CLI releases can differ from this source snapshot.

- [CLI setup and installation](https://github.com/MiniMax-AI/minimax-code#quick-start)
- [Accounts and data directories](https://github.com/MiniMax-AI/minimax-code/blob/da22f11c55d4748155d7162c1030414228a00565/docs/installation.md#accounts-and-data)
- [ACP capability and session handlers](https://github.com/MiniMax-AI/minimax-code/blob/da22f11c55d4748155d7162c1030414228a00565/packages/tui/src/acp/agent.ts)
- [Model, mode and permission configuration](https://github.com/MiniMax-AI/minimax-code/blob/da22f11c55d4748155d7162c1030414228a00565/packages/tui/src/acp/control-state.ts)
- [Native MCP configuration and overlays](https://github.com/MiniMax-AI/minimax-code/blob/da22f11c55d4748155d7162c1030414228a00565/packages/local-runtime-v2/src/service/mcp/runtime/local-mcp.service.ts)
