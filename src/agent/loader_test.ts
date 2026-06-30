import { assert, assertEquals, assertRejects, test } from "@/test-shim";
import { fileURLToPath } from "node:url";
import { loadAgents } from "./loader";
import { AgentDefaults } from "./registry";
import { InMemoryStore } from "@/store/memory";
import { PassthroughCache } from "@/cache/passthrough";
import { defaultAssembler } from "@/assembler/default";

const dir = (name: string) => fileURLToPath(new URL(`testdata/${name}`, import.meta.url));
const defaults = () => new AgentDefaults(new InMemoryStore());

test("loads valid agents and synthesizes the built-in default", async () => {
  const reg = await loadAgents({ dir: dir("good"), defaults: defaults() });
  assert(reg.has("vet"), "vet loaded");
  assert(reg.has("summarize"), "summarize loaded");
  assert(reg.has("default"), "built-in default present");
});

test("persist:false utility is recognized; default agent persists", async () => {
  const reg = await loadAgents({ dir: dir("good"), defaults: defaults() });
  assertEquals(reg.get("summarize")!.persists, false);
  assertEquals(reg.get("vet")!.persists, true);
  assertEquals(reg.get("default")!.persists, true);
});

test("missing hooks fall back to built-in defaults", async () => {
  const reg = await loadAgents({ dir: dir("good"), defaults: defaults() });
  // summarize omits cache → passthrough; default agent omits everything.
  assert(reg.get("summarize")!.cache instanceof PassthroughCache);
  assert(reg.get("default")!.cache instanceof PassthroughCache);
  assertEquals(reg.get("default")!.assemble, defaultAssembler);
});

test("a broken agent file fails boot loudly", async () => {
  await assertRejects(() => loadAgents({ dir: dir("broken"), defaults: defaults() }));
});

test("a non-function default export fails boot", async () => {
  await assertRejects(
    () => loadAgents({ dir: dir("notfn"), defaults: defaults() }),
    Error,
    "factory",
  );
});

test("a slow factory times out and fails boot", async () => {
  await assertRejects(
    () => loadAgents({ dir: dir("slow"), defaults: defaults(), timeoutMs: 20 }),
  );
});

test("missing agents dir yields the built-in default only", async () => {
  const reg = await loadAgents({ dir: dir("does-not-exist"), defaults: defaults() });
  assertEquals([...reg.keys()], ["default"]);
});

test("default agent is overridable by a default.agent file", async () => {
  const reg = await loadAgents({ dir: dir("override"), defaults: defaults() });
  // the override sets persist:false, proving the file replaced the built-in
  assertEquals(reg.get("default")!.persists, false);
});
