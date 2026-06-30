// The LLM proxy, provider boundary, and telemetry envelope (CallRecord).

import type { AssembledMessage, ConversationId, ConversationScope } from "./core";
import type { CacheBreakpoint, PreparedContext } from "./agent";
import type { DebugStage } from "./debug";

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number; // recorded from day one (D4), even under passthrough
}

export interface LLMRequest {
  prepared: PreparedContext;
  model: string;
  // sampling params, tools, etc. (extensible)
}

export interface LLMResponse {
  reply: string;
  usage: Usage;
  raw?: unknown; // provider raw response, for debugging
}

export interface CallContext {
  agent: string; // which agent served this call (D15)
  conversationId?: ConversationId; // absent for non-persisting agents
  scope: ConversationScope;
  traceId: string;
}

/**
 * The vendor boundary. The proxy wraps a Provider with observability + telemetry;
 * the provider knows only how to turn a prepared request into a response.
 */
export interface Provider {
  readonly id: string; // e.g. "openai" | "fake"
  complete(req: LLMRequest, ctx: CallContext): Promise<LLMResponse>;
}

export interface LLMProxy {
  complete(req: LLMRequest, ctx: CallContext): Promise<LLMResponse>;
}

/** The full envelope recorded for EVERY call. This IS the eval dataset later. */
export interface CallRecord {
  traceId: string;
  agent: string;
  conversationId?: ConversationId;
  scope: ConversationScope;
  systemPrompt: string;
  requestMessages: AssembledMessage[]; // exact context sent (enveloped, D16)
  breakpoints: CacheBreakpoint[];
  model: string;
  response: LLMResponse;
  usage: Usage; // cache hit rate is derived from here
  latencyMs: number;
  timestamp: string; // ISO 8601
  error?: { stage: DebugStage; message: string };
}

export interface CallRecordFilter {
  agent?: string;
  scopePrefix?: ConversationScope; // match records whose scope starts with this prefix
  conversationId?: ConversationId;
  model?: string;
  since?: string;
  until?: string;
}

export type CallRecordMeta =
  & Omit<CallRecord, "requestMessages" | "response">
  & { replyPreview?: string };

export interface CallRecordStore {
  write(record: CallRecord): Promise<void>;
  get(traceId: string): Promise<CallRecord | null>;
  query(filter: CallRecordFilter): Promise<CallRecordMeta[]>;
}
