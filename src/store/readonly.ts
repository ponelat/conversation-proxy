// Narrow a full store to the read-only slice handed to assembler hooks (D11).

import type { ConversationStore, ReadOnlyConversationStore } from "@/types/index";

export function readOnly(store: ConversationStore): ReadOnlyConversationStore {
  return {
    getConversation: (scope) => store.getConversation(scope),
    getMessages: (scope, opts) => store.getMessages(scope, opts),
  };
}
