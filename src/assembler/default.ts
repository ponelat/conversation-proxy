// The default assembler (D11, D16): the conversation for the scope (the scope IS
// the id, D2), history + current turn as a single volatile segment. Used when an
// agent omits `assemble`. Utility agents (persisted=false) get no history.

import type { AssemblerHook } from "@/types/index";
import { assembledFromParts, assembledToText, toAssembledMessage } from "./parts";
import { countTokensMany } from "@/util/tokens";

export const defaultAssembler: AssemblerHook = async (
  { scope, persisted, message, store },
) => {
  const history = persisted ? await store.getMessages(scope) : [];

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
