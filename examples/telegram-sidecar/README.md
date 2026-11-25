# Codeg Telegram sidecar

An optional standalone Telegram Bot for Codeg, using Node.js built-in modules.
It connects to Codeg's HTTP API and WebSocket events and provides private-chat
topic sessions, interactive permission/question/plan approvals, and desktop
synchronization. The Bot's current message text is in Simplified Chinese.

## Requirements

- Node.js **22.13.0 or later** (`node:sqlite` is used for the optional desktop
  token lookup).
- A running Codeg desktop Web Service or `codeg-server`; this implementation was
  developed against Codeg 0.48.1.
- A Telegram Bot token from `@BotFather` and your own Telegram user ID.
- For private topics, enable **Threaded Mode** in the BotFather Mini App's Bot
  Settings. If Telegram rejects topic creation, the Bot uses a per-chat fallback
  session and explains how to enable topics.

Each configured Telegram user is a trusted operator of the connected Codeg
instance. `allowedUserIds` starts empty, so a new checkout authorizes nobody.

## Start

1. Start Codeg's Web Service on `127.0.0.1:3080` and obtain its access token. In
   desktop mode, a read-only lookup of the platform's Codeg database is available
   as a fallback. In server mode, provide the server's configured access token.
2. Stop any other Telegram polling client using the same Bot token, including
   Codeg's built-in Telegram channel, to avoid Telegram `409 Conflict` responses.
3. From this directory, copy the example and fill in `allowedUserIds`:

   ```sh
   cp config.example.json config.json
   ```

   On Windows PowerShell:

   ```powershell
   Copy-Item config.example.json config.json
   ```

4. Put the Telegram token in `telegram_token.txt` and Codeg Web Service token in
   `codeg_token.txt` in a secrets directory outside the checkout. Point
   `CODEG_TG_SECRETS_DIR` at that directory, or set `telegramTokenFile` and
   `codegTokenFile` in your private configuration.
5. Run:

   ```sh
   npm start
   ```

No `npm install` is needed. The process runs in the foreground; use Ctrl+C to
stop it, or your preferred service manager for a persistent deployment.

## Configuration

Config is loaded from `--config=<path>`, `CODEG_TG_BOT_CONFIG`, or this directory's
`config.json`. Paths in a config file should be absolute when the service may
start from another working directory. State and logs default to this directory's
`run/`.

| Setting / environment variable                       | Behavior                                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `codegUrl` / `CODEG_TG_CODEG_URL`                    | Codeg API URL; default `http://127.0.0.1:3080`                                              |
| `allowedUserIds` / `CODEG_TG_ALLOWED_USER_IDS`       | Trusted Telegram IDs; env accepts comma-separated IDs or a JSON array                       |
| `telegramTokenFile` / `CODEG_TG_TELEGRAM_TOKEN_FILE` | Telegram secret file                                                                        |
| `codegTokenFile` / `CODEG_TG_CODEG_TOKEN_FILE`       | Codeg secret file                                                                           |
| `CODEG_TG_SECRETS_DIR`                               | Directory containing both token files                                                       |
| `MG_SECRETS_DIR`                                     | Compatible legacy secrets root; uses its `codeg-tg-bot` subdirectory                        |
| `CODEG_TG_BOT_TOKEN` / `CODEG_WEB_TOKEN`             | Token env fallbacks when the corresponding secret file is absent                            |
| `codegDbPath` / `CODEG_TG_DB_PATH`                   | Optional read-only desktop database lookup                                                  |
| `telegramProxy` / `CODEG_TG_TELEGRAM_PROXY`          | HTTP CONNECT proxy URL; `auto` reads `HTTPS_PROXY` / `HTTP_PROXY`; empty string disables it |
| `stateFile` / `CODEG_TG_STATE_FILE`                  | Persisted topic bindings and Telegram polling offset                                        |
| `logFile` / `CODEG_TG_LOG_FILE`                      | Redacted, rotating Bot log                                                                  |

Secret files take priority over token environment variables. Without an explicit
secrets directory, files default to `codeg/telegram-sidecar/secrets` under the
user's platform configuration directory (`APPDATA` on Windows, Application
Support on macOS, or `XDG_CONFIG_HOME` / `~/.config` on Linux). A project-local
`run/telegram_token.txt` fallback remains available and is ignored by Git.

## Commands

| Command               | Behavior                                                    |
| --------------------- | ----------------------------------------------------------- |
| `/new`                | Choose a project and agent, then create a topic session     |
| `/sessions [keyword]` | Browse and attach existing Codeg sessions                   |
| `/active`             | List active connections and pending approvals               |
| `/mode`, `/model`     | Select session mode, model, and supported config options    |
| `/history [N]`        | Show recent messages for the current session                |
| `/rename <title>`     | Rename the Codeg session and Telegram topic                 |
| `/stop`               | Cancel the current turn                                     |
| `/close`              | Unbind/close the topic; optionally delete the Codeg session |
| `/status`, `/help`    | Session information and help                                |
| `/web`                | Open/manage the optional Mini App and revoke web sessions   |

Permission cards preserve the ACP permission options supplied by the agent.
Question cards support single/multiple choices, paging, skip, and free-text
answers by replying to the card. Plan cards support approve, reject, and revision
feedback by reply; long plans are attached as `plan.md`. Resolving a request on
desktop updates the Telegram card as well.

Bindings use `(chatId, threadId)` and reply routes include the originating chat
and topic. Legacy state migrates to schema 2; records with no identifiable chat
owner are preserved as unassigned records rather than routed into another chat.

## Optional Mini App

`miniApp.enabled` is `false` in the example. When enabled, an HTTP/WS gateway
listens on loopback port 3081, verifies Telegram `initData` signatures and the
allowlist, and injects the Codeg token into upstream requests. It accepts an
`http://` loopback Codeg upstream. Sessions use an HttpOnly cookie and can be
revoked with `/web`; restarting the Bot requires reopening the Mini App.

For a public HTTPS entry, separately install
[cloudflared](https://github.com/cloudflare/cloudflared) and set its absolute
`miniApp.cloudflaredPath`. Quick tunnels need no account; named tunnels require
`tunnelMode: "named"`, a `publicUrl`, a `tunnelTokenFile` outside the checkout, and
a Cloudflare route pointing at the gateway's loopback URL. The contribution does
not include a tunnel executable, domain, or credentials. When managing a tunnel,
the Bot stops only the child process it started; a stale PID file is discarded.

## Validation

```sh
npm test
```

Tests use mock Telegram/Codeg HTTP and WebSocket services and synthetic identities.
They cover the session wizard, streaming, permission/question/plan actions,
desktop synchronization, Mini App authentication/token injection/revocation,
cross-chat/topic isolation, legacy migration, redaction, and configuration.
They do not send messages to Telegram or read deployment credentials.

## License and acknowledgments

The sidecar source is Apache-2.0, matching Codeg. See [LICENSE](LICENSE),
[PROVENANCE.md](PROVENANCE.md), and the complete reference-project license texts
in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
