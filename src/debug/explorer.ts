// Read-only context explorer (debug plane). Reconstructs what WAS sent from a
// CallRecord, previews what WOULD be assembled (reusing the agent's hook), and
// browses storage by hierarchy prefix.

import type {
  AgentRegistry,
  AssembledContext,
  CallRecordStore,
  ContextExplorer,
  ConversationScope,
  ConversationStore,
} from "@/types/index";
import { readOnly } from "@/store/readonly";
import { assembledToText, systemNote } from "@/assembler/parts";
import { countTokensMany } from "@/util/tokens";
import { NotFound } from "@/util/errors";

export class DefaultContextExplorer implements ContextExplorer {
  constructor(
    private registry: AgentRegistry,
    private store: ConversationStore,
    private records: CallRecordStore,
  ) {}

  async getActualContext(traceId: string): Promise<AssembledContext> {
    const rec = await this.records.get(traceId);
    if (!rec) throw new NotFound(`unknown traceId: ${traceId}`);
    // The CallRecord holds the flat list that was sent (the source of truth for
    // what reached the model). We surface it as: a system segment (if any) + the
    // sent messages as one volatile segment.
    const segments: AssembledContext["segments"] = [];
    if (rec.systemPrompt) {
      segments.push({
        source: "system",
        stability: "static",
        messages: [systemNote(rec.systemPrompt)],
      });
    }
    segments.push({ source: "sent", stability: "volatile", messages: rec.requestMessages });
    const texts = segments.flatMap((s) => s.messages.map(assembledToText));
    return { segments, totalTokens: countTokensMany(texts) };
  }

  async previewContext(
    agent: string,
    scope: ConversationScope,
  ): Promise<AssembledContext> {
    const resolved = this.registry.get(agent);
    if (!resolved) throw new NotFound(`unknown agent: ${agent}`);
    // Preview the prefix the agent would build right now, with no incoming turn.
    return await resolved.assemble({
      scope,
      persisted: resolved.persists,
      message: [],
      store: readOnly(this.store),
    });
  }

  async explore(scopePrefix: ConversationScope) {
    const [conversations, records] = await Promise.all([
      this.store.listConversationsByPrefix(scopePrefix),
      this.records.query({ scopePrefix }),
    ]);
    return { conversations, records };
  }
}
