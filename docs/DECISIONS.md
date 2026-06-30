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
| Identity    | **Scope IS the conversation id** (`/`-joined string)      | One scope ↔ one conversation; no separate handle. Branch a thread by appending `/<uuid>` (client convention). See "Scope as conversation id" below (D2) |
| Migrations  | **Minimal in-repo runner** (`pg`)                         | Inlined ordered migrations (`src/db/migrations.ts`), ledger `cp_migrations` in the `conversation_proxy` schema, `pg_advisory_lock` apply (D12). Inlined (not on-disk SQL) so it's bundle-safe. Rewrite-in-place vs. forward-only is governed by [`MIGRATIONS.md`](./MIGRATIONS.md) |
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

### Scope as conversation id (D2)

The identity hierarchy is a single `/`-separated **string** (`"user_42/client_88"`),
and that string **is** the conversation id — there is no separate `conversationId`.
This reverses the earlier "ordered array + opaque conversation handle" shape.

- **One scope ↔ one conversation.** Same scope → same thread; history accrues with
  no client bookkeeping. `getConversation(scope)` is the lookup; the store keys on
  it directly (Postgres `conversations.id text` holds the scope — opaque for
  equality/FK, path-structured only for prefix queries).
- **Branch a thread** by appending a unique segment (`/<uuid>`). Pure client
  convention — the server never special-cases any segment, including the leaf.
- **`/` is a reserved separator.** Segment values may not contain `/` or be empty;
  malformed scopes (`a//c`, leading/trailing `/`, NUL, > 1024 chars) are **rejected
  (400), not normalized** — a 400 surfaces a client's missing-id bug instead of
  silently blending two callers into one conversation. Validated once at the facade
  ingress (`validateScope`), so HTTP and embedded callers share the gate.
- **Prefix queries are boundary-aware and inclusive:** `scope === prefix ||
  starts_with(scope, prefix + "/")` — the node at the prefix and all descendants,
  never a bare string-prefix match (`user_1` must not match `user_12`).
- **`conversationId` is gone everywhere** — request input, `AgentResponse`,
  `CallRecord`, `RecordFilter`, and debug events. LLM trace fidelity is unaffected:
  Chat Completions is stateless (we own identity), and the per-call `chatcmpl-…` id
  is still captured verbatim in `CallRecord.response.raw`.

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
