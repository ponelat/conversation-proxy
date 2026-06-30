// Default cache strategy (D4): send everything, no breakpoints, prefixTokens = 0.
// Usage (incl. cachedTokens) is still recorded by the proxy from day one.

import type {
  AssembledContext,
  AssembledMessage,
  CacheStrategy,
  PreparedContext,
} from "@/types/index";
import { assembledToText } from "@/assembler/parts";

export class PassthroughCache implements CacheStrategy {
  prepare(ctx: AssembledContext): PreparedContext {
    const systemParts: string[] = [];
    const messages: AssembledMessage[] = [];

    for (const seg of ctx.segments) {
      for (const m of seg.messages) {
        // System-role messages are lifted into the systemPrompt field; the rest
        // flow through as the flat message list. Order is preserved.
        if (m.source.role === "system") {
          systemParts.push(assembledToText(m));
        } else {
          messages.push(m);
        }
      }
    }

    return {
      messages,
      systemPrompt: systemParts.join("\n\n"),
      breakpoints: [],
      prefixTokens: 0,
    };
  }
}
