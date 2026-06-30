# Architecture decisions (D1–D17) and open questions

This is the firm-decision reference behind the codebase — the **why** the code's
`(D2)`, `(D11)`, `(D15)` citations point at. It was distilled from the pre-build
design RFC (`spec-files/`, since retired; the full prose lives in git history).

- **This file** = the architectural decisions and their one-line rationale.
- [`DECISIONS.md`](./DECISIONS.md) = **what actually shipped in v1**, including the
  decisions the build reversed.
- [`NOT_DONE.md`](./NOT_DONE.md) = what was deliberately left out, with caveats.

Where the build diverged from the original decision, the row below is marked **†**
and the current state is authoritative in `DECISIONS.md`.

## Reversed or changed during the build

- **D2 — scope is now a `/`-joined string and IS the conversation id** (was: an
  ordered `string[]` array with a separate `conversationId` handle). One scope ↔
  one conversation; branch with a `/<uuid>` segment. See `DECISIONS.md` →
  "Scope as conversation id".
- **D6 — embeddable *and* standalone** (was: dedicated long-lived service only).
  One Hono app; `createServer()` returns `app.fetch` to mount in Next.js.
- **D7 — Node.js (TypeScript)** (was: Deno).
- **D8 — REST + cursor-polled debug events** (was: REST + SSE). Polling is
  serverless/load-balancer friendly; durable via Postgres `debug_events`.
- **D13 — OpenAPI 3.1 shipped (`/openapi.yaml`, CI drift-checked); AsyncAPI deferred**
  alongside the future SDK debug consumer.

## Appendix A — Decision quick-reference

| ID  | Decision | One-line rationale |
| --- | --- | --- |
| D1  | Three separable layers (Store/Assembler/CacheStrategy) + Proxy | Each changes for a different reason |
| D2 †| Identity is a generic hierarchy that IS the conversation id | Server stays domain-agnostic; order enables prefix lookup |
| D3  | Assembler is a distinct role; talks to cache via stability tags | Domain-aware, vendor-agnostic; opposite of cache strategy |
| D4  | Caching starts as passthrough; usage recorded anyway | Correctness first; enable caching when data justifies |
| D5  | Single facade `ConversationAgent.send()` | One consumption surface; layers stay independently testable |
| D6 †| Embeddable + standalone (one Hono app) | `app.fetch` mounts anywhere; also runs as its own process |
| D7 †| Node.js (TypeScript) | Embeds in a Node/Next.js server; native TS for hooks |
| D8 †| REST + cursor-polled debug events | Serverless-friendly; no long-lived connection |
| D9  | Two planes (control/data + debug) | Debug can be gated, disabled, scaled independently |
| D10 | Proxy emits events to a `DebugChannel` interface; null by default | Transport-agnostic; zero overhead in prod |
| D11 | Agents are manifests (programmatic or `*.agent.ts`), resolved at startup | One file/object per agent; a broken file stops the deploy, not prod |
| D12 | Owns tables in a dedicated DB schema; tracks own migrations; advisory-locked apply | Coexists on a shared DB without colliding with other migration systems |
| D13 †| OpenAPI 3.1 (control) shipped; AsyncAPI (debug) deferred | Sync vs. streaming need different spec languages; keeps the SDK from drifting |
| D14 | Scope-keyed extra-context store; client writes, assembler reads | Lets derived domain data enter context without the server knowing its meaning |
| D15 | One unified agent model; persistence is a hook, not a mode | "One-shot" = `persist:false`; one front door, one `CallRecord` shape |
| D16 | Normalized content parts; pristine persisted vs. enveloped assembled | Media is just content; transport intent lives on the assembled envelope only |
| D17 | S3-compatible blob store with write-behind mint | UUID minted synchronously, upload in background — the LLM call never waits |

## Appendix B — Open questions

| ID | Question | Why deferred | Revisit when |
| --- | --- | --- | --- |
| Q1 | `CallRecord` storage: same Postgres vs. separate sink (ClickHouse) | Volume unknown at start; same-DB is pragmatic now | telemetry volume grows |
| Q2 | Data handling / retention for PII in envelopes | Requires compliance input | production launch |
| Q3 | Eval harness specifics (metrics, dataset format) | Depends on accumulated `CallRecord`s | first eval cycle |
| Q4 | LLM streaming to the client (not just internal) | Not needed for one-shot v1 | real-time UX requirement appears |
| Q5 | Multi-provider routing / fallback | One provider suffices for v1 | second provider needed |
| Q6 | Go rewrite of the proxy hot path | Only if profiling shows process/memory bound | load profile justifies it |
| Q7 | Auth model specifics for the two planes | Infra-dependent | first deployment |

## Glossary

- **Scope** — the conversation identity: a `/`-separated path of opaque string
  segments, broadest first and leaf last (e.g. `"user_42/client_88/patient_3/2026-W26"`).
  The scope **is** the conversation id (D2); `/` is a reserved separator and
  segments may not be empty.
- **Assembler** — an agent hook that composes the prompt from ordered,
  stability-tagged segments (`static` / `semi-static` / `volatile`).
- **CallRecord** — the full per-call envelope (exact context sent + usage +
  latency + raw provider response), written for every call; the future eval dataset.
- **Segment stability** — the contract between the assembler and the cache strategy:
  how likely a segment is to change between calls.
