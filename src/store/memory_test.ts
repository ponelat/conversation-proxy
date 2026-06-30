import { test, assert, assertEquals } from "@/test-shim";
import { InMemoryStore } from "./memory";
import type { StoredMessage } from "@/types/index";
import { newId, nowIso } from "@/util/ids";

function msg(role: StoredMessage["role"], text: string, createdAt?: string): StoredMessage {
  return {
    id: newId(),
    role,
    content: [{ kind: "text", text }],
    createdAt: createdAt ?? nowIso(),
  };
}

test("getOrCreateConversation + getConversation round-trips by scope", async () => {
  const store = new InMemoryStore();
  const conv = await store.getOrCreateConversation("user_1/client_1");
  assertEquals(conv.scope, "user_1/client_1");
  const got = await store.getConversation("user_1/client_1");
  assertEquals(got?.scope, "user_1/client_1");
  assertEquals(got?.messages, []);
});

test("getConversation returns null for an unknown scope", async () => {
  const store = new InMemoryStore();
  assertEquals(await store.getConversation("nope"), null);
});

test("getOrCreateConversation is idempotent and never wipes messages", async () => {
  const store = new InMemoryStore();
  await store.getOrCreateConversation("u");
  await store.appendMessages("u", [msg("user", "hi", "2026-01-01T00:00:00.000Z")]);
  // A second get-or-create (e.g. a concurrent first turn) must NOT reset history.
  const again = await store.getOrCreateConversation("u");
  assertEquals(again.messages.length, 1);
  assertEquals((await store.getMessages("u")).length, 1);
});

test("listConversationsByPrefix is boundary-aware, not a bare string prefix", async () => {
  const store = new InMemoryStore();
  await store.getOrCreateConversation("user_1"); // exact match — included
  await store.getOrCreateConversation("user_1/client_1"); // descendant
  await store.getOrCreateConversation("user_1/client_2"); // descendant
  await store.getOrCreateConversation("user_12"); // shares the string prefix — excluded
  const got = await store.listConversationsByPrefix("user_1");
  assertEquals(
    got.map((m) => m.scope).sort(),
    ["user_1", "user_1/client_1", "user_1/client_2"],
  );
});

test("appendMessages + getMessages preserve chronological order", async () => {
  const store = new InMemoryStore();
  await store.getOrCreateConversation("u");
  await store.appendMessages("u", [
    msg("user", "first", "2026-01-01T00:00:00.000Z"),
    msg("assistant", "second", "2026-01-01T00:00:01.000Z"),
  ]);
  const got = await store.getMessages("u");
  assertEquals(got.map((m) => (m.content[0].kind === "text" ? m.content[0].text : "")), [
    "first",
    "second",
  ]);
});

test("getMessages honors before + limit", async () => {
  const store = new InMemoryStore();
  await store.getOrCreateConversation("u");
  await store.appendMessages("u", [
    msg("user", "m1", "2026-01-01T00:00:00.000Z"),
    msg("assistant", "m2", "2026-01-01T00:00:01.000Z"),
    msg("user", "m3", "2026-01-01T00:00:02.000Z"),
  ]);
  const before = await store.getMessages("u", { before: "2026-01-01T00:00:02.000Z" });
  assertEquals(before.length, 2);
  const limited = await store.getMessages("u", { limit: 1 });
  assertEquals(limited.length, 1);
  assertEquals((limited[0].content[0] as { text: string }).text, "m3");
});

test("getMessages returns [] for an unknown conversation", async () => {
  const store = new InMemoryStore();
  assert((await store.getMessages("nope")).length === 0);
});
