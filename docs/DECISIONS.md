# v1 decisions

This file records what the **v1 lean core** includes, what it defers, and the concrete technology
choices — layered on top of the firm architectural decisions (D1–D17) in
[`../spec-files/CONVERSATION_PROXY_HANDOFF.md`](../spec-files/CONVERSATION_PROXY_HANDOFF.md). The
spec is the _why_; this file is the _what, for v1_.

## Guiding priorities

Simplicity · observability · reliability · **avoid extra features**. When the spec's breadth
conflicts with these, v1 cuts scope. The organizing constraint: **every feature must be verifiable
end-to-end from the CLI.**

## In v1

| Area        | Choice                                                    | Notes                                                                                                                                                              |
| ----------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime     | **Node.js (TypeScript)**, tsup + vitest                   | Reverses spec D7 (Deno). Built to ESM+CJS+dts; CLI via tsx in dev, `node dist/main.js` in prod. See "Runtime reversal" below                                      |
| Embedding   | **One Hono app**; standalone **or** embedded             | Reverses spec D6 (dedicated-only). `createServer()` returns `app.fetch` to mount in a Next.js Route Handler; `@hono/node-server` for standalone. SSE needs a long-lived process |
| Scope       | Lean text-only one-shot proxy                             | The observable `send()` path + debug plane                                                                                                                        |
| Storage     | `InMemoryStore` **and** `PostgresStore`                   | One `ConversationStore` interface; same suite both backends (D1, D2)                                                                                              |
| Migrations  | **Minimal in-repo runner** (`pg`)                         | Inlined ordered migrations (`src/db/migrations.ts`), ledger `cp_migrations` in the `conversation_proxy` schema, `pg_advisory_lock` apply (D12). Inlined (not on-disk SQL) so it's bundle-safe |
| Agents      | **Programmatic** + optional dir-scan                      | `createProxy({ agents })` is bundler-safe (primary for embedding); dir-scan of `*.agent.{ts,js}` for standalone (D11)                                              |
| Provider    | **OpenAI** Chat Completions + `FakeProvider`              | Behind `LLMProxy` (node `fetch`); multi-provider routing deferred (Q5)                                                                                            |
| Caching     | `PassthroughCache` only                                   | `usage.cached_tokens` recorded from day one (D4)                                                                                                                  |
| Tokens      | `js-tiktoken` pre-call count                              | Provider `usage` overwrites with ground truth in the `CallRecord`                                                                                                 |
| Telemetry   | `CallRecord` in same Postgres (`call_records`)            | `InMemoryCallRecordStore` for tests; ClickHouse later behind the interface (Q1)                                                                                   |
| HTTP        | Hono on `@hono/node-server`                               | HTTP is an adapter over the facade (D6, D8)                                                                                                                       |
| Auth        | Static bearer tokens, two keys                            | `CP_API_KEY` (control), `CP_DEBUG_TOKEN` (debug) (D9)                                                                                                             |
| Debug plane | **Cursor polling** (`/debug/events`) + read-only explorer | `DebugEventLog` — in-memory ring **or** Postgres `debug_events` (by backend) ↔ `NullDebugChannel`; off unless `CP_DEBUG_ENABLED`. Replaced SSE so it works serverless / behind LBs (D9, D10) |
| Contract    | `openapi.yaml`, hand-maintained + CI drift check          | No codegen yet (D13)                                                                                                                                              |
| Layout      | Single npm package; `src/types/` is the source of truth   | Public API via `src/index.ts`; extractable to packages when the SDK lands                                                                                         |
| License     | Apache-2.0                                                | Permissive + patent grant                                                                                                                                         |

### Runtime reversal (Deno → Node) and embed model

The spec chose **Deno** (D7) for a **dedicated, non-embedded service** (D6). This
build reverses both, deliberately and with sign-off, to make the proxy embeddable
in a Next.js app server while still running standalone:

- **Node, not Deno.** `Deno.*` APIs → Node equivalents (`process.env`, `node:fs`,
  `node:util parseArgs`, `@hono/node-server`, `pg` instead of `@db/postgres`,
  `node:crypto`). The HTTP layer was already Hono, so it ported unchanged.
- **Embeddable + standalone.** `createServer(config, { agents, scanDir:false })`
  returns the Hono app and an `app.fetch` handler for a Next.js Route Handler;
  `createProxy()` exposes the wired core; `npm run serve` runs it standalone.
- **Agents go programmatic-first.** Node bundlers/Next.js are hostile to runtime
  `import()` of filesystem `.ts`, so agents are registered as objects; the
  dir-scan remains for standalone (and runs under tsx/vitest for `.ts`).
- **Debug plane is now poll-based, not SSE.** Clients poll `GET /debug/events?after=<cursor>`
  for deltas instead of holding a connection, so the old D6/D9 "SSE needs a
  long-lived process" caveat is gone. Use `CP_STORE=postgres` for the durable,
  multi-instance `debug_events` log; the in-memory ring buffer only sees one process.

## Deferred (designed, not built in v1)

| Item                           | Spec ref  | Reintroduced when                      |
| ------------------------------ | --------- | -------------------------------------- |
| Blobs / multimodal media       | D16, D17  | First non-text consumer                |
| Extra-context store            | D14       | First derived-domain-data need         |
| TypeScript SDK + codegen       | D13, §5.2 | First external consumer beyond the CLI |
| AsyncAPI spec                  | D13       | Alongside the SDK's debug consumer     |
| Web observation UI             | §5.3      | After the CLI/HTTP surface stabilizes  |
| Prefix caching (`PrefixCache`) | D4, §6.6  | Usage data justifies it                |
| LLM streaming to the client    | Q4        | A real-time UX requirement appears     |

The CLI is the seed of the deferred SDK (same fetch logic); the debug plane is already wired so the
deferred UI is a pure client.

## Closing the loop

- `deno task test` — unit + integration (in-memory)
- `deno task e2e` — full stack in-process with the fake provider
- `deno task smoke` — same via a live server over HTTP+CLI
- `deno task test:pg` — full suite against real Postgres
- Per-feature CLI subcommands: `serve`, `send`, `preview`, `record`, `stream`, `explore`, `agents`,
  `migrate`.
