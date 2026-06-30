// The debug channel + events (D10) and the read-only context explorer.

import type { AssembledMessage, ConversationMeta, ConversationScope } from "./core";
import type { AssembledContext, CacheBreakpoint, ContextSegment } from "./agent";
import type { CallRecordMeta, Usage } from "./proxy";

export type DebugStage = "assemble" | "cache" | "llm" | "persist";

export type DebugEvent =
  | {
    type: "request.received";
    traceId: string;
    agent: string;
    scope: ConversationScope;
    ts: string;
  }
  | {
    type: "context.assembled";
    traceId: string;
    agent: string;
    segments: ContextSegment[];
    totalTokens: number;
    ts: string;
  }
  | {
    type: "cache.prepared";
    traceId: string;
    agent: string;
    breakpoints: CacheBreakpoint[];
    prefixTokens: number;
    ts: string;
  }
  | {
    type: "llm.request";
    traceId: string;
    agent: string;
    model: string;
    messages: AssembledMessage[];
    systemPrompt: string;
    ts: string;
  }
  | { type: "llm.chunk"; traceId: string; agent: string; delta: string; ts: string }
  | {
    type: "llm.response";
    traceId: string;
    agent: string;
    reply: string;
    usage: Usage;
    latencyMs: number;
    ts: string;
  }
  | {
    type: "error";
    traceId: string;
    agent: string;
    stage: DebugStage;
    message: string;
    ts: string;
  };

export type DebugEventType = DebugEvent["type"];

/** The proxy depends on THIS, not on any transport. */
export interface DebugChannel {
  emit(event: DebugEvent): void;
}

// --- Pollable event log (D10) -----------------------------------------------
// Clients poll for deltas with a monotonic cursor instead of holding an SSE
// connection — works behind load balancers and serverless instances.

export interface DebugPollOptions {
  /** Return events with seq > after. Omit (undefined) to probe the head cursor only. */
  after?: number;
  limit?: number;
  traceId?: string;
  agent?: string;
  types?: DebugEventType[];
}

export interface DebugPollResult {
  events: DebugEvent[];
  /** Pass this back as `after` on the next poll. */
  cursor: number;
  /** True when `after` predates the oldest retained event (a gap was skipped). */
  dropped: boolean;
}

/** A debug channel whose events can be polled by cursor. */
export interface DebugEventLog extends DebugChannel {
  poll(opts: DebugPollOptions): Promise<DebugPollResult>;
}

// --- Context explorer (debug plane, read-only) ------------------------------

export interface ContextExplorer {
  /** What WAS sent for a past call (from the persisted CallRecord). */
  getActualContext(traceId: string): Promise<AssembledContext>;

  /** What WOULD be assembled right now, WITHOUT calling the LLM (reuses the agent's hook). */
  previewContext(
    agent: string,
    scope: ConversationScope,
  ): Promise<AssembledContext>;

  /** Browse storage by hierarchy prefix. */
  explore(scopePrefix: ConversationScope): Promise<{
    conversations: ConversationMeta[];
    records: CallRecordMeta[];
  }>;
}
