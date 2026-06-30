// A thin, typed HTTP client over the REST endpoints (debug events are polled by
// cursor, not streamed). Used by the CLI to close the loop from a terminal; also
// the seed of the deferred TypeScript SDK (same fetch logic).

import type {
  AgentInput,
  AgentResponse,
  AssembledContext,
  CallRecord,
  CallRecordFilter,
  CallRecordMeta,
  Conversation,
  ConversationMeta,
  ConversationScope,
  DebugEvent,
  DebugEventType,
  DebugPollResult,
} from "@/types/index";
import { encodeScope } from "@/server/scope";

export interface ClientOptions {
  baseUrl: string;
  apiKey?: string;
  debugToken?: string;
}

/** Thrown on a non-2xx response; carries the server's error message + traceId. */
export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly traceId?: string) {
    super(message);
    this.name = "ApiError";
  }
}

export class ConversationProxyClient {
  constructor(private opts: ClientOptions) {}

  #url(path: string, query?: Record<string, string | undefined>): string {
    const u = new URL(path, this.opts.baseUrl);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) u.searchParams.set(k, v);
    }
    return u.toString();
  }

  async #req<T>(
    path: string,
    init: RequestInit & { query?: Record<string, string | undefined>; debug?: boolean } = {},
  ): Promise<T> {
    const { query, debug, ...rest } = init;
    const token = debug ? this.opts.debugToken : this.opts.apiKey;
    const res = await fetch(this.#url(path, query), {
      ...rest,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...rest.headers,
      },
    });
    if (!res.ok) {
      const body = await res.text();
      let parsed: { error?: string; traceId?: string } | undefined;
      try {
        parsed = JSON.parse(body);
      } catch { /* non-JSON body */ }
      throw new ApiError(res.status, parsed?.error ?? body, parsed?.traceId);
    }
    return res.status === 204 ? (undefined as T) : await res.json() as T;
  }

  // --- Control plane --------------------------------------------------------

  send(input: AgentInput): Promise<AgentResponse> {
    const { agent, ...body } = input;
    return this.#req(`/agents/${encodeURIComponent(agent)}/messages`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  listAgents(): Promise<Array<{ name: string; persists: boolean }>> {
    return this.#req("/agents");
  }

  /** Fetch the conversation for a scope (the scope IS the id, D2). */
  getConversation(scope: ConversationScope): Promise<Conversation> {
    return this.#req("/conversations", { query: { scope: encodeScope(scope) } });
  }

  previewContext(
    agent: string,
    scope: ConversationScope,
  ): Promise<AssembledContext> {
    return this.#req(`/agents/${encodeURIComponent(agent)}/context`, {
      query: { scope: encodeScope(scope) },
    });
  }

  getRecord(traceId: string): Promise<CallRecord> {
    return this.#req(`/records/${encodeURIComponent(traceId)}`);
  }

  queryRecords(filter: CallRecordFilter = {}): Promise<CallRecordMeta[]> {
    return this.#req("/records", {
      query: {
        agent: filter.agent,
        scopePrefix: filter.scopePrefix ? encodeScope(filter.scopePrefix) : undefined,
        model: filter.model,
        since: filter.since,
        until: filter.until,
      },
    });
  }

  // --- Debug plane ----------------------------------------------------------

  explore(scopePrefix: ConversationScope): Promise<{
    conversations: ConversationMeta[];
    records: CallRecordMeta[];
  }> {
    return this.#req("/debug/explore", { debug: true, query: { scope: encodeScope(scopePrefix) } });
  }

  /** One poll for debug-event deltas (D10). Pass the returned cursor next time. */
  pollDebugEvents(
    opts: {
      after?: number;
      limit?: number;
      traceId?: string;
      agent?: string;
      types?: DebugEventType[];
    } = {},
  ): Promise<DebugPollResult> {
    return this.#req("/debug/events", {
      debug: true,
      query: {
        after: opts.after === undefined ? undefined : String(opts.after),
        limit: opts.limit === undefined ? undefined : String(opts.limit),
        traceId: opts.traceId,
        agent: opts.agent,
        types: opts.types?.join(","),
      },
    });
  }

  /**
   * Tail debug events by polling. Starts from the current head (only new events)
   * unless `fromStart` is set. Yields until `signal` aborts.
   */
  async *watchDebug(
    opts: {
      traceId?: string;
      agent?: string;
      types?: DebugEventType[];
      intervalMs?: number;
      fromStart?: boolean;
      signal?: AbortSignal;
    } = {},
  ): AsyncIterable<DebugEvent> {
    const { traceId, agent, types, intervalMs = 1000, fromStart, signal } = opts;
    let cursor = fromStart ? 0 : (await this.pollDebugEvents({ traceId, agent, types })).cursor;
    while (!signal?.aborted) {
      const res = await this.pollDebugEvents({ after: cursor, traceId, agent, types });
      for (const ev of res.events) yield ev;
      cursor = res.cursor;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}
