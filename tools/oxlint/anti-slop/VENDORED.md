# Vendored anti-slop plugin

Source: [prathamdby/droid-mcp](https://github.com/prathamdby/droid-mcp), `tools/oxlint/anti-slop`, commit `7a87536`.
Copied: 2026-11-14.

The files here are vendored verbatim. Do not edit them; update them by re-copying from the source repository.

Copied: `index.ts`, `rules/*.ts` (without `*.test.ts`), `shared/`, and `vendor/eslint-stylistic/` with its `LICENSE` and `UPSTREAM.md`. Not copied: `effect/`.

The plugin needs `@oxlint/plugins` at the same version as `oxlint`. Lint, oxfmt and `tsconfig.json` ignore this directory.

## Rules left off on purpose

These rules ship here but stay out of `.oxlintrc.json`. Turning one on is a separate decision, not a cleanup.

- `require-readable-spacing` (889 hits): blank lines between statements; it would rewrite almost every file for no behavior gain.
- `require-safety-comment-for-type-assertion` (117 hits): a `SAFETY:` comment on every `as`; most are typed test doubles.
- `no-chained-type-assertions` (25 hits): `as unknown as` builds partial test doubles; the one in `src` covers a known SDK 0.11 type gap.
- `no-unknown-parameters` (25 hits): JSON, MCP SDK and error values at the I/O boundary are honestly `unknown`.
- `no-runtime-typeof` (21 hits): `typeof` is how those boundary values are parsed.
- `no-unsafe-dictionary-type` (18 hits): `Record<string, unknown>` holds JSON payloads and MCP `structuredContent`.
- `no-unknown-returns` (10 hits): SDK answers and JSON results passed back to the SDK or the MCP response.
