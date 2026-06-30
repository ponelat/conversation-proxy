// In-memory CallRecordStore — dev / tests. Postgres adapter implements the same
// interface; a separate analytics sink (ClickHouse) is a later swap (spec Q1).

import type {
  CallRecord,
  CallRecordFilter,
  CallRecordMeta,
  CallRecordStore,
  ConversationScope,
} from "@/types/index";
import { toMeta } from "./meta";

/** Boundary-aware: the exact scope or any descendant (never a bare string prefix). */
function underPrefix(scope: ConversationScope, prefix: ConversationScope): boolean {
  return scope === prefix || scope.startsWith(prefix + "/");
}

export class InMemoryCallRecordStore implements CallRecordStore {
  #byTrace = new Map<string, CallRecord>();

  write(record: CallRecord): Promise<void> {
    this.#byTrace.set(record.traceId, record);
    return Promise.resolve();
  }

  get(traceId: string): Promise<CallRecord | null> {
    return Promise.resolve(this.#byTrace.get(traceId) ?? null);
  }

  query(filter: CallRecordFilter): Promise<CallRecordMeta[]> {
    const out = [...this.#byTrace.values()]
      .filter((r) => (filter.agent ? r.agent === filter.agent : true))
      .filter((r) => (filter.model ? r.model === filter.model : true))
      .filter((r) => (filter.scopePrefix ? underPrefix(r.scope, filter.scopePrefix) : true))
      .filter((r) => (filter.since ? r.timestamp >= filter.since : true))
      .filter((r) => (filter.until ? r.timestamp <= filter.until : true))
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .map(toMeta);
    return Promise.resolve(out);
  }
}
