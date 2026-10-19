# Command line: `codeg-cli`

`codeg-cli` runs one prompt through a Codeg that is already running — the
desktop app or `codeg-server` — and prints the agent's reply. No window opens.
The run is an ordinary conversation: it is listed in Codeg with the others,
where you can read it, answer what the agent asks, and carry it on. A terminal
mark sets it apart, and the Recent section's filter can show only those.

```bash
codeg-cli -a claude_code -p "Review the latest commit"
git diff main | codeg-cli -a codex -p "Review this diff" -o review.md
codeg-cli --assistant code-reviewer "Review the latest commit"
```

- [Install](#install)
- [Which Codeg it talks to](#which-codeg-it-talks-to)
- [Commands](#commands)
- [Several agents at once](#several-agents-at-once)
- [Detached runs](#detached-runs)
- [Permissions](#permissions)
- [Output](#output)
- [Exit codes](#exit-codes)
- [Error codes](#error-codes)
- [Events](#events)
- [In CI](#in-ci)
- [Security](#security)

## Install

`codeg-cli` comes with every package: the desktop app, `codeg-server`, and the
Docker image.

| Package | `codeg-cli` | On PATH |
| --- | --- | --- |
| Linux `.deb` / `.rpm` | `/usr/bin/codeg-cli` | Yes |
| macOS app | `codeg.app/Contents/MacOS/codeg-cli` | Install command-line tool, below |
| Windows installer | `%LOCALAPPDATA%\codeg\bin\codeg-cli.exe` | Install command-line tool, below |
| AppImage | Inside the image, copied out at every start | Install command-line tool, below |
| `install.sh` / `install.ps1` | Next to `codeg-server` | Yes |
| Docker image | `/usr/local/bin/codeg-cli` | Yes |

**Install command-line tool.** In the desktop app, Settings → System →
Command-line access has a button that puts `codeg-cli` on your PATH: on macOS
a link in `/usr/local/bin` (macOS asks for an administrator's password when
the folder needs one), on Windows the installer's `bin` folder on your PATH,
for an AppImage a link in `~/.local/bin`. A `codeg-cli` already there that is
not the app's — the one `install.sh` puts there with `codeg-server`, say — is
left alone: the two are the same program. The steps below do the same by
hand.

**In Codeg's own terminals and agents**, the app's own `codeg-cli` comes first
on PATH, and `CODEG_CLI` names it: a `codeg-cli` typed there is always the
app's release. A login shell may put its own PATH first; `"$CODEG_CLI"` is the
app's whatever the PATH. A development build calls its command
`codeg-cli-dev`, so it never takes the place of an installed release.

**macOS.** Link the app's copy into a folder on PATH:

```bash
sudo mkdir -p /usr/local/bin
sudo ln -s /Applications/codeg.app/Contents/MacOS/codeg-cli /usr/local/bin/codeg-cli
```

Without `-f`, `ln` does not replace a `codeg-cli` that is already there — one
`install.sh` put there with `codeg-server`, say. The two are the same program:
keep either.

**Windows.** The installer puts a copy of `codeg-cli.exe` in a `bin` folder of
its own, so that PATH gains this one program and not `codeg.exe` or the
uninstaller beside it. Add that folder to your PATH once, then open a new
terminal:

```powershell
$bin = Join-Path $env:LOCALAPPDATA "codeg\bin"
$path = [Environment]::GetEnvironmentVariable("Path", "User")
[Environment]::SetEnvironmentVariable("Path", "$path;$bin", "User")
```

If you installed Codeg in another folder, use its `bin` folder. `codeg-cli.exe`
is a console program: it behaves the same in PowerShell, `cmd` and Git Bash,
and a prompt reaches the agent exactly as you wrote it.

**AppImage.** The release has one for x64; `tauri build` makes one for other
machines. Its files are only there while it runs, so at every start the app
copies its `codeg-cli` to `<data dir>/cli/bin/codeg-cli` —
`~/.local/share/app.codeg` by default — over the copy it wrote before, never
over a file you changed; Install command-line tool links that copy into
`~/.local/bin`. Until the newer app first starts, the older copy keeps working
with it. Or take it out of the image yourself:

```bash
./codeg.AppImage --appimage-extract usr/bin/codeg-cli
mkdir -p ~/.local/bin
mv squashfs-root/usr/bin/codeg-cli ~/.local/bin/
```

**`install.sh` and `install.ps1`** put `codeg-cli` next to `codeg-server` when
the release has it, and leave alone a desktop app's `codeg-cli` they find there
— in its install, or the ones it keeps in its data directory for its own
terminals.
From 0.38.0 on, the server's in-place update brings the matching `codeg-cli`
with it. The update from 0.37.0 does not, as 0.37.0 knows nothing of
`codeg-cli`: take it from the server package on the release page and put it
next to `codeg-server`. Replacing `codeg-cli` never stops one that is running,
but a run it waits on in that server ends when the upgrade stops the server.

**Docker.** Run it in the container: it finds the server there by itself. The
workspace is a path in the container, e.g. under the `/projects` mount of
`docker-compose.yml`:

```bash
docker compose exec codeg codeg-cli -w /projects/app -a claude_code -p "Review the latest commit"
```

### Turning it on and off

Settings → System → **Command-line access**, on by default, shows the endpoint
file this Codeg publishes and a command to try. Switched off, no `codeg-cli` on
this computer can reach this Codeg. `--url` to a server, with the server's
token, does not depend on it (see [Security](#security)).

## Which Codeg it talks to

Every running Codeg, desktop or server, listens on a loopback port of its own
for `codeg-cli`, and says where in a private file,
`<data dir>/cli/endpoint-<pid>.json`. `codeg-cli` looks, in this order:

1. `--url` with `--token` or `--token-file`: a Codeg over HTTP(S), usually a
   `codeg-server` on another machine.
2. `--data-dir DIR`: the Codeg that keeps its data in `DIR`.
3. `CODEG_CLI_ENDPOINT_FILE`: set by Codeg in its own terminals and for its
   agents, so that `codeg-cli` typed there reaches the Codeg it runs in —
   whatever your shell profile exports.
4. `CODEG_URL` with `CODEG_TOKEN`.
5. `CODEG_DATA_DIR`.
6. The default data directories of the desktop app (`app.codeg`) and of
   `codeg-server` (`codeg`), in the platform's data directory:
   `~/Library/Application Support` on macOS, `~/.local/share` on Linux,
   `%APPDATA%` on Windows.

Only the first one given is used. If it fails — that Codeg is not running, or
cannot prove it is the one in the file — `codeg-cli` stops and says that
nothing was sent. It never falls back to another Codeg: a conversation there
would end up in a database nobody is looking at. In a data directory, a file
that leads to no Codeg that answers and proves itself is skipped. When several
Codegs answer
there, the desktop app wins, then a debug build of it, then a server, the most
recently started first. `--runtime desktop|server` picks the kind.

`codeg-cli status` lists everything it looked at, what each turned out to be,
and which one a run would use:

| State | Meaning |
| --- | --- |
| `ready` | It answered, and proved it is the Codeg in the file |
| `stale` | The file is there, its process is gone |
| `unreachable` | Its process is alive, but nothing answered |
| `unverified` | Something answered, without the proof only that Codeg can give |
| `access_denied` | The operating system refused the connection — a sandbox, most likely |
| `incompatible` | It speaks another CLI API, or cannot do what this command needs |

`codeg-cli open` starts the desktop app when no desktop answers, and waits
until one does (`--wait`, 60 seconds by default).

**In a sandbox.** An agent's shell often may not use the network at all,
loopback included. `codeg-cli` then fails with `error_runtime_access_denied`:
allow the command local network access, or run it outside the sandbox.
Restarting Codeg does not help. An agent in Codeg is better off with Codeg's
own delegation tools, which do not go through its shell.

## Commands

```text
codeg-cli [GLOBAL OPTIONS] [run] [RUN OPTIONS] [PROMPT]
codeg-cli agents      [--json]
codeg-cli agents install SLUG [--version VERSION] [--wait DUR] [--json]
codeg-cli assistants  [--json]
codeg-cli status      [--json]
codeg-cli open        [--wait DUR] [--json]
codeg-cli result      RUN [--wait DUR] [--output-format FORMAT] [-o FILE]
codeg-cli cancel      RUN [--json]
codeg-cli automations [list] [--json]
codeg-cli automations run ID [--wait DUR] [--json]
```

No command means `run`: `codeg-cli "review it"` and `codeg-cli run "review it"`
are the same run. A first word that names a command is that command. To send
`status` as a prompt, write `codeg-cli run status` or `codeg-cli -p status`.
Run options go after `run`, or with no command at all: written before `run`,
or with another command, they are a usage error rather than quietly dropped.

| Command | |
| --- | --- |
| `run` | Run one prompt (below) |
| `agents` | The agents this Codeg knows, whether each is enabled and installed, and how to install one that is not |
| `agents install` | Install an agent as Codeg's settings do. See [Installing agents](#installing-agents) |
| `assistants` | The assistants to run with `--assistant` |
| `status` | The runtimes this command can reach, and which it would use. Exit code 0 when it would use one |
| `open` | Start the desktop app unless it is running, and wait until it answers. This computer's desktop app only |
| `result` | The result of a run: one started with `--detach`, or one whose `codeg-cli` lost its Codeg. See [Detached runs](#detached-runs) |
| `cancel` | Cancel a run |
| `automations` | The automations saved in Codeg; `automations run ID` runs one now. See [Automations](#automations) |

Global options:

| Option | |
| --- | --- |
| `--url URL` | A Codeg over HTTP(S), e.g. `https://host:3080` |
| `--token TOKEN`, `--token-file FILE` | The token for `--url`: the server's `CODEG_TOKEN`. Without either, `CODEG_TOKEN` from the environment |
| `--data-dir DIR` | The Codeg that keeps its data in `DIR`. With `--standalone`, the data directory of the command's own server |
| `--standalone` | Start a `codeg-server` for this command alone, and stop it when the command ends. See [In CI](#in-ci) |
| `--runtime desktop\|server` | The kind to use when several answer |
| `-q`, `--quiet` | Errors only: no progress, no heartbeat |
| `-v`, `--verbose` | Progress on stderr even when it is not a terminal, and diagnostics |
| `--no-color` | Plain progress lines |

### `run`

| Option | |
| --- | --- |
| `-p`, `--prompt TEXT` | The prompt. `-` reads it from stdin. It can also be the last argument |
| `-w`, `--workspace DIR` (`--cd`, `-C`) | Where the agent works. By default the current directory; a relative path is taken from it. With `--url`, a path on the server's machine: required, and sent as written |
| `-a`, `--agent SLUG` | The agent: `claude_code`, `codex`, … (`codeg-cli agents`). Again for another run: see [Several agents at once](#several-agents-at-once) |
| `-A`, `--assistant NAME\|ID` | Run as an assistant: its agent, settings and instructions (`codeg-cli assistants`). A number is an id before it is a name |
| `--max-parallel N` | With several `-a` and `-A`: how many run at once, 4 by default. The rest wait their turn |
| `-m`, `--model VALUE` | The model, as the agent lists it |
| `--effort LEVEL` | The thinking effort, as the agent lists it |
| `--mode ID` | The session mode, e.g. `plan` or `acceptEdits` |
| `-c`, `--config ID=VALUE` | Another of the agent's session options. Repeatable |
| `--permissions POLICY` | What to answer when the agent asks for a permission: `deny` (the default), `reads`, `allow`, `fail` or `wait`. See [Permissions](#permissions) |
| `--output-format FORMAT` (`--format`) | `text` (the default), `json` or `stream-json`. See [Output](#output) |
| `-o`, `--output FILE` | Also write the final reply to `FILE` |
| `--output-schema FILE` | Have the agent hand in its result as JSON matching the JSON Schema in `FILE`. See [Structured output](#structured-output) |
| `--title TEXT` | The conversation's title. The agent's own titles do not replace it |
| `--timeout DUR` | Give up after this long — `90s`, `30m`, `2h` — counted from the start of the command. The run is cancelled in Codeg too, even if this command is gone by then |
| `--open` | Open the conversation in the desktop app once it exists, and bring it to the front. Desktop app only |
| `--no-stdin` | Never read stdin |
| `--detach` | Return once the agent has the prompt, printing the run's id. See [Detached runs](#detached-runs) |
| `--worktree`, `--worktree=NAME` | Run in a new git worktree of the workspace's repository, on branch `cli/NAME`. See below |

With neither `-a` nor `-A`, the run uses the workspace's default agent, when
it has one.

**stdin.** Piped stdin is context for the prompt:
`git diff | codeg-cli -p "review this"` sends the prompt, then the diff.
Without a prompt, stdin is the prompt. A terminal or an empty device such as
`/dev/null` is never read, so a CI job that leaves stdin open does not hang.
The prompt and stdin may be up to 10 MiB together.

**Model, effort, mode, options.** `--model`, `--effort`, `--mode` and `-c` are
checked against what the agent offers once it has started, and applied before
the prompt is sent. A value the agent does not offer ends the run with exit
code 2, and the message lists the values it does offer; one it offers but does
not take ends it the same way. The choices are for this run only: the agent's
defaults in Codeg stay as they are.
`--effort` is not accepted for Kiro, whose answer cannot confirm the change.

**The workspace** becomes a folder in Codeg if it is not one yet. It is not
opened in the sidebar.

**A worktree of its own.** `--worktree` gives the run a new git worktree next
to the repository, on a new branch from its HEAD: `cli/NAME` with
`--worktree=NAME`, or `cli/` and the start of the run's id. The agent works
there, in the same subdirectory when the workspace is below the top of the
repository, and the worktree stays when the run is done, for you to review,
merge or delete in Codeg. It shows under the repository's folder when that
folder is open in Codeg. `init` and the result name it:
`"worktree": {"path": …, "branch": "cli/…"}`. A name already taken gets more
of the run's id after it. A launch that fails before its conversation exists
takes its worktree and branch away again: nothing ran in them. The name only
goes after `=`: `--worktree review` is an unnamed worktree, and the prompt
`review`. `--worktree` needs git 2.33 or later.

**Interrupting.** Ctrl-C (SIGINT) or SIGTERM cancels the run in Codeg and
waits up to 10 seconds for it to wind up. A second one quits within two
seconds. The exit code is 130 or 143, also when the signal comes before the
run has started.

**Losing Codeg.** When Codeg stops answering for 30 seconds, `codeg-cli` gives
up with exit code 4. The run may still be going: the result has its link.

## Installing agents

`codeg-cli agents install claude_code` installs an agent the way Settings →
Agents does — its npm package, or its download — at the version this Codeg
pins, or at `--version`. It is installed where Codeg runs: with `--url`, on
the server. An install can take minutes: it goes on in Codeg whatever becomes
of the command, and asking again while it runs follows the same install.
`--wait` stops waiting after that long, with exit code 6. Kiro, which comes
with its own installer, is not installed this way.

## Automations

`codeg-cli automations` lists the automations saved in Codeg, and
`codeg-cli automations run ID` runs one now, as its Run now button does. It
returns once the run is under way and prints its id; `--wait DUR` waits that
long for it to end instead, then prints the agent's reply and exits 0 when
the run succeeded, 1 when it did not, and 6 when it has not ended yet. An
automation that queues a work task ends when the task is queued: `task_id`
names it, and the task's own work is no part of the run. `--json` prints the
run:

```json
{"v": 1, "type": "automation_run", "automation_id": 3, "run_id": 41, "status": "succeeded", "conversation_id": 214, "link": "codeg://session/214", "summary": "…", "error": null}
```

Of the Codegs that share a data directory, only the first to start runs
automations. `run` on another one fails with `automations_elsewhere`: pick the
right one with `--runtime`. Waiting never cancels a run.

## Several agents at once

Each `-a` and `-A` is a run of the prompt of its own, numbered from 1 in the
order written; the same one twice is two runs to compare:

```bash
git diff main | codeg-cli -a claude_code -a codex -A reviewer -p "Review this diff" -o review.md
```

- The prompt, stdin included, is read once, and the runs share `--timeout`.
  At most `--max-parallel` run at a time. Ctrl-C or SIGTERM cancels them all.
- `text` prints each reply under a line naming its run: `== #2 codex (8d0c7c2e) ==`.
  `json` prints an array of [result objects](#the-result-object), in the same
  order, each with its `target_index`. `stream-json` prints the runs' events as
  they come, told apart by `run_id`, and each run's result as it ends.
- `-o review.md` writes one file per run: `review.1-claude_code.md`,
  `review.2-codex.md`, … A character a file name cannot hold becomes `_`.
- The exit code is the first failed run's, in the order written; 0 when every
  run succeeded.
- They all work in the same directory: under `--permissions allow`, say, give
  each its own with `--worktree`. `--worktree=NAME` names them `NAME-1`,
  `NAME-2`, …
- With `--detach`, `text` prints one run id per line, in order (an empty line
  for one that did not start), and `json` an array of `init` events.
- With `--output-schema`, `text` prints one line of JSON per run instead: see
  [Structured output](#structured-output).

## Detached runs

`--detach` returns as soon as the agent has the prompt and prints the run's
id; the run goes on in Codeg. `result` collects it, `cancel` stops it:

```bash
run=$(codeg-cli --detach -a codex -p "Review the latest commit")
# … other steps …
codeg-cli result "$run" --wait 30m -o review.md
```

- `--detach` prints the id alone on stdout in `text`, and the run's `init`
  event in both JSON formats. It does not go with `-o`: the reply is not
  there yet. `--timeout` still counts: Codeg cancels the run when it runs out,
  with no `codeg-cli` left to wait for it.
- `result RUN` prints the run's result as `run` would have — the reply in
  `text`, the [result object](#the-result-object) in JSON — writes `-o FILE`,
  and exits with the run's [exit code](#exit-codes). Without `--wait` it looks
  once; with it, it waits that long for the run to finish. A run that has not
  finished by then makes it exit with code 6 and, in JSON, print a status
  instead of a result:

  ```json
  {"v": 1, "type": "status", "run_id": "8d0c7c2e-…", "state": "running", "subtype": "still_running", "conversation_id": 214, "link": "codeg://session/214"}
  ```

  `result` never cancels a run, not even when interrupted.
- `cancel RUN` cancels the run, and says whether it had already finished.
- A run is named by its id or by at least 8 characters from its start, as
  long as no other run starts the same way.
- Codeg keeps a finished run's result for 30 minutes, in memory: a Codeg that
  restarted no longer has it. The conversation itself stays in Codeg.

The same `result` collects a run whose `codeg-cli` gave up on its Codeg —
exit code 4, `runtime_lost` — once that Codeg answers again.

## Permissions

No one is watching a headless run, so `--permissions` decides what Codeg
answers when the agent asks — to run a command, edit a file, use a tool. It
answers once, never "always": an "always" answer writes a lasting rule into
your agent's own settings.

| Policy | A permission request | A question the agent asks |
| --- | --- | --- |
| `deny` (default) | Refused, this once | Declined |
| `reads` | Allowed once if it only reads or searches, refused otherwise | Declined |
| `allow` | Allowed, this once | Declined |
| `fail` | Refused, and the run ends with exit code 5 | Declined |
| `wait` | Left for you to answer in Codeg | Left for you |

When the agent offers no one-time answer of the kind needed, Codeg does not
pick a lasting one instead: `allow` refuses once, and with no one-time refusal
either, the run ends with exit code 5. A plan the agent wants approved (Grok)
is approved under `allow`, left for you under `wait`, and abandoned otherwise.
Sub-agents the run delegates to answer by the same policy.

Every request, and what became of it, is an event. The refused ones are listed
in the result's `permission_denials`, and under `deny` `codeg-cli` says on
stderr how many there were.

The agent's own mode is another matter: `--mode bypassPermissions` (Claude
Code) decides whether the agent asks at all, `--permissions` what Codeg answers
when it does.

Under `wait`, the conversation's link goes to stderr. Answer there — in the
window, or from a chat channel. `--open` brings it to the front. When
`--timeout` runs out while requests are still waiting, the result lists them
in `pending`.

**Runs an agent starts.** An agent can run `codeg-cli` too. A run started from
inside a `codeg-cli` run never gets a wider policy than that run: a
`--permissions allow` under a `deny` run becomes `deny`, and a notice says so.
Such a run cannot start another: runs nest one level deep. This guards against
mistakes, not against an agent set on getting around it. A run started from a
conversation you drive in the window keeps the policy it asks for: its command
already went through your agent's own permission check.

## Output

| `--output-format` | stdout | stderr |
| --- | --- | --- |
| `text` (default) | The final reply, nothing else. With `--output-schema`, the result's JSON on one line | Progress — tool calls, permission decisions — when stderr is a terminal or with `-v`; errors |
| `json` | One [result object](#the-result-object), at the end; with several `-a` and `-A`, an array of them | Errors and hints |
| `stream-json` | One [event](#events) per line: `init` first, the result object last | Errors and hints |

In both JSON formats stdout carries JSON only. Every exit after the arguments
were read prints a result object — a Codeg that could not be reached, a
timeout and an interrupt included — with `is_error: true` and the reason in
`subtype` and `error`. Only arguments `codeg-cli` cannot parse print nothing
but a message on stderr, with exit code 2. Scripts should look at both the
exit code and `is_error`.

**Heartbeat.** When stderr is not a terminal and nothing was written there for
a minute, a line goes there:

```text
codeg-cli: still running (12m so far, 31 tool calls)
```

A CI system that kills a job gone silent — CircleCI does after ten minutes by
default — then leaves a long review alone. `-q` turns it off.

**`-o FILE`** writes the final reply to `FILE` too, all at once: a reader
never sees half of it. A run that failed after replying writes its reply all
the same; the exit code says how it went. Without a reply the file is left as
it was. A reply that cannot be written makes a successful run's result an
error (`output_unwritable`, exit code 1). With `--output-schema` the file
holds the result's JSON instead, and is left as it was without one.

## Structured output

`--output-schema FILE` asks for the run's result as JSON matching the JSON
Schema in `FILE`, as Claude Code's `--json-schema` and Codex's
`--output-schema` do:

```bash
cat > verdict.json <<'EOF'
{
  "type": "object",
  "properties": {
    "verdict": {"enum": ["pass", "fail"]},
    "issues": {"type": "array", "items": {"type": "string"}}
  },
  "required": ["verdict", "issues"],
  "additionalProperties": false
}
EOF
git show HEAD | codeg-cli -a claude_code --output-schema verdict.json \
  -p "Review this commit" > result.json
jq -r .verdict result.json
```

The agent hands the result in with a tool Codeg gives it, `submit_result`,
whose input schema is yours. Each result is checked against the schema, and
one that does not match is refused with where it goes wrong, so the agent can
fix it and try again; after five refusals no more are taken. The last result
accepted is the run's. An agent Codeg cannot give the tool to (Pi, Cline,
OpenClaw, a custom agent with MCP turned off) is shown the schema instead and
asked to reply with the JSON; so is any agent read that way when it ends its
turn without calling the tool. Its reply is then the result when the whole
reply is JSON, or when it has one ```` ```json ```` block, checked against the
schema the same way.

- `text` prints the result's JSON on one line, and `-o FILE` writes it, with a
  line end. In the JSON formats it is the result object's `structured_output`,
  where Claude Code puts it, so a `jq '.structured_output'` reads either;
  `result` keeps the agent's reply. `codeg-cli result` gives it the same way,
  for a run started with `--detach`.
- With several `-a` and `-A` each run hands in its own. `text` prints one line
  per run, in the order written: its result's JSON, or `null` for one without,
  and each run's `== #n ==` line goes to stderr instead, so stdout holds JSON
  alone. `-o` writes a file per run.
- A turn that ends without a result that matches fails with exit code 7,
  `error_max_structured_output_retries` (the name Claude Code gives it), and
  `output_schema_unmet` says why. stdout then stays empty in `text`, and `-o`
  leaves its file as it was: nothing but that JSON ever goes there. A run that
  failed for another reason, a timeout say, keeps its own exit code.
- Each result that does not match is a `notice` event.
- `submit_result` needs no permission. An agent that asks for one before it
  calls the tool — Claude Code asks before any MCP tool — is answered "yes,
  once" by Codeg whatever `--permissions` says: the tool runs and reads
  nothing, it only hands the run its result.
- The schema is a JSON object of at most 64 KiB, and its root takes objects
  only — `"type": "object"` — since the result is handed in as a tool's
  arguments. Put a list or a single value in a property. `$schema` picks the
  draft: 2020-12 (the default), 2019-09, 7, 6 or 4; `format` is checked as the
  draft says, in draft 7 and earlier only. A `$ref` is followed within the
  schema only: nothing it names elsewhere, a file or a URL, is read. A schema
  that is not one is refused before anything starts, with exit code 2
  (`bad_output_schema`).

## Exit codes

| Code | `subtype` | |
| --- | --- | --- |
| 0 | `success` | The turn ended normally |
| 1 | `error_during_execution` | The run failed: the agent reported an error, refused, ran out of tokens or exited; or it is not installed, or not enabled |
| 2 | `error_usage` | The arguments; an agent, assistant, model, effort, mode or option that does not exist or did not take; a workspace that does not exist; an empty or too large prompt |
| 3 | `error_timeout` | `--timeout` ran out. The run was cancelled |
| 4 | `error_runtime_unavailable` | No Codeg to talk to: none is running, its proof or the token failed, it went away during the run, or the run's result is past its 30-minute retention |
| 4 | `error_runtime_access_denied` | The operating system refused the connection, a sandbox most likely |
| 4 | `error_runtime_incompatible` | That Codeg speaks another CLI API, or is too old for what was asked, `--effort` say: update whichever is older |
| 5 | `error_permission_required` | The agent needed a permission the policy does not give: `--permissions fail`, or a request with no one-time answer |
| 6 | `still_running` | `result`, `automations run` or `agents install`: what it waited for had not ended within `--wait`. It was not cancelled. Not a result: see [Detached runs](#detached-runs) |
| 7 | `error_max_structured_output_retries` | `--output-schema`: the turn ended without a result that matches the schema. See [Structured output](#structured-output) |
| 130 | `error_interrupted` | SIGINT (Ctrl-C). The run was cancelled |
| 143 | `error_interrupted` | SIGTERM, which a CI system sends a job it cancels. The run was cancelled |

Exit codes and `subtype`s are only ever added. A retired one is never given a
new meaning.

## Error codes

When `is_error` is true, the result's `error` says what went wrong:

```json
{"code": "unknown_agent", "message": "\"claud\" is not an agent", "next_steps": ["codeg-cli agents"]}
```

`code` is stable, for scripts. `message` is for people, and its wording may
change. `next_steps` are commands or actions to try, when there are any.

| `code` | `subtype` | |
| --- | --- | --- |
| `no_prompt` | `error_usage` | No prompt, and stdin is a terminal or an empty device, or `--no-stdin` keeps it from being read |
| `empty_prompt` | `error_usage` | The prompt is empty |
| `prompt_too_large` | `error_usage` | The prompt and stdin are over 10 MiB together |
| `stdin_unreadable`, `stdin_not_utf8` | `error_usage` | stdin cannot be read, or is not UTF-8 text |
| `token_missing` | `error_usage` | `--url` or `CODEG_URL` without a token |
| `token_file_unreadable` | `error_usage` | `--token-file` cannot be read |
| `workspace_required` | `error_usage` | `--url` needs `-w` |
| `no_cwd`, `bad_workspace` | `error_usage` | The workspace cannot be made an absolute path |
| `workspace_not_absolute`, `workspace_not_found` | `error_usage` | On Codeg's machine, the workspace is not an absolute path to a directory |
| `unknown_agent` | `error_usage` | No such agent |
| `agent_is_an_assistant` | `error_usage` | `--agent` was given an assistant: `next_steps` has the `--assistant` to write |
| `unknown_assistant` | `error_usage` | No enabled assistant has that name or id |
| `agent_and_assistant` | `error_usage` | Both `--agent` and `--assistant`: an assistant decides its agent |
| `no_agent` | `error_usage` | Neither, and the workspace has no default agent |
| `option_unavailable` | `error_usage` | The agent has nothing `--model`, `--effort` or `--mode` could set |
| `invalid_value`, `unknown_mode`, `unknown_config_option` | `error_usage` | A value or option the agent does not offer. The message lists what it does |
| `selection_rewritten`, `selection_refused`, `selection_not_applied`, `selection_failed`, `selection_unconfirmed` | `error_usage` | The agent did not take a `--model`, `--effort`, `--mode` or `-c` choice as asked, or did not confirm it |
| `kiro_effort_unconfirmable` | `error_usage` | `--effort` with Kiro |
| `open_unsupported` | `error_usage` | `--open` with a server, or with `--url`: it opens this computer's desktop app |
| `open_takes_no_url` | `error_usage` | `open` with `--url` |
| `nested_too_deep` | `error_usage` | A run from inside a run that is itself nested |
| `bad_data_dir` | `error_usage` | `--standalone --data-dir` with a directory that cannot be made absolute |
| `bad_run_id` | `error_usage` | `result` or `cancel` with something that is not a run id, or fewer than 8 of its characters |
| `unknown_automation` | `error_usage` | No automation has that id |
| `not_installable`, `bad_version` | `error_usage` | `agents install` of an agent with its own installer, or with a `--version` that is not one |
| `not_a_git_repository` | `error_usage` | `--worktree` with a workspace that is not in a git repository |
| `bad_worktree_name` | `error_usage` | A `--worktree` name that is not letters, digits, `.`, `_` and `-` |
| `workspace_not_in_worktree`, `worktree_unavailable` | `error_usage` | The workspace's directory is not in the repository's HEAD, there is no directory above the repository to put the worktree in, or git is older than 2.33 |
| `ambiguous_run` | `error_usage` | More than one run starts that way: `next_steps` lists them |
| `bad_nonce` | `error_usage` | A request no `codeg-cli` sends |
| `bad_output_schema` | `error_usage` | `--output-schema` names a file that cannot be read, or is not a JSON Schema whose root takes objects |
| `output_unwritable` | `error_during_execution` | The reply could not be written to `-o FILE` |
| `agent_not_installed` | `error_during_execution` | The agent is not installed: `codeg-cli agents` says how to install it |
| `agent_unavailable` | `error_during_execution` | The agent is disabled in Codeg's settings, or its settings cannot be read |
| `agent_spawn_failed` | `error_during_execution` | The agent could not be started |
| `agent_exited` | `error_during_execution` | The agent ended before its turn did |
| `selectors_timeout` | `error_during_execution` | The agent did not list its options within 30 seconds, so `--model` and the like could not be checked |
| `workspace_unavailable`, `conversation_create_failed`, `prompt_failed` | `error_during_execution` | Codeg could not read the workspace, create the conversation, or send the prompt |
| `worktree_failed` | `error_during_execution` | git could not add the worktree |
| `automation_busy`, `automation_failed`, `automations_unavailable` | `error_during_execution` | The automation is running already, or could not be started or read |
| `install_failed`, `agent_not_found_after_install` | `error_during_execution` | The install failed, or what it installed cannot be found where Codeg looks |
| `cancelled` | `error_during_execution` | The run was cancelled in Codeg |
| `run_stopped`, `run_lost` | `error_during_execution` | The run stopped before its prompt was sent |
| `stop_<reason>` | `error_during_execution` | The turn ended for another reason than finishing: `stop_max_tokens`, `stop_refusal`, `stop_max_turn_requests`, … |
| `too_many_reservations` | `error_during_execution` | Too many runs are being set up on that Codeg at once. Try again shortly |
| `agents_unavailable`, `assistants_unavailable` | `error_during_execution` | Codeg could not list them |
| `http_error` | `error_during_execution` | An unexpected HTTP answer |
| `timeout` | `error_timeout` | `--timeout` ran out |
| `runtime_unavailable` | `error_runtime_unavailable` | No Codeg is running where `codeg-cli` looked, or the one there does not answer |
| `unauthorized` | `error_runtime_unavailable` | That Codeg refused the token |
| `runtime_lost` | `error_runtime_unavailable` | Codeg stopped answering during the run. The run may still be going |
| `run_not_found`, `result_missing`, `install_not_found` | `error_runtime_unavailable` | That Codeg has no such run or install, or no result for it |
| `open_failed`, `open_timeout` | `error_runtime_unavailable` | `open` could not start the desktop app, or it did not answer in time |
| `no_server`, `standalone_failed` | `error_runtime_unavailable` | `--standalone` found no `codeg-server` to start, or the one it started did not come up |
| `data_dir_in_use` | `error_runtime_unavailable` | `--standalone`: another Codeg is alive on that data directory |
| `runtime_access_denied` | `error_runtime_access_denied` | The operating system refused the connection |
| `runtime_incompatible`, `api_version`, `bad_response`, `run_not_reserved` | `error_runtime_incompatible` | That Codeg and this `codeg-cli` do not understand each other |
| `automations_elsewhere` | `error_runtime_incompatible` | Another Codeg on the same data directory runs the automations |
| `permission_required` | `error_permission_required` | A permission the policy does not give |
| `interrupted` | `error_interrupted` | SIGINT or SIGTERM |
| `output_schema_unmet` | `error_max_structured_output_retries` | The agent handed in no result that matches `--output-schema`: `message` says what it did instead |

Codes are only ever added, too.

## Events

`--output-format stream-json` prints one JSON object per line as the run goes.
Each carries:

| Field | |
| --- | --- |
| `v` | The contract version: `1` |
| `type` | What happened (below) |
| `seq` | Increases within a run |
| `run_id` | The run. `null` only on a result for a run that never got an id |

| `type` | Fields | |
| --- | --- | --- |
| `init` | `conversation_id`, `folder_id`, `agent`, `assistant?` (`{id, name}`), `workspace`, `link`, `worktree?` (`{path, branch}`) | The conversation exists. `link` opens it: `codeg://session/<id>`. `workspace` is where the agent works |
| `session` | `session_id`, `launch` | The agent started. `session_id` is the agent's own id for the session |
| `message_delta` | `text` | Reply text. Consecutive pieces arrive merged |
| `tool_call` | `id`, `title`, `kind`, `status` | The agent called a tool |
| `tool_call_update` | `id`, `title?`, `status?` | A tool call changed |
| `plan` | `entries` (`[{content, status}]`) | The agent's plan |
| `permission` | `request_id`, `conversation_id`, `tool`, `tool_kind?`, `decision`, `decided_by?`, `option_name?` | A permission request. `decision`: `allowed`, `denied`, `waiting`, `failed`, `withdrawn`. `decided_by`: `policy`, `user`, `withdrawn` |
| `question` | `question_id`, `conversation_id`, `decision` | A question the agent asked. `decision`: `declined`, `waiting` |
| `notice` | `severity`, `title`, `message?` | Something worth knowing, e.g. a policy that was narrowed, or a result `submit_result` refused |
| `error` | `message`, `code?` | An error during the run. The result says how the run ended |
| `gap` | — | Some events were lost: they were older than what Codeg keeps |
| `result` | See [below](#the-result-object) | The last event |

A `permission` or `question` whose `conversation_id` is not the run's came
from a sub-agent the run delegated to. `?` marks a field that may be missing.

The heartbeat is not an event: it only ever goes to stderr.

### The result object

The last event of a run, and all that `--output-format json` prints. Its shape
is the one Claude Code, Cursor and others print, so a `jq '.result'` written for
them reads it too.

```json
{
  "v": 1,
  "seq": 42,
  "run_id": "8d0c7c2e-3f0b-4a5e-9c1b-6f2d1e0a7b44",
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "result": "The commit looks good. Two things to look at: …",
  "session_id": "9f1e2d3c-…",
  "stop_reason": "end_turn",
  "duration_ms": 48210,
  "permission_denials": [],
  "launch": {
    "requested": {"model": "opus"},
    "effective": {"model": "opus", "mode": "default"}
  },
  "conversation_id": 214,
  "link": "codeg://session/214"
}
```

| Field | |
| --- | --- |
| `subtype`, `is_error` | How the run ended. See [Exit codes](#exit-codes) |
| `result` | The agent's final reply, or `null` |
| `session_id` | The agent's own session id, or `null` |
| `stop_reason` | Why the turn ended, as the agent said: `end_turn`, `cancelled`, `max_tokens`, … |
| `duration_ms` | How long the run took |
| `permission_denials` | `[{tool_name, tool_kind?, request_id, conversation_id?}]`: what was refused |
| `launch` | `requested` and `effective`: the `model`, `effort` and `mode` asked for, and those in effect. `unconfirmed` names any the agent accepted without confirming |
| `pending` | Under `--permissions wait`: `[{request_id, conversation_id?, tool}]`, the requests, questions and plan approvals still waiting when `--timeout` ended the run |
| `target_index?` | With several `-a` and `-A`: which run this is, from 1 |
| `conversation_id`, `link` | The conversation in Codeg |
| `agent`, `assistant?` | The agent that ran, and the assistant (`{id, name}`) it ran as. Missing when the run failed before its agent was known |
| `worktree?` | With `--worktree`: `{path, branch}` of the worktree the run worked in |
| `structured_output?` | With `--output-schema`: the result the agent handed in, which matches the schema, or `null` when there is none. Missing without `--output-schema` |
| `error` | When `is_error`: `{code, message, next_steps}`. See [Error codes](#error-codes) |

A run that failed before Codeg took it — no Codeg to reach, or arguments
`codeg-cli` itself refused — has `null` for `run_id`. One that failed before
its conversation existed has `null` for `conversation_id` and `link`, and
`stream-json` then prints the result alone, without `init`.

**Compatibility.** Fields and event types are only ever added. An existing
field never changes its meaning or its type. Ignore fields and event types you
do not know: newer Codegs send more.

## In CI

The shortest way on a fresh runner is a server of the command's own:

```bash
curl -fsSL https://raw.githubusercontent.com/spacering-net/codeg/main/install.sh | bash
export ANTHROPIC_API_KEY="..."   # from the CI system's secrets
codeg-cli --standalone agents install claude_code
git show HEAD | codeg-cli --standalone -a claude_code -w "$PWD" --timeout 30m \
  -p "Review this commit for bugs" -o review.md
```

`--standalone` starts the `codeg-server` installed next to `codeg-cli` (or on
PATH) on a fresh temporary data directory, listening on this machine only;
runs the command there; and stops the server and removes the directory when
the command ends. Killed outright (`kill -9`), the command still takes its
server down with it, but leaves the temporary directory. The agents it starts get
the command's environment, credentials included. Each command starts from
nothing: an npm agent stays installed (npm keeps it), but settings, assistants
and downloaded agents do not. `--data-dir DIR` keeps them in `DIR` between
commands instead. It never starts on its own: when `codeg-cli` cannot reach a
Codeg it says so, and nothing else happens.

A data directory is never shared with a `--standalone` server. One that finds
another Codeg alive on its `--data-dir` — even one that cannot be reached —
stops before touching anything, with `data_dir_in_use`. A `codeg-server`
started on a directory a `--standalone` server holds waits for it; the
desktop app says so and quits. Only a Codeg that ships `codeg-cli` is seen
this way: an older desktop app or `codeg-server` on the same directory is
not, and does not see a `--standalone` server either — keep `--data-dir`
away from a directory one of them uses. `--standalone` does not go with
`--url`, `--detach`, `result`, `cancel` or `open`: its server is gone when the
command is. For the same reason `automations run` waits for its run to end,
and `agents install` for the install, so `--wait` does not go with it either.

A CI job can also use a `codeg-server` that runs elsewhere, with `--url` and
its token, or start one of its own that several commands share. A fresh
runner:

```bash
set -e

# 1. codeg-server and codeg-cli
curl -fsSL https://raw.githubusercontent.com/spacering-net/codeg/main/install.sh | bash

# 2. A server for this job alone: its own data directory, loopback only. The
#    agents it starts inherit its environment, credentials included.
export CODEG_DATA_DIR="$(mktemp -d)"
export CODEG_HOST=127.0.0.1 CODEG_PORT=3080
export CODEG_TOKEN="$(openssl rand -hex 32)"
export ANTHROPIC_API_KEY="..."   # from the CI system's secrets
codeg-server > "$CODEG_DATA_DIR/server.log" 2>&1 &
export CODEG_URL="http://127.0.0.1:$CODEG_PORT"
for _ in $(seq 60); do codeg-cli status > /dev/null 2>&1 && break; sleep 1; done
codeg-cli status   # fails the job, saying why, if the server did not come up

# 3. The agent, installed by that server as its settings page would.
codeg-cli agents install claude_code

# 4. The run
git show HEAD | codeg-cli -a claude_code -w "$PWD" --timeout 30m \
  -p "Review this commit for bugs" -o review.md
```

`CODEG_URL` and `CODEG_TOKEN` point `codeg-cli` at that server, as `--url`
and `--token-file` would. The prompt carries the commit on stdin, because
under the default `--permissions deny` the agent cannot run `git` itself.
`--permissions reads` lets it read the rest of the checkout.

In GitHub Actions:

```yaml
- name: Review the commit
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
    CODEG_DATA_DIR: ${{ runner.temp }}/codeg
    CODEG_HOST: 127.0.0.1
    CODEG_PORT: "3080"
  run: |
    curl -fsSL https://raw.githubusercontent.com/spacering-net/codeg/main/install.sh | bash
    export CODEG_TOKEN="$(openssl rand -hex 32)"
    codeg-server > "$RUNNER_TEMP/codeg-server.log" 2>&1 &
    export CODEG_URL="http://127.0.0.1:$CODEG_PORT"
    for _ in $(seq 60); do codeg-cli status > /dev/null 2>&1 && break; sleep 1; done
    codeg-cli status
    codeg-cli agents install claude_code
    git show HEAD | codeg-cli -a claude_code -w "$GITHUB_WORKSPACE" --timeout 30m \
      --permissions reads -p "Review this commit for bugs" -o review.md
```

The step fails when the run does: the exit code is non-zero for anything but
a finished turn. To let it pass and decide from the result, add
`--output-format json` and read `subtype`. To decide on what the agent found,
have it hand in a verdict with `--output-schema`: see
[Structured output](#structured-output).

## Security

- **This computer only.** A Codeg's `codeg-cli` port listens on `127.0.0.1`
  and serves nothing but the run API and a health check: no web interface, no
  other API. It
  accepts only `Host: 127.0.0.1` and `localhost`, so a web page cannot reach it
  by DNS rebinding. The desktop app's web service is a different thing, off
  by default.
- **A key per launch.** Each start of Codeg makes a new key and keeps it in the
  endpoint file only — never in the database. The file and its folder are
  readable by your user alone from the moment they exist (`0700`/`0600`, an
  owner-only access list on Windows). A folder found otherwise — another
  user's, one others may read, or on macOS one with an access list (say,
  inherited from the folder above) — is refused and left as it is: Codeg
  then publishes nothing, and Settings shows why. `codeg-cli` in turn reads
  only an endpoint file that is your own, and that no one else may write.
- **Proof before anything is sent.** A file left by a crash may name a port
  another program now holds. `codeg-cli` first asks whoever answers to prove it
  knows the key, bound to that port, and sends the key and the prompt only to
  one that does.
- **The same trust as your files.** Any program running as you can read the
  endpoint file, and so run agents as you. It could as well read Codeg's
  database or start an agent itself: the boundary is your user account.
- **Remote.** `--url` uses the server's own token, as the web interface does,
  and is allowed nothing the web interface is not. Prefer HTTPS. A `--url` to
  this machine (`127.0.0.1`, `localhost`) never goes through a proxy, and a
  user name or password in the URL is never printed. Switching Command-line
  access off closes the local port; it does not change what the token allows.
- **Nested runs** are kept to one level and to their parent's policy (see
  [Permissions](#permissions)) — against accidents, not as a security
  boundary.
