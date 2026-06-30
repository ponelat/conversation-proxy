# What was NOT done in v1

A deliberately complete, honest inventory of everything in the design
([`spec-files/`](../spec-files)) and the build plan that v1 does **not** include —
plus the caveats on what it does include. v1's mandate was a *lean, observable,
reliable core* with "avoid extra features," so most of this is intentional
scope-cutting, not oversight. See [`DECISIONS.md`](./DECISIONS.md) for the
positive list of what shipped.

Legend: **D#/Q#** reference the firm decisions / open questions in
[`CONVERSATION_PROXY_HANDOFF.md`](../spec-files/CONVERSATION_PROXY_HANDOFF.md).

---

## 1. Whole features deferred by design

These are specced and understood, just not built. Each is additive — none
requires reworking what exists.

| Feature | Spec | What's missing | Reintroduce when |
|---|---|---|---|
| **Blob store + media** | D16, D17 | `BlobStore`, `MediaResolver`, write-behind mint, the in-process pending buffer, `POST /blobs`, `GET /blobs/:uuid`. `ContentPart` is **text-only** today (the `image`/`audio`/`file` kinds from the spec are not in the type). `assembledFromParts(..., hydrateMedia)` accepts the flag but no-ops. | First non-text consumer |
| **Extra-context store** | D14 | `ExtraContextStore`, `getExtraContext`/`set`/`clear`, the `getExtraContextChain` prefix walk, `GET/PUT/DELETE /extra-context`, and the extra-context slice of `ReadOnlyConversationStore` (hooks can read conversations/messages but not scope-keyed JSON). | First derived-domain-data need (e.g. SOAP notes) |
| **TypeScript SDK package** | D13, §5.2 | A published `@.../sdk`. We ship `src/cli/client.ts` (`ConversationProxyClient`) as the *seed* — same fetch logic — but it is not packaged, versioned, or generated from the spec. | First external consumer beyond the CLI |
| **Shared types package** | §8.1 | `@.../types` as its own package. It exists as an internal `src/types/` module (the single source of truth), structured to extract later, but is not published. | Alongside the SDK |
| **AsyncAPI spec** | D13 | No longer applicable in v1: the debug plane is now cursor **polling** (`GET /debug/events`), a plain REST endpoint documented in `openapi.yaml` — there is no streaming channel to describe. Revisit only if a push transport (SSE/WebSocket) is reintroduced. | A push transport returns |
| **Web observation UI** | §5.3 | All five views (live stream, context inspector, preview/explorer, storage explorer, eval staging). The debug plane it would consume is fully wired. | After the HTTP/CLI surface stabilizes |
| **Prefix caching** | D4, §6.6 | `PrefixCache` strategy and cache breakpoints. Only `PassthroughCache` exists (`prefixTokens: 0`, no breakpoints). `usage.cachedTokens` **is** recorded from day one so the data to justify enabling it accumulates. | Usage data shows it's worth it |
| **Client-facing LLM streaming** | Q4, §7 | Streaming `complete()`, `llm.chunk` events, chunked HTTP responses. v1 is request/response only; the debug log still records the other lifecycle events. The `DebugEvent` union *includes* `llm.chunk`, but nothing emits it. | A real-time UX requirement appears |
| **Debug-event retention/pruning** | D10 | The Postgres `debug_events` table grows unbounded — no TTL, no pruning job, no cap. The in-memory log is a bounded ring (default 1000). | Before a long-running Postgres deployment |
| **Multi-step / tool-calling agent loop** | §6.7 | The send path is strictly one-shot (one user turn → one LLM call → one reply). The architecture is built to absorb a loop inside `send()` with no interface change, but the loop isn't written and there's no tool execution. | Agentic behavior is needed |
| **Multi-provider routing / fallback** | Q5 | One provider per process. No routing, no fallback, no per-agent provider selection. | A second provider is needed |
| **Anthropic adapter** | §1, D7 | We chose **OpenAI** for v1. No Anthropic provider despite the spec naming both. | Second provider needed |
| **Eval harness** | Q3, §5.3 | Metrics, dataset format, scoring. `CallRecord`s are the raw material and are queryable, but nothing consumes them for evals yet. | First eval cycle |

---

## 2. Caveats on what *was* built

Things that exist but are partial, simplified, or have sharp edges worth knowing.

- **OpenAI adapter: only the happy path is exercised live.** A real call has now
  been made (a basic completion returns reply + usage incl. `cached_tokens`), but
  streaming, tool calls, refusals, and rate-limit/backoff handling are still
  untested against real responses. Unit tests stub `fetch` for request shape,
  usage parsing, and the error path.
- **Built-bin dir-scan can't load `.ts` agents.** `node dist/main.js serve`
  scanning `CP_AGENTS_DIR` only imports `.js`/compiled agents; `.ts` agents work
  under `tsx`/`vitest`, or register agents programmatically (the recommended path
  for embedding). See [`DECISIONS.md`](./DECISIONS.md).
- **`getActualContext` reconstructs a flattened view.** The `CallRecord` stores
  the flat list that was *sent* (`systemPrompt` + `requestMessages`), not the
  original segmented `AssembledContext`. So `/debug/context/:traceId` returns a
  best-effort two-segment view (a `static` system segment + one `volatile`
  "sent" segment), **not** the original per-source segments/stability tags. The
  live `context.assembled` event *does* carry the true segments, so a client
  polling `/debug/events` sees full fidelity; replay from a `CallRecord` does not.
- **Postgres debug-log inserts are globally serialized.** To keep `seq` in
  emission order, `PostgresDebugLog` chains inserts through one promise (one at a
  time). Fine for an opt-in debug plane; not built for high-throughput event rates.
- **`previewContext` uses an empty current turn.** Preview shows the prefix an
  agent would build with `message: []` (no incoming user text), which is what you
  want for inspecting cacheability — but it isn't "the context for a specific
  next message."
- **Token counting is not model-aware and unused for budgeting.** Always uses
  `o200k_base`; there's no per-model encoding selection. We count tokens but never
  enforce a budget or truncate history — `totalTokens` is informational only.
- **`tool`-role messages are passed as plain text** to OpenAI. No `tool_call_id`,
  no function/tool-call plumbing (consistent with no tool loop).
- **Scope prefix queries are not index-backed.** Both backends key on the scope
  string identically (the scope IS the id, D2): in-memory uses it as the `Map` key,
  Postgres as `conversations.id text` (PK). Equality lookups use the PK/Map; the
  boundary-aware prefix query (`starts_with(id, prefix || '/')`, used by the debug
  explorer and `scopePrefix` record filter) is a sequential scan — fine for v1's
  admin/debug volume, not for hot-path use at scale.
- **Migration statement splitting is naive.** `src/db/migrate.ts` strips line
  comments then splits on `;`. It assumes **no semicolons inside string literals**
  in migration files. Fine for our DDL; a gotcha for future data migrations.
- **No graceful shutdown / connection draining.** `serve` doesn't drain in-flight
  in-flight requests or close pools on SIGTERM; it relies on process exit.
  (`App.close()` exists for embedders to call explicitly.)

---

## 3. Endpoints & CLI surface not present

- **Control plane not built:** `POST /blobs`, `GET /blobs/:uuid`,
  `GET/PUT/DELETE /extra-context` (their features are deferred, §1).
- **CLI has no `context` or `preview-debug` verbs.** `/debug/context/:traceId`
  and `/debug/preview` are reachable via `curl`/`ConversationProxyClient` but lack
  dedicated subcommands (the control-plane `preview` covers assembly preview).
- **No conversation mutation endpoints** beyond create (no rename/delete) and no
  message-deletion API.
- **No pagination** on `/records` or `/conversations` (only `getMessages` honors
  `before`/`limit`).

---

## 4. Operational / production concerns not addressed

These are explicitly out of scope for a v1 core and several are flagged
**[DEFERRED]** in the spec itself (§7).

- **PII / clinical-data handling (Q2):** no encryption at rest, no retention
  limits, no redaction. `CallRecord`s store full prompt context in plaintext
  jsonb. Do not run on real clinical data without addressing this.
- **Auth model specifics (Q7):** only static bearer tokens. No user accounts,
  no key rotation, no scoped/expiring tokens, no per-tenant isolation.
- **Telemetry sink at scale (Q1):** `CallRecord`s live in the same Postgres. No
  separate analytics sink (ClickHouse) — the `CallRecordStore` interface is the
  seam for it later.
- **No rate limiting, request-size limits, or backpressure** beyond the
  debug-log insert being fire-and-forget.
- **No structured logging or metrics.** Errors ≥500 go to `console.error`; there
  are no request logs, traces export, or Prometheus/OTel metrics.
- **No load/perf profiling**, and therefore no decision on the **Go rewrite (Q6)**
  — which the spec gates on exactly such profiling.

---

## 5. Process notes

- **Three design decisions were reversed** (all with sign-off), so the spec's
  letter differs from the repo:
  - Runtime + deployment: **Deno → Node**, and **dedicated-only → embeddable
    (D6/D7 reversed)** so it mounts in a Next.js server. See [`DECISIONS.md`](./docs/DECISIONS.md).
  - Migrations: **Nessie → minimal in-repo runner** (Nessie didn't fit the
    runtime); SQL is now inlined in `src/db/migrations.ts`.
  - Postgres scope: stored as `text[]`, not a NUL-joined `text` key (see §2).
- **Not committed to git yet** at the time of writing — the repo is initialized
  on `main` with no commits.
- The **assembler test kit** the spec mentions (§7, a packaged `makeTestStore`
  helper) is not shipped as a kit; tests use `InMemoryStore` + `readOnly()`
  directly.
