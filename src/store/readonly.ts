// Narrow a full store to the read-only slice handed to assembler hooks (D11).

import type { ConversationStore, ReadOnlyConversationStore } from "@/types/index";

export function readOnly(store: ConversationStore): ReadOnlyConversationStore {
  return {
    listConversations: (scope) => store.listConversations(scope),
    getConversation: (id) => store.getConversation(id),
    getMessages: (id, opts) => store.getMessages(id, opts),
  };
}
