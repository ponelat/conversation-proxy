import { test, assert, assertEquals, assertRejects } from "@/test-shim";
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

test("createConversation + getConversation round-trips", async () => {
  const store = new InMemoryStore();
  const conv = await store.createConversation(["user_1", "client_1"], { title: "t" });
  const got = await store.getConversation(conv.id);
  assertEquals(got?.id, conv.id);
  assertEquals(got?.scope, ["user_1", "client_1"]);
  assertEquals(got?.title, "t");
  assertEquals(got?.messages, []);
});

test("getConversation returns null for unknown id", async () => {
  const store = new InMemoryStore();
  assertEquals(await store.getConversation("nope"), null);
});

test("listConversations matches exact scope only", async () => {
  const store = new InMemoryStore();
  await store.createConversation(["user_1", "client_1"]);
  await store.createConversation(["user_1", "client_2"]);
  const got = await store.listConversations(["user_1", "client_1"]);
  assertEquals(got.length, 1);
  assertEquals(got[0].scope, ["user_1", "client_1"]);
});

test("listConversations returns most-recent first", async () => {
  const store = new InMemoryStore();
  const a = await store.createConversation(["u"], { updatedAt: "2026-01-01T00:00:00.000Z" });
  const b = await store.createConversation(["u"], { updatedAt: "2026-06-01T00:00:00.000Z" });
  const got = await store.listConversations(["u"]);
  assertEquals(got.map((m) => m.id), [b.id, a.id]);
});

test("appendMessages + getMessages preserve chronological order", async () => {
  const store = new InMemoryStore();
  const conv = await store.createConversation(["u"]);
  await store.appendMessages(conv.id, [
    msg("user", "first", "2026-01-01T00:00:00.000Z"),
    msg("assistant", "second", "2026-01-01T00:00:01.000Z"),
  ]);
  const got = await store.getMessages(conv.id);
  assertEquals(got.map((m) => m.content[0]).map((c) => (c.kind === "text" ? c.text : "")), [
    "first",
    "second",
  ]);
});

test("getMessages honors before + limit", async () => {
  const store = new InMemoryStore();
  const conv = await store.createConversation(["u"]);
  await store.appendMessages(conv.id, [
    msg("user", "m1", "2026-01-01T00:00:00.000Z"),
    msg("assistant", "m2", "2026-01-01T00:00:01.000Z"),
    msg("user", "m3", "2026-01-01T00:00:02.000Z"),
  ]);
  const before = await store.getMessages(conv.id, { before: "2026-01-01T00:00:02.000Z" });
  assertEquals(before.length, 2);
  const limited = await store.getMessages(conv.id, { limit: 1 });
  assertEquals(limited.length, 1);
  assertEquals((limited[0].content[0] as { text: string }).text, "m3");
});

test("getMessages returns [] for unknown conversation", async () => {
  const store = new InMemoryStore();
  assertEquals(await store.getMessages("nope"), []);
});
