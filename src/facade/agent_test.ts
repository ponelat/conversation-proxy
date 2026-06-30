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
    scope: "user_1/client_1",
    input: textContent("Bella is vomiting"),
  });

  assert(res.reply.includes("Bella is vomiting"));

  // The scope IS the conversation id — history is addressable by scope directly.
  const msgs = await store.getMessages("user_1/client_1");
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

test("multi-turn accrues history under the same scope automatically", async () => {
  const { facade, store } = wire();
  // No conversationId threading: re-using the scope continues the conversation.
  await facade.send({ agent: "default", scope: "u", input: textContent("turn one") });
  await facade.send({ agent: "default", scope: "u", input: textContent("turn two") });
  const msgs = await store.getMessages("u");
  assertEquals(msgs.length, 4);
});

test("persist:false utility stores nothing", async () => {
  const { facade, store, records } = wire();
  const res = await facade.send({
    agent: "summarize",
    scope: "user_1",
    input: textContent("summarize this"),
  });
  assertEquals(await store.getConversation("user_1"), null);
  // observability still happens: a CallRecord exists
  const rec = await records.get(res.traceId);
  assert(rec, "utility agents still produce a CallRecord");
});

test("malformed scope with an empty segment is rejected", async () => {
  const { facade } = wire();
  // A missing id between separators ("a//c") is a client bug — surface it, not store it.
  await assertRejects(
    () => facade.send({ agent: "default", scope: "a//c", input: textContent("hi") }),
    Error,
    "empty segment",
  );
});

test("unknown agent throws NotFound", async () => {
  const { facade } = wire();
  await assertRejects(
    () => facade.send({ agent: "ghost", scope: "u", input: textContent("hi") }),
    Error,
    "unknown agent: ghost",
  );
});
