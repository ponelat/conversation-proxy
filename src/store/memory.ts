// In-memory ConversationStore — dev / tests / demo (D1, D2).
// Non-durable; the PostgresStore implements the same interface for prod.
// Keyed by scope string (the scope IS the conversation id, D2).

import type {
  Conversation,
  ConversationMeta,
  ConversationScope,
  ConversationStore,
  StoredMessage,
} from "@/types/index";
import { nowIso } from "@/util/ids";

interface Stored {
  meta: ConversationMeta;
  messages: StoredMessage[];
}

/** Boundary-aware: the exact scope or any descendant (never a bare string prefix). */
function underPrefix(scope: ConversationScope, prefix: ConversationScope): boolean {
  return scope === prefix || scope.startsWith(prefix + "/");
}

export class InMemoryStore implements ConversationStore {
  #byScope = new Map<ConversationScope, Stored>();

  listConversationsByPrefix(prefix: ConversationScope): Promise<ConversationMeta[]> {
    const metas = [...this.#byScope.values()]
      .filter((s) => underPrefix(s.meta.scope, prefix))
      .map((s) => s.meta)
      // most-recent first: matches PostgresStore ordering
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return Promise.resolve(metas);
  }

  getConversation(scope: ConversationScope): Promise<Conversation | null> {
    const s = this.#byScope.get(scope);
    if (!s) return Promise.resolve(null);
    return Promise.resolve({ ...s.meta, messages: [...s.messages] });
  }

  getOrCreateConversation(scope: ConversationScope): Promise<Conversation> {
    // check-then-set is atomic on JS's single thread (no await between).
    const existing = this.#byScope.get(scope);
    if (existing) return Promise.resolve({ ...existing.meta, messages: [...existing.messages] });
    const ts = nowIso();
    const meta: ConversationMeta = { scope, createdAt: ts, updatedAt: ts };
    this.#byScope.set(scope, { meta, messages: [] });
    return Promise.resolve({ ...meta, messages: [] });
  }

  appendMessages(scope: ConversationScope, msgs: StoredMessage[]): Promise<void> {
    const s = this.#byScope.get(scope);
    if (!s) throw new Error(`unknown conversation: ${scope}`);
    s.messages.push(...msgs);
    s.meta = { ...s.meta, updatedAt: nowIso() };
    return Promise.resolve();
  }

  getMessages(
    scope: ConversationScope,
    opts?: { limit?: number; before?: string },
  ): Promise<StoredMessage[]> {
    const s = this.#byScope.get(scope);
    if (!s) return Promise.resolve([]);
    let msgs = [...s.messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (opts?.before) msgs = msgs.filter((m) => m.createdAt < opts.before!);
    if (opts?.limit !== undefined) msgs = msgs.slice(-opts.limit);
    return Promise.resolve(msgs);
  }
}
