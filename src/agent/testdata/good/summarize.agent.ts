// One-shot utility agent (persist: false): no history, no stored messages.
import type { AgentManifest } from "@/types/index";
import { assembledFromParts } from "@/assembler/parts";

export default function (): Promise<AgentManifest> {
  return Promise.resolve({
    persist: false,
    assemble({ message }) {
      return Promise.resolve({
        segments: [
          {
            source: "input",
            stability: "volatile" as const,
            messages: [assembledFromParts("user", message, true)],
          },
        ],
        totalTokens: 0,
      });
    },
  });
}
