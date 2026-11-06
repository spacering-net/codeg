# Official DeepSeek Harness ACP in Codeg

This built-in is the first-party DeepSeek Harness (DSH) ACP profile. It is a **separate** agent (`deepseek_official`) from Codeg's existing `deepseek` integration using the community `deepseek-acp` bridge. Previously saved DeepSeek sessions and existing custom `dsh` registrations remain distinct.

## Requirements

Install Node.js **24.9.0+** and configure DSH's model-provider credentials (for example `DEEPSEEK_API_KEY`) with DSH itself or Codeg's agent environment editor. Codeg can install the pinned npm release through its normal agent installer. To install the same release manually:

```sh
npm install -g @deepseek-ai/dsh@0.2.1-rc.4
```

Codeg launches `dsh --profile acp` on stdio (it is an ACP server, not an interactive terminal). Choose **DeepSeek Harness (Official ACP)** from the agent picker; the legacy entry continues to launch `deepseek-acp`.

## Supported features and limits

The official ACP profile provides `session/new`, `session/list`, `session/resume`, `session/close`, `session/prompt`, cancellation, permissions, model selection and (for supporting models) reasoning effort. Session-scoped MCP servers are supported over stdio and Streamable HTTP, including Codeg's MCP collaboration companion. StdIO MCP commands **must have absolute executable paths**; SSE MCP is unsupported.

It deliberately omits `session/load` transcript replay, `session/fork`, deletion, additional directories, interactive modes/plans/terminals, and editor-specific presentation cards. Codeg keeps its **own ACP transcript** for sessions started through this built-in. It does not parse or import DSH's private session format into this new agent; existing community-bridge history remains untouched. The legacy DeepSeek-specific model catalog editor and rich editor features belong to the legacy bridge, not to this profile.

Sources: [DSH CLI](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/README.md), [ACP contract](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md), [Issue #1057](https://github.com/spacering-net/codeg/issues/1057).
