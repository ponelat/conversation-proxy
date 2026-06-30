// Deterministic fake provider for dev / tests / e2e (no network, no API key).
// Echoes the last user turn and reports tiktoken-based usage so telemetry is
// realistic without a real model.

import type { CallContext, LLMRequest, LLMResponse, Provider } from "@/types/index";
import { assembledToText } from "@/assembler/parts";
import { countTokens } from "@/util/tokens";

export class FakeProvider implements Provider {
  readonly id = "fake";

  complete(req: LLMRequest, _ctx: CallContext): Promise<LLMResponse> {
    const msgs = req.prepared.messages;
    const lastUser = [...msgs].reverse().find((m) => m.source.role === "user");
    const lastUserText = lastUser ? assembledToText(lastUser) : "";
    const reply = `FAKE[${req.model}]: ${lastUserText}`;

    const promptText = [req.prepared.systemPrompt, ...msgs.map(assembledToText)].join("\n");
    const usage = {
      promptTokens: countTokens(promptText),
      completionTokens: countTokens(reply),
      cachedTokens: 0,
    };

    return Promise.resolve({ reply, usage, raw: { provider: "fake" } });
  }
}
