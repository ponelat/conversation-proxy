// Example one-shot utility agent (persist: false). No history is read and no
// messages are stored, yet it still gets full observability (a CallRecord and
// debug events) — "one-shot" is just persistence turned off (D15).

import type { AgentManifest } from "@/types/index";
import { assembledFromParts, systemNote } from "@/assembler/parts";

const INSTRUCTION = "Summarize the user's text in three concise bullet points.";

export default function (): Promise<AgentManifest> {
  return Promise.resolve({
    persist: false,
    assemble({ message }) {
      return Promise.resolve({
        segments: [
          { source: "system", stability: "static" as const, messages: [systemNote(INSTRUCTION)] },
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
