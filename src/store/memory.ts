// In-memory ConversationStore — dev / tests / demo (D1, D2).
// Non-durable; the PostgresStore implements the same interface for prod.

import type {
  Conversation,
  ConversationId,
  ConversationMeta,
  ConversationScope,
  ConversationStore,
  StoredMessage,
} from "@/types/index";
import { scopeKey } from "@/types/index";
import { newId, nowIso } from "@/util/ids";

interface Stored {
  meta: ConversationMeta;
  messages: StoredMessage[];
}

export class InMemoryStore implements ConversationStore {
  #byId = new Map<ConversationId, Stored>();

  listConversations(scope: ConversationScope): Promise<ConversationMeta[]> {
    const key = scopeKey(scope);
    const metas = [...this.#byId.values()]
      .filter((s) => scopeKey(s.meta.scope) === key)
      .map((s) => s.meta)
      // most-recent first: the default assembler picks [0] (spec §4.3)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return Promise.resolve(metas);
  }

  listConversationsByPrefix(prefix: ConversationScope): Promise<ConversationMeta[]> {
    const pkey = scopeKey(prefix);
    const metas = [...this.#byId.values()]
      .filter((s) => scopeKey(s.meta.scope.slice(0, prefix.length)) === pkey)
      .map((s) => s.meta)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return Promise.resolve(metas);
  }

  getConversation(id: ConversationId): Promise<Conversation | null> {
    const s = this.#byId.get(id);
    if (!s) return Promise.resolve(null);
    return Promise.resolve({ ...s.meta, messages: [...s.messages] });
  }

  createConversation(
    scope: ConversationScope,
    meta?: Partial<ConversationMeta>,
  ): Promise<Conversation> {
    const ts = nowIso();
    const full: ConversationMeta = {
      id: meta?.id ?? newId(),
      scope,
      title: meta?.title,
      createdAt: meta?.createdAt ?? ts,
      updatedAt: meta?.updatedAt ?? ts,
      metadata: meta?.metadata,
    };
    this.#byId.set(full.id, { meta: full, messages: [] });
    return Promise.resolve({ ...full, messages: [] });
  }

  appendMessages(id: ConversationId, msgs: StoredMessage[]): Promise<void> {
    const s = this.#byId.get(id);
    if (!s) throw new Error(`unknown conversation: ${id}`);
    s.messages.push(...msgs);
    s.meta = { ...s.meta, updatedAt: nowIso() };
    return Promise.resolve();
  }

  getMessages(
    id: ConversationId,
    opts?: { limit?: number; before?: string },
  ): Promise<StoredMessage[]> {
    const s = this.#byId.get(id);
    if (!s) return Promise.resolve([]);
    let msgs = [...s.messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (opts?.before) msgs = msgs.filter((m) => m.createdAt < opts.before!);
    if (opts?.limit !== undefined) msgs = msgs.slice(-opts.limit);
    return Promise.resolve(msgs);
  }
}
