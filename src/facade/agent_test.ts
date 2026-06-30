import { test, assert, assertEquals, assertRejects } from "@/test-shim";
import { PersistedConversationAgent } from "./agent";
import { InMemoryStore } from "@/store/memory";
import { InMemoryCallRecordStore } from "@/telemetry/memory";
import { ObservableLLMProxy } from "@/proxy/proxy";
import { FakeProvider } from "@/provider/fake";
import { AgentDefaults, resolveAgent } from "@/agent/registry";
import { textContent } from "@/types/index";
import type { AgentRegistry, DebugChannel, DebugEvent } from "@/types/index";

class RecordingChannel implements DebugChannel {
  events: DebugEvent[] = [];
  emit(e: DebugEvent): void {
    this.events.push(e);
  }
}

function wire() {
  const store = new InMemoryStore();
  const defaults = new AgentDefaults(store);
  const registry: AgentRegistry = new Map([
    ["default", resolveAgent("default", {}, defaults)],
    ["summarize", resolveAgent("summarize", { persist: false }, defaults)],
  ]);
  const debug = new RecordingChannel();
  const records = new InMemoryCallRecordStore();
  const proxy = new ObservableLLMProxy(new FakeProvider(), debug, records);
  const facade = new PersistedConversationAgent({
    registry,
    store,
    proxy,
    debug,
    defaultModel: "test-model",
  });
  return { facade, store, debug, records };
}

test("persisting agent stores both turns and emits all five events in order", async () => {
  const { facade, store, debug } = wire();
  const res = await facade.send({
    agent: "default",
    scope: ["user_1", "client_1"],
    input: textContent("Bella is vomiting"),
  });

  assert(res.conversationId, "conversationId returned for persisting agent");
  assert(res.reply.includes("Bella is vomiting"));

  const msgs = await store.getMessages(res.conversationId!);
  assertEquals(msgs.map((m) => m.role), ["user", "assistant"]);

  assertEquals(debug.events.map((e) => e.type), [
    "request.received",
    "context.assembled",
    "cache.prepared",
    "llm.request",
    "llm.response",
  ]);
  // all events share the one traceId
  assert(debug.events.every((e) => e.traceId === res.traceId));
});

test("multi-turn appends history under the same conversation", async () => {
  const { facade, store } = wire();
  const first = await facade.send({
    agent: "default",
    scope: ["u"],
    input: textContent("turn one"),
  });
  await facade.send({
    agent: "default",
    scope: ["u"],
    conversationId: first.conversationId,
    input: textContent("turn two"),
  });
  const msgs = await store.getMessages(first.conversationId!);
  assertEquals(msgs.length, 4);
});

test("persist:false utility stores nothing and returns no conversationId", async () => {
  const { facade, store, records } = wire();
  const res = await facade.send({
    agent: "summarize",
    scope: ["user_1"],
    input: textContent("summarize this"),
  });
  assertEquals(res.conversationId, undefined);
  assertEquals((await store.listConversations(["user_1"])).length, 0);
  // observability still happens: a CallRecord exists
  const rec = await records.get(res.traceId);
  assert(rec, "utility agents still produce a CallRecord");
  assertEquals(rec!.conversationId, undefined);
});

test("unknown agent throws NotFound", async () => {
  const { facade } = wire();
  await assertRejects(
    () => facade.send({ agent: "ghost", scope: ["u"], input: textContent("hi") }),
    Error,
    "unknown agent: ghost",
  );
});
