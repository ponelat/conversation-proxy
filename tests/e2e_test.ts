// Full-stack end-to-end: a real HTTP server (memory store + fake provider +
// pollable debug log), driven through the HTTP client. This is the canonical
// "is the loop closed?" check.

import { assert, assertEquals, test } from "@/test-shim";
import { serve } from "@hono/node-server";
import { buildApp } from "@/app";
import { buildHttpApp } from "@/server/http";
import { ConversationProxyClient } from "@/cli/client";
import { textContent } from "@/types/index";
import type { Config } from "@/config";

/** Start a Node HTTP server on an ephemeral port; resolve with port + closer. */
function startServer(
  fetch: (req: Request) => Response | Promise<Response>,
): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = serve({ fetch, port: 0 }, (info) => {
      resolve({
        port: info.port,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

const TEST_CONFIG: Config = {
  port: 0,
  agentsDir: "./agents",
  store: "memory",
  schema: "conversation_proxy",
  migrateMode: "command",
  provider: "fake",
  model: "test-model",
  apiKey: "test-control",
  debugEnabled: true,
  debugToken: "test-debug",
  baseUrl: "",
};

test("end-to-end: send → polled events → record → persistence", async () => {
  const app = await buildApp(TEST_CONFIG);
  const { port, close } = await startServer(buildHttpApp(app).fetch);
  const client = new ConversationProxyClient({
    baseUrl: `http://localhost:${port}`,
    apiKey: "test-control",
    debugToken: "test-debug",
  });

  try {
    // sanity: control plane
    assertEquals(
      (await client.listAgents()).map((a) => a.name).sort(),
      ["default", "summarize", "vet"],
    );

    // --- persisting agent --------------------------------------------------
    const res = await client.send({
      agent: "vet",
      scope: ["user_42", "client_88"],
      input: textContent("Bella is vomiting"),
    });
    assert(res.conversationId, "persisting agent returns a conversationId");
    assert(res.reply.includes("Bella is vomiting"));
    assert(res.usage.promptTokens > 0, "real token usage recorded");

    // the five lifecycle events are pollable, in order, filtered by traceId
    const poll = await client.pollDebugEvents({ after: 0, traceId: res.traceId });
    assertEquals(poll.events.map((e) => e.type), [
      "request.received",
      "context.assembled",
      "cache.prepared",
      "llm.request",
      "llm.response",
    ]);
    assert(poll.cursor > 0, "cursor advances");

    // a second poll from the returned cursor yields nothing new (delta semantics)
    const poll2 = await client.pollDebugEvents({ after: poll.cursor, traceId: res.traceId });
    assertEquals(poll2.events, []);
    assertEquals(poll2.cursor, poll.cursor);

    // the call envelope is fetchable by traceId
    const rec = await client.getRecord(res.traceId);
    assertEquals(rec.agent, "vet");
    assertEquals(rec.scope, ["user_42", "client_88"]);
    assert(rec.systemPrompt.includes("veterinary"));

    // both turns persisted under the conversation
    const conv = await client.getConversation(res.conversationId!);
    assertEquals(conv.messages.map((m) => m.role), ["user", "assistant"]);

    // --- utility agent (persist:false) -------------------------------------
    const util = await client.send({
      agent: "summarize",
      scope: ["user_42"],
      input: textContent("a long document"),
    });
    assertEquals(util.conversationId, undefined);
    assertEquals((await client.listConversations(["user_42"])).length, 0);
    const utilRec = await client.getRecord(util.traceId);
    assertEquals(utilRec.agent, "summarize");

    // --- debug explorer ----------------------------------------------------
    const explored = await client.explore(["user_42"]);
    assert(explored.records.length >= 2, "records visible under the user prefix");
  } finally {
    await close();
    await app.close();
  }
});
