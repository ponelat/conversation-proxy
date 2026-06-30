// OpenAI Chat Completions adapter (the v1 real provider). Maps the prepared
// context to chat messages and reads usage incl. cached_tokens (recorded from
// day one, D4). OpenAI does automatic prefix caching, so there are no explicit
// breakpoints to send — the cache strategy stays passthrough in v1.

import type { CallContext, LLMRequest, LLMResponse, Provider } from "@/types/index";
import { assembledToText } from "@/assembler/parts";

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

interface ChatCompletionResponse {
  choices: Array<{ message?: { content?: string | null } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

export class OpenAIProvider implements Provider {
  readonly id = "openai";

  constructor(
    private apiKey: string,
    private baseUrl = "https://api.openai.com/v1",
  ) {}

  async complete(req: LLMRequest, _ctx: CallContext): Promise<LLMResponse> {
    const messages: ChatMessage[] = [];
    if (req.prepared.systemPrompt) {
      messages.push({ role: "system", content: req.prepared.systemPrompt });
    }
    for (const m of req.prepared.messages) {
      messages.push({ role: m.source.role, content: assembledToText(m) });
    }

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: req.model, messages }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI ${res.status} ${res.statusText}: ${body}`);
    }

    const data = await res.json() as ChatCompletionResponse;
    const reply = data.choices?.[0]?.message?.content ?? "";
    return {
      reply,
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        cachedTokens: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      },
      raw: data,
    };
  }
}
