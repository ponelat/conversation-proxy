// Public API. Import this when embedding conversation-proxy in a Node/Next.js app.
//
//   import { createServer } from "conversation-proxy";
//   const { fetch } = await createServer(loadConfig(), { agents: { vet }, scanDir: false });
//   export const POST = fetch;   // a Next.js route handler

import type { Hono } from "hono";
import type { Config } from "@/config";
import { type App, createProxy, type ProxyOptions } from "@/app";
import { buildHttpApp } from "@/server/http";

export * from "@/types/index";
export { type App, buildApp, createProxy, type ProxyOptions } from "@/app";
export { buildHttpApp } from "@/server/http";
export { type Config, loadConfig } from "@/config";
export { InMemoryStore } from "@/store/memory";
export { PostgresStore } from "@/store/postgres";
export { InMemoryCallRecordStore } from "@/telemetry/memory";
export { PostgresCallRecordStore } from "@/telemetry/postgres";
export { FakeProvider } from "@/provider/fake";
export { OpenAIProvider } from "@/provider/openai";
export { NullDebugChannel } from "@/debug/null";
export { InMemoryDebugLog } from "@/debug/memory-log";
export { PostgresDebugLog } from "@/debug/postgres";
export { PassthroughCache } from "@/cache/passthrough";
export { defaultAssembler } from "@/assembler/default";
export {
  assembledFromParts,
  assembledToText,
  messageFromParts,
  systemNote,
  toAssembledMessage,
} from "@/assembler/parts";
export { AgentDefaults, resolveAgent } from "@/agent/registry";
export { DefaultPersistence, NoopPersistence } from "@/agent/persistence";
export { type AgentInput, loadAgents } from "@/agent/loader";
export { migrationStatus, runMigrations } from "@/db/migrate";
export { ApiError, ConversationProxyClient } from "@/cli/client";

export interface Server {
  /** The Hono app — mount app.fetch wherever you need it. */
  app: Hono;
  /** A `(Request) => Response` handler, ready for a Next.js route handler. */
  fetch: (req: Request) => Response | Promise<Response>;
  /** The wired core (facade, store, registry, …). */
  proxy: App;
  /** Release backend resources (DB pools). */
  close(): Promise<void>;
}

/**
 * Wire the core + HTTP layer and return a mountable handler. Standalone callers
 * pass it to `@hono/node-server`; Next.js callers re-export `fetch` from a route.
 *
 * Note (D6): the live SSE debug plane needs a long-lived process. It works under
 * a custom Node server but not under per-request serverless invocations.
 */
export async function createServer(config: Config, opts?: ProxyOptions): Promise<Server> {
  const proxy = await createProxy(config, opts);
  const app = buildHttpApp(proxy);
  return {
    app,
    fetch: (req: Request) => app.fetch(req),
    proxy,
    close: () => proxy.close(),
  };
}
