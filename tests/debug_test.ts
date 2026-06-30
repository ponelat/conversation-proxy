// Debug plane: cursor-based polling semantics, and the plane gated off by default.

import { assert, assertEquals, test } from "@/test-shim";
import { serve } from "@hono/node-server";
import { buildApp } from "@/app";
import { buildHttpApp } from "@/server/http";
import { InMemoryDebugLog } from "@/debug/memory-log";
import type { Config } from "@/config";
import type { DebugEvent } from "@/types/index";

function ev(traceId: string, type: DebugEvent["type"] = "request.received", agent = "vet"): DebugEvent {
  return { type, traceId, agent, scope: [], ts: new Date().toISOString() } as DebugEvent;
}

function startServer(
  fetch: (req: Request) => Response | Promise<Response>,
): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = serve({ fetch, port: 0 }, (info) => {
      resolve({ port: info.port, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

test("poll returns deltas by advancing cursor", async () => {
  const log = new InMemoryDebugLog();
  assertEquals((await log.poll({})).cursor, 0); // head probe on empty

  log.emit(ev("t1"));
  log.emit(ev("t1"));
  const first = await log.poll({ after: 0 });
  assertEquals(first.events.length, 2);
  assertEquals(first.cursor, 2);

  // polling from the cursor yields nothing new
  const none = await log.poll({ after: first.cursor });
  assertEquals(none.events, []);
  assertEquals(none.cursor, 2);

  // a new event is a delta
  log.emit(ev("t1"));
  const delta = await log.poll({ after: first.cursor });
  assertEquals(delta.events.length, 1);
  assertEquals(delta.cursor, 3);
});

test("poll filters by traceId, agent and type", async () => {
  const log = new InMemoryDebugLog();
  log.emit(ev("t1", "request.received", "vet"));
  log.emit(ev("t2", "llm.response", "summarize"));
  log.emit(ev("t1", "llm.response", "vet"));

  assertEquals((await log.poll({ after: 0, traceId: "t1" })).events.length, 2);
  assertEquals((await log.poll({ after: 0, agent: "summarize" })).events.length, 1);
  assertEquals((await log.poll({ after: 0, types: ["llm.response"] })).events.length, 2);
});

test("poll reports dropped when the cursor predates the buffer", async () => {
  const log = new InMemoryDebugLog(3); // capacity 3
  for (let i = 0; i < 5; i++) log.emit(ev("t1")); // seq 1..5, buffer holds 3,4,5
  const res = await log.poll({ after: 1 });
  assert(res.dropped, "gap detected");
  assertEquals(res.events.length, 3); // seq 3,4,5
  assertEquals(res.cursor, 5);
});

test("debug plane returns 404 when disabled", async () => {
  const config: Config = {
    port: 0,
    agentsDir: "./agents",
    store: "memory",
    schema: "conversation_proxy",
    migrateMode: "command",
    provider: "fake",
    model: "m",
    apiKey: "ck",
    debugEnabled: false,
    debugToken: "dk",
    baseUrl: "",
  };
  const app = await buildApp(config);
  const { port, close } = await startServer(buildHttpApp(app).fetch);
  try {
    const r = await fetch(`http://localhost:${port}/debug/events?after=0`, {
      headers: { Authorization: "Bearer dk" },
    });
    assertEquals(r.status, 404);
    await r.body?.cancel();
  } finally {
    await close();
    await app.close();
  }
});
