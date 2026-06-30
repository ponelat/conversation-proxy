# Conversation Proxy & Observability Module — Build Handoff

**Status:** Design complete, ready to implement **Audience:** An AI coding agent or a developer
building this module from scratch **Last updated:** 2026-06-29

---

## 0. How to read this document

This is a build specification, not a tutorial. It captures every architectural decision made during
design, the rationale behind each one, the full interface contracts, concrete workflows, and a
staged build plan. Read sections 1–3 to understand _what_ and _why_, then sections 4–7 for the
_how_. Sections 8–10 cover the build order, testing, and open questions.

A reader (human or agent) should be able to implement the module from this document alone. Where a
decision was deliberately deferred, it is marked **[DEFERRED]**. Where a decision is firm, it is
stated as such with reasoning so it is not relitigated by accident.

---

## 1. What we are building

A **dedicated Deno (TypeScript) service** that sits between a client application and an LLM provider
(OpenAI/Anthropic). It owns conversation persistence, composes context intentionally from a domain
hierarchy, controls prompt caching, calls the LLM, and emits rich observability so the exact context
sent to the model can be inspected, replayed, and evaluated later.

It ships as three deliverables:

1. **The server** — a long-lived Deno (TypeScript) process exposing a REST API (control/data plane)
   and a streaming debug channel (debug plane).
2. **A TypeScript SDK** — a typed client the application imports to talk to the server, so callers
   never hand-craft HTTP.
3. **A web-based observation UI** — a browser tool that taps the debug channel in real time,
   explores the storage layer, and previews/inspects context.

These are backed by two machine-readable API contracts (D13): `openapi.yaml` (control/data plane)
and `asyncapi.yaml` (debug plane), which the SDK is generated from and validated against.

### 1.1 The domain

The first consumer is a **veterinary application**. The identity hierarchy is:

```
user (vet / clinic staff)
  └─ client (pet owner)
       └─ patient (animal)
            └─ conversation (a thread about that patient)
```

This hierarchy is central: conversations are retrieved and context is composed in terms of it. But
the server stores it as a **generic ordered array** (D2) —
`["user_42","client_88","patient_3","2026-W26"]` — and attaches no meaning to any level. The vet
domain is just one mapping onto that array; another consumer could use `["org","team","thread"]`.
Additional levels are simply longer arrays, with no method-signature changes.

### 1.2 What "agent" means here

Even though the initial behavior is **one-shot** (one user turn → one LLM call → one reply), the
module is structured as a true agent: it has persistent state (the store), a managed context window
(the assembler), and a controlled model interface (the proxy). Upgrading to a multi-step
tool-calling loop later is a change _inside one method_, with no interface changes. This is a firm
design goal, not an afterthought.

---

## 2. Core architectural decisions (firm, with rationale)

These were settled during design. Each includes the reasoning so it is not accidentally reversed.

### D1 — Three separable layers, not one

The system is decomposed into **Store**, **Assembler**, and **CacheStrategy**, plus an **LLMProxy**.
They are independent interfaces wired together, never merged.

**Rationale:** Each layer changes for different reasons. Storage changes when the backend changes
(Postgres → Redis). Assembly changes when the domain hierarchy or context-composition rules change.
Cache strategy changes when vendor caching mechanics change. Keeping them apart means a change in
one does not ripple into the others. The litmus test used throughout: _"if I change how the patient
record is cached, does the storage layer change?"_ The answer must be no.

### D2 — Identity is a generic hierarchy array, not domain-named fields

Retrieval is expressed as `listConversations(scope)` where `scope` is an **ordered array of opaque
string IDs**, broadest level first and the leaf last — e.g.
`["user_42", "client_88", "patient_3", "2026-W26"]`. The server attaches no meaning to any level. It
is **not** `getConversationsForPatient(...)`, and it is **not** a domain-named struct like
`{ userId, clientId, patientId }`.

**Rationale:** The hierarchy _is_ the abstraction. Different consumers will have different trees (a
vet app's user→client→patient→week, some other app's org→team→thread), and the server must serve all
of them without knowing the levels' meaning. An ordered array generalizes cleanly: new levels are
just longer arrays, and the **order carries the only structural fact the server needs** — that
earlier elements are broader than later ones, which is what makes prefix-based extra-context lookup
(D14) possible. A scope serializes to a stable storage key by joining the elements with a reserved
separator (`\u0000`) that cannot appear in an ID. Trade-off accepted: the array is less
self-documenting than named fields, so client teams must keep a documented convention for their
level order; the meaning lives in client code and the assembler, never in the server.

### D3 — The Assembler is a distinct third role

Context sent to the LLM is **composed** from multiple sources (system prompt, client profile,
patient record, conversation history), ordered most-stable-first. Something must build that
composition; it is neither the raw store nor the cache strategy. That something is the
`ContextAssembler`.

**Rationale:** The assembler knows the _domain_ (what a patient record is, what's reusable across a
pet's conversations) but is _vendor-agnostic_. The cache strategy knows the _vendor_ (Anthropic
`cache_control`, OpenAI prefix rules) but is _domain-agnostic_. They communicate only through
**stability tags** on segments, never through direct knowledge of each other.

### D4 — Caching starts as a no-op and is data-driven

The default `CacheStrategy` is **passthrough**: send the entire composed context, ignore caching.
Cache usage (`cachedTokens`) is recorded from day one anyway.

**Rationale:** Premature cache optimization risks correctness (a leaked volatile token in the prefix
silently breaks cache hits and is hard to debug). By recording usage envelopes even while
passthrough is the only strategy, the team accumulates the data needed to decide _when_ prefix
caching is worth enabling — before implementing it. Correctness first, optimization when measured.

### D5 — A facade exposes a single interface

The application talks to **one** object, `ConversationAgent`, with one primary method `send()`. It
internally composes store + assembler + cache + proxy via constructor injection.

**Rationale:** Independent testability of layers, single consumption surface for callers. The facade
only _orchestrates_; the heavy logic is tested at the layer below, so the facade's own test is small
(it asserts wiring: turn persisted before call, response persisted after, traceId propagated).

### D6 — Dedicated service, not embedded import

The module is a long-lived process, not a library imported into the Next.js app.

**Rationale:** The realtime debug channel requires a process that holds streaming connections and
persists across requests. Serverless/Next.js request handlers cannot be that. The three layers and
proxy become the _internals_ of this service; the facade `send()` becomes the implementation behind
a REST endpoint. Nothing from the layered design is wasted — the boundary simply relocates.

### D7 — Deno (TypeScript) runtime, not Go (for now)

The service is built in TypeScript on the **Deno** runtime.

**Rationale:** The workload is **I/O-bound** — nearly all wall-clock time is spent awaiting the LLM,
so Go's concurrency/CPU advantages are not perceptible here. TypeScript lets the existing
store/assembler/cache code be reused verbatim and keeps the team in one language. Deno specifically
is chosen over Node for three properties that matter to this design: (1) **native TypeScript with no
build step**, so client-authored hook files stay plain `.ts`; (2) **runtime dynamic `import()` of
TypeScript modules**, which makes the optional drop-in assembler loadable without a compile step
(see D11); and (3) **permission flags** (`--allow-net`, `--allow-read`, etc.) that bound what the
process — and therefore the client-authored hook running inside it — can touch. Go is revisited only
if profiling later shows process- or memory-bound load, tens of thousands of concurrent streams, or
CPU-heavy work (local embeddings) in the hot path. Because the interfaces are transport- and
language-agnostic, a future Go rewrite of the hot path is mechanical and bounded.

> **Permissions caveat:** Deno permissions are process-wide, not per-module. They constrain the hook
> by constraining the whole server process; the hook is not independently sandboxed from the proxy.
> Scope the flags to the minimum the service needs (provider host, DB host, hook directory, config).

### D8 — REST + SSE, not gRPC (for now)

The control/data plane is REST; the debug plane is SSE (or WebSocket).

**Rationale:** The debug consumer is a browser-based observation tool. gRPC streaming into a browser
needs grpc-web + a proxy (Envoy), which is real friction for a human-facing channel. REST + SSE is
dramatically simpler for "a tool taps in and watches events flow." gRPC is reserved for future
service-to-service contracts where both ends are controlled.

### D9 — Two planes in one service

A **control/data plane** (REST: send messages, query conversations, preview context) and a **debug
plane** (streaming lifecycle events + storage explorer).

**Rationale:** The debug plane can be auth-gated, disabled in prod, and scaled independently. A slow
observer must never backpressure a real request — separation guarantees this.

### D10 — The proxy emits events; the debug channel is a subscriber

The `LLMProxy` depends on a `DebugChannel` interface and calls `emit(event)`. It knows nothing about
SSE/WebSocket. The default is `NullDebugChannel` (zero overhead, no observers).

**Rationale:** Same decoupling discipline as the rest of the system. Zero subscribers in prod, many
while debugging, without the proxy knowing or caring. Transports live behind the interface.

### D11 — Agents are single-file manifests, discovered by directory scan at startup

Each agent is one file, `<agent_name>.agent.{ts,js}`, whose **default export is an async factory**
returning an `AgentManifest`. At startup the server **scans the agents directory** for all
`*.agent.{ts,js}` files (preferring `.ts` when both exist), `await import()`s each, and calls the
factory. The **filename is the agent's identity** (`summarize.agent.ts` → agent `summarize`); the
manifest may not override it. The manifest supplies optional hooks — `assemble`, `cache`, `persist`
— each of which **falls back to a built-in default when omitted**. A built-in `default` agent always
exists and can be overridden by a `default.agent.{ts,js}` file, which also supplies the fallbacks
for any other agent's missing hooks.

**Boot semantics:** the service is considered "up" only when **all** agents have loaded
successfully, within a **25-second timeout**. Any import error, factory throw, or timeout **kills
boot loudly** — there is no partial start and no per-agent silent disable. Discovery happens **once
at startup**; adding or changing an agent requires a restart.

**Rationale:** Context composition and caching are domain logic that belongs to the client, but the
server must never call back into the client app. A single manifest file per agent inverts this
cleanly: the server owns the _contract_ (the manifest shape and hook signatures), the client owns
the _implementation_. This supersedes the earlier single-`./assembler/hook.ts` design (and a brief
two-file `.context`/`.cache` convention) because the service is now **multi-agent** — one file per
agent, each declaring all of its own needs (assembly, caching, persistence behavior), is the
simplest thing that scales past one agent. A directory scan is the right discovery mechanism at N
agents (explicit per-agent registration would be tedious boilerplate); this is a deliberate reversal
of the earlier "no filesystem scan" stance, justified by the change in scale. Dynamic `import()` is
required because agent files are resolved at runtime; the Deno runtime resolves the TS import graph
with no build step, so each `.agent.ts` may freely import its own helpers. **Discover-once +
all-or-nothing boot** is chosen over hot-reload and per-agent isolation deliberately: a broken agent
file is a deploy error that should stop the deploy, not a live partial-failure to debug in
production.

### D13 — Two machine-readable API contracts: OpenAPI for control, AsyncAPI for debug

The service publishes two specs the SDK is generated/validated against: **OpenAPI 3.1** for the
synchronous control/data plane (`openapi.yaml`) and **AsyncAPI 3.0** for the event-driven debug
plane (`asyncapi.yaml`).

**Rationale:** The two planes have fundamentally different shapes — request/response vs. streaming
events — and these two spec languages are the standard counterparts for exactly that split. OpenAPI
models the synchronous endpoints and generates the SDK's typed methods; AsyncAPI models the SSE
channel and the `DebugEvent` discriminated union. Maintaining both as machine-readable specs keeps
the server and the client SDK from drifting, and lets the SDK (and mock servers/tests) be generated
rather than hand-written.

### D14 — A scope-keyed extra-context store, written by client code, read by the assembler

A separate persistence interface, `ExtraContextStore`, holds arbitrary JSON **keyed by scope**:
`getExtraContext(scope)`, `setExtraContext(scope, json)`, `clearExtraContext(scope)`. Client code
writes it out of band (via the control plane); the assembler hook reads it (via the read-only store
slice) to pull derived domain data into context. The core lookup is **exact-scope**; an opt-in
**prefix walk** helper lets an assembler inherit context from ancestor levels.

**Rationale:** Without this, a custom assembler can only read raw conversation messages — it has
nowhere to find derived domain data (a patient's last SOAP note, allergies, a rolling summary) that
should enter the prompt. A scope-keyed KV store fills that gap while preserving every boundary: the
store holds opaque JSON (server attaches no meaning), writes are a control-plane operation (the
assembler still never mutates state), and reads happen through the same read-only slice the hook
already has. Because data is attached at whatever scope level the client chooses, a SOAP note set at
the patient level naturally lands in the cacheable, `semi-static` prefix region when the assembler
adds it — aligning with future prefix caching (D4). Exact-match is the primitive because inheritance
semantics are a domain decision that belongs in the (client-owned) assembler, not in the storage
layer; the prefix walk is offered as a convenience the assembler opts into. Named "extra-context
store" (not "cache") to avoid collision with the prompt-cache concept in D4.

### D15 — One unified agent model; persistence is a hook, not a mode

There is **one kind of agent**. There is no "conversational vs. oneshot" mode enum. An agent's
manifest carries a `persist` field: a **function** for a custom persistence strategy, `false` to
disable message persistence entirely, or `true`/`undefined` to use the default (store the user turn
and the assistant reply). A "one-shot utility" agent — e.g. a document summarizer or a transcriber —
is simply an agent with `persist: false`: it reads no history and writes no messages, so it always
sends a single conceptual message. In every other respect (scope, extra-context, context assembly,
the LLM call, the `CallRecord`, debug events) its flow is **identical** to a persisting agent.

**Rationale:** Modes would force a branch through `send()` and two parallel code paths; folding
persistence into a hook collapses them into one. The insight is that "one-shot" is not a different
_kind_ of request — it is the same request with persistence turned off. This keeps a single front
door (`send()`), one observability path, and one `CallRecord` shape. It also means a utility agent
still benefits from scope and extra-context (a summarizer can read user-scoped context), and that
"summarize _with_ conversation context" is expressible by flipping one field, with no new pathway.
`send()` always sends exactly one conceptual message and never surfaces threads, regardless of
`persist`.

### D16 — Normalized multimodal content; pristine persisted parts vs. enveloped assembled parts

Message content is a normalized, provider-agnostic array of **content parts** (`text` | `image` |
`audio` | `file`). Non-text parts are **blob-only**: each carries a `sourceUri` into an
S3-compatible blob store — **never inline base64** at rest or over the service's own API. Two
representations are kept strictly separate: the **persisted** `ContentPart` / `StoredMessage` (the
source of truth for storage and the cache; never carries transport metadata) and the **assembled**
`AssembledPart` / `AssembledMessage` (ephemeral, per-request; wraps the pristine part by value and
adds a `meta` channel). The assembler decides, per part, how each should reach the model by setting
`meta.resolve` on the assembled part; a **`MediaResolver`** in the provider adapter reads that flag
and produces the vendor payload. The default assembler marks the **current turn's** media for
byte-hydration and leaves all **historical** media as refs.

**Rationale:** Treating media as just another content part means multimodal input needs no new
pathway — it reuses messages, segments, storage, and the debug plane. Blob-only at rest keeps the
cache prefix byte-stable (a media part is a short, fixed `sourceUri`, not megabytes of unique bytes)
and keeps `CallRecord`s small. The pristine-vs-assembled split is the crucial discipline: transport
intent (`resolve`) is a per-request concern that must not pollute the persisted/cached shape, so it
lives on an _envelope_ (`AssembledPart.meta`) that wraps the untouched `ContentPart` by value, never
as a field on the part itself. Putting `resolve` on the assembled part (not on a separate hydration
list, not on a positional convention) keeps the decision local to the thing decided about, survives
reordering, and keeps the resolver dumb — it just obeys the flag. The default "current-turn bytes,
history as refs" rule reflects the common case (the model needs _this_ clip as bytes; re-shipping
every past clip every turn would be ruinous and cache-hostile). **Rule:** anything marked
`resolve: true` (bytes) must live in a `volatile` segment, since hydrated bytes are by definition
not cacheable. The dedicated-transcription-API alternative was rejected: it would splinter the front
door, observability, and media handling into two of everything, and could not express
"transcribe/summarize _with_ context"; modeling transcription as an ordinary agent receiving an
audio part keeps the unified model.

### D17 — S3-compatible blob store with write-behind mint (don't block the LLM call on upload)

Binary media lives in a `BlobStore` (S3-compatible). Its key operation is a **write-behind mint**:
given bytes, it **synchronously returns a UUID and ref** and starts the upload in the background,
exposing a `flushed: Promise<void>` for durability. The bytes are also held in an **in-process
pending buffer** keyed by the UUID. The `MediaResolver`, hydrating a part marked `resolve: true`,
fetches bytes **from the pending buffer first** (instant, no network) and falls back to the blob
store if already flushed. The LLM call **never awaits** `flushed`. Stored messages and `CallRecord`s
hold only the ref; the debug plane resolves a ref to a fetchable URL (download/play link), never
inline bytes.

**Rationale:** The latency requirement is explicit — do not wait for blob persistence before sending
the request to the LLM. Minting the UUID synchronously and uploading in the background takes
persistence off the critical path; the pending buffer guarantees the resolver can supply bytes
immediately even if the S3 write hasn't landed. This also yields the bytes-vs-ref answer cleanly:
the message list always holds refs (cache-stable, durable), and bytes are a _resolution step_ at the
transport boundary, not a second representation in the list — which is why no
`ephemeral`/inline-base64 field is needed on `ContentPart`. Base64 still exists, but only
transiently, inside the provider adapter, for providers that require inline data (providers that
accept URLs get the resolved URL instead).

### D12 — Owns its tables in a dedicated DB namespace; tracks its own migrations with a standard tool

The service plugs into an **existing shared database**. It isolates all its tables in a **dedicated
Postgres schema** (e.g. `conversation_proxy`) and tracks migration state in its **own migration
table inside that schema**, using an established migration tool's format (node-pg-migrate or Umzug)
rather than a hand-rolled one.

**Rationale:** The service must coexist on a shared DB without other migration systems
(Flyway/Prisma/raw SQL) ever touching its state, and without the team having to evolve a bespoke
migration-tracking format. A dedicated schema gives the strongest isolation; configuring a standard
tool's `migrationsTable` + `schema` to the service namespace means its applied-migrations ledger is
invisible to and non-conflicting with anything else on that database. Migrations apply via an
explicit `migrate` command by default; passing **`--migrate-on-startup`** runs pending migrations
(guarded by a Postgres advisory lock to avoid races across instances) before the server accepts
requests.

---

## 3. System overview

### 3.1 The pipeline

```
                   ┌─────────────────────── Dedicated Deno (TS) Service ─────────────────────┐
                   │                                                                          │
App ──(SDK)──► REST control/data plane                                                        │
                   │      │                                                                   │
                   │      ▼                                                                   │
                   │   ConversationAgent.send()   ◄── the facade (D5)                         │
                   │      │                                                                   │
                   │      ├─1─► Store.appendMessages()      (persist incoming turn)           │
                   │      ├─2─► Assembler.assemble()        (compose tagged segments, D3)      │
                   │      ├─3─► CacheStrategy.prepare()     (passthrough now, prefix later, D4)│
                   │      ├─4─► LLMProxy.complete() ──► OpenAI/Anthropic                       │
                   │      │         │                                                          │
                   │      │         └──► DebugChannel.emit()  ──► NullDebugChannel (prod)      │
                   │      │                                   └─► BroadcastDebugChannel ──┐    │
                   │      └─5─► Store.appendMessages()      (persist response)            │    │
                   │      └────► CallRecordStore.write()    (telemetry envelope for evals)│    │
                   │                                                                      │    │
Observation UI ◄── debug plane (SSE/WS subscribers) ◄─────────────────────────────────────┘    │
Observation UI ◄── ContextExplorer (read-only: actual context, preview, storage browse)       │
                   └──────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Responsibility table

| Component                 | Knows about                                | Does NOT know about                      | Changes when                      |
| ------------------------- | ------------------------------------------ | ---------------------------------------- | --------------------------------- |
| `ConversationStore`       | scope, messages, persistence               | LLM, caching, ordering-for-cache         | storage backend changes           |
| `ExtraContextStore`       | scope-keyed JSON blobs (opaque)            | the meaning of the JSON, LLM, caching    | new backend; new lookup semantics |
| `Agent registry`          | loaded agents by name, their hooks         | how hooks are implemented (client's job) | agents added/changed (restart)    |
| `BlobStore`               | media bytes, refs, write-behind upload     | what the media means, the provider       | blob backend changes              |
| `MediaResolver`           | vendor media encoding, bytes-vs-url        | domain meaning, which parts to hydrate   | provider/media-format changes     |
| `ContextAssembler` (hook) | domain hierarchy, segment order, stability | vendor cache syntax, transport           | composition rules change          |
| `CacheStrategy`           | vendor cache mechanics, breakpoints        | domain meaning of segments               | vendor caching changes            |
| `LLMProxy`                | provider SDKs, request/response, telemetry | your DB schema, domain                   | provider/telemetry changes        |
| `ConversationAgent`       | how to orchestrate the above               | internals of each                        | orchestration steps change        |
| `DebugChannel`            | event fan-out                              | who produces events, transport detail    | new transport added               |
| `ContextExplorer`         | reading store + assembler preview          | writing, LLM calls                       | query needs change                |

---

## 4. Interface contracts (the heart of the spec)

All interfaces are TypeScript. Implementations are injected. Names are normative; adjust types as
needed but preserve the boundaries.

### 4.1 Identity & messages

```typescript
// The hierarchy, as an ordered array of opaque IDs (D2). Broadest level first,
// leaf last. The server attaches NO meaning to any level.
//   e.g. ["user_42", "client_88", "patient_3", "2026-W26"]
type ConversationScope = string[];

// Reserved separator used to serialize a scope to a storage key.
// Must not appear in any ID.
const SCOPE_SEP = "\u0000";
const scopeKey = (s: ConversationScope) => s.join(SCOPE_SEP);

type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

type ConversationId = string;

interface ConversationMeta {
  id: ConversationId;
  scope: ConversationScope;
  title?: string;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  metadata?: Record<string, unknown>;
}

interface Conversation extends ConversationMeta {
  messages: StoredMessage[];
}

type Role = "system" | "user" | "assistant" | "tool";

// --- Persisted content model (D16) -----------------------------------------
// Normalized, provider-agnostic content parts. Non-text parts are BLOB-ONLY:
// each carries a sourceUri into the blob store (D17). NEVER inline base64 at rest.
// This is the source of truth for storage AND the cache — it never carries
// transport metadata.
type ContentPart =
  | { kind: "text"; text: string }
  | { kind: "image"; mime: string; sourceUri: string }
  | { kind: "audio"; mime: string; sourceUri: string; transcript?: string }
  | { kind: "file"; mime: string; sourceUri: string; name?: string };

interface StoredMessage {
  id: string;
  role: Role;
  content: ContentPart[]; // text-only is just [{ kind: 'text', text }]
  tokenCount?: number; // populated when known; used by assembler budgeting
  createdAt: string; // ISO 8601
  metadata?: Record<string, unknown>;
}
```

### 4.1a Assembled (ephemeral) content model (D16)

The assembler emits **enveloped** types that wrap the pristine persisted parts by value and add a
per-request `meta` channel. The store and cache never see these; only the proxy/resolver do.

```typescript
type ResolveMode = boolean; // true → hydrate to bytes for the provider; false/undefined → keep as ref

interface PartMeta {
  resolve?: ResolveMode; // transport intent — NEVER persisted
  // room for future per-part hints (redaction, priority, token-budget…)
}

interface AssembledPart {
  part: ContentPart; // the pristine persisted shape, untouched, by value
  meta?: PartMeta; // ephemeral, per-request
}

interface MessageMeta {
  // room for per-message transport hints
  [k: string]: unknown;
}

interface AssembledMessage {
  source: StoredMessage; // pristine persisted message, reachable untouched
  parts: AssembledPart[]; // each pristine part + its ephemeral meta
  meta?: MessageMeta; // message-level ephemeral hints
}
```

> **Caching rule (D16):** any part with `meta.resolve === true` (sent as bytes) MUST live in a
> `volatile` segment — hydrated bytes are by definition not cacheable. Marking media in a
> `static`/`semi-static` segment for byte-hydration silently wrecks that segment's cache.

### 4.2 The storage boundary (copy this shape per backend)

```typescript
interface ConversationStore {
  // Retrieval is scope-based (D2): scope is an ordered hierarchy array, not id-based.
  listConversations(scope: ConversationScope): Promise<ConversationMeta[]>;
  getConversation(id: ConversationId): Promise<Conversation | null>;
  createConversation(
    scope: ConversationScope,
    meta?: Partial<ConversationMeta>,
  ): Promise<Conversation>;

  appendMessages(id: ConversationId, msgs: StoredMessage[]): Promise<void>;
  getMessages(
    id: ConversationId,
    opts?: { limit?: number; before?: string },
  ): Promise<StoredMessage[]>;
}

// Concrete adapters implement the same interface (Mastra-style adapter pattern).
// class InMemoryStore  implements ConversationStore {}   // dev / tests
// class PostgresStore  implements ConversationStore {}   // prod (Supabase fits here)
```

**The extra-context store (D14)** — scope-keyed arbitrary JSON, written by client code, read by the
assembler:

```typescript
interface ExtraContextStore {
  // Exact-scope lookup is the primitive.
  getExtraContext(scope: ConversationScope): Promise<JsonValue | null>;
  setExtraContext(scope: ConversationScope, value: JsonValue): Promise<void>;
  clearExtraContext(scope: ConversationScope): Promise<void>;

  // Opt-in convenience: walk from the given scope up to the root, returning each
  // ancestor level's value (nearest-first). The assembler decides whether to use it.
  getExtraContextChain?(scope: ConversationScope): Promise<
    Array<{ scope: ConversationScope; value: JsonValue }>
  >;
}
```

**Postgres schema sketch** (first real adapter, given the Next.js/Supabase stack). Scope is stored
as a serialized key plus the raw array for prefix queries:

```
conversations(
  id            uuid primary key,
  scope_key     text not null,          -- scopeKey(scope): elements joined by SCOPE_SEP
  scope_arr     text[] not null,        -- raw hierarchy, for prefix/ancestor queries
  title         text,
  metadata      jsonb default '{}',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
)
-- index on (scope_key); GIN or expression index on scope_arr for prefix matches

messages(
  id              uuid primary key,
  conversation_id uuid not null references conversations(id),
  role            text not null,
  content         jsonb not null,
  token_count     int,
  metadata        jsonb default '{}',
  created_at      timestamptz not null default now()
)
-- index on (conversation_id, created_at)

extra_context(
  scope_key     text primary key,       -- scopeKey(scope)
  scope_arr     text[] not null,        -- raw hierarchy, for ancestor/prefix walks
  value         jsonb not null,
  updated_at    timestamptz not null default now()
)
-- index on scope_arr for getExtraContextChain ancestor lookups
```

### 4.3 Agents, the assembler hook, and the registry (D3, D11, D15, D16)

An **agent** is one file, `<name>.agent.{ts,js}`, whose default export is an **async factory**
returning an `AgentManifest`. The manifest supplies optional hooks (`assemble`, `cache`, `persist`);
each missing hook falls back to a built-in default. The server scans the agents directory at
startup, loads every agent, and serves them from a registry keyed by filename.

```typescript
type SegmentStability = "static" | "semi-static" | "volatile";

interface ContextSegment {
  source: string; // free-form label, e.g. 'system' | 'history' | a domain tag
  stability: SegmentStability; // the contract with CacheStrategy (D3)
  messages: AssembledMessage[]; // enveloped, ephemeral parts (D16)
}

interface AssembledContext {
  segments: ContextSegment[]; // ordered most-stable-first
  totalTokens: number;
}

// Read-only slice handed to hooks — read conversations AND extra-context (D14),
// never write (D11).
type ReadOnlyConversationStore =
  & Pick<ConversationStore, "listConversations" | "getConversation" | "getMessages">
  & Pick<ExtraContextStore, "getExtraContext" | "getExtraContextChain">;

// The incoming turn is now multimodal content parts (D16), not a bare string.
interface AssemblerInput {
  scope: ConversationScope;
  conversationId?: ConversationId; // absent for non-persisting agents (D15)
  message: ContentPart[]; // the incoming user turn's parts
  store: ReadOnlyConversationStore;
}

type AssemblerHook = (input: AssemblerInput) => Promise<AssembledContext>;

// --- Persistence is a hook, not a mode (D15) -------------------------------
interface PersistenceHook {
  // Utility agents return [] here; persisting agents load prior turns.
  loadHistory(scope: ConversationScope, conversationId?: ConversationId): Promise<StoredMessage[]>;
  // No-op for utility agents; default stores user + assistant turns.
  persistTurn(
    scope: ConversationScope,
    conversationId: ConversationId | undefined,
    user: StoredMessage,
    assistant: StoredMessage,
  ): Promise<void>;
}

// --- The agent manifest (D11, D15) -----------------------------------------
interface AgentManifest {
  assemble?: AssemblerHook; // omitted → default assembler
  cache?: CacheStrategy; // omitted → passthrough
  persist?: PersistenceHook | boolean; // fn = custom · false = off · true/undefined = default
}

// THE CONTRACT every <name>.agent.ts must default-export:
type AgentFactory = () => Promise<AgentManifest>;
```

**The default assembler** (used when an agent omits `assemble`). Most recent conversation for the
scope; history as a volatile segment; the **current turn's** media marked for byte-hydration,
history media left as refs (D16):

```typescript
export const defaultAssembler: AssemblerHook = async (
  { scope, conversationId, message, store },
) => {
  const id = conversationId ?? (await store.listConversations(scope))[0]?.id;
  const history = id ? await store.getMessages(id) : [];

  // history → enveloped, all parts left as refs (resolve omitted)
  const historyMsgs = history.map(toAssembledMessage);
  // current turn → enveloped, media marked resolve:true (hydrate to bytes)
  const currentMsg = assembledFromParts("user", message, /* hydrateMedia */ true);

  return {
    segments: [
      { source: "conversation", stability: "volatile", messages: [...historyMsgs, currentMsg] },
    ],
    totalTokens: countTokens(history),
  };
};
```

**A custom agent** lives at `<name>.agent.ts`, default-exports an async factory, and may freely
import its own helpers (Deno, D7). This `vet.agent.ts` reads a patient-level SOAP note from
extra-context and keeps the default message persistence:

```typescript
// vet.agent.ts
import { assembledFromParts, systemNote, toAssembledMessage } from "./helpers.ts";

export default async function (): Promise<AgentManifest> {
  return {
    async assemble({ scope, conversationId, message, store }) {
      const patientScope = scope.slice(0, 3); // [user, client, patient]
      const extra = await store.getExtraContext(patientScope);
      const history = conversationId ? await store.getMessages(conversationId) : [];

      return {
        segments: [
          ...(extra && typeof extra === "object" && "lastSoapNote" in extra
            ? [{
              source: "patient-soap",
              stability: "semi-static" as const,
              messages: [systemNote(String(extra.lastSoapNote))],
            }] // ref/text, stays cacheable
            : []),
          {
            source: "conversation",
            stability: "volatile" as const,
            messages: [
              ...history.map(toAssembledMessage),
              assembledFromParts("user", message, true),
            ],
          },
        ],
        totalTokens: 0,
      };
    },
    // persist omitted → default message storage
  };
}
```

**A one-shot utility agent** sets `persist: false` — no history, no stored messages, but full
observability (D15). This `summarize.agent.ts` summarizes whatever document parts arrive:

```typescript
// summarize.agent.ts
export default async function (): Promise<AgentManifest> {
  return {
    persist: false, // utility: never stores messages
    async assemble({ message }) {
      // no history to read; just compose the incoming parts (+ instructions)
      return {
        segments: [{
          source: "input",
          stability: "volatile",
          messages: [assembledFromParts("user", message, true)],
        }],
        totalTokens: 0,
      };
    },
  };
}
```

**The agent registry & loader (D11)** — pure directory scan, all-or-nothing boot within 25s:

```typescript
const AGENTS_DIR = "./agents";
const BOOT_TIMEOUT_MS = 25_000;

export async function loadAgents(): Promise<Map<string, ResolvedAgent>> {
  const registry = new Map<string, ResolvedAgent>();
  const files = [...Deno.readDirSync(AGENTS_DIR)]
    .filter((f) => /\.agent\.(ts|js)$/.test(f.name));

  // prefer .ts when both <name>.agent.ts and .js exist
  const byName = preferTs(files);

  await withTimeout(
    BOOT_TIMEOUT_MS,
    Promise.all(
      [...byName].map(async ([name, file]) => {
        const mod = await import(`${AGENTS_DIR}/${file}`);
        if (typeof mod.default !== "function") {
          throw new Error(`${file}: default export must be an async AgentManifest factory`);
        }
        const manifest = await mod.default(); // any throw kills boot (loud)
        registry.set(name, resolveAgent(name, manifest)); // fill missing hooks w/ defaults
      }),
    ),
  );

  // ensure a built-in 'default' agent exists (overridable by default.agent.ts)
  if (!registry.has("default")) registry.set("default", resolveAgent("default", {}));
  return registry;
}
```

A broken file, a non-function default export, or exceeding 25s **fails boot loudly** — no partial
start. Adding an agent requires a restart (discover-once, D11).

**Preview reuses the same agent.** The "what would be sent without calling the LLM" path resolves
the named agent and invokes its `assemble` with the same `AssemblerInput`, returning the
`AssembledContext` — preview matches the live path exactly.

**Assembler ordering (most-stable → most-volatile):**

```
[ system / clinic prompt ]    stability: static       shared across everyone
[ client profile ]            stability: semi-static  shared across this client's pets
[ patient record ]            stability: semi-static  shared across this pet's conversations
[ this conversation history ] stability: volatile     changes every turn
```

**Normalization requirement (critical for caching):** For an upper segment (e.g. the patient record)
to hit cache across conversations, its serialized form must be **byte-identical** every time for
that pet. The assembler MUST normalize upper segments deterministically — sorted JSON keys, fixed
formatting, no timestamps or per-request values. This normalization is a core reason the assembler
is distinct from the raw store.

### 4.4 The cache-strategy boundary (D4)

```typescript
interface CacheBreakpoint {
  afterSegmentIndex: number; // breakpoint placed after this segment
  // vendor-specific hints can extend this (e.g. Anthropic ttl tier)
}

interface PreparedContext {
  messages: AssembledMessage[]; // final flat list to send (enveloped, D16)
  systemPrompt: string;
  breakpoints: CacheBreakpoint[];
  prefixTokens: number; // tokens in the cacheable prefix (0 for passthrough)
}

interface CacheStrategy {
  // Reads stability tags; decides arrangement + breakpoints. Vendor-aware, domain-agnostic.
  prepare(ctx: AssembledContext): PreparedContext;
}

// Default (D4): send everything, no breakpoints, prefixTokens = 0.
// class PassthroughCache implements CacheStrategy {}
// Later: mark stable prefix + add provider breakpoints.
// class PrefixCache      implements CacheStrategy {}
```

### 4.4a The blob store + media resolver (D16, D17)

```typescript
// S3-compatible blob store with a WRITE-BEHIND mint (D17): UUID is returned
// synchronously; the upload runs in the background; bytes are also held in an
// in-process pending buffer keyed by UUID so the resolver never waits on S3.
interface BlobStore {
  mint(bytes: Uint8Array, mime: string): {
    uuid: string;
    ref: string; // e.g. blob://<bucket>/<uuid>
    flushed: Promise<void>; // resolves when durably written — the LLM call NEVER awaits this
  };
  getBytes(ref: string): Promise<Uint8Array>; // pending-buffer-first, then S3
  resolveUrl(ref: string): Promise<string>; // a fetchable URL for the debug UI (download/play)
}

// Lives in the provider adapter — the ONLY component that knows vendor media
// encoding. Reads meta.resolve on each assembled part and produces the vendor
// payload. resolve:true → inline bytes (from BlobStore.getBytes, transiently
// base64 if the provider requires it); otherwise pass a resolved URL or omit.
interface MediaResolver {
  toProviderPayload(messages: AssembledMessage[], provider: ProviderId): Promise<ProviderContent>;
}
```

> Base64 exists **only transiently**, inside `toProviderPayload`, for providers that require inline
> data. It is never stored, never cached, never in a `CallRecord`. Providers that accept URLs
> receive `resolveUrl(ref)` instead.

### 4.5 The LLM proxy + telemetry boundary

```typescript
interface Usage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number; // recorded from day one (D4), even under passthrough
}

interface LLMRequest {
  prepared: PreparedContext;
  model: string;
  // sampling params, tools, etc.
}

interface LLMResponse {
  reply: string;
  usage: Usage;
  raw?: unknown; // provider raw response, for debugging
}

interface CallContext {
  agent: string; // which agent served this call (D15)
  conversationId?: ConversationId; // absent for non-persisting agents (D15)
  scope: ConversationScope;
  traceId: string;
}

interface LLMProxy {
  complete(req: LLMRequest, ctx: CallContext): Promise<LLMResponse>;
}

// The full envelope recorded for EVERY call. This IS the eval dataset later.
interface CallRecord {
  traceId: string;
  agent: string; // D15
  conversationId?: ConversationId; // absent for utility agents
  scope: ConversationScope;
  systemPrompt: string;
  requestMessages: AssembledMessage[]; // exact context sent (enveloped; media as refs, D16)
  breakpoints: CacheBreakpoint[];
  model: string;
  response: LLMResponse;
  usage: Usage; // cache hit rate is derived from here
  latencyMs: number;
  timestamp: string; // ISO 8601
  error?: { stage: DebugStage; message: string };
}

interface CallRecordStore {
  write(record: CallRecord): Promise<void>;
  get(traceId: string): Promise<CallRecord | null>;
  query(filter: CallRecordFilter): Promise<CallRecordMeta[]>;
}

interface CallRecordFilter {
  agent?: string; // filter by agent (D15)
  scopePrefix?: ConversationScope; // match records whose scope starts with this prefix
  conversationId?: ConversationId;
  model?: string;
  since?: string;
  until?: string;
}

type CallRecordMeta = Omit<CallRecord, "requestMessages" | "response"> & {
  replyPreview?: string;
};
```

### 4.6 The debug channel (D10)

```typescript
type DebugStage = "assemble" | "cache" | "llm" | "persist";

type DebugEvent =
  | {
    type: "request.received";
    traceId: string;
    agent: string;
    conversationId?: string;
    scope: ConversationScope;
    ts: string;
  }
  | {
    type: "context.assembled";
    traceId: string;
    agent: string;
    segments: ContextSegment[];
    totalTokens: number;
    ts: string;
  }
  | {
    type: "cache.prepared";
    traceId: string;
    agent: string;
    breakpoints: CacheBreakpoint[];
    prefixTokens: number;
    ts: string;
  }
  | {
    type: "llm.request";
    traceId: string;
    agent: string;
    model: string;
    messages: AssembledMessage[];
    systemPrompt: string;
    ts: string;
  }
  | { type: "llm.chunk"; traceId: string; agent: string; delta: string; ts: string } // only if streaming the LLM
  | {
    type: "llm.response";
    traceId: string;
    agent: string;
    reply: string;
    usage: Usage;
    latencyMs: number;
    ts: string;
  }
  | {
    type: "error";
    traceId: string;
    agent: string;
    stage: DebugStage;
    message: string;
    ts: string;
  };

// Media in events is carried as metadata only (kind, mime, sourceUri) — NEVER raw
// bytes. The UI resolves a sourceUri to a GET /blobs/:uuid URL for download/play.

// The proxy depends on THIS, not on any transport.
interface DebugChannel {
  emit(event: DebugEvent): void;
}

// Production default: zero overhead.
class NullDebugChannel implements DebugChannel {
  emit(): void {}
}

type DebugEventFilter = (e: DebugEvent) => boolean;

interface DebugSubscriber {
  send(event: DebugEvent): void;
  readonly filter?: DebugEventFilter; // e.g. only this traceId, or only llm.* events
}

// Debug build: fan out to live SSE/WS subscribers.
class BroadcastDebugChannel implements DebugChannel {
  private subscribers = new Set<DebugSubscriber>();
  subscribe(sub: DebugSubscriber): () => void {
    this.subscribers.add(sub);
    return () => this.subscribers.delete(sub);
  }
  emit(event: DebugEvent): void {
    for (const sub of this.subscribers) {
      if (!sub.filter || sub.filter(event)) sub.send(event);
    }
  }
}
```

### 4.7 The context explorer (debug plane, read-only)

```typescript
interface ContextExplorer {
  // What WAS sent for a past call (from the persisted CallRecord).
  getActualContext(traceId: string): Promise<AssembledContext>;

  // What WOULD be assembled right now, WITHOUT calling the LLM (reuses the named agent's hook).
  previewContext(
    agent: string,
    scope: ConversationScope,
    conversationId?: ConversationId,
  ): Promise<AssembledContext>;

  // Browse storage by hierarchy — pass a scope prefix to scope the browse
  // (e.g. ["user_42","client_88"] lists everything under that client).
  explore(scopePrefix: ConversationScope): Promise<{
    conversations: ConversationMeta[];
    records: CallRecordMeta[]; // usage, cache hit rate, latency per call
  }>;
}
```

### 4.8 The facade (D5, D15)

```typescript
interface AgentInput {
  agent: string; // which agent to invoke (D15); 404 if unknown
  scope: ConversationScope;
  conversationId?: ConversationId; // ignored by non-persisting agents
  input: ContentPart[]; // the turn's content parts (text + media), D16
}

interface AgentResponse {
  reply: string;
  conversationId?: ConversationId; // present only for persisting agents
  traceId: string;
  usage: Usage;
}

interface ConversationAgent {
  send(input: AgentInput): Promise<AgentResponse>;
}
```

Reference implementation — one path for all agents; persistence behavior comes from the agent's
resolved `persist` hook (D15), so there is no oneshot branch:

```typescript
class PersistedConversationAgent implements ConversationAgent {
  constructor(
    private registry: Map<string, ResolvedAgent>, // loaded agents (D11)
    private store: ConversationStore,
    private proxy: LLMProxy,
    private records: CallRecordStore,
  ) {}

  async send(input: AgentInput): Promise<AgentResponse> {
    const agent = this.registry.get(input.agent);
    if (!agent) throw new NotFound(`unknown agent: ${input.agent}`); // 404 (D11)

    const userMsg = messageFromParts("user", input.input);

    // 1. persist the incoming turn — the hook decides (no-op for utility agents)
    const conversationId = await agent.persist.beginTurn(
      input.scope,
      input.conversationId,
      userMsg,
    );

    // 2. assemble context via the agent's hook (history may be [] for utility agents)
    const assembled = await agent.assemble({
      scope: input.scope,
      conversationId,
      input: input.input,
      store: readOnly(this.store),
    });

    // 3. apply the agent's cache strategy (passthrough by default)
    const prepared = agent.cache.prepare(assembled);

    // 4. call the LLM through the observability proxy (resolver hydrates media)
    const ctx: CallContext = {
      agent: input.agent,
      conversationId,
      scope: input.scope,
      traceId: newTraceId(),
    };
    const res = await this.proxy.complete({ prepared, model: agent.model }, ctx);

    // 5. persist the response — again, the hook decides
    await agent.persist.endTurn(input.scope, conversationId, userMsg, assistantMsg(res.reply));

    return { reply: res.reply, conversationId, traceId: ctx.traceId, usage: res.usage };
  }
}
```

> The `persist` hook (D15) absorbs what would otherwise be a `oneshot` branch. A utility agent's
> `persist` no-ops `beginTurn`/`endTurn` and returns no `conversationId`; a persisting agent stores
> both turns. The proxy still writes the `CallRecord` and emits debug events for **every** agent
> regardless of persistence.

---

## 5. The three deliverables

### 5.1 The server

**Runtime:** Deno (latest stable), TypeScript, no build step (D7). HTTP via Deno's built-in server
(`Deno.serve`) or a thin Deno-compatible router (e.g. Hono, which runs on Deno and has clean SSE
support). No framework lock-in in the core — HTTP is an adapter over the facade.

**Process model (D6):** one long-lived agent constructed at startup with stateless injected
collaborators. Per-request construction is unnecessary since no collaborator holds request-scoped
state.

**REST endpoints (control/data plane, D9):**

| Method & path                                            | Purpose                                                                                                                          | Body / params → returns                               |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `POST /agents/:agent/messages`                           | The `send()` facade for a named agent (D15). `:agent` is the filename identity; `"default"` is a valid name; unknown → 404 (D11) | `{ scope, conversationId?, input }` → `AgentResponse` |
| `GET /agents`                                            | List loaded agents                                                                                                               | → `{ name, persists }[]`                              |
| `POST /conversations`                                    | Create a conversation                                                                                                            | `{ scope, meta? }` → `ConversationMeta`               |
| `GET /conversations?scope=a/b/c`                         | List by scope (path-encoded hierarchy)                                                                                           | → `ConversationMeta[]`                                |
| `GET /conversations/:id`                                 | Fetch one + messages                                                                                                             | → `Conversation`                                      |
| `GET /agents/:agent/context?scope=a/b/c&conversationId=` | What context the agent _would_ assemble (no LLM)                                                                                 | → `AssembledContext`                                  |
| `POST /blobs`                                            | Upload media; write-behind mint (D17). Body is raw bytes + `Content-Type`                                                        | → `{ uuid, sourceUri }`                               |
| `GET /blobs/:uuid`                                       | Fetch/stream a blob (debug download/play links resolve here)                                                                     | → bytes                                               |
| `GET /extra-context?scope=a/b/c`                         | Read scope-attached JSON (D14)                                                                                                   | → `JsonValue \| null`                                 |
| `PUT /extra-context?scope=a/b/c`                         | Write scope-attached JSON (D14)                                                                                                  | `{ value }` → `204`                                   |
| `DELETE /extra-context?scope=a/b/c`                      | Clear scope-attached JSON (D14)                                                                                                  | → `204`                                               |
| `GET /records/:traceId`                                  | Fetch a call envelope                                                                                                            | → `CallRecord`                                        |
| `GET /records?agent=&scopePrefix=a/b&…`                  | Query call envelopes                                                                                                             | → `CallRecordMeta[]`                                  |

> **Scope encoding in URLs:** the hierarchy array is passed as a single `scope` query param with
> elements joined by `/` and each element percent-encoded (e.g.
> `scope=user_42%2Fclient_88%2Fpatient_3`). The server splits and decodes back to the array. This
> keeps arbitrary-depth hierarchies in one stable param.
>
> **Media flow:** a client uploads bytes to `POST /blobs` (getting a `sourceUri`) and passes that
> `sourceUri` inside an `input` content part to `POST /agents/:agent/messages`. Because the mint is
> write-behind (D17), the upload need not have flushed before the message call.

**Debug plane (D9, D10):**

| Method & path                              | Purpose                                                                                                                                                                            |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /debug/stream?traceId=&agent=&types=` | SSE stream of `DebugEvent`s; optional filters (incl. by agent). Each connection registers a `DebugSubscriber` on the `BroadcastDebugChannel`; closing the connection unsubscribes. |
| `GET /debug/context/:traceId`              | `ContextExplorer.getActualContext` (media shown as metadata + a `GET /blobs/:uuid` URL)                                                                                            |
| `POST /debug/preview`                      | `ContextExplorer.previewContext` (`{ agent, scope, conversationId? }`)                                                                                                             |
| `GET /debug/explore?scope=a/b/c`           | `ContextExplorer.explore`                                                                                                                                                          |

The debug plane should be independently auth-gated and switchable off in production (swap
`BroadcastDebugChannel` for `NullDebugChannel` via config; when null, debug endpoints return
404/disabled).

**Configuration knobs:** provider + model, storage adapter selection, agents directory path (D11),
blob store config (S3 bucket/endpoint — D17), cache strategy selection (`passthrough` | `prefix`),
DB schema name + migration mode (`command` | `startup-with-lock` — D12), debug channel on/off, auth
secrets. All via env/config, no code change to swap.

### 5.2 The TypeScript SDK

A thin, fully-typed client wrapping the REST + SSE endpoints so the application never crafts HTTP by
hand. It re-exports the shared types (scope, messages, `AgentResponse`, `DebugEvent`, etc.) from a
common package so server and SDK cannot drift. **The control-plane methods are generated from /
validated against `openapi.yaml`, and the debug-stream consumer against `asyncapi.yaml` (D13)**, so
the SDK surface stays in lockstep with the specs.

```typescript
class ConversationProxyClient {
  constructor(opts: { baseUrl: string; apiKey?: string });

  // send() takes the agent name + content parts (D15, D16)
  send(input: AgentInput): Promise<AgentResponse>;
  listAgents(): Promise<Array<{ name: string; persists: boolean }>>;

  createConversation(
    scope: ConversationScope,
    meta?: Partial<ConversationMeta>,
  ): Promise<ConversationMeta>;
  listConversations(scope: ConversationScope): Promise<ConversationMeta[]>;
  getConversation(id: ConversationId): Promise<Conversation>;
  previewContext(
    agent: string,
    scope: ConversationScope,
    conversationId?: ConversationId,
  ): Promise<AssembledContext>;

  // Media (D16, D17) — upload returns a sourceUri to embed in a ContentPart
  uploadBlob(bytes: Uint8Array | Blob, mime: string): Promise<{ uuid: string; sourceUri: string }>;
  blobUrl(uuid: string): string; // a fetchable URL (download/play)

  // Extra-context store (D14)
  getExtraContext(scope: ConversationScope): Promise<JsonValue | null>;
  setExtraContext(scope: ConversationScope, value: JsonValue): Promise<void>;
  clearExtraContext(scope: ConversationScope): Promise<void>;

  getRecord(traceId: string): Promise<CallRecord>;
  queryRecords(filter: CallRecordFilter): Promise<CallRecordMeta[]>;

  // Debug plane
  streamDebug(
    opts?: { traceId?: string; agent?: string; types?: DebugEvent["type"][] },
  ): AsyncIterable<DebugEvent>;
}
```

**Packaging:** publish (or workspace-link) three packages: `@vetproxy/types` (shared contracts),
`@vetproxy/sdk` (client), and the server app. The types package is the single source of truth; both
server and SDK import from it.

### 5.3 The web-based observation UI

A browser tool for inspecting and debugging conversations in real time. Built as a separate frontend
(React/Next.js fits the existing stack) that talks only to the debug plane + read endpoints.

**Core views:**

1. **Live stream** — subscribes to `GET /debug/stream`, renders `DebugEvent`s as they flow
   (request.received → context.assembled → cache.prepared → llm.request → llm.response). Filter by
   `traceId` or event type. This is the "watch requests go to the LLM in real time" view.
2. **Context inspector** — for a selected `traceId`, shows the exact `AssembledContext` (segments,
   stability tags, token counts) and the final flat prompt. Highlights which segments were in the
   cacheable prefix.
3. **Context preview / explorer** — pick a scope (user → client → patient) and call `previewContext`
   to see what _would_ be sent right now, before any real request. Visualizes prefix byte-stability
   so the user can confirm a patient record will actually cache across conversations.
4. **Storage explorer** — browse the hierarchy, list conversations and their `CallRecordMeta`
   (usage, cache hit rate, latency). Drill into any call's full envelope.
5. **Eval staging [DEFERRED detail]** — select sets of `CallRecord`s for later offline evaluation of
   caching and response quality. At minimum, export selected records as a dataset.

**Design guidance:** Follow the `frontend-design` skill conventions if building polished UI. The UI
is read-only against the system except for triggering previews; it must never mutate conversations.

### 5.4 The API contracts (D13)

Two machine-readable specs ship with the service and are the source of truth for the SDK:

- **`openapi.yaml` (OpenAPI 3.1)** — the control/data plane. Endpoints: `createConversation`,
  `listConversations`, `getConversation`, `send`, `previewContext`, `getRecord`, `queryRecords`.
  Auth via an `Authorization` header API key. All schemas (scope, messages, `AssembledContext`,
  `CallRecord`, etc.) are defined here.
- **`asyncapi.yaml` (AsyncAPI 3.0)** — the debug plane. One SSE channel `/debug/stream` with
  optional `traceId`/`types` filters, carrying the seven `DebugEvent` message types
  (`request.received`, `context.assembled`, `cache.prepared`, `llm.request`, `llm.chunk`,
  `llm.response`, `error`) as a discriminated union on `type`.

Keep both specs versioned in the repo next to the server. Regenerate or validate the SDK against
them in CI so server and client cannot silently drift. The remaining read-only debug endpoints
(`/debug/context/:traceId`, `/debug/preview`, `/debug/explore`) are synchronous and belong in
`openapi.yaml` alongside the control plane (they are request/response, not streaming); only the live
event stream is AsyncAPI.

### 5.5 CLI / runtime surface

The server is a Deno program (D7) with a small CLI surface:

| Invocation                                                                   | Effect                                                          |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `deno run --allow-net=<db,provider> --allow-read=<hookdir,config> server.ts` | Start the server (default; does NOT migrate)                    |
| `… server.ts --migrate-on-startup`                                           | Run pending migrations under an advisory lock, then start (D12) |
| `… server.ts migrate`                                                        | Run pending migrations and exit (the standalone command)        |
| `… server.ts migrate:status`                                                 | Print applied/pending migrations from the service's own ledger  |

Permission flags are scoped to the minimum the service needs (DB host, provider host, the hook
directory, config). This bounds the client-authored assembler hook by bounding the process (see D7
caveat).

---

## 6. Workflow walk-throughs

### 6.1 One-shot send (the primary path)

```
App: client.send({ scope: ["user_42","client_88","patient_3","2026-W26"], conversationId, message: "Bella is vomiting, what should I check?" })
  → POST /conversations/:id/messages
    → ConversationAgent.send()
       1. store.appendMessages(convId, [userMsg])
          → emit request.received
       2. assembler hook({ scope, conversationId, message, store: readOnly })  // loaded drop-in or default (D11)
          → reads extra-context at the patient-level scope (e.g. last SOAP note) via store.getExtraContext (D14)
          → pulls conversation history; composes segments
          → normalizes upper segments (sorted keys, no timestamps)
          → returns segments tagged static/semi-static/volatile
          → emit context.assembled
       3. cache.prepare(assembled)              // passthrough: flat array, prefixTokens = 0
          → emit cache.prepared
       4. proxy.complete({ prepared, model }, ctx)
          → emit llm.request
          → calls Anthropic/OpenAI
          → emit llm.response (usage incl. cachedTokens)
          → records.write(CallRecord)            // the eval envelope
       5. store.appendMessages(convId, [assistantMsg])
    ← AgentResponse { reply, conversationId, traceId, usage }
Meanwhile: Observation UI subscribed to /debug/stream sees all five events live.
```

### 6.2 Previewing prospective context (no LLM)

```
UI: previewContext(["user_42","client_88","patient_3","2026-W26"])
  → POST /debug/preview
    → invoke loaded assembler hook (SAME hook as live path), no proxy step
    ← AssembledContext { segments, totalTokens }
UI renders segments + flags whether the patient segment is byte-stable for caching.
```

This is how the team decides, before turning on prefix caching, whether the prospective prefix is
actually stable.

### 6.3 Post-hoc inspection for evals

```
UI: explore(["user_42","client_88","patient_3"])   // scope prefix
  → GET /debug/explore
    ← { conversations[], records[] (usage, cacheHitRate, latency) }
UI: pick a traceId → GET /debug/context/:traceId
    ← exact AssembledContext that was sent
→ compare reply quality vs. context across many calls → tune assembler & cache strategy
```

### 6.4 Attaching domain data with the extra-context store (D14)

```
Out of band (control plane), when a vet finalizes a SOAP note:
  App: client.setExtraContext(["user_42","client_88","patient_3"], { lastSoapNote: "S: ..." })
    → PUT /extra-context?scope=user_42%2Fclient_88%2Fpatient_3
    → ExtraContextStore.setExtraContext(scope, value)   // stored as jsonb keyed by scope_key

On the NEXT send() for any conversation under that patient:
  → assembler hook calls store.getExtraContext(scope.slice(0,3))
  → adds the note as a 'semi-static' segment → lands in the cacheable prefix region
  → the model now sees the latest SOAP note without it being re-typed into the chat

To remove it:  client.clearExtraContext(["user_42","client_88","patient_3"]) → DELETE /extra-context
```

The assembler decides _which_ ancestor level to read from (exact-match), or uses
`getExtraContextChain` to inherit from every ancestor. Writes never go through the assembler — the
boundary holds.

### 6.5 One-shot transcription with media (D15, D16, D17)

```
1. Client uploads audio:  client.uploadBlob(bytes, "audio/m4a")
     → POST /blobs           → write-behind mint (D17): returns { uuid, sourceUri } immediately,
                               S3 upload runs in background; bytes also in the pending buffer.

2. Client calls the transcribe agent with an audio part + a text instruction:
     client.send({
       agent: "transcribe",
       scope: ["user_42"],
       input: [
         { kind: "audio", mime: "audio/m4a", sourceUri },
         { kind: "text",  text: "Transcribe and clean up filler words." },
       ],
     })
     → POST /agents/transcribe/messages
       → registry.get("transcribe")   // persist:false utility agent
       → persist hook no-ops (no conversation created, no messages stored)
       → assemble(): wraps the input parts; marks the audio part meta.resolve = true
       → cache.prepare(): passthrough
       → proxy.complete():
            MediaResolver.toProviderPayload() hydrates the audio part — bytes from the
            pending buffer (no wait on S3), transient base64 only if the provider needs it
            emit llm.request (media shown as metadata + a /blobs URL, never bytes)
            calls the provider's transcription-capable endpoint
            emit llm.response · records.write(CallRecord)   // ref kept, not bytes
     ← AgentResponse { reply, traceId, usage }   // NO conversationId (utility agent)

Observability is identical to a persisting agent — only message storage was skipped.
```

### 6.6 Enabling prefix caching later (the upgrade D4 anticipates)

```
1. Confirm via preview (6.2) that upper segments are byte-stable.
2. Swap CacheStrategy: passthrough → prefix (config change, no other layer touched).
3. PrefixCache.prepare() places a breakpoint after the semi-static segment (e.g. the SOAP note).
4. Watch cachedTokens climb in CallRecords; verify cache hit rate via explore.
5. If hit rate is low, inspect a traceId's actual context to find the leaked volatile token.
```

Note the storage layer never changes — the litmus test from D1 holds. Media stays cache-safe because
the message list holds only refs; bytes are hydrated at the transport boundary (D16/D17), never in
the cached prefix.

### 6.7 Upgrading to a multi-step agent (future)

```
Inside ConversationAgent.send(), wrap steps 2–4 in a loop:
  while (response has tool calls):
     execute tools → append tool results as NEW trailing messages
     re-assemble (prefix stays stable; only the volatile tail grows)
     call proxy again
No interface changes. Prefix caching benefits more as the stable prefix is reused each hop.
```

---

## 7. Cross-cutting concerns

**Trace IDs.** Generated once per `send()` in the proxy/facade, propagated through every event and
the `CallRecord`. This is the join key across live stream, stored envelope, and explorer.

**Token counting.** Needed by the assembler for budgeting and by the UI for display. Use the
provider's tokenizer where possible; persist `tokenCount` on messages when known so it need not be
recomputed.

**Streaming the LLM.** Optional at first. If/when enabled, the proxy emits `llm.chunk` events and
the UI live view renders deltas. The `complete()` interface can gain a streaming sibling later
without disturbing callers.

**Auth.** Control plane and debug plane authenticated separately (D9). Debug plane should be
disable-able and is the more sensitive of the two (it exposes full context).

**Error handling.** On failure at any stage, the proxy emits an `error` event with the `stage`, and
the `CallRecord` records the error. The facade surfaces a clean error to the caller. A failed call
still produces an envelope (valuable for debugging).

**PII / clinical data.** This is veterinary clinical data. Treat `CallRecord` contents (which
include full context) as sensitive: encrypt at rest, gate debug access, and consider retention
limits on stored envelopes. **[DEFERRED]** — confirm data-handling requirements before production.

**Determinism for caching.** Reiterated because it is the most common silent failure: any
non-determinism (timestamps, UUIDs, unsorted JSON, locale-dependent formatting) in an upper segment
destroys cross-conversation cache hits. The assembler owns normalization and must be tested for
byte-stability.

**Database migrations (D12).** The service owns its tables inside a dedicated Postgres schema (e.g.
`conversation_proxy`) so it can plug into a shared database without colliding with other tables or
migration systems. Migration state is tracked in the service's **own** migration table inside that
schema, using an established tool (node-pg-migrate or Umzug) configured with a service-specific
`migrationsTable` + `schema` — never a hand-rolled tracker. The service ships an ordered list of
migration files (`001_init.sql`, `002_call_records.sql`, …) and applies pending ones via an explicit
`migrate` command, or on startup guarded by a Postgres advisory lock to prevent races across
multiple instances. Other teams' Flyway/Prisma/raw migrations on the same database never touch this
ledger. Table naming: either schema-qualified (preferred) or prefixed (`cvp_*`) if a dedicated
schema is unavailable.

**Testing assembler hooks (D11).** Because a hook is a pure function over an injected read-only
store, ship an **assembler test kit** in the shared package: a `makeTestStore()` seed helper and a
`readOnly()` wrapper. Client teams test custom hooks in isolation — seed a store, call the hook,
assert segment sources/order/stability and byte-stable normalization — without standing up the
server.

---

## 8. Recommended build order

Each stage is independently testable and yields something runnable.

1. **Shared types package** (`@vetproxy/types`) — all interfaces from section 4:
   `ContentPart`/`AssembledPart`/`AssembledMessage`,
   `AgentManifest`/`AgentFactory`/`PersistenceHook`, `BlobStore`/`MediaResolver`, plus the assembler
   test kit (`makeTestStore`, `readOnly`). No logic. Everything imports from here.
2. **`InMemoryStore` + `ExtraContextStore`** + tests — append/retrieve, scope queries, and
   scope-keyed get/set/clear extra-context plus the opt-in ancestor chain walk (D14). No LLM.
3. **Default assembler + agent registry + loader** (D11, D15) + tests — `defaultAssembler`
   (current-turn media → bytes, history → refs); the dir-scan `loadAgents()` with **all-or-nothing
   25s boot**; assert: a valid `*.agent.ts` loads, a broken file fails boot loudly, a missing hook
   falls back to default, the built-in `default` agent exists and is overridable. Include a
   `persist:false` utility agent and a custom agent that imports its own helper.
4. **`PassthroughCache`** + tests — returns everything, `prefixTokens = 0`, no breakpoints.
5. **In-memory `BlobStore` + `MediaResolver`** (D16, D17) + tests — write-behind mint returns a ref
   synchronously; resolver hydrates `resolve:true` parts from the pending buffer; assert refs stay
   in the message list and bytes never enter `StoredMessage`/`CallRecord`.
6. **`LLMProxy`** with a **fake provider** + `NullDebugChannel` + `CallRecordStore` (in-memory) +
   tests — assert it writes a correct `CallRecord` (incl. `agent`), emits events, hydrates media via
   the resolver, and returns a response. No network.
7. **`PersistedConversationAgent`** facade + tests — inject fakes + the registry; assert one path
   serves both a persisting agent (turns stored) and a `persist:false` agent (nothing stored, no
   `conversationId`), with traceId propagation. Assert unknown agent → 404.
8. **Migration runner + `001_init` migration** (D12) — dedicated schema with its own migration
   table; `001` creates `conversations` + `messages`. Verify it coexists with an unrelated migration
   table on the same DB.
9. **REST server + OpenAPI spec** over the facade (D13) — author `openapi.yaml`; wire endpoints from
   5.1 (`/agents/:agent/messages`, `/blobs`, …) using `loadAgents()` at startup and the
   `--migrate-on-startup` flag; integration test the happy path with the fake provider. Validate
   responses against the schema in CI.
10. **`BroadcastDebugChannel` + SSE endpoint + AsyncAPI spec** (D13) + `ContextExplorer` + debug
    endpoints — author `asyncapi.yaml`; assert events stream (with `agent`), media-as-metadata +
    blob URLs, unsubscribe on disconnect; preview reuses the agent's hook.
11. **Real provider adapter** (Anthropic and/or OpenAI) behind the `LLMProxy`, incl. the
    `MediaResolver` translation to vendor media format.
12. **`PostgresStore` + S3 `BlobStore`** (Supabase + S3-compatible) implementing the same
    interfaces, plus `002_call_records` migration — swap-in test: the suite from stages 2–10 should
    pass against real backends unchanged.
13. **TypeScript SDK** (`@vetproxy/sdk`) wrapping REST + SSE, re-exporting shared types, incl.
    `uploadBlob`/`blobUrl`.
14. **Observation UI** — live stream, context inspector (media as play/download links), preview,
    storage explorer.
15. **[Later] `PrefixCache`** — only after usage data justifies it (D4); swap via config.

---

## 9. Testing strategy

**Per-layer (the point of D1):**

- _Store_ — CRUD + scope queries against in-memory and Postgres; same test suite, both backends.
- _Assembler hook_ — pure function over an injected read-only store (D11); use the test kit
  (`makeTestStore`, `readOnly`) to seed, call the hook, and assert segment ordering, stability tags,
  and **byte-identical** normalization across repeated calls for the same patient. The default
  assembler is tested the same way.
- _CacheStrategy_ — feed tagged segments; passthrough returns all with no breakpoints; prefix places
  breakpoints at the right indices.
- _Proxy_ — fake provider; assert `CallRecord` correctness, `emit` sequence, latency capture, error
  envelopes.
- _Facade_ — fakes for all; assert orchestration order and traceId propagation only (not behavior
  already covered below).

**Integration:**

- End-to-end `send()` over HTTP with a fake provider; assert response + that all five debug events
  fired in order.
- Debug stream: connect a subscriber, run a `send()`, assert the subscriber received the expected
  event sequence; disconnect and assert unsubscribe.
- Backend swap: run the full suite against Postgres to prove the storage boundary holds.

**Caching (once `PrefixCache` exists):**

- Assert byte-stability of the assembled prefix for a fixed patient across multiple conversations.
- Assert `cachedTokens` increases on the second+ call with a shared prefix (against a
  provider/sandbox that reports it).

---

## 10. Open questions / deferred decisions

| Ref | Item                                                                           | Why deferred                                      | Needs decision before            |
| --- | ------------------------------------------------------------------------------ | ------------------------------------------------- | -------------------------------- |
| Q1  | `CallRecord` storage: same Postgres (join-able) vs. separate sink (ClickHouse) | Volume unknown at start; same-DB is pragmatic now | telemetry volume grows           |
| Q2  | Data handling / retention for clinical PII in envelopes                        | Requires compliance input                         | production launch                |
| Q3  | Eval harness specifics (metrics, dataset format)                               | Depends on accumulated `CallRecord`s              | first eval cycle                 |
| Q4  | LLM streaming to the client (not just internal)                                | Not needed for one-shot v1                        | real-time UX requirement appears |
| Q5  | Multi-provider routing / fallback                                              | One provider suffices for v1                      | second provider needed           |
| Q6  | Go rewrite of the proxy hot path                                               | Only if profiling shows process/memory bound (D7) | load profile justifies it        |
| Q7  | Auth model specifics for the two planes                                        | Infra-dependent                                   | first deployment                 |

---

## Appendix A — Decision quick-reference

| ID  | Decision                                                                                                      | One-line rationale                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| D1  | Three separable layers (Store/Assembler/CacheStrategy) + Proxy                                                | Each changes for a different reason                                                                                   |
| D2  | Identity is a generic hierarchy array (string[]), leaf-last                                                   | Server stays domain-agnostic; new levels are just longer arrays; order enables prefix lookup                          |
| D3  | Assembler is a distinct role; talks to cache via stability tags                                               | Domain-aware, vendor-agnostic; opposite of cache strategy                                                             |
| D4  | Caching starts as passthrough; usage recorded anyway                                                          | Correctness first; enable caching when data justifies                                                                 |
| D5  | Single facade `ConversationAgent.send()`                                                                      | One consumption surface; layers stay independently testable                                                           |
| D6  | Dedicated long-lived service, not embedded import                                                             | Realtime debug channel needs a persistent process                                                                     |
| D7  | Deno (TypeScript), not Go (revisit on profiling)                                                              | I/O-bound; native TS, runtime import for hooks, permission flags                                                      |
| D8  | REST + SSE, not gRPC                                                                                          | Browser debug consumer; gRPC-web friction not worth it                                                                |
| D9  | Two planes (control/data + debug)                                                                             | Debug can be gated, disabled, scaled independently                                                                    |
| D10 | Proxy emits events to a `DebugChannel` interface; null by default                                             | Transport-agnostic; zero overhead in prod                                                                             |
| D11 | Agents are single-file `.agent.ts` manifests, dir-scanned at startup; all-or-nothing boot in 25s              | One file per agent scales past one agent; broken file stops the deploy, not production                                |
| D12 | Owns tables in a dedicated DB schema; tracks own migrations with a standard tool; `--migrate-on-startup` flag | Coexists on a shared DB without colliding with other migration systems                                                |
| D13 | Two specs: OpenAPI 3.1 (control) + AsyncAPI 3.0 (debug)                                                       | Sync vs. streaming need different spec languages; keeps SDK from drifting                                             |
| D14 | Scope-keyed extra-context store; client writes, assembler reads                                               | Lets derived domain data (e.g. SOAP notes) enter context without the server knowing its meaning                       |
| D15 | One unified agent model; persistence is a hook, not a mode                                                    | "One-shot" = persist:false; no mode branch, one front door, one CallRecord shape                                      |
| D16 | Normalized content parts; pristine persisted vs. enveloped assembled                                          | Media is just content; transport intent (resolve) lives on the assembled envelope, never on the persisted/cached part |
| D17 | S3-compatible blob store with write-behind mint                                                               | UUID minted synchronously, upload in background — the LLM call never waits on persistence                             |

## Appendix B — Glossary

- **Scope** — an ordered array of opaque string IDs addressing where a conversation lives in the
  hierarchy, broadest first and leaf last (e.g. `["user_42","client_88","patient_3","2026-W26"]`).
  The server attaches no meaning to any level.
- **Extra-context store** — scope-keyed JSON KV store (D14); client code writes derived domain data
  (e.g. last SOAP note), the assembler reads it into context. Distinct from the prompt cache (D4).
- **Segment** — a contiguous, single-source block of context (system / client / patient /
  conversation) carrying a stability tag.
- **Stability tag** — `static | semi-static | volatile`; the contract between assembler and cache
  strategy.
- **Prefix** — the leading, stable portion of the prompt eligible for provider prompt caching.
- **CallRecord** — the full telemetry envelope of one LLM call; the raw material for evals.
- **Trace ID** — per-`send()` identifier joining live events, stored envelope, and explorer.
- **Control/data plane** — REST endpoints for sending and querying.
- **Debug plane** — streaming events + read-only context/storage explorer.
- **Passthrough** — the default cache strategy: send everything, ignore caching.
- **Assembler hook** — a client-owned drop-in function (`AssemblerHook`) at the single path
  `./assembler/hook.ts` exporting `assemble`; dynamically loaded at startup, with a built-in default
  when absent.
- **Agent** — a single file `<name>.agent.{ts,js}` whose async-factory default export returns an
  `AgentManifest`; the filename is its identity. Discovered by dir scan at startup (D11, D15).
- **Agent manifest** — the object an agent's factory returns: optional `assemble`, `cache`, and
  `persist` hooks; missing hooks use built-in defaults.
- **Default assembler** — the zero-config hook: most recent conversation for the scope, history +
  current turn as a volatile segment, current-turn media marked for byte-hydration.
- **Persistence hook** — the manifest field that absorbs "one-shot": a function for custom
  persistence, `false` to disable (utility agent), `true`/undefined for default message storage
  (D15).
- **Content part** — a normalized, provider-agnostic unit of message content
  (`text`/`image`/`audio`/`file`); non-text parts are blob-only via `sourceUri` (D16). The persisted
  source of truth.
- **Assembled part / message** — the ephemeral, per-request envelope wrapping a pristine
  `ContentPart`/`StoredMessage` and adding a `meta` channel (e.g. `resolve`). Never persisted (D16).
- **resolve** — per-part transport intent on an assembled part: `true` hydrates to bytes for the
  provider; otherwise the part stays a ref. Must only be `true` in a volatile segment.
- **Blob store** — S3-compatible store for media; `mint` returns a UUID/ref synchronously and
  uploads in the background (write-behind), so the LLM call never waits on persistence (D17).
- **Media resolver** — provider-adapter component that turns assembled parts into the vendor
  payload, hydrating `resolve:true` parts to bytes (transient base64) or passing a URL.
- **absent→default, broken→loud** — the loader rule: a missing hook file falls back to the default
  silently; a present-but-broken file fails startup loudly.
- **Read-only store** — the narrowed store slice
  (`listConversations`/`getConversation`/`getMessages`) handed to assembler hooks so they can read
  but never write.
- **Migration ledger** — the service's own applied-migrations table, kept in a dedicated DB schema
  using a standard migration tool, isolated from other migration systems on a shared database.
- **Control plane spec** — `openapi.yaml` (OpenAPI 3.1), the synchronous REST contract.
- **Debug plane spec** — `asyncapi.yaml` (AsyncAPI 3.0), the streaming `DebugEvent` contract.
