# droid-mcp

An MCP server that lets any MCP client (Droid, Claude Code, Cursor, other agents) find, start, steer and read Factory Droid sessions on every Droid computer you have, including mission/workstream orchestrators and their agents. It reads local session files, runs its own sessions through `@factory/droid-sdk`, and reaches sessions on every other online Droid computer (your own computers and Factory cloud computers) through the Factory REST API when an API key is available.

Droids can also call back. In HTTP mode, a hook on each computer posts an event to the server's `POST /events` when a session finishes, asks a question, needs a permission or ends. The server keeps recent events for `droid_events` and forwards events from subscribed sessions to a webhook that wakes your agent.

Status: early (0.1.0). Tested on macOS with droid CLI 1.10.0, `@factory/droid-sdk` 0.11.0 and Node 26 (`engines` requires Node >= 24). The only platform-specific server code is the Keychain lookup for secrets (`FACTORY_API_KEY`, the events token, the webhook URL and key), which runs only on `darwin`; elsewhere they must come from the environment. Linux is untested.

## Install & set up

### 1. Check the prerequisites

You need Node >= 24, the `droid` CLI installed and logged in, and `git` and `rg` on your `PATH`.

```sh
node --version    # v24 or later
droid --version
git --version
rg --version
```

To install `droid`, follow the [Factory CLI quickstart](https://docs.factory.com/droid-cli/quickstart). Log in by running `droid` once.

Many MCP clients start servers with a minimal `PATH`. If the server cannot find `droid` or `rg`, pass a `PATH` that contains them when you connect the client (step 4).

### 2. Clone and install

```sh
git clone https://github.com/Jason-Holt-Digital/droid-mcp.git
cd droid-mcp
npm ci
npm run typecheck
npm test
```

### 3. Optional: add a `FACTORY_API_KEY`

Without a key, the server works with local session files and the sessions it starts itself, using your droid CLI login. A key enables the REST backend, which lists your Droid computers and reaches sessions on every other online computer (your own and Factory cloud computers), sessions held by the desktop app, and workstream sessions. When a key is found, spawned sessions also use it instead of the CLI login.

Create a key on the [API Keys page](https://app.factory.ai/settings/api-keys) in Factory settings. Then give it to the server in one of two ways:

- Set `FACTORY_API_KEY=<key>` in the server's environment, for example next to `PATH` in the client's `env` settings. This is the only option outside macOS.
- On macOS, store it in the Keychain. The server looks there when `FACTORY_API_KEY` is not set:

  ```sh
  security add-generic-password -s droid-mcp -a FACTORY_API_KEY -w   # prompts for the key
  ```

The key is read once at startup; restart the server after changing it.

### 4. Connect a client over stdio

`DROID_MCP_ROOTS` lists the directories sessions may start in (colon-separated, default `~/repos`). Set it to where your projects live, or `droid_start` refuses them.

Droid:

```sh
droid mcp add droid-mcp node /path/to/droid-mcp/src/main.ts --env PATH=/path/to/bin:/usr/bin:/bin --env DROID_MCP_ROOTS=/path/to/projects
```

Claude Code:

```sh
claude mcp add droid-mcp -e PATH=/path/to/bin:/usr/bin:/bin -e DROID_MCP_ROOTS=/path/to/projects -- node /path/to/droid-mcp/src/main.ts
```

Cursor (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "droid-mcp": {
      "command": "node",
      "args": ["/path/to/droid-mcp/src/main.ts"],
      "env": { "PATH": "/path/to/bin:/usr/bin:/bin", "DROID_MCP_ROOTS": "/path/to/projects" }
    }
  }
}
```

### 5. Optional: run over HTTP

Generate a token and start the server:

```sh
openssl rand -hex 32
DROID_MCP_TOKEN=<token> node src/main.ts --http 127.0.0.1:37999
```

Use `http://127.0.0.1:37999/mcp` as the endpoint (the server answers on any path) with the header `Authorization: Bearer <token>`:

```sh
droid mcp add droid-mcp http://127.0.0.1:37999/mcp --type http --header "Authorization: Bearer <token>"
claude mcp add --transport http droid-mcp http://127.0.0.1:37999/mcp -H "Authorization: Bearer <token>"
```

#### Run it as a service on macOS (launchd)

Create the directory, readable only by you:

```sh
mkdir -p -m 700 ~/.droid-mcp
```

Create a wrapper script at `~/.droid-mcp/run.sh` that sets the environment and starts the server:

```sh
#!/bin/sh
export PATH=/path/to/bin:/usr/bin:/bin
export DROID_MCP_TOKEN=<token>
cd /path/to/droid-mcp
exec node src/main.ts --http 127.0.0.1:37999
```

Make the script executable and private, so the token is not world-readable:

```sh
chmod 700 ~/.droid-mcp/run.sh
```

Create `~/Library/LaunchAgents/com.example.droid-mcp.plist`. launchd does not expand `~`, so use full paths:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.example.droid-mcp</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/<you>/.droid-mcp/run.sh</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardErrorPath</key>
  <string>/Users/<you>/.droid-mcp/server.log</string>
</dict>
</plist>
```

Load it, and restart it after changes:

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.droid-mcp.plist
launchctl kickstart -k gui/$(id -u)/com.example.droid-mcp
```

#### Run it as a service on Linux (systemd, untested)

Linux is untested, so treat this as a starting point. Create the directory and make sure only you can read it, even if it already existed:

```sh
mkdir -p ~/.droid-mcp && chmod 700 ~/.droid-mcp
umask 077
```

Then put the environment in `~/.droid-mcp/env`. Outside macOS, the API key can only come from the environment, so it goes here too; leave out the last line if you do not use a key:

```sh
PATH=/path/to/bin:/usr/bin:/bin
DROID_MCP_TOKEN=<token>
FACTORY_API_KEY=<key>
```

```sh
chmod 600 ~/.droid-mcp/env
```

Create the unit directory, then `~/.config/systemd/user/droid-mcp.service`:

```sh
mkdir -p ~/.config/systemd/user
```

```ini
[Unit]
Description=droid-mcp

[Service]
EnvironmentFile=%h/.droid-mcp/env
WorkingDirectory=/path/to/droid-mcp
ExecStart=/path/to/node /path/to/droid-mcp/src/main.ts --http 127.0.0.1:37999
Restart=on-failure

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now droid-mcp
```

#### Reach it from other machines on a tailnet

Put it behind `tailscale serve`:

```sh
tailscale serve --bg --https=8443 http://127.0.0.1:37999
```

The endpoint is then `https://<your-host>.<tailnet>.ts.net:8443/mcp`. The bearer token is still required.

### 6. Verify it works

From the repo directory, use the MCP Inspector CLI. List the tools:

```sh
npx -y @modelcontextprotocol/inspector --cli node src/main.ts --method tools/list
```

Expect 12 tools: `droid_find`, `droid_computers`, `droid_events`, `droid_subscribe`, `droid_unsubscribe`, `droid_models`, `droid_start`, `droid_send`, `droid_wait`, `droid_respond`, `droid_cancel`, `droid_result`.

Call three read-only tools:

```sh
npx -y @modelcontextprotocol/inspector --cli node src/main.ts --method tools/call --tool-name droid_models --tool-arg filter=opus
npx -y @modelcontextprotocol/inspector --cli node src/main.ts --method tools/call --tool-name droid_computers
npx -y @modelcontextprotocol/inspector --cli node src/main.ts --method tools/call --tool-name droid_find --tool-arg limit=5
```

Then, from a connected client, ask it to call `droid_computers` and `droid_find`. Both are read-only and spend no model tokens.

### 7. Optional: callbacks from every computer

Callbacks need HTTP mode (step 5). A hook on each computer posts events to `https://<host>/events`; see [Callbacks](#callbacks) for what it sends.

Create an events token. It is separate from `DROID_MCP_TOKEN`; use a different value. On macOS, store it in the Keychain:

```sh
security add-generic-password -s droid-mcp -a EVENTS_TOKEN -w "$(openssl rand -hex 32)"
security find-generic-password -s droid-mcp -a EVENTS_TOKEN -w   # prints it, for the installers below
```

Elsewhere, or instead, set `DROID_MCP_EVENTS_TOKEN=<token>` in the server's environment (for example in `~/.droid-mcp/run.sh` or `~/.droid-mcp/env`). Restart the server. Until the token is set, a `POST /events` that carries a token answers 404. Tokenless posts from the [doorbell plugin](#doorbell-plugin) do not need it.

Then install the hook on every computer that runs Droid sessions, with the same token. Run the installer from a clone of this repo on that computer.

macOS and Linux (needs `python3`):

```sh
DROID_MCP_EVENTS_TOKEN=<token> python3 scripts/install_hooks.py --url https://<host>/events
python3 scripts/install_hooks.py --url https://<host>/events --token-stdin < token.txt   # or read it from stdin
python3 scripts/install_hooks.py --url https://<host>/events                            # or type it at a hidden prompt
python3 scripts/install_hooks.py --uninstall
```

On the machine that runs the server, the URL can be `http://127.0.0.1:<port>/events`.

Windows (PowerShell 5.1 or later; the token comes from `DROID_MCP_EVENTS_TOKEN`, `-TokenStdin` or a hidden prompt):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-hooks.ps1 -Url https://<host>/events
powershell -ExecutionPolicy Bypass -File scripts\install-hooks.ps1 -Uninstall
```

What the installer changes:

- Copies the hook script to `~/.factory/droid-mcp/`.
- Writes `~/.factory/droid-mcp/hook.json` with the URL and token, mode 600 (on Windows, readable only by the current user). The token is never printed.
- Adds the hook for `Stop`, `Notification` and `SessionEnd` to `~/.factory/hooks.json`, keeping your other hooks and saving a timestamped backup first.
- Running it again replaces its own entries instead of adding more. `--uninstall` / `-Uninstall` removes them and the `~/.factory/droid-mcp/` directory.

New sessions pick the hook up. Droid snapshots hooks at startup, so a session that was already running may need a restart.

Each computer must reach the server URL. Over a tailnet, `tailscale serve` (step 5) gives `https://<your-host>.<tailnet>.ts.net:8443/events`. A Factory cloud computer needs a network route to that URL too.

Optionally, forward events to a webhook, for example a Grok Bot webhook routine. Set both:

- `DROID_MCP_WEBHOOK_URL` (or Keychain account `WEBHOOK_URL`): where to POST each forwarded event.
- `DROID_MCP_WEBHOOK_KEY` (or Keychain account `WEBHOOK_KEY`): sent as `Authorization: Bearer <key>` and `X-Automation-Key: <key>`.

Each forward has an 8 s timeout and one try. Failures go to the server log. Restart the server after changing either value.

## Doorbell plugin

This repo is also a Factory plugin marketplace with one plugin, `droid-mcp` (in `plugin/`). It hooks `Stop`, `Notification` and `SessionEnd`, and each hook runs one `curl` call that posts the hook's stdin JSON, unchanged, to the server's `/events`. It sends no token and runs no script.

Install it on each computer:

```sh
droid plugin marketplace add Jason-Holt-Digital/droid-mcp
droid plugin install droid-mcp@droid-mcp --scope user
```

Then write the server URL to `~/.factory/droid-mcp.curlrc`, a curl config file with one line:

```text
url = "http://<server>:<port>/events"
```

Check it with `droid plugin list --scope user`, which shows `droid-mcp@droid-mcp` as `Enabled`. New sessions pick the hooks up. The hook waits at most 3 s, prints nothing and always exits 0, so a missing curlrc or a down server does not show in the session.

The server accepts these tokenless posts and checks each one with Factory before it forwards anything; see [Callbacks](#callbacks). Until the plugin is rolled out, the token-based hooks and installers from step 7 stay. Windows is unverified: which shell Droid uses for hook commands there is not documented, and in Windows PowerShell 5.1 `curl` is an alias for `Invoke-WebRequest`.

## Configuration

- `FACTORY_API_KEY` (default unset): enables the REST backend (other computers, workstream children), and is used for spawned sessions instead of the CLI login. On macOS, the server falls back to the Keychain (step 3).
- `DROID_MCP_ROOTS` (default `~/repos`): colon-separated directories a session cwd must resolve inside.
- `DROID_MCP_MAX_AUTONOMY` (default `high`): autonomy cap, one of `off`, `low`, `medium`, `high`; any other value means `off`.
- `DROID_MCP_TOKEN` (default unset): bearer token for the MCP endpoint; required with `--http`.
- `DROID_MCP_EVENTS_TOKEN` (default unset): bearer token for the token hooks' `POST /events`; the doorbell plugin does not use it. On macOS, falls back to Keychain account `EVENTS_TOKEN` (step 7).
- `DROID_MCP_WEBHOOK_URL` (default unset): webhook that receives forwarded events. Falls back to Keychain account `WEBHOOK_URL`.
- `DROID_MCP_WEBHOOK_KEY` (default unset): key sent to the webhook; forwarding needs both URL and key. Falls back to Keychain account `WEBHOOK_KEY`.

## How the tools fit together

```text
Discover               Start or steer          Follow and approve                        Read or stop
droid_computers  ─┐
droid_find       ─┤    droid_start ─┐          droid_wait ── pending prompt? ──► droid_respond
droid_models     ─┴──► droid_send  ─┴─► turn ─► droid_wait ── state "idle" ─────► droid_result
                                        runs in                                   droid_cancel
                                        background

Callback           hook on any computer ─► POST /events ─► droid_events or webhook ─► droid_send, droid_respond
```

Terms used below:

- **Workstream (mission):** a multi-agent Factory session: one **orchestrator** plus child **agent** sessions, tagged `mission-v2`.
- **Own session:** a session currently running inside this server, either started with `droid_start` or resumed locally by `droid_send`. It stays own until it is closed.
- **Autonomy:** what the agent in a session may do without asking: `off` < `low` < `medium` < `high`.
- **Pending prompt:** a permission request or AskUser question waiting for `droid_respond` (listed in `attention`).
- **Own session state:** the `state` (`status` from `droid_send`, `run` in `droid_find`) of an own session, one of five (`src/runs.ts`):
  - `working`: a turn is running.
  - `needs_you`: the turn is paused on a pending prompt.
  - `idle`: the turn ended and the droid process is still alive.
  - `dead`: the droid process exited or its connection failed without this server closing it. Pending prompts are cancelled, and the next `droid_send` resumes it from its transcript in a new process.
  - `closed`: closed with `droid_cancel` scope `session`, by auto-close, or at server shutdown.

## Access at a glance

The server uses three backends and accepts events from hooks. Each edge is labeled with the credential it needs.

```mermaid
flowchart LR
  client["MCP client"] -->|"stdio, or HTTP with<br/>DROID_MCP_TOKEN"| server["droid-mcp"]
  server -->|"read-only<br/>no credential"| files[("Local session files<br/>~/.factory/sessions<br/>~/.factory/settings.json")]
  server -->|"@factory/droid-sdk<br/>FACTORY_API_KEY if found,<br/>else droid CLI login"| exec["droid exec child process"]
  exec -->|"writes"| files
  server -->|"FACTORY_API_KEY"| rest["Factory REST API<br/>https://api.factory.ai"]
  rest --> computers["Every online Droid computer:<br/>your own computers (daemon, desktop app)<br/>and Factory cloud computers"]
  hooks["Hook on each computer<br/>Stop, Notification, SessionEnd"] -->|"POST /events<br/>DROID_MCP_EVENTS_TOKEN"| server
  server -->|"DROID_MCP_WEBHOOK_KEY<br/>optional"| webhook["Webhook<br/>wakes your agent"]
  server --> helpers["Helpers: git diff HEAD (diffs),<br/>rg (transcript search),<br/>droid exec --help (model list)"]
```

Sessions this server starts live in memory. When the stdio client disconnects, or the process gets SIGINT or SIGTERM, the server closes all of them. After a restart they are ordinary local sessions.

A session started with `droid_start` (including a fork) closes itself after 30 minutes in `idle`. The timer starts when a turn ends and stops on the next send, on close, or when the process dies; a `working` or `needs_you` turn is never timed out. The `state` event reads `closed after 30 min idle`. Sessions resumed from your own local sessions are never auto-closed. Auto-close only stops the process: the session stays resumable with `droid_send` (`src/runs.ts`).

### Tools

"Read-only" means the tool is registered with `readOnlyHint: true` (`src/tools.ts`). All results are JSON text, trimmed to about 8 KB; `droid_wait` event text is clipped at 4000 characters with `truncated: true`.

The `computer` parameter of `droid_send`, `droid_wait`, `droid_respond`, `droid_cancel` and `droid_result` takes a name or id from `droid_computers`. Without it, the tool uses the computer where `droid_find` or a posted event last saw the session, or else this machine. If that computer is offline, the call fails at once with its last heartbeat time instead of hanging. A paused cloud computer is allowed.

#### droid_find

![read-only](https://img.shields.io/badge/read--only-2ea44f) ![no model tokens](https://img.shields.io/badge/no%20model%20tokens-2ea44f) ![FACTORY_API_KEY optional](https://img.shields.io/badge/FACTORY__API__KEY-optional-lightgrey)

- Reads: session headers and settings on this machine; the session list of every other online computer over REST (first 100 sessions per computer); transcripts when `content: true`; child sessions of listed workstreams when a key is set. Changes nothing.
- Backend: local files (`~/.factory/sessions`), `rg`, Factory REST API (optional).
- Credential: none for this machine; `FACTORY_API_KEY` for other computers and the child-session summary.
- Parameters: `query`, `content`, `scope` (`workstreams`, `sessions`, `all`), `cwd`, `computer`, `includeArchived`, `includeSubagents`, `limit` (1-200, default 40), `cursor`.
- Notes:
  - Asks every online computer at once, with an 8 s timeout per computer. A slow or failing computer does not fail the call.
  - The `computers` field reports `searched`, `skipped` (paused or offline, with last heartbeat), `failed` (with the error) and `truncated` (computers with more than 100 sessions, of which only the first 100 are listed).
  - `computer` limits the search to one computer.
  - Groups workstreams (orchestrator first, then agents) across computers. Standalone sessions are grouped by repo on this machine and by computer elsewhere. Each session names its computer, and the server remembers it for the other tools.
  - `query` matches title, id prefix or cwd. With `content: true` it searches transcripts with `rg -F` (40 s timeout) on this machine only, and other computers are not searched.
  - Hidden by default: archived sessions and subagents.
  - With a key, each listed workstream gets a `children` summary from REST, including agents on other computers.
  - Subscribed sessions carry `subscribed: true`.

#### droid_computers

![read-only](https://img.shields.io/badge/read--only-2ea44f) ![no model tokens](https://img.shields.io/badge/no%20model%20tokens-2ea44f) ![FACTORY_API_KEY optional](https://img.shields.io/badge/FACTORY__API__KEY-optional-lightgrey)

- Reads: your computer list from REST; `~/.factory/computer.json` to know which one is this machine. Changes nothing.
- Backend: Factory REST API.
- Credential: `FACTORY_API_KEY`; without it, the list holds only this machine.
- Parameters: none.
- Notes:
  - Returns `id`, `name`, `kind` (`own`, `cloud`), `state` (`online`, `paused`, `offline`), `lastSeen`, `thisMachine` and `providerStatus` for each computer. See [Computers and online state](#computers-and-online-state).
  - Always fetches a fresh list; other tools reuse a list for up to 30 s.
  - When several computers share a name, tools refuse that name and list the matching ids; pass an id instead.

#### droid_events

![read-only](https://img.shields.io/badge/read--only-2ea44f) ![no model tokens](https://img.shields.io/badge/no%20model%20tokens-2ea44f) ![HTTP mode](https://img.shields.io/badge/needs-HTTP%20mode-lightgrey)

- Reads: the last 500 events from hooks and doorbell rings posted to `POST /events`. Changes nothing.
- Backend: in-memory event ring.
- Credential: none for the tool; token hooks post with `DROID_MCP_EVENTS_TOKEN`, doorbell rings with no token.
- Parameters: `after`, `limit` (1-200, default 50), `kinds` (`finished`, `question`, `permission`, `ended`).
- Notes:
  - Without `after`, returns the latest events. With it, returns events after that `seq`, oldest first. It does not wait; pass `nextAfter` back as `after`.
  - Each event has `seq`, `at`, `computer`, `sessionId`, `kind`, `title`, `text`, `cwd`, `tags` and `forwarded`.
  - `missed: true` means events after `after` already dropped out of the ring; an `after` ahead of the log (after a server restart) restarts from the oldest kept event and sets `missed`. `forwarding` says whether a webhook is configured.
  - Anyone who can reach `/events` can ring. A ring for an unsubscribed session costs no Factory call and only adds an unforwarded line to `droid_events`; for a subscribed one, the server forwards only what Factory or its own run confirms.
- Event text is untrusted session content. See [Callbacks](#callbacks).

#### droid_subscribe and droid_unsubscribe

![no model tokens](https://img.shields.io/badge/no%20model%20tokens-2ea44f) ![no credential](https://img.shields.io/badge/no%20credential-lightgrey)

- Changes: adds or removes a session in `~/.droid-mcp/subscriptions.json`. Only subscribed sessions' events wake your agent through the webhook; see [Callbacks](#callbacks).
- Parameters: `session`.
- Notes: return `sessionId` and `subscribed`. Both are idempotent. The agent should subscribe to a session you run yourself only when you ask it to.

#### droid_models

![read-only](https://img.shields.io/badge/read--only-2ea44f) ![no model tokens](https://img.shields.io/badge/no%20model%20tokens-2ea44f) ![no credential](https://img.shields.io/badge/no%20credential-lightgrey)

- Reads: built-in models, aliases and wildcards; `customModels` in settings. Changes nothing.
- Backend: `droid exec --help` (cached 60 s), `~/.factory/settings.json`.
- Credential: none.
- Parameters: `filter`, `include` (`builtin`, `custom`, `aliases`).
- Notes: returns built-in ids with supported efforts, custom models, tier aliases, version wildcards and the default model.

#### droid_start

![spends model tokens](https://img.shields.io/badge/spends%20model%20tokens-d73a49) ![edits files](https://img.shields.io/badge/edits%20files-dbab09) ![FACTORY_API_KEY or CLI login](https://img.shields.io/badge/FACTORY__API__KEY-or%20CLI%20login-lightgrey)

- Reads: model list, `~/.droid-mcp/state.json`, the fork source (with `fork`).
- Changes: creates a session; the agent edits files in `cwd` up to the granted autonomy. Writes `~/.droid-mcp/state.json` and subscribes to the session in `~/.droid-mcp/subscriptions.json`.
- Backend: `droid exec` child process spawned through the SDK.
- Credential: `FACTORY_API_KEY` if found, otherwise the droid CLI login.
- Parameters: `cwd`, `prompt`, `idempotencyKey` (required), `autonomy`, `subscribe` (default `true`), settings (see [Models and settings](#models-and-settings)).
- Notes: returns `sessionId` and `state`. The turn runs in the background; follow it with `droid_wait`. A retry with the same key keeps the first call's `subscribe` choice.

#### droid_send

![spends model tokens](https://img.shields.io/badge/spends%20model%20tokens-d73a49) ![sends as the user](https://img.shields.io/badge/sends%20as%20the%20user-dbab09) ![FACTORY_API_KEY for REST](https://img.shields.io/badge/FACTORY__API__KEY-for%20REST-lightgrey)

- Reads: target session settings, model list, `~/.droid-mcp/state.json`.
- Changes: sends a prompt as the user; changes model, tools and autonomy; may resume a local session. Writes `~/.droid-mcp/state.json`.
- Backend: own child process, Factory REST API, or a new `droid exec` (local resume).
- Credential: own session's existing connection; `FACTORY_API_KEY` for REST; CLI login for local resume (only reachable without a key).
- Parameters: `session`, `computer`, `prompt`, `idempotencyKey` (required), `mode` (`queue`, `interrupt`), `allowLocalResume`, `autonomy`, settings.
- Notes: returns `via` (`own`, `local-resume`, `rest`), `nextSeq` for own and resumed sessions, `messageId` for REST. `queue` is refused while a turn is running. A `dead` own session is resumed under the same `sessionId` before the prompt is sent.

#### droid_wait

![read-only](https://img.shields.io/badge/read--only-2ea44f) ![no model tokens](https://img.shields.io/badge/no%20model%20tokens-2ea44f) ![FACTORY_API_KEY for REST](https://img.shields.io/badge/FACTORY__API__KEY-for%20REST-lightgrey)

- Reads: new events, local transcript messages (user and assistant text only), or REST messages and pending prompts. Changes nothing.
- Backend: in-memory event log, local transcript, Factory REST API. Polls every 1 s (local file) or 2 s (REST).
- Credential: none for local; `FACTORY_API_KEY` for REST.
- Parameters: `session`, `computer`, `afterSeq`, `waitMs` (default 25000, max 50000), `maxEvents` (1-200, default 50).
- Notes:
  - Without `afterSeq`, returns the latest events at once. With it, waits for an assistant message, prompt, error or state change.
  - `attention` lists pending prompts with their `requestId` (`null` for local transcript reads).

#### droid_respond

![lets a paused turn spend tokens](https://img.shields.io/badge/lets%20a%20paused%20turn%20spend%20tokens-dbab09) ![FACTORY_API_KEY if not own](https://img.shields.io/badge/FACTORY__API__KEY-if%20not%20own-lightgrey)

- Reads: pending prompts.
- Changes: answers or cancels a permission prompt or AskUser question, which lets a paused turn continue and spend tokens.
- Backend: own child process or Factory REST API.
- Credential: none for own sessions; `FACTORY_API_KEY` otherwise.
- Parameters: `session`, `computer`, `requestId`, then `decision` and `comment`, or `answers` (one per question), or `cancel`.
- Notes: `decision` must be one of the offered options.

#### droid_cancel

![stops token spend](https://img.shields.io/badge/stops%20token%20spend-2ea44f) ![interrupts or closes](https://img.shields.io/badge/interrupts%20or%20closes-dbab09) ![FACTORY_API_KEY if not own](https://img.shields.io/badge/FACTORY__API__KEY-if%20not%20own-lightgrey)

- Reads: nothing.
- Changes: interrupts a turn; closes an own session.
- Backend: own child process or Factory REST API.
- Credential: none for own sessions; `FACTORY_API_KEY` otherwise (`scope: "turn"` only).
- Parameters: `session`, `computer`, `scope` (`turn`, `session`).
- Notes: `scope: "session"` works only for own sessions.

#### droid_result

![read-only](https://img.shields.io/badge/read--only-2ea44f) ![no model tokens](https://img.shields.io/badge/no%20model%20tokens-2ea44f) ![FACTORY_API_KEY if not on this machine](https://img.shields.io/badge/FACTORY__API__KEY-if%20not%20on%20this%20machine-lightgrey)

- Reads: latest result text; `git diff HEAD` in the session's cwd. Changes nothing.
- Backend: in-memory result, local transcript, Factory REST API, `git`.
- Credential: none for local; `FACTORY_API_KEY` for sessions not on this machine.
- Parameters: `session`, `computer`, `include` (`text`, `diff`), `offset`, `maxBytes` (1-32768, default 6000).
- Notes: paged by byte offset; pass `nextOffset` back as `offset`.

### Which backend a call uses

It depends on the target session (`src/route.ts`, `src/tools.ts`):

```mermaid
flowchart TD
  target["target session"] --> own{"own session?"}
  own -->|yes| ownBox["Own child process<br/>all tools; droid_cancel can close it;<br/>droid_result: last result and diff"]
  own -->|no| here{"on this machine?"}
  here -->|no| keyRemote{"key set?"}
  keyRemote -->|yes| restRemote["REST: droid_send, droid_wait,<br/>droid_respond, droid_cancel (turn only),<br/>droid_result (text, no diff)"]
  keyRemote -->|no| refusedRemote["Refused"]
  here -->|yes| ws{"workstream?"}
  ws -->|yes| keyWs{"key set?"}
  keyWs -->|yes| restWs["REST: droid_send, droid_wait,<br/>droid_respond, droid_cancel<br/>Local: droid_result"]
  keyWs -->|no| localWs["Local transcript: droid_wait, droid_result<br/>Refused: droid_send (never resumed locally),<br/>droid_respond, droid_cancel"]
  ws -->|no| keyStd{"key set?"}
  keyStd -->|yes| restStd["REST: droid_send, droid_respond, droid_cancel<br/>Local transcript: droid_wait, droid_result"]
  keyStd -->|no| localStd["droid_send: local resume (conditions below)<br/>Local transcript: droid_wait, droid_result<br/>Refused: droid_respond, droid_cancel"]
```

Per-tool differences:

- `seq` in `droid_wait` is a cursor whose meaning depends on the source: an event number for own sessions, a byte offset into the transcript for other local sessions, and a message sequence number for REST sessions. Treat it as opaque and pass `nextSeq` back as `afterSeq`.
- `droid_wait` on a local transcript returns no pending prompts.
- `droid_result` on an own session returns the last result. For any session on this machine, it can also return `git diff HEAD`. For a session not on this machine, it returns REST text and no diff.
- `droid_cancel` can close only an own session. For every other session it can only interrupt the turn.

Local resume happens only without a key, only with `allowLocalResume: true`, and only for a standalone session that has readable settings, is not archived, is not a subagent, was not modified in the last 30 minutes, and has a recorded autonomy within the cap. The resumed session becomes an own session.

A session this server closed (with `droid_cancel` scope `session`, auto-close, or shutdown) can be resumed at once: the 30-minute check is skipped because no other droid holds it. With a key, `droid_send` resumes it locally instead of going over REST, so `droid_wait` sees the new turn; without a key it still needs `allowLocalResume: true`. The server remembers these sessions in memory only, so after a restart they fall back to the 30-minute check (`src/route.ts`).

## Computers and online state

A Droid computer is either your own machine running the Droid daemon (`kind: "own"`) or a Factory cloud computer (`kind: "cloud"`). `droid_computers` sorts each into `online`, `paused` or `offline` (`src/computers.ts`):

- Own computer: `online` when its daemon heartbeat (`lastSeenAt`) is under 5 minutes old, otherwise `offline`. Heartbeats arrive about every 60 s; the worst gap measured was about 150 s.
- Cloud computer: follows the sandbox state. `running` is `online`. `paused` is `paused`: `droid_find` skips it, but a tool that names it is allowed, since Factory may resume it. Anything else is `offline`.

Factory's own `status` field says `active` even when an own computer's daemon is dead, and a call to a dead daemon hangs about 30 s before failing with 503. That is why the server judges liveness by the heartbeat and fails fast on offline computers.

## Callbacks

Each computer reports session events to the server. Your agent reads them with `droid_events`, or a webhook wakes it, and it answers with `droid_send` or `droid_respond`. There are two ways in: the doorbell plugin, and the older token hooks from step 7, which stay until the plugin is rolled out everywhere.

### Doorbell plugin: tokenless rings

The [doorbell plugin](#doorbell-plugin) posts each hook's stdin JSON to `POST /events` with no `Authorization` header. The server calls that a ring and treats it only as a claim: it never forwards what a ring says. Rings work whether or not `DROID_MCP_EVENTS_TOKEN` is set.

```mermaid
sequenceDiagram
  participant D as Droid session (any computer)
  participant S as droid-mcp
  participant F as Factory REST, or this server's own run
  participant W as Webhook (optional)
  D->>S: POST /events (hook stdin, no token, 3 s timeout)
  S-->>D: 202 at once
  alt session not subscribed
    S->>S: log the ring (droid_events, forwarded false), no Factory call
  else subscribed
    S->>F: what is true now? (status, pending prompts, last reply)
    S->>S: add the confirmed event (30 s debounce)
    S->>W: POST event (8 s timeout, one try)
  end
```

From a ring the server reads only `session_id`, `hook_event_name` and `notification_type`; everything else, such as `transcript_path` or the notification message, is dropped. For a subscribed session it asks the session's source of truth: its own run state when this server started the session, and Factory REST otherwise. Without `FACTORY_API_KEY`, a ring for a session this server does not run is only logged, and the server log says why.

| Hook                                                       | What the server checks                                                                                                                                                               | Event                                                                                                                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Stop`                                                     | The session is no longer running. Factory can report `running` for a moment after the hook fires, so it checks again every second, up to 5 times. Still running after that: nothing. | `finished` with the end of the last reply (up to 300 characters), or `question` if the reply has a line starting `QUESTION:` (text runs from that line) |
| `Notification` (`permission_prompt`, `elicitation_dialog`) | A prompt is actually pending. None pending: nothing.                                                                                                                                 | `permission` for a permission prompt, `question` for an AskUser prompt; text describes the prompt                                                       |
| `SessionEnd`                                               | The session exists (REST answers, or this server runs it).                                                                                                                           | `ended`                                                                                                                                                 |

Other hook events and other notification types (`idle_prompt`, `auth_success`) get a 202 and are ignored. The event's computer is the session's computer from REST, or this machine for sessions this server runs. Each source address may ring 60 times a minute; beyond that the server answers 429 and does nothing else. Bad JSON or a bad shape gets a 400. Verification errors go to the server log and never affect the reply.

A forged ring can at most repeat a real event for a subscribed session, which the debounce limits, or add an unverified line to `droid_events` for an unsubscribed one.

### Token hooks

A request with an `Authorization` header takes the old path: the events token from step 7 is checked (401 if wrong, 404 if no token is set), and the hook's own event body is recorded and forwarded as sent. The hook script (`hooks/droid_mcp_hook.py`) maps events like this:

- `finished`: a `Stop` hook. Text is the end of the last reply (up to 300 characters).
- `question`: a `Stop` whose last reply has a line starting `QUESTION:` (text runs from that line), or a `Notification` of type `elicitation_dialog`.
- `permission`: a `Notification` of type `permission_prompt`.
- `ended`: a `SessionEnd` hook. Text is the reason.
- Ignored: the `idle_prompt` and `auth_success` notifications.

On macOS and Linux the hook forks, posts in the background with a 3 s timeout, and the parent exits at once. On Windows it posts synchronously with a 3 s timeout. Either way it always exits 0 and prints nothing, so a down server does not show up in the session.

### Forwarding

To get a question back from a session, tell it to end its reply with a line starting `QUESTION:`.

Forwarding rule (`src/ring.ts`, `src/events.ts`), the same for both paths:

- An event is forwarded only if its session is subscribed, whatever its kind. Tags and which process started the session do not matter.
- `droid_start` subscribes to the sessions it starts (unless `subscribe: false`). For other sessions, the agent calls `droid_subscribe` when you ask it to, and `droid_unsubscribe` to stop.
- Subscriptions are saved in `~/.droid-mcp/subscriptions.json` and last until unsubscribed, across server restarts and session restarts.
- The same session and kind are never forwarded twice within 30 s.
- The webhook gets `source: "droid-mcp"`, `seq`, `at`, `computer`, `sessionId`, `kind`, `title`, `text` and `cwd`.

Every event is kept for `droid_events`, forwarded or not. Events live in memory only and are lost when the server restarts.

## What the agent can and cannot touch

### Filesystem

- `droid_start`, local resume and `droid_result` diffs require a `cwd` inside `DROID_MCP_ROOTS` (colon-separated, default `~/repos`). Both the cwd and each root go through `realpath`, so symlinks are resolved before the prefix check, and a missing cwd is refused (`src/config.ts`).
- `DROID_MCP_ROOTS` limits where the server starts or diffs work. It is not a read sandbox.
  - Limited to `DROID_MCP_ROOTS`:
    - `droid_start` cwd
    - local resume
    - `droid_result` diff
  - Not limited:
    - `droid_start` fork source (the source's own cwd)
    - `droid_find`, `droid_wait`, `droid_result` text (any local transcript)
    - REST sends, `droid_respond`, `droid_cancel` (any session the key can reach)
- Files read: `~/.factory/sessions/*/*.jsonl` and their `.settings.json` files (`src/catalog.ts`), `~/.factory/settings.json` (`src/models.ts`), `~/.factory/computer.json` (`src/computers.ts`), `~/.droid-mcp/state.json` (`src/runs.ts`) and `~/.droid-mcp/subscriptions.json` (`src/subscriptions.ts`).
- The only files the server writes are `~/.droid-mcp/state.json` and `~/.droid-mcp/subscriptions.json`, each through a temporary file in the same directory and a rename. The directory is created with mode `0700` and the files with `0600` (`src/runs.ts`).
- Droid writes its own session files. The agent inside a session starts in its cwd, but autonomy, not the roots list, decides what its commands can touch.

### Autonomy

- Levels are `off`, `low`, `medium`, `high`. A start without `autonomy` uses `off` (`src/config.ts`).
- `DROID_MCP_MAX_AUTONOMY` sets the cap (default `high`). An unrecognized value sets the cap to `off`. Requests above the cap are refused (`src/config.ts`).
- A local resume refuses a session whose recorded autonomy is above the cap, and checks again after loading it (`src/route.ts`, `src/runs.ts`). A fork does not check the source's autonomy; the fork gets the requested autonomy (default `off`).
- Over REST, the requested autonomy is capped, but the session's existing autonomy is not read or checked (`src/tools.ts`).
- Permission prompt answers are filtered by `allowedDecisions`: `proceed_always*`, `proceed_edit`, `proceed_auto_run` and `proceed_new_session` are never offered, and `proceed_auto_run_<level>` / `proceed_new_session_<level>` only when the level is within the cap. This applies to own sessions and REST answers (`src/config.ts`, `src/runs.ts`, `src/tools.ts`).
- No parameter maps to `--skip-permissions-unsafe`. The only extra `droid exec` argument the server adds is `--worktree [branch]` (`src/runs.ts`).

### Models and settings

`droid_start` and `droid_send` share these optional settings: `model`, `reasoningEffort`, `specModel`, `specReasoningEffort`, `useSpec`, `mission`, `workerModel`, `workerReasoningEffort`, `validatorModel`, `validatorReasoningEffort`, `tags`, `worktree`, `onlyTools`, `addTools`, `removeTools`, `appendSystemPrompt`, `fork`.

Validation, before anything runs (`src/settings.ts`, `src/models.ts`):

- Every model id must be a built-in id, a custom id from `~/.factory/settings.json`, a tier alias or a version wildcard. Unknown ids are refused with up to five close matches.
- An effort is checked against the model's supported list when that model is given (`specReasoningEffort` against `specModel`, falling back to `model`).
- Worker and validator settings require `mission: true`; `mission` cannot be combined with `useSpec`; `mission` requires autonomy `high` (the requested autonomy, or the session's current one for own and local sessions).

Where each setting is applied:

- `model`, efforts, `specModel`, `useSpec: true`, tool lists:
  - New session and fork: `updateSettings` before the first prompt.
  - Own session send or local resume: `updateSettings` before the prompt.
  - REST send: `updateSession` before the prompt.
- `mission: true`, worker and validator settings:
  - New session, fork, own session send or local resume: `updateSettings`.
  - REST send: ignored. Still validated, so `mission` needs `autonomy: "high"` in the same call.
- `autonomy`:
  - New session: at session creation.
  - Fork, own session send or local resume: `updateSettings`.
  - REST send: `updateSession`.
- `tags`:
  - New session: at creation, plus `droid-mcp`.
  - Fork: on the fork, plus `droid-mcp`.
  - Own session send or local resume: added to the session's tags, keeping existing tag metadata.
  - REST send: ignored.
- `worktree`:
  - New session and fork: `--worktree [branch]`.
  - Own session send, local resume, REST send: ignored.
- `appendSystemPrompt`:
  - New session: appended to the `droid` preset.
  - Fork: refused.
  - Own session send, local resume, REST send: ignored.
- `fork`:
  - New session: loads the source locally and forks it. Only checks that the source is on disk and not open in this server; the local-resume guards above do not apply.
  - Own session send, local resume, REST send: ignored.

Ignored settings come back in the `ignored` field of the `droid_send` result; REST sends also return `applied` (`src/tools.ts`, `src/settings.ts`). `useSpec: false` and `mission: false` do nothing: neither switches a session back to normal mode.

### Concurrency limits

- At most 3 own sessions `working` or `needs_you` at once, and one per repo. The repo is the nearest ancestor of the cwd that contains `.git` (`src/runs.ts`, `src/catalog.ts`).
- A pending permission or AskUser prompt is cancelled after 30 minutes (`src/runs.ts`).
- A session started with `droid_start` is closed after 30 minutes idle (`src/runs.ts`).
- `mode: "interrupt"` waits up to 15 s for the running turn to stop; if it does not, nothing is sent (`src/runs.ts`).
- Each own session keeps its last 1000 events; `droid_wait` sets `gap: true` when older events were dropped (`src/runs.ts`).

### Idempotency keys

`droid_start` and `droid_send` require an `idempotencyKey` (1 to 200 characters). Keys are stored in `~/.droid-mcp/state.json` for 7 days (`src/runs.ts`):

- A retry with a finished key returns the first result without running again. For `droid_start` the session state in the reply is current.
- A key is marked pending before the action runs. If the action was refused before any side effect, the key is dropped and can be reused. If it failed after it may have taken effect, the key stays pending and a retry is refused.
- Each save merges with the file on disk, so several server processes can share it.

### HTTP mode

- `--http <host:port>` requires `DROID_MCP_TOKEN`. Every MCP request must send `Authorization: Bearer <token>`, compared with `timingSafeEqual` (`src/main.ts`).
- Any request with an `Origin` header is rejected with 403, so browsers cannot call the server (`src/main.ts`).
- `DROID_MCP_TOKEN`, `DROID_MCP_EVENTS_TOKEN` and `DROID_MCP_WEBHOOK_KEY` are deleted from the process environment at startup, so spawned sessions do not inherit them (`src/main.ts`).
- Each request gets a fresh, stateless MCP server; sessions and runs are shared across requests (`src/main.ts`).
- A `POST /events` with an `Authorization` header takes only `DROID_MCP_EVENTS_TOKEN`, and the MCP endpoint takes only `DROID_MCP_TOKEN` (`src/http.ts`). Without an events token, token posts to `/events` answer 404. Bodies over 16 KB get 413; invalid events get 400; accepted ones get 202 with `seq` and `forwarded`.
- A `POST /events` without an `Authorization` header is a doorbell ring (`src/ring.ts`): 60 per minute per source address (then 429), 202 before any check, and forwarded only after Factory or this server's own run confirms it.

### What it never does

- Never returns `FACTORY_API_KEY` or custom-model API keys. Custom models are reduced to an allowlist of fields, and `baseUrl` is reduced to its host (`src/models.ts`).
- Never offers "always allow" permission options (`src/config.ts`).
- Never closes a session that is not an own session; `droid_cancel` with `scope: "session"` is refused for those (`src/tools.ts`).
- Never resumes a workstream session, or one whose settings it cannot read, through `droid_send` (`src/route.ts`). `droid_start` with `fork` does load its source locally without these checks.
- Never runs commands other than `droid exec` (through the SDK), `droid exec --help`, `git -C <cwd> diff HEAD`, `rg` and, on macOS, `security find-generic-password` (`src/models.ts`, `src/tools.ts`, `src/catalog.ts`, `src/config.ts`).
- Has no tool that deletes sessions or files (`src/tools.ts`).

## Development

```sh
npm run typecheck   # tsc --noEmit
npm test            # node --test "test/*.test.ts"
node scripts/smoke.ts [scratchDir] [idleSessionIdToResume]
```

`scripts/smoke.ts` is a live end-to-end check over a real stdio MCP client. It spends model tokens. It starts the server with `DROID_MCP_MAX_AUTONOMY=medium` and `FACTORY_API_KEY` removed from its environment, then:

- checks the tool list, `droid_find` grouping, title and content search, and read-only `droid_wait`/`droid_result` on a local orchestrator;
- checks refusals: sending to a workstream without a key, an unknown session, a cwd outside the roots, autonomy above the cap;
- starts a session in the scratch dir (default `~/repos/droid-mcp-scratch`, which must be inside `DROID_MCP_ROOTS`) at autonomy `off`, approves its permission prompt, and checks the created file, the result text, idempotent start and send, the diff and closing;
- with a second argument, resumes that idle local session with `allowLocalResume`.

It needs at least one local workstream session with its orchestrator, and a transcript containing the text `droid_find`. It refuses to run when a key is in the Keychain: the refusal checks send to a real workstream, and with a key those sends would go through REST and actually post.

## Known limits

- REST settings updates (`updateSession`) are not verified against the live API.
- Sessions started with `worktree` run in a worktree outside the allowed roots, so `droid_result` refuses their diffs.
- A fork keeps its source session loaded until the fork is closed.
- Mission mode is untested live.
- REST `droid_wait` assumes `getMessages` returns the newest messages (see the comment in `src/tools.ts`).
- `droid_wait` on a local transcript cannot see pending prompts or tool events.
- After an own session is closed, `droid_wait` and `droid_result` keep reading its in-memory state until a `droid_send` resumes it locally. If a later `droid_send` reaches it over REST (a named remote computer), they do not see the new turn.
- Linux is untested.
- `droid_find` and the other tools cannot reach an offline computer; Factory does not wake it.
- Hooks on cloud computers need a network route to the server URL.
- Events are kept in memory and lost when the server restarts.
- The Windows hook and installer are tested only with PowerShell 7 on Linux so far.
- `droid_start` still starts sessions on this machine only.

## Security notes

- Treat `DROID_MCP_TOKEN` like a password: it grants every tool, including starting sessions.
- Autonomy `high` lets droid run arbitrary commands, starting from a cwd inside the allowed roots but not confined to it. Lower `DROID_MCP_MAX_AUTONOMY` if clients should not be able to grant it.
- REST sends act as the owner of `FACTORY_API_KEY`, on any session that key can reach.
- Prompts are sent as the user; the session sees them as the user's own messages.
- When a key is found, the SDK passes it to spawned `droid exec` processes as `FACTORY_API_KEY`, so commands an agent runs in those sessions can read it.
- The events token can only append events. It cannot call tools: the MCP token is not accepted on `/events`, and the events token is not accepted on the MCP endpoint.
- The events token sits in `~/.factory/droid-mcp/hook.json` on every computer with the hook, where agents can read it. Anyone with it can post fake events.
- Event text is untrusted session content. Treat it as data, not instructions.
- A hook payload carries the session id, computer id, host, title, cwd, tags and at most 1000 characters of text. It never carries credentials.

## License

MIT. See [LICENSE](LICENSE).
