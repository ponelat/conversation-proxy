// Example domain agent (persisting). Demonstrates a custom assembler that adds a
// stable system prompt ahead of conversation history. The vet domain is just an
// example — the server attaches no meaning to the scope hierarchy (D2).

import type { AgentManifest } from "@/types/index";
import { assembledFromParts, systemNote, toAssembledMessage } from "@/assembler/parts";

const SYSTEM_PROMPT = "You are a careful veterinary assistant. Ask clarifying questions when a " +
  "symptom is ambiguous, and never give a diagnosis you are not confident in.";

export default function (): Promise<AgentManifest> {
  return Promise.resolve({
    async assemble({ conversationId, message, store }) {
      const history = conversationId ? await store.getMessages(conversationId) : [];
      return {
        segments: [
          // most-stable first: a static system prompt shared across every turn
          { source: "system", stability: "static", messages: [systemNote(SYSTEM_PROMPT)] },
          // then the volatile conversation tail
          {
            source: "conversation",
            stability: "volatile",
            messages: [
              ...history.map(toAssembledMessage),
              assembledFromParts("user", message, true),
            ],
          },
        ],
        totalTokens: 0,
      };
    },
    // persist omitted → default message storage
  });
}
