// PostgresCallRecordStore — durable telemetry envelopes (spec Q1). Same interface
// as the in-memory store; the full CallRecord is stored as jsonb with a few
// projected columns for filtering.

import type {
  CallRecord,
  CallRecordFilter,
  CallRecordMeta,
  CallRecordStore,
} from "@/types/index";
import { assertIdentifier, makePool, type Pool } from "@/db/pg";
import { toMeta } from "./meta";

export class PostgresCallRecordStore implements CallRecordStore {
  private constructor(private pool: Pool, private schema: string) {}

  static connect(databaseUrl: string, schema: string): Promise<PostgresCallRecordStore> {
    return Promise.resolve(
      new PostgresCallRecordStore(makePool(databaseUrl), assertIdentifier(schema)),
    );
  }

  async write(record: CallRecord): Promise<void> {
    const t = this.schema;
    await this.pool.query(
      `insert into "${t}".call_records
         (trace_id, agent, scope, model, reply_preview, ts, envelope)
       values ($1, $2, $3, $4, $5, $6::timestamptz, $7::jsonb)
       on conflict (trace_id) do update set envelope = excluded.envelope`,
      [
        record.traceId,
        record.agent,
        record.scope,
        record.model,
        record.response.reply.slice(0, 120),
        record.timestamp,
        JSON.stringify(record),
      ],
    );
  }

  async get(traceId: string): Promise<CallRecord | null> {
    const t = this.schema;
    const { rows } = await this.pool.query<{ envelope: CallRecord }>(
      `select envelope from "${t}".call_records where trace_id = $1`,
      [traceId],
    );
    return rows.length ? rows[0].envelope : null;
  }

  async query(filter: CallRecordFilter): Promise<CallRecordMeta[]> {
    const t = this.schema;
    const args: unknown[] = [];
    const clauses: string[] = [];
    const add = (sql: string, val: unknown) => {
      args.push(val);
      clauses.push(sql.replace("$?", `$${args.length}`));
    };
    if (filter.agent) add("agent = $?", filter.agent);
    if (filter.model) add("model = $?", filter.model);
    if (filter.since) add("ts >= $?::timestamptz", filter.since);
    if (filter.until) add("ts <= $?::timestamptz", filter.until);
    if (filter.scopePrefix) {
      args.push(filter.scopePrefix);
      // Boundary-aware: the exact scope or any descendant under "prefix/".
      clauses.push(`(scope = $${args.length} or starts_with(scope, $${args.length} || '/'))`);
    }
    const where = clauses.length ? `where ${clauses.join(" and ")}` : "";
    const { rows } = await this.pool.query<{ envelope: CallRecord }>(
      `select envelope from "${t}".call_records ${where} order by ts desc`,
      args,
    );
    return rows.map((r) => toMeta(r.envelope));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
