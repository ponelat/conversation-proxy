// Custom persisting agent that imports its own helpers and a domain prompt.
import type { AgentManifest } from "@/types/index";
import { assembledFromParts, PROMPT, systemNote, toAssembledMessage } from "./helpers";

export default function (): Promise<AgentManifest> {
  return Promise.resolve({
    assemble({ conversationId, message, store }) {
      return (async () => {
        const history = conversationId ? await store.getMessages(conversationId) : [];
        return {
          segments: [
            { source: "system", stability: "static" as const, messages: [systemNote(PROMPT)] },
            {
              source: "conversation",
              stability: "volatile" as const,
              messages: [
                ...history.map(toAssembledMessage),
                assembledFromParts("user", message, true),
              ],
            },
          ],
          totalTokens: 0,
        };
      })();
    },
    // persist omitted → default message storage
  });
}
