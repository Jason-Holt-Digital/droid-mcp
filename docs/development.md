# Development

droid-mcp is TypeScript that Node runs directly (Node 24 or later strips the types). There is no build step.

## npm scripts

```sh
npm test            # node --test "test/*.test.ts"
npm run lint        # oxlint
npm run fmt         # oxfmt --write .
npm run fmt:check   # oxfmt --check .
npm run typecheck   # tsc --noEmit
npm start           # node src/main.ts (stdio)
```

The formatter uses single quotes and a print width of 160 (`.oxfmtrc.json`). The plugin tests need `curl` and skip without it.

## Smoke test

```sh
node scripts/smoke.ts [scratchDir] [idleSessionIdToResume]
```

`scripts/smoke.ts` runs the server over a real stdio MCP client and spends model tokens. It starts the server with `DROID_MCP_MAX_AUTONOMY=medium` and without `FACTORY_API_KEY`, then:

- checks the tool list, `droid_sessions` grouping and search, and read-only `droid_wait` and `droid_result` on a local orchestrator;
- checks refusals: a workstream without a key, an unknown session, a cwd outside the roots, autonomy above the cap;
- starts a session in the scratch directory (default `~/repos/droid-mcp-scratch`, which must be inside `DROID_MCP_ROOTS`), approves its permission prompt, and checks the file it made, the result, idempotent start and send, the diff and closing;
- with a second argument, resumes that idle local session with `allowLocalResume`.

It needs at least one local workstream with its orchestrator, and a transcript that contains `droid_sessions`. It refuses to run when the Keychain holds a key, because the refusal checks would then post to a real workstream over REST.

## Code map

- `src/main.ts`: entry point. Reads config and secrets, builds the context, serves stdio or `--http`, runs `doctor`.
- `src/http.ts`: HTTP handler. Bearer auth for MCP, `POST /events` for rings and legacy events.
- `src/tools.ts`: registers the 14 tools and shapes their results and errors.
- `src/access.ts`: one session interface with three adapters: own run, REST, local transcript.
- `src/route.ts`: decides how `droid_send` reaches a session: own, local resume or REST.
- `src/runs.ts`: sessions droid-mcp runs, their state machine, prompts, auto-close, and the idempotency key store.
- `src/catalog.ts`: reads local session files, groups workstreams, searches transcripts with `rg`.
- `src/computers.ts`: the computer list, online state, and name or id lookup.
- `src/rest.ts`: the Factory REST client and its error codes.
- `src/config.ts`: roots, autonomy cap, Keychain lookup, error classes, allowed permission options.
- `src/capabilities.ts`: the checks behind `droid_status` and `doctor`, and the paste line.
- `src/setup.ts`: the `droid_setup` job and the setup commands.
- `src/ring.ts`: the doorbell. Verifies rings and records events.
- `src/events.ts`: the event log, its 30-second debounce, and the webhook forwarder.
- `src/subscriptions.ts`: the subscription list in `~/.droid-mcp/subscriptions.json`.
- `src/models.ts`: the model catalog from `droid exec --help` and custom models.
- `src/settings.ts`: validates run settings and maps them to SDK and REST updates.

`plugin/` is the doorbell plugin, and `.factory-plugin/marketplace.json` makes this repo its marketplace. `hooks/` and `scripts/install*` are the legacy token hooks.

## Stacked pull requests

The redesign lands as a stack of slices. Each `slice-N-*` branch starts from the slice before it, and its pull request targets that branch; slice 1 targets `main`. A fix goes on the lowest slice it belongs to, then each later slice merges the one below it, so the fix flows up the stack.

## CI

`.github/workflows/ci.yml` runs on every push to `main` and on every pull request, whatever its base, so each slice in the stack is checked. It runs on Ubuntu with Node 24 and 26, installs `ripgrep`, then runs `npm ci`, `npm run lint`, `npm run fmt:check`, `npm run typecheck` and `npm test`. It does not run the smoke test.
