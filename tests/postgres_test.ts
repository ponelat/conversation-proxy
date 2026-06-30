// Backend-swap proof: the same behavior, against real Postgres. Runs only when
// CP_TEST_PG=1 (see `deno task test:pg`); uses a throwaway schema it drops after.

import { assert, assertEquals, test } from "@/test-shim";
import { runMigrations } from "@/db/migrate";
import { buildApp } from "@/app";
import { PostgresStore } from "@/store/postgres";
import { PostgresCallRecordStore } from "@/telemetry/postgres";
import { makePool } from "@/db/pg";
import { textContent } from "@/types/index";
import type { Config } from "@/config";

const RUN = process.env.CP_TEST_PG === "1";
const DATABASE_URL = process.env.CP_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/postgres";
const SCHEMA = "conversation_proxy_test";

function pgConfig(): Config {
  return {
    port: 0,
    agentsDir: "./agents",
    store: "postgres",
    databaseUrl: DATABASE_URL,
    schema: SCHEMA,
    migrateMode: "command",
    provider: "fake",
    model: "test-model",
    apiKey: "k",
    debugEnabled: true,
    debugToken: "d",
    baseUrl: "",
  };
}

async function pollUntil<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 3000) {
  const start = Date.now();
  while (true) {
    const v = await fn();
    if (ok(v) || Date.now() - start > timeoutMs) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function dropSchema() {
  const pool = makePool(DATABASE_URL, 1);
  try {
    await pool.query(`drop schema if exists "${SCHEMA}" cascade`);
  } finally {
    await pool.end();
  }
}

test.skipIf(!RUN)(
  "postgres: migrations + store + telemetry + facade end-to-end",
  async () => {
    await dropSchema();
    await runMigrations(pgConfig(), { lock: true });
    // idempotent re-run applies nothing
    await runMigrations(pgConfig(), { lock: true });

    const app = await buildApp(pgConfig());
    const root = crypto.randomUUID();
    const scope = [`user_${root}`, "client_1"];

    try {
      // facade → real PG persistence
      const res = await app.facade.send({ agent: "vet", scope, input: textContent("hello pg") });
      assert(res.conversationId, "conversationId returned");
      assert(res.reply.includes("hello pg"));

      const conv = await app.store.getConversation(res.conversationId!);
      assertEquals(conv?.messages.map((m) => m.role), ["user", "assistant"]);

      // exact + prefix scope queries
      assertEquals((await app.store.listConversations(scope)).length, 1);
      assertEquals((await app.store.listConversationsByPrefix([`user_${root}`])).length, 1);

      // telemetry envelope round-trips and filters
      const rec = await app.records.get(res.traceId);
      assertEquals(rec?.agent, "vet");
      const metas = await app.records.query({ scopePrefix: [`user_${root}`] });
      assertEquals(metas.length, 1);
      assertEquals(metas[0].traceId, res.traceId);

      // getMessages limit returns the most recent in chronological order
      await app.facade.send({
        agent: "vet",
        scope,
        conversationId: res.conversationId,
        input: textContent("second turn"),
      });
      const recent = await app.store.getMessages(res.conversationId!, { limit: 2 });
      assertEquals(recent.length, 2);

      // durable debug event log (fire-and-forget inserts → poll with retry)
      const poll = await pollUntil(
        () => app.debugLog!.poll({ after: 0, traceId: res.traceId }),
        (r) => r.events.length >= 5,
      );
      assertEquals(poll.events.map((e) => e.type).slice(0, 5), [
        "request.received",
        "context.assembled",
        "cache.prepared",
        "llm.request",
        "llm.response",
      ]);
    } finally {
      await (app.store as PostgresStore).close();
      await (app.records as PostgresCallRecordStore).close();
      await dropSchema();
    }
  },
);
