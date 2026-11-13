# droid-mcp

An MCP server that lets any MCP client (Droid, Claude Code, Cursor, other agents) find, start, steer and read Factory Droid sessions, including mission/workstream orchestrators and their agents. It reads local session files, runs its own sessions through `@factory/droid-sdk`, and reaches sessions held elsewhere through the Factory REST API when an API key is available.

Status: early (0.1.0). Tested on macOS with droid CLI 1.10.0, `@factory/droid-sdk` 0.11.0 and Node 26 (`engines` requires Node >= 24). The only platform-specific code is the Keychain lookup for `FACTORY_API_KEY`, which runs only on `darwin`; elsewhere the key must come from the environment. Linux is untested.

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

Without a key, the server works with local session files and the sessions it starts itself, using your droid CLI login. A key enables the REST backend, which reaches sessions on other machines, sessions held by the desktop app, and workstream sessions. When a key is found, spawned sessions also use it instead of the CLI login.

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

Expect 8 tools: `droid_find`, `droid_models`, `droid_start`, `droid_send`, `droid_wait`, `droid_respond`, `droid_cancel`, `droid_result`.

Call two read-only tools:

```sh
npx -y @modelcontextprotocol/inspector --cli node src/main.ts --method tools/call --tool-name droid_models --tool-arg filter=opus
npx -y @modelcontextprotocol/inspector --cli node src/main.ts --method tools/call --tool-name droid_find --tool-arg limit=5
```

Then, from a connected client, ask it to call `droid_models` and `droid_find`. Both are read-only and spend no model tokens.

## Configuration

- `FACTORY_API_KEY` (default unset): enables the REST backend, and is used for spawned sessions instead of the CLI login. On macOS, the server falls back to the Keychain (step 3).
- `DROID_MCP_ROOTS` (default `~/repos`): colon-separated directories a session cwd must resolve inside.
- `DROID_MCP_MAX_AUTONOMY` (default `high`): autonomy cap, one of `off`, `low`, `medium`, `high`; any other value means `off`.
- `DROID_MCP_TOKEN` (default unset): bearer token; required with `--http`.

## How the tools fit together

```text
Discover            Start or steer          Follow and approve                        Read or stop
droid_find    ─┐    droid_start ─┐          droid_wait ── pending prompt? ──► droid_respond
droid_models  ─┴──► droid_send  ─┴─► turn ─► droid_wait ── state "idle" ─────► droid_result
                                     runs in                                   droid_cancel
                                     background
```

Terms used below:

- **Workstream (mission):** a multi-agent Factory session: one **orchestrator** plus child **agent** sessions, tagged `mission-v2`.
- **Own session:** a session currently running inside this server, either started with `droid_start` or resumed locally by `droid_send`. It stays own until it is closed.
- **Autonomy:** what the agent in a session may do without asking: `off` < `low` < `medium` < `high`.
- **Pending prompt:** a permission request or AskUser question waiting for `droid_respond` (listed in `attention`).

## Access at a glance

The server uses three backends. Each edge into a backend is labeled with the credential it needs.

```mermaid
flowchart LR
  client["MCP client"] -->|"stdio or HTTP"| server["droid-mcp"]
  server -->|"read-only<br/>no credential"| files[("Local session files<br/>~/.factory/sessions<br/>~/.factory/settings.json")]
  server -->|"@factory/droid-sdk<br/>FACTORY_API_KEY if found,<br/>else droid CLI login"| exec["droid exec child process"]
  exec -->|"writes"| files
  server -->|"FACTORY_API_KEY"| rest["Factory REST API<br/>https://api.factory.ai"]
  rest --> daemons["Desktop app, other machines<br/>and the cloud,<br/>holding the session"]
  server --> helpers["Helpers: git diff HEAD (diffs),<br/>rg (transcript search),<br/>droid exec --help (model list)"]
```

Sessions this server starts live in memory. When the stdio client disconnects, or the process gets SIGINT or SIGTERM, the server closes all of them. After a restart they are ordinary local sessions.

### Tools

"Read-only" means the tool is registered with `readOnlyHint: true` (`src/tools.ts`). All results are JSON text, trimmed to about 8 KB; event text is clipped at 4000 characters with `truncated: true`.

#### droid_find

![read-only](https://img.shields.io/badge/read--only-2ea44f) ![no model tokens](https://img.shields.io/badge/no%20model%20tokens-2ea44f) ![FACTORY_API_KEY optional](https://img.shields.io/badge/FACTORY__API__KEY-optional-lightgrey)

- Reads: session headers and settings; transcripts when `content: true`; child sessions of listed workstreams when a key is set. Changes nothing.
- Backend: local files (`~/.factory/sessions`), `rg`, Factory REST API (optional).
- Credential: none; `FACTORY_API_KEY` for the child-session summary.
- Parameters: `query`, `content`, `scope` (`workstreams`, `sessions`, `all`), `cwd`, `includeArchived`, `includeSubagents`, `limit` (1-200, default 40), `cursor`.
- Notes:
  - Groups workstreams (orchestrator first, then agents) and standalone sessions by repo.
  - `query` matches title, id prefix or cwd; with `content: true` it searches transcripts with `rg -F` (40 s timeout).
  - Hidden by default: archived sessions and subagents.
  - With a key, each listed workstream gets a `children` summary from REST, including agents on other machines.

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
- Changes: creates a session; the agent edits files in `cwd` up to the granted autonomy. Writes `~/.droid-mcp/state.json`.
- Backend: `droid exec` child process spawned through the SDK.
- Credential: `FACTORY_API_KEY` if found, otherwise the droid CLI login.
- Parameters: `cwd`, `prompt`, `idempotencyKey` (required), `autonomy`, settings (see [Models and settings](#models-and-settings)).
- Notes: returns `sessionId` and `state`. The turn runs in the background; follow it with `droid_wait`.

#### droid_send

![spends model tokens](https://img.shields.io/badge/spends%20model%20tokens-d73a49) ![sends as the user](https://img.shields.io/badge/sends%20as%20the%20user-dbab09) ![FACTORY_API_KEY for REST](https://img.shields.io/badge/FACTORY__API__KEY-for%20REST-lightgrey)

- Reads: target session settings, model list, `~/.droid-mcp/state.json`.
- Changes: sends a prompt as the user; changes model, tools and autonomy; may resume a local session. Writes `~/.droid-mcp/state.json`.
- Backend: own child process, Factory REST API, or a new `droid exec` (local resume).
- Credential: own session's existing connection; `FACTORY_API_KEY` for REST; CLI login for local resume (only reachable without a key).
- Parameters: `session`, `prompt`, `idempotencyKey` (required), `mode` (`queue`, `interrupt`), `allowLocalResume`, `autonomy`, settings.
- Notes: returns `via` (`own`, `local-resume`, `rest`), `nextSeq` for own and resumed sessions, `messageId` for REST. `queue` is refused while a turn is running.

#### droid_wait

![read-only](https://img.shields.io/badge/read--only-2ea44f) ![no model tokens](https://img.shields.io/badge/no%20model%20tokens-2ea44f) ![FACTORY_API_KEY for REST](https://img.shields.io/badge/FACTORY__API__KEY-for%20REST-lightgrey)

- Reads: new events, local transcript messages (user and assistant text only), or REST messages and pending prompts. Changes nothing.
- Backend: in-memory event log, local transcript, Factory REST API. Polls every 1 s (local file) or 2 s (REST).
- Credential: none for local; `FACTORY_API_KEY` for REST.
- Parameters: `session`, `afterSeq`, `waitMs` (default 25000, max 50000), `maxEvents` (1-200, default 50).
- Notes:
  - Without `afterSeq`, returns the latest events at once. With it, waits for an assistant message, prompt, error or state change.
  - `attention` lists pending prompts with their `requestId` (`null` for local transcript reads).

#### droid_respond

![lets a paused turn spend tokens](https://img.shields.io/badge/lets%20a%20paused%20turn%20spend%20tokens-dbab09) ![FACTORY_API_KEY if not own](https://img.shields.io/badge/FACTORY__API__KEY-if%20not%20own-lightgrey)

- Reads: pending prompts.
- Changes: answers or cancels a permission prompt or AskUser question, which lets a paused turn continue and spend tokens.
- Backend: own child process or Factory REST API.
- Credential: none for own sessions; `FACTORY_API_KEY` otherwise.
- Parameters: `session`, `requestId`, then `decision` and `comment`, or `answers` (one per question), or `cancel`.
- Notes: `decision` must be one of the offered options.

#### droid_cancel

![stops token spend](https://img.shields.io/badge/stops%20token%20spend-2ea44f) ![interrupts or closes](https://img.shields.io/badge/interrupts%20or%20closes-dbab09) ![FACTORY_API_KEY if not own](https://img.shields.io/badge/FACTORY__API__KEY-if%20not%20own-lightgrey)

- Reads: nothing.
- Changes: interrupts a turn; closes an own session.
- Backend: own child process or Factory REST API.
- Credential: none for own sessions; `FACTORY_API_KEY` otherwise (`scope: "turn"` only).
- Parameters: `session`, `scope` (`turn`, `session`).
- Notes: `scope: "session"` works only for own sessions.

#### droid_result

![read-only](https://img.shields.io/badge/read--only-2ea44f) ![no model tokens](https://img.shields.io/badge/no%20model%20tokens-2ea44f) ![FACTORY_API_KEY if not on this machine](https://img.shields.io/badge/FACTORY__API__KEY-if%20not%20on%20this%20machine-lightgrey)

- Reads: latest result text; `git diff HEAD` in the session's cwd. Changes nothing.
- Backend: in-memory result, local transcript, Factory REST API, `git`.
- Credential: none for local; `FACTORY_API_KEY` for sessions not on this machine.
- Parameters: `session`, `include` (`text`, `diff`), `offset`, `maxBytes` (1-32768, default 6000).
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
- Files read: `~/.factory/sessions/*/*.jsonl` and their `.settings.json` files (`src/catalog.ts`), `~/.factory/settings.json` (`src/models.ts`), and `~/.droid-mcp/state.json` (`src/runs.ts`).
- The only file the server writes is `~/.droid-mcp/state.json`, through a temporary file in the same directory and a rename. The directory is created with mode `0700` and the file with `0600` (`src/runs.ts`).
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

- At most 3 turns running or waiting on a prompt at once, and one per repo. The repo is the nearest ancestor of the cwd that contains `.git` (`src/runs.ts`, `src/catalog.ts`).
- A pending permission or AskUser prompt is cancelled after 30 minutes (`src/runs.ts`).
- `mode: "interrupt"` waits up to 15 s for the running turn to stop; if it does not, nothing is sent (`src/runs.ts`).
- Each own session keeps its last 1000 events; `droid_wait` sets `gap: true` when older events were dropped (`src/runs.ts`).

### Idempotency keys

`droid_start` and `droid_send` require an `idempotencyKey` (1 to 200 characters). Keys are stored in `~/.droid-mcp/state.json` for 7 days (`src/runs.ts`):

- A retry with a finished key returns the first result without running again. For `droid_start` the session state in the reply is current.
- A key is marked pending before the action runs. If the action was refused before any side effect, the key is dropped and can be reused. If it failed after it may have taken effect, the key stays pending and a retry is refused.
- Each save merges with the file on disk, so several server processes can share it.

### HTTP mode

- `--http <host:port>` requires `DROID_MCP_TOKEN`. Every request must send `Authorization: Bearer <token>`, compared with `timingSafeEqual` (`src/main.ts`).
- Any request with an `Origin` header is rejected with 403, so browsers cannot call the server (`src/main.ts`).
- `DROID_MCP_TOKEN` is deleted from the process environment at startup, so spawned sessions do not inherit it (`src/main.ts`).
- Each request gets a fresh, stateless MCP server; sessions and runs are shared across requests (`src/main.ts`).

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
- Sessions on other machines are reachable by REST, but `droid_find` lists only local session files (plus the REST child summary for local workstreams).
- `droid_wait` on a local transcript cannot see pending prompts or tool events.
- After an own session is closed, `droid_wait` and `droid_result` keep reading its in-memory state. If a later `droid_send` reaches it over REST, they do not see the new turn.
- Linux is untested.

## Security notes

- Treat `DROID_MCP_TOKEN` like a password: it grants every tool, including starting sessions.
- Autonomy `high` lets droid run arbitrary commands, starting from a cwd inside the allowed roots but not confined to it. Lower `DROID_MCP_MAX_AUTONOMY` if clients should not be able to grant it.
- REST sends act as the owner of `FACTORY_API_KEY`, on any session that key can reach.
- Prompts are sent as the user; the session sees them as the user's own messages.
- When a key is found, the SDK passes it to spawned `droid exec` processes as `FACTORY_API_KEY`, so commands an agent runs in those sessions can read it.

## License

MIT. See [LICENSE](LICENSE).
