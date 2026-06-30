---
name: conversation-proxy
description: >
  Drive the conversation-proxy service from its CLI — send turns to LLM agents,
  continue conversations, preview/inspect the exact context sent to the model,
  query call records, and poll debug events. Use when working in the
  conversation-proxy repo or whenever asked to exercise, test, or demo the proxy
  through its command line.
---

# Using the conversation-proxy CLI

A small observable proxy between an app and an LLM. The CLI is a thin HTTP client
over a running server, so **most commands need a server up first**. Everything is
configured by `CP_*` environment variables (see `.env` / `.env.example`).

## 0. The one gotcha: `npm run cli` needs `--`

When invoking via npm, put `--` before the flags or npm swallows them:

```sh
npm run cli -- send --agent vet --scope u/c --input "hi"   # ✅
npm run cli send --agent vet ...                            # ❌ "requires --agent, --scope"
```

To avoid `--` entirely, call the entry directly (preferred for scripting):

```sh
npx tsx src/main.ts send --agent vet --scope u/c --input "hi"   # from repo root
node dist/main.js send ...                                       # after `npm run build`
conversation-proxy send ...                                      # if installed/linked
```

This skill uses the `npx tsx src/main.ts <cmd>` form. Run from the repo root.

## 1. Start a server (most commands need it)

```sh
npm install                       # once
cp .env.example .env              # defaults: in-memory store + fake provider
npm run serve                     # http://localhost:8787  (or: npx tsx src/main.ts serve)
```

- Fake provider (default) gives deterministic replies — no API key, no cost. Use
  it for testing. For real model calls set `CP_PROVIDER=openai` and `CP_OPENAI_API_KEY`.
- `migrate` / `migrate:status` are the only commands that don't need a running
  server (and they only do anything when `CP_STORE=postgres`).

## 2. Commands

| Command | Needs server | Output |
|---|---|---|
| `agents` | yes | JSON: `[{name, persists}]` |
| `send --agent <a> --scope a/b/c --input "..."` | yes | reply on **stdout**; `traceId`/usage on **stderr** |
| `preview --agent <a> --scope a/b/c` | yes | JSON `AssembledContext` (no LLM call) |
| `record <traceId>` | yes | JSON `CallRecord` (the full envelope sent) |
| `explore --scope a/b/c` | yes (debug enabled) | JSON `{conversations, records}` |
| `stream [--trace <id>] [--agent <a>] [--types a,b]` | yes (debug enabled) | tails debug events (polls; Ctrl-C to stop) |
| `serve [--migrate-on-startup]` | — | starts the service |
| `migrate` / `migrate:status` | — (Postgres only) | applies/lists migrations |

### Send a turn

```sh
npx tsx src/main.ts send --agent vet --scope user_42/client_88 --input "Bella is vomiting"
```

- **`--scope`** is the conversation identity: a `/`-joined hierarchy
  (`user_42/client_88/...`). The scope **is** the conversation id — segments are
  opaque, but `/` is reserved (no empty segments; `a//c` is a 400).
- **`--agent`** is the agent name. `default` always exists; `vet` (persisting) and
  `summarize` (`persist:false` utility) ship as examples. List them with `agents`.
- The reply prints to **stdout**. The `traceId` and usage print to **stderr** as:
  `traceId=tr_... tokens(prompt/completion/cached)=…`.

### Continue a conversation (append)

There is no conversation handle to thread — **reuse the same scope** and history
accrues automatically:

```sh
# turn 1
npx tsx src/main.ts send --agent vet --scope u/c --input "first"
# turn 2 — same scope continues the same thread
npx tsx src/main.ts send --agent vet --scope u/c --input "follow-up"
```

To start a **fresh** thread under the same identity, append a unique segment
(e.g. a UUID): `--scope u/c/$(uuidgen)`.

> **Note:** `persist:false` agents (e.g. `summarize`) store nothing — each call is
> independent regardless of scope.

### Inspect what was / would be sent

```sh
npx tsx src/main.ts record <traceId>                       # exact context + usage + latency for a past call
npx tsx src/main.ts preview --agent vet --scope u/c        # what WOULD be assembled, no LLM call
```

### Watch / poll debug events

Requires `CP_DEBUG_ENABLED=true` and `CP_DEBUG_TOKEN` on the server. Polling is
cursor-based (no streaming connection):

```sh
npx tsx src/main.ts stream --agent vet     # live tail (polls /debug/events)
npx tsx src/main.ts explore --scope user_42
```

Lifecycle per call: `request.received → context.assembled → cache.prepared →
llm.request → llm.response` (or `error`).

## 3. Configuration (env vars)

| Var | Default | Notes |
|---|---|---|
| `CP_PORT` | `8787` | server port |
| `CP_BASE_URL` | `http://localhost:<port>` | where the CLI client points |
| `CP_STORE` | `memory` | `memory` \| `postgres` |
| `CP_DATABASE_URL` | — | required when `CP_STORE=postgres` |
| `CP_PROVIDER` | `fake` | `fake` \| `openai` (must be exactly `openai`) |
| `CP_OPENAI_API_KEY` | — | required when `CP_PROVIDER=openai` |
| `CP_MODEL` | `gpt-4o-mini` | model id |
| `CP_API_KEY` | `dev-control-token` | control-plane bearer token |
| `CP_DEBUG_ENABLED` | `false` | gate the debug plane |
| `CP_DEBUG_TOKEN` | `dev-debug-token` | debug-plane bearer token |

The CLI reads the same env (it loads `.env` automatically). The server and CLI
must agree on `CP_BASE_URL` and the tokens.

## 4. Quick end-to-end check (no server needed beyond what you start)

```sh
npm run smoke    # spawns a fake-provider server and drives agents/send/record/explore
npm test         # full vitest suite (in-memory)
```

## 5. Troubleshooting

- **"requires --agent, --scope"** despite passing them → you used `npm run cli`
  without `--`. Add `--`, or use `npx tsx src/main.ts`.
- **`ECONNREFUSED` / fetch failed** → no server running, or `CP_BASE_URL`/`CP_PORT`
  mismatch between the CLI and `serve`.
- **`401`** → wrong `CP_API_KEY` (control) or `CP_DEBUG_TOKEN` (debug).
- **`404` on `/debug/*` or `explore`/`stream`** → `CP_DEBUG_ENABLED` is not `true`.
- **A `send` failed but you want the envelope** → the error line still prints a
  `traceId`; `record <traceId>` returns the error envelope.
- **History not continuing across turns** → you changed the `--scope`. Same scope =
  same thread; a different scope (or a stray `/<uuid>`) is a *new* conversation.
- **`400` "scope has an empty segment"** → a `/`-joined scope with a missing piece
  (`a//c`, leading/trailing `/`) — usually an undefined id on the client side.
- **OpenAI `429 insufficient_quota`** → provider works; the OpenAI account needs billing.
