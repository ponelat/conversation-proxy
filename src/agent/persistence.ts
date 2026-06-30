// Built-in persistence hooks (D15). Persistence is a hook, not a mode.

import type {
  ConversationScope,
  ConversationStore,
  PersistenceHook,
  StoredMessage,
} from "@/types/index";

/** Default: ensure the conversation exists, then store the user + assistant turns. */
export class DefaultPersistence implements PersistenceHook {
  constructor(private store: ConversationStore) {}

  async beginTurn(scope: ConversationScope): Promise<void> {
    await this.store.getOrCreateConversation(scope);
  }

  async endTurn(
    scope: ConversationScope,
    user: StoredMessage,
    assistant: StoredMessage,
  ): Promise<void> {
    await this.store.appendMessages(scope, [user, assistant]);
  }
}

/** Utility agents (persist: false): no conversation, no stored messages. */
export class NoopPersistence implements PersistenceHook {
  beginTurn(): Promise<void> {
    return Promise.resolve();
  }
  endTurn(): Promise<void> {
    return Promise.resolve();
  }
}
