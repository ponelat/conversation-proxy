// The observability proxy (D10): wraps a Provider, emits debug events, captures
// latency + usage, and writes the CallRecord for EVERY call — success or failure.
// It knows nothing about SSE/WebSocket; it depends only on the DebugChannel.

import type {
  CallContext,
  CallRecord,
  CallRecordStore,
  DebugChannel,
  LLMProxy,
  LLMRequest,
  LLMResponse,
  Provider,
} from "@/types/index";
import { nowIso } from "@/util/ids";

const emptyResponse = (): LLMResponse => ({
  reply: "",
  usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0 },
});

export class ObservableLLMProxy implements LLMProxy {
  constructor(
    private provider: Provider,
    private debug: DebugChannel,
    private records: CallRecordStore,
  ) {}

  async complete(req: LLMRequest, ctx: CallContext): Promise<LLMResponse> {
    const { traceId, agent } = ctx;
    this.debug.emit({
      type: "llm.request",
      traceId,
      agent,
      model: req.model,
      messages: req.prepared.messages,
      systemPrompt: req.prepared.systemPrompt,
      ts: nowIso(),
    });

    const startedAt = performance.now();
    let response: LLMResponse | undefined;
    let thrown: unknown;
    try {
      response = await this.provider.complete(req, ctx);
    } catch (e) {
      thrown = e;
    }
    const latencyMs = Math.round(performance.now() - startedAt);

    const error = thrown
      ? {
        stage: "llm" as const,
        message: thrown instanceof Error ? thrown.message : String(thrown),
      }
      : undefined;
    const finalResponse = response ?? emptyResponse();

    if (error) {
      this.debug.emit({
        type: "error",
        traceId,
        agent,
        stage: "llm",
        message: error.message,
        ts: nowIso(),
      });
    } else {
      this.debug.emit({
        type: "llm.response",
        traceId,
        agent,
        reply: finalResponse.reply,
        usage: finalResponse.usage,
        latencyMs,
        ts: nowIso(),
      });
    }

    // A failed call still produces an envelope — valuable for debugging (spec §7).
    const record: CallRecord = {
      traceId,
      agent,
      scope: ctx.scope,
      systemPrompt: req.prepared.systemPrompt,
      requestMessages: req.prepared.messages,
      breakpoints: req.prepared.breakpoints,
      model: req.model,
      response: finalResponse,
      usage: finalResponse.usage,
      latencyMs,
      timestamp: nowIso(),
      error,
    };
    await this.records.write(record);

    if (thrown) throw thrown;
    return finalResponse;
  }
}
