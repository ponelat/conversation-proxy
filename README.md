# conversation-proxy

A small, observable proxy that sits between your application and an LLM provider.
It owns conversation persistence, composes context intentionally from a generic
identity hierarchy, and emits rich observability so the **exact** context sent to
the model can be watched live, replayed, and evaluated later.

It is deliberately simple: a handful of swappable interfaces (store, assembler,
cache strategy, provider) and a debug plane you can tap from your terminal. It
**runs standalone** or **embeds in a Node/Next.js server** — same Hono app
either way.

> Status: **v1 — lean text-only core** on Node.js (TypeScript). Multimodal/blobs,
> an extra-context store, an SDK, and a web UI are designed but deferred. See
> [`spec-files/`](./spec-files) for the full design, [`docs/DECISIONS.md`](./docs/DECISIONS.md)
> for what's in v1 and why, and [`docs/NOT_DONE.md`](./docs/NOT_DONE.md) for what isn't.

## What it does

```
your app ──HTTP / app.fetch──► conversation-proxy ──► OpenAI
                                  │  persist turn
                                  │  assemble context  (domain-aware, vendor-agnostic)
                                  │  cache strategy     (passthrough in v1)
                                  │  call the model
                                  │  record envelope    (the future eval dataset)
                                  └─ emit debug events ─► you, watching live
```

- **One front door.** `POST /agents/:agent/messages` → one reply. One-shot now,
  multi-step later, with no interface change.
- **Generic hierarchy.** A conversation is addressed by a `scope` — a `/`-separated
  path of opaque IDs (e.g. `"user_42/client_88/patient_3/2026-W26"`). The scope
  **is** the conversation id: same scope → same thread, history accrues
  automatically. The server attaches no meaning to any segment — the vet domain is
  just one example. To branch a fresh thread under one identity, append a
  `/<uuid>` segment (a pure client convention). `/` is reserved; segment values
  may not contain it or be empty.
- **Agents are plain objects or single files.** Register them programmatically
  (`{ vet, summarize }`) or drop a `<name>.agent.ts` into `agents/`. Each declares
  how to assemble context, cache, and persist; missing hooks fall back to defaults.
- **Observable by construction.** Every call produces a `CallRecord` and a stream
  of lifecycle events (`request.received → context.assembled → cache.prepared →
  llm.request → llm.response`).

## Quickstart — standalone (closing the loop from your terminal)

No database or API key needed — the defaults use an in-memory store and a
deterministic fake provider.

```sh
npm install
cp .env.example .env          # defaults: in-memory store, fake provider

# Terminal 1 — run the service (tsx; hot-reloads)
npm run dev

# Terminal 2 — watch requests flow through the model, live (needs CP_DEBUG_ENABLED=true)
npm run cli -- stream

# Terminal 3 — send a message
npm run cli -- send --agent default --scope user_42/client_88 --input "Hello"
```

The `send` returns a `traceId` you can inspect:

```sh
npm run cli -- record <traceId>     # the full envelope sent to the model
npm run cli -- preview --agent default --scope user_42/client_88   # no LLM call
```

Switch to OpenAI by setting `CP_PROVIDER=openai` and `CP_OPENAI_API_KEY` in `.env`.

## Embedding in a Node / Next.js server

The whole service is one Hono app, so `app.fetch` is exactly what a Next.js Route
Handler wants. Register agents programmatically and skip the filesystem scan
(`scanDir: false`) so it's bundler-safe.

```ts
// app/api/proxy/[...path]/route.ts
import { createServer, loadConfig } from "conversation-proxy";
import { vet } from "@/agents/vet";

const ready = createServer(loadConfig(), { agents: { vet }, scanDir: false });

export async function POST(req: Request) {
  const { fetch } = await ready;   // cache this across invocations in a real app
  return fetch(req);
}
export const GET = POST;
```

> **Debug plane is poll-based** (`GET /debug/events?after=<cursor>`), not SSE — no
> long-lived connection, so it works behind load balancers and serverless. Set
> `CP_STORE=postgres` for the durable event log that's shared across instances
> (the in-memory log only sees one process). This sidesteps the old D6/D9 SSE
> caveat.

For a standalone Node process, `npm run serve` (or `node dist/main.js serve`
after `npm run build`) uses `@hono/node-server` under the hood.

## Verification surface

Every layer is exercisable from one command:

| Command            | What it proves                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| `npm test`         | All unit + integration + e2e tests (in-memory, fake provider)                                     |
| `npm run test:pg`  | The full suite against real Postgres (`docker compose up -d` first)                               |
| `npm run smoke`    | A **live** server driven through the CLI subcommands (HTTP path)                                  |
| `npm run typecheck`| `tsc --noEmit`                                                                                    |
| `npm run build`    | tsup → ESM + CJS + `.d.ts` for the library and the CLI bin                                        |

## Configuration

All settings are environment variables prefixed `CP_`. See [`.env.example`](./.env.example).
Backends swap by config alone: `CP_STORE` (`memory`|`postgres`), `CP_PROVIDER`
(`fake`|`openai`). When embedding, build the `Config` however you like and pass it
to `createServer`.

## Agent skill (for AI coding agents)

This package bundles a CLI runbook for AI agents (e.g. Claude Code) at
[`skills/conversation-proxy/SKILL.md`](./skills/conversation-proxy/SKILL.md) — how
to start a server, send/append turns, inspect the exact context, and poll debug
events, including the common gotchas.

- **In this repo** it's already linked into `.claude/skills/` (a relative symlink),
  so Claude Code discovers it automatically.
- **As a dependency**, it ships with `npm install`. A post-install note prints its
  path; link it into your project so your agent can find it:

  ```sh
  mkdir -p .claude/skills
  ln -s node_modules/conversation-proxy/skills/conversation-proxy .claude/skills/conversation-proxy
  ```

## Design

The architecture and the rationale behind every firm decision (D1–D17) live in
[`spec-files/CONVERSATION_PROXY_HANDOFF.md`](./spec-files/CONVERSATION_PROXY_HANDOFF.md).
[`docs/DECISIONS.md`](./docs/DECISIONS.md) records what made it into v1 (including
the Node runtime and the embed model); [`docs/NOT_DONE.md`](./docs/NOT_DONE.md) is
the honest inventory of what was left out and the caveats on what shipped.
For a visual overview, open [`docs/architecture.html`](./docs/architecture.html)
in a browser — a self-contained page with the pipeline, layers, and API.

## License

[Apache-2.0](./LICENSE).
