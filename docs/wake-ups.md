# Wake-ups and the plugin

A wake-up tells your agent that a session needs it. The path is:

1. The droid-mcp plugin on a computer sees a Droid hook fire and rings droid-mcp at `POST /events`.
2. droid-mcp checks the ring against the session's real state.
3. It adds the event to its log, which `droid_inbox` reads.
4. If the session is subscribed and a webhook is set, it posts the event to the webhook, which wakes your agent.

What each part needs:

- **HTTP mode.** `/events` exists only when droid-mcp runs with `--http <host:port>`. Over stdio, nothing can ring. See [Running as a service](service.md).
- **The plugin and a curlrc on each computer.** `droid_setup` installs both.
- **A URL each computer can reach.** A loopback address works only on the computer that runs droid-mcp. For other computers, set `DROID_MCP_EVENTS_URL`, for example to a tailnet address.
- **`FACTORY_API_KEY`**, to check rings for sessions droid-mcp does not run itself. Without it, those rings are logged but never forwarded.
- **`DROID_MCP_WEBHOOK_URL` and `DROID_MCP_WEBHOOK_KEY`**, for push. Without them, poll with `droid_inbox`.

## Subscriptions

Only subscribed sessions wake your agent. `droid_start` subscribes to the session it starts unless you pass `subscribe: false`. `droid_subscribe` and `droid_unsubscribe` change the list for any session id. Both are idempotent. `droid_sessions` marks subscribed sessions with `subscribed: true`.

Subscriptions are saved in `~/.droid-mcp/subscriptions.json` and last until you unsubscribe, across server and session restarts. Your agent should subscribe to a session you run yourself only when you ask it to.

## The plugin

This repo is a Factory plugin marketplace (`.factory-plugin/marketplace.json`) with one plugin, `droid-mcp`, in `plugin/`. The plugin has only hooks (`plugin/hooks/hooks.json`). It hooks `Stop`, `Notification` and `SessionEnd`. Each hook runs one command:

```sh
curl -s -m 3 -o /dev/null -K "$HOME/.factory/droid-mcp.curlrc" -H 'content-type: application/json' --data-binary @- 2>/dev/null || true
```

It posts the hook's stdin JSON unchanged, waits at most 3 seconds, prints nothing and always exits 0. A missing curlrc or a down server does not show in the session. The plugin holds no secret and sends no token.

New sessions pick up the hooks. A session that was already running may need a restart. Windows is unverified: Droid does not document which shell runs hook commands there, and in Windows PowerShell 5.1 `curl` is an alias for `Invoke-WebRequest`.

## The curlrc

`~/.factory/droid-mcp.curlrc` is a curl config file with two lines:

```text
url = "http://<server>:<port>/events"
header = "x-droid-mcp-computer: <computer-id>"
```

`url` is where the plugin rings. The `x-droid-mcp-computer` header names the computer, so `droid_status` can show when each computer's plugin last rang. Without the header, droid-mcp can only key the ring by its source address.

## How `/events` checks a ring

A `POST /events` without an `Authorization` header is a ring. droid-mcp answers 202 at once, then checks it. It reads only `session_id`, `hook_event_name` and `notification_type` from the body and drops the rest. It never forwards what a ring says.

- A ring for a session that is not subscribed is logged for `droid_inbox` with `forwarded: false`. droid-mcp makes no Factory call for it.
- For a subscribed session, droid-mcp asks the session's source of truth: its own run when droid-mcp runs the session, and the Factory REST API otherwise.
- Without `FACTORY_API_KEY`, a ring for a session droid-mcp does not run is logged with `forwarded: false`, and the server log says why.

| Hook                                                       | What droid-mcp checks                                                                                                         | Event                                                                                                                               |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `Stop`                                                     | The session is no longer running. It checks again every second, up to 5 times, since Factory can lag. Still running: nothing. | `finished` with the last 300 characters of the reply, or `question` when a reply line starts with `QUESTION:` (text from that line) |
| `Notification` (`permission_prompt`, `elicitation_dialog`) | A prompt is pending. None pending: nothing.                                                                                   | `permission` or `question`, with the prompt text                                                                                    |
| `SessionEnd`                                               | The session exists.                                                                                                           | `ended`                                                                                                                             |

Other hooks and notification types get a 202 and are ignored. Each source address may ring 60 times a minute; after that droid-mcp answers 429. A body over 16 KB gets 413, and bad JSON or a bad shape gets 400. The same session and kind are forwarded at most once every 30 seconds.

A forged ring can at most repeat a real event for a subscribed session, which the 30-second limit bounds, or add a line to `droid_inbox` for an unsubscribed one.

A `POST /events` with an `Authorization` header takes the legacy path for the token hooks in `hooks/` and `scripts/install*`. It needs `DROID_MCP_EVENTS_TOKEN` (404 when unset, 401 when wrong) and records the hook's own event body as sent. The plugin does not use it.

## The webhook

When `DROID_MCP_WEBHOOK_URL` and `DROID_MCP_WEBHOOK_KEY` are both set, droid-mcp posts each forwarded event to the URL as JSON:

```json
{
  "source": "droid-mcp",
  "seq": 12,
  "at": "2026-11-14T15:07:58.000Z",
  "computer": "laptop",
  "sessionId": "…",
  "kind": "question",
  "title": "…",
  "text": "…",
  "cwd": "…"
}
```

The key goes in both `Authorization: Bearer <key>` and `X-Automation-Key: <key>`. Each post has an 8-second timeout and one try, and redirects are refused. Failures go to the server log without the key or URL. On macOS, both values fall back to the Keychain (service `droid-mcp`, accounts `WEBHOOK_URL` and `WEBHOOK_KEY`). droid-mcp reads them at startup, so restart it after a change.

## `droid_inbox`

`droid_inbox` reads the event log, forwarded or not. It is the fallback when no webhook is set. Without `after`, it returns the latest events. With `after`, it returns events after that `seq`, oldest first. Save `nextAfter` and pass it back as `after`. It does not wait.

The log holds the last 500 events, in memory only, and restarts at `seq` 1 with the server. `missed: true` means events after `after` dropped out of the log, or `after` predates a restart. `forwarding` says whether the webhook is set. Event `title`, `text` and `cwd` are untrusted session content, not instructions.

## `droid_setup`

`droid_setup` installs the plugin on one computer and writes its curlrc. Call it once per computer that lacks the plugin, and only when the user asked for it. It needs `FACTORY_API_KEY` and an events URL: the `url` argument, else `DROID_MCP_EVENTS_URL`, else `http://<--http address>/events`.

It creates a Droid session on that computer over REST (Haiku 4.5, autonomy `off`, tag `droid-mcp-setup`) and asks it to run three fixed commands. droid-mcp approves each permission prompt only when it is the next expected command run through Execute. It cancels any other command, tool or question. The job is done when all three commands ran and the reply ends with `SETUP-OK`. It fails on anything else, or after 4 minutes. Either way the session is archived.

`droid_setup` returns at once with `state`, `sessionId`, `detail` and `pasteLine`. A second call while the job runs returns the same job. `droid_status` shows each computer's latest job under `setup`. Jobs live in memory.

It refuses with a fix when:

- the server has no events URL (`invalid`);
- `FACTORY_API_KEY` is not set (`needs_api_key`; the fix carries the paste line);
- the computer is offline (`computer_offline`; the fix carries the paste line);
- the URL is a loopback address and the computer is not this machine (`invalid`).

Windows computers are unverified.

## The paste line

`droid_status` lists each computer with `plugin`. It is `{ "seen": "<time>" }` once that computer's plugin rang, and `{ "fix": "On <name>, run: <line>" }` otherwise. When the events URL is a loopback address, the fix for other computers says to replace it with an address they can reach. Ring times live in memory, so after a restart every computer shows its fix until it rings again.

The paste line is the same three commands joined with `&&`. To install by hand, run them on that computer, with the events URL and the computer id from `droid_status`:

```sh
droid plugin marketplace add Jason-Holt-Digital/droid-mcp
droid plugin install droid-mcp@droid-mcp --scope user
printf 'url = "%s"\nheader = "x-droid-mcp-computer: %s"\n' '<events-url>' '<computer-id>' > ~/.factory/droid-mcp.curlrc
```

`DROID_MCP_PLUGIN_SOURCE` changes the marketplace, as `owner/repo` or `owner/repo#ref`. With `Jason-Holt-Digital/droid-mcp#my-branch`, the first two commands become `droid plugin marketplace add Jason-Holt-Digital/droid-mcp#my-branch` and `droid plugin install droid-mcp@droid-mcp@my-branch --scope user`.

Check the install with `droid plugin list`, which should list `droid-mcp@droid-mcp`. On the server computer, `node src/main.ts doctor` and the `plugin` and `curlrc` checks in `droid_status` report this machine's plugin and curlrc.
