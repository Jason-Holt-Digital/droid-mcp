---
name: droid-mcp
description: Use when you need to set up droid-mcp, or drive Factory Droid sessions through it. Covers installing the plugin on each computer, starting work, subscriptions and wake-ups, answering, reviewing and watching the user's own sessions.
---

# droid-mcp

droid-mcp lets you start, steer and watch Factory Droid sessions on every computer the user has. You are the orchestrator. Droid writes the code. You pick the session, answer it, and review what it did.

## Before anything else

Call `droid_status`. It returns two lists.

- `checks`: one entry per capability, with `name`, `ok`, `detail`, `unlocks` and, when it fails, `fix`. The names are `api_key`, `webhook`, `http`, `roots`, `autonomy_cap`, `plugin`, `curlrc` and `events_token`.
- `computers`: every Droid computer, with `state` (`online`, `paused`, `offline`), `thisMachine`, `plugin` (`seen` with the time its plugin last rang, or a `fix` line to paste there) and `setup` (its latest `droid_setup` job).

Do not guess what is set up. Read it from `droid_status`.

## Setup walkthrough

Do the steps in order. Run the check after each one. Stop and tell the user when a check fails.

1. **Droid CLI on the server computer.** Run `droid --version` and confirm the user is logged in. Check that `droid_models` returns a model list.
2. **Connect droid-mcp to the agent.** Use stdio for an agent on the same computer. Use HTTP with `DROID_MCP_TOKEN` for an agent elsewhere, or when the user wants wake-ups: only HTTP mode can receive rings. Check that the agent lists the droid tools, and that the `http` check is ok.
3. **Allowed folders.** Set `DROID_MCP_ROOTS` to the folders that hold the user's repos, colon-separated. Check that the `roots` check is ok and its `detail` lists them.
4. **Factory API key.** Ask the user to create a key in Factory settings and store it themselves: on macOS in the Keychain (`security add-generic-password -s droid-mcp -a FACTORY_API_KEY -w`, which prompts), elsewhere in the server's environment. Never ask them to paste it in chat. Restart droid-mcp. Check that the `api_key` check is ok and `computers` lists every computer.
5. **Plugin on each computer.** Ask the user which computers should wake you. Call `droid_setup` with `computer` once for each online computer whose `plugin` has no `seen`. It needs the API key and an events URL that computer can reach; for other computers that means `DROID_MCP_EVENTS_URL`, such as a tailnet address. It returns at once and runs a Droid session there that may run only `droid plugin marketplace add Jason-Holt-Digital/droid-mcp`, `droid plugin install droid-mcp@droid-mcp --scope user`, and a `printf` that writes `~/.factory/droid-mcp.curlrc`. The plugin carries no secret. Check that the computer's `setup.state` becomes `done`, and that `plugin` shows `seen` after its next Droid session. If a computer is offline or `droid_setup` fails there, give the user that computer's `plugin.fix` line from `droid_status`, or the `pasteLine` or `fix` that `droid_setup` returned.
6. **Push to the agent.** Ask the user to store `DROID_MCP_WEBHOOK_URL` and `DROID_MCP_WEBHOOK_KEY` (Keychain accounts `WEBHOOK_URL` and `WEBHOOK_KEY` on macOS, or the environment), then restart droid-mcp. Check that the `webhook` check is ok. Then start a scratch session, subscribed, that ends its reply with `QUESTION: ping`. You should be woken within seconds.

Installing the plugin, changing settings, storing keys and restarting services need the user's OK. Ask once and say what each step unlocks.

## Daily loop

1. **Pick the session.** Use `droid_sessions` to see what already runs. Continue an existing session in the same repo with `droid_send` before starting a new one. Pass `computer` for a session on another computer.
2. **Start.** Call `droid_start` with `cwd`, `prompt`, and optionally `model`, `autonomy` and an `idempotencyKey`. It starts the session on the computer that runs droid-mcp; it has no `computer` parameter. Use `droid_models` when the user names a model you do not recognize. `droid_start` subscribes you to the session, so you hear when it asks or finishes. Pass `subscribe: false` only when the user says they want no updates. Tell Droid to end its reply with a line starting `QUESTION:` when it needs you.
3. **Wait to be woken.** Do not poll in a loop. Only subscribed sessions wake you. A wake-up names the session and its `kind`: `finished`, `question`, `permission` or `ended`. If push is off, call `droid_inbox` with `after` set to the `nextAfter` you saved.
4. **Answer.** Call `droid_wait` to read the session. A pending permission or AskUser prompt is in `attention` with its `requestId`; answer it with `droid_respond`. A `QUESTION:` line means the turn ended; answer with `droid_send`.
5. **Review.** Call `droid_result` with `include: ['text', 'diff']`. The diff works only for sessions on this machine. Check the diff against the request before you tell the user it is done.
6. **Finish.** To stop a turn that went wrong, call `droid_interrupt`; the session stays open for the next `droid_send`. Call `droid_close` when the work is done, and `droid_unsubscribe` if the user wants no more updates. `droid_close` works only on sessions droid-mcp runs. Sessions you started close on their own after 30 idle minutes once a turn ends. A turn that is still working is never cut off. A dead or closed session resumes on the next `droid_send`; without the API key, a closed one also needs `allowLocalResume: true`.

## Watching the user's own sessions

- `droid_sessions` has no state filter. Look for `state: "needs_you"` in its list. Only sessions droid-mcp runs can show `needs_you`; the user's own sessions show `working` or `idle`. For those, `droid_wait` shows pending prompts in `attention`, and a subscription wakes you with `permission` or `question`.
- Read a session with `droid_wait`. Reading never changes it.
- Subscribe to a session the user runs only when they tell you to. Call `droid_subscribe`. Never subscribe on your own judgment.
- Unsubscribe when they tell you to, or when you finish the job they gave you for that session.
- `droid_sessions` marks the sessions you are subscribed to with `subscribed: true`. Keep that list short.
- Send into a session the user runs only when they asked you to.

## Rare operations

For a Factory API endpoint or Droid daemon method that no other tool covers, such as listing environments or a computer's metrics:

1. Search with `droid_ops` and a `query`, then call it with the `id` you picked to read its params.
2. Run it with `droid_call`. A REST request body goes in `params.body`. Daemon operations run only on the computer that runs droid-mcp.
3. A destructive operation needs the user's OK first. Ask, then pass `confirm: true`. Never pass it on your own judgment.

With `DROID_MCP_MAX_AUTONOMY` at `off` or `low`, only read-only operations run.

## When a call fails

Every failure has a `code`, a `message` and a `fix`. Do what `fix` says, or tell the user. The codes:

- `computer_offline` means that computer's Droid daemon is down. Pick another computer or ask the user to start it.
- `needs_api_key` means the call needs `FACTORY_API_KEY`, or Factory rejected it. Follow setup step 4.
- `outside_roots` means the folder does not exist or is not allowed. Use a folder from the `roots` check.
- `busy` means a turn already runs there, three turns run at once, or a local session was active in the last 30 minutes. Wait, or send with `mode: 'interrupt'`.
- `not_found` means no such computer, model, session or pending request. Check the id with `droid_status`, `droid_models`, `droid_sessions` or `droid_wait`.
- `invalid` means the request is not allowed as given, such as autonomy above the cap. Read `message` and `fix`.
- `internal` means something unexpected failed. Retry once, then report the message.
