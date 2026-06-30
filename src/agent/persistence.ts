// Built-in persistence hooks (D15). Persistence is a hook, not a mode.

import type {
  ConversationId,
  ConversationScope,
  ConversationStore,
  PersistenceHook,
  StoredMessage,
} from "@/types/index";

/** Default: ensure a conversation exists, then store the user + assistant turns. */
export class DefaultPersistence implements PersistenceHook {
  constructor(private store: ConversationStore) {}

  async beginTurn(
    scope: ConversationScope,
    conversationId?: ConversationId,
  ): Promise<ConversationId | undefined> {
    if (conversationId) {
      const existing = await this.store.getConversation(conversationId);
      if (existing) return conversationId;
      const created = await this.store.createConversation(scope, { id: conversationId });
      return created.id;
    }
    const created = await this.store.createConversation(scope);
    return created.id;
  }

  async endTurn(
    _scope: ConversationScope,
    conversationId: ConversationId | undefined,
    user: StoredMessage,
    assistant: StoredMessage,
  ): Promise<void> {
    if (!conversationId) return;
    await this.store.appendMessages(conversationId, [user, assistant]);
  }
}

/** Utility agents (persist: false): no conversation, no stored messages. */
export class NoopPersistence implements PersistenceHook {
  beginTurn(): Promise<ConversationId | undefined> {
    return Promise.resolve(undefined);
  }
  endTurn(): Promise<void> {
    return Promise.resolve();
  }
}
