# Agent accounts

Use **Settings > Agents > Accounts** to add a named account to a built-in agent.
Each account has its own folder and official sign-in. **Default** uses the
agent's existing account. Adding a named account keeps the built-in agent's
controls and conversation history.

You can also choose **Add account** or **Manage accounts** beside a chat's
account picker. Setup opens in the chat, so your draft stays in place.

Choose **Add account**, give it a name, and choose a connection method. Claude
Code and Codex offer account sign-in or an API key. API usage is billed
separately from subscriptions. Other supported agents use their own setup;
Antigravity offers its personal and business sign-in flows.

Choose **Continue** to save the account and start setup. Desktop opens the
agent's official sign-in. In the web interface, copy the displayed command and
run it on the computer hosting Codeg. **Check sign-in** checks Claude Code or
Codex after you finish. Opening sign-in does not mean it has completed.
Then choose the named account in a chat's account menu.

Use **Set up** to reconnect an existing account or change its connection
method. Close its chats before replacing an API key or changing Claude to
account sign-in. The connection settings below the Accounts card configure
**Default**; each named account keeps its own connection settings.

To reuse an account folder, expand **Advanced: use an existing account folder** while
adding an account. This keeps its existing sign-in and history. Removing an
account keeps its folder and history. Add the same folder again to restore
the account binding.

## Supported agents

Named accounts are available for Claude Code, Codex, Gemini, OpenCode, Grok,
Hermes, CodeBuddy, Cline, Kimi Code, Pi, DeepSeek, Qoder and Antigravity. Cursor
supports named accounts on Windows and Linux; use Default on macOS. Kiro,
ZCode, TRAE CLI and Command Code do not yet support named accounts. OpenClaw
uses its configured gateway's account.

OpenCode and Cursor keep the usual home folder and GitHub CLI configuration.
Other command-line tools that use their separate configuration folders may
need their own configuration or sign-in in each account. Codeg does not copy
their credentials from Default.

## Conversation accounts

A conversation keeps the account selected when it was created. Reopening or
resuming it uses that account. A missing or removed account never silently
falls back to Default.

Claude Code conversations can switch accounts from their account picker when
no turn or background task is running. The conversation and transcript are
retained. The current model and mode carry over unless the target account has
its own saved choices. Turn off Claude Remote Control before switching accounts.
An unavailable requested model cancels the switch. The selected account's own
settings, permissions and project memory apply.

Session task lists and legacy todos move with a native Claude session, including
updates and deletions. Replaced task files remain in the target account's
`.codeg-account-switch/` recovery folder. A custom task-list id can be shared
with other sessions, so native switching refuses it instead of replacing the
shared list.

For another supported agent, choosing an account opens **Continue this
conversation**. Confirm the account to start a new native session with the saved
conversation available as context. The chat, draft, title, pin and tags remain
in place.

## Continue with another agent

Choose **Switch agent or account** in the composer or conversation menu. Select
an installed agent and an account, optionally add a note, then choose **Switch**.
The dialog identifies whether the selected agent resumes the native Claude
session or starts a new session with portable context.

Portable context keeps the complete conversation saved by Codeg, including its
tool records and embedded images. Long histories stay available in pages through
a read-only context tool, rather than being shortened into a digest. Agents
that do not accept MCP servers use the local transcript. OpenClaw gateway
handoffs are not supported. Account sign-ins and credentials are never copied.

Different agents have different tools, instructions and context limits. A
portable handoff does not transfer another provider's private session state.
The original agent's files remain intact, and the earlier conversation stays
visible in the same chat. If the new agent's first prompt fails, Codeg keeps the
context ready for the next send.

## Backups and moving computers

A Codeg backup includes account names, their folder paths and conversation
bindings, including saved handoff context. **Include conversation content** includes transcripts from the CLI
default folders. It does not include named-account folders, their transcripts,
or their sign-ins. Back up named-account folders separately before deleting
data or moving to another computer.

Restoring a Codeg backup keeps the saved account paths. Restore the separate
folders to those paths to reopen their conversations, and sign in again if the
agent requires it. A missing folder produces an error instead of starting a
different account. Keep the original folders until you have verified the
restored history. Account folders can contain credentials, so protect those
separate backups accordingly.
