// The default assembler (D11, D16): most recent conversation for the scope,
// history + current turn as a single volatile segment. Used when an agent
// omits `assemble`.

import type { AssemblerHook } from "@/types/index";
import { assembledFromParts, assembledToText, toAssembledMessage } from "./parts";
import { countTokensMany } from "@/util/tokens";

export const defaultAssembler: AssemblerHook = async (
  { scope, conversationId, message, store },
) => {
  const id = conversationId ?? (await store.listConversations(scope))[0]?.id;
  const history = id ? await store.getMessages(id) : [];

  const historyMsgs = history.map(toAssembledMessage);
  // current turn → media (when present) marked for byte-hydration (no-op for text)
  const currentMsg = assembledFromParts("user", message, true);
  const messages = [...historyMsgs, currentMsg];

  return {
    segments: [
      { source: "conversation", stability: "volatile", messages },
    ],
    totalTokens: countTokensMany(messages.map(assembledToText)),
  };
};
