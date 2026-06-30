import { test, assert, assertEquals, assertRejects } from "@/test-shim";
import { ObservableLLMProxy } from "./proxy";
import { FakeProvider } from "@/provider/fake";
import { InMemoryCallRecordStore } from "@/telemetry/memory";
import { assembledFromParts } from "@/assembler/parts";
import { textContent } from "@/types/index";
import type { CallContext, DebugChannel, DebugEvent, LLMRequest, Provider } from "@/types/index";

class RecordingChannel implements DebugChannel {
  events: DebugEvent[] = [];
  emit(e: DebugEvent): void {
    this.events.push(e);
  }
}

const req = (): LLMRequest => ({
  model: "test-model",
  prepared: {
    messages: [assembledFromParts("user", textContent("hi"))],
    systemPrompt: "be brief",
    breakpoints: [],
    prefixTokens: 0,
  },
});

const ctx = (): CallContext => ({
  agent: "default",
  scope: "user_1/client_1",
  traceId: "tr_test",
});

test("successful call writes a correct CallRecord and emits request→response", async () => {
  const debug = new RecordingChannel();
  const records = new InMemoryCallRecordStore();
  const proxy = new ObservableLLMProxy(new FakeProvider(), debug, records);

  const res = await proxy.complete(req(), ctx());
  assert(res.reply.includes("hi"));

  assertEquals(debug.events.map((e) => e.type), ["llm.request", "llm.response"]);

  const rec = await records.get("tr_test");
  assert(rec, "record written");
  assertEquals(rec!.agent, "default");
  assertEquals(rec!.scope, "user_1/client_1");
  assertEquals(rec!.model, "test-model");
  assertEquals(rec!.systemPrompt, "be brief");
  assertEquals(rec!.error, undefined);
  assert(rec!.usage.promptTokens > 0);
  assert(rec!.latencyMs >= 0);
});

test("failed call emits error, writes an error envelope, and rethrows", async () => {
  const failing: Provider = {
    id: "boom",
    complete() {
      return Promise.reject(new Error("provider exploded"));
    },
  };
  const debug = new RecordingChannel();
  const records = new InMemoryCallRecordStore();
  const proxy = new ObservableLLMProxy(failing, debug, records);

  await assertRejects(() => proxy.complete(req(), ctx()), Error, "provider exploded");

  assertEquals(debug.events.map((e) => e.type), ["llm.request", "error"]);

  const rec = await records.get("tr_test");
  assert(rec, "envelope written even on failure");
  assertEquals(rec!.error?.stage, "llm");
  assertEquals(rec!.error?.message, "provider exploded");
  assertEquals(rec!.response.reply, "");
});

test("query filters records by scope prefix and agent", async () => {
  const records = new InMemoryCallRecordStore();
  const proxy = new ObservableLLMProxy(new FakeProvider(), new RecordingChannel(), records);
  await proxy.complete(req(), { ...ctx(), traceId: "tr_a", scope: "user_1/client_1" });
  await proxy.complete(req(), { ...ctx(), traceId: "tr_b", scope: "user_2/client_9" });

  const underUser1 = await records.query({ scopePrefix: "user_1" });
  assertEquals(underUser1.length, 1);
  assertEquals(underUser1[0].traceId, "tr_a");

  const byAgent = await records.query({ agent: "default" });
  assertEquals(byAgent.length, 2);
});
