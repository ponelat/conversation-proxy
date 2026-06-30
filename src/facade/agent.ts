// The single front door (D5, D15). One path serves both persisting agents and
// persist:false utility agents — persistence behavior comes from the resolved
// hook, so there is no oneshot branch. The facade only orchestrates; the heavy
// logic lives in the layers below.

import type {
  AgentInput,
  AgentRegistry,
  AgentResponse,
  CallContext,
  ConversationAgent,
  ConversationStore,
  DebugChannel,
  LLMProxy,
} from "@/types/index";
import { textContent } from "@/types/index";
import { readOnly } from "@/store/readonly";
import { messageFromParts } from "@/assembler/parts";
import { newTraceId, nowIso } from "@/util/ids";
import { NotFound } from "@/util/errors";

export interface FacadeDeps {
  registry: AgentRegistry;
  store: ConversationStore;
  proxy: LLMProxy;
  debug: DebugChannel;
  defaultModel: string;
}

export class PersistedConversationAgent implements ConversationAgent {
  constructor(private deps: FacadeDeps) {}

  async send(input: AgentInput): Promise<AgentResponse> {
    const agent = this.deps.registry.get(input.agent);
    if (!agent) throw new NotFound(`unknown agent: ${input.agent}`);

    const traceId = newTraceId();
    const model = agent.model ?? this.deps.defaultModel;
    const { debug } = this.deps;

    // 1. begin the turn — the hook decides (no-op + undefined for utility agents)
    const conversationId = await agent.persist.beginTurn(input.scope, input.conversationId);

    debug.emit({
      type: "request.received",
      traceId,
      agent: input.agent,
      conversationId,
      scope: input.scope,
      ts: nowIso(),
    });

    // 2. assemble context via the agent's hook (history may be [] for utility agents)
    const assembled = await agent.assemble({
      scope: input.scope,
      conversationId,
      message: input.input,
      store: readOnly(this.deps.store),
    });
    debug.emit({
      type: "context.assembled",
      traceId,
      agent: input.agent,
      segments: assembled.segments,
      totalTokens: assembled.totalTokens,
      ts: nowIso(),
    });

    // 3. apply the agent's cache strategy (passthrough by default)
    const prepared = agent.cache.prepare(assembled);
    debug.emit({
      type: "cache.prepared",
      traceId,
      agent: input.agent,
      breakpoints: prepared.breakpoints,
      prefixTokens: prepared.prefixTokens,
      ts: nowIso(),
    });

    // 4. call the LLM through the observability proxy (emits llm.* + writes CallRecord)
    const ctx: CallContext = { agent: input.agent, conversationId, scope: input.scope, traceId };
    let res;
    try {
      res = await this.deps.proxy.complete({ prepared, model }, ctx);
    } catch (e) {
      // The proxy already wrote an error CallRecord under this traceId; attach it
      // so the caller can inspect the envelope (`record <traceId>`).
      if (e && typeof e === "object") (e as { traceId?: string }).traceId = traceId;
      throw e;
    }

    // 5. persist the turn — again, the hook decides (no-op for utility agents)
    const userMsg = messageFromParts("user", input.input);
    const assistantMsg = messageFromParts("assistant", textContent(res.reply));
    await agent.persist.endTurn(input.scope, conversationId, userMsg, assistantMsg);

    return { reply: res.reply, conversationId, traceId, usage: res.usage };
  }
}
