// Durable, pollable debug event log backed by Postgres (D10). Works across
// serverless/multi-instance and survives restarts. emit() is fire-and-forget so
// it never backpressures a real request; poll() reads deltas by cursor.

import type { DebugEvent, DebugEventLog, DebugPollOptions, DebugPollResult } from "@/types/index";
import { assertIdentifier, makePool, type Pool } from "@/db/pg";

export class PostgresDebugLog implements DebugEventLog {
  // Serialize inserts through a promise chain so `seq` (bigserial) is assigned in
  // emission order — without blocking the request (we never await the chain on
  // the hot path). Cross-request interleaving is fine; per-request order holds.
  #tail: Promise<unknown> = Promise.resolve();

  private constructor(private pool: Pool, private schema: string) {}

  static connect(databaseUrl: string, schema: string): Promise<PostgresDebugLog> {
    return Promise.resolve(new PostgresDebugLog(makePool(databaseUrl), assertIdentifier(schema)));
  }

  emit(event: DebugEvent): void {
    // fire-and-forget to the caller; ordered + best-effort under the hood
    this.#tail = this.#tail
      .then(() => this.#append(event))
      .catch((e) => console.error("[debug-log] insert failed:", e));
  }

  async #append(event: DebugEvent): Promise<void> {
    const t = this.schema;
    await this.pool.query(
      `insert into "${t}".debug_events (trace_id, agent, type, ts, event)
       values ($1, $2, $3, $4::timestamptz, $5::jsonb)`,
      [event.traceId, event.agent, event.type, event.ts, JSON.stringify(event)],
    );
  }

  async poll(opts: DebugPollOptions): Promise<DebugPollResult> {
    const t = this.schema;
    // head probe: no `after` → report the current cursor, no events
    if (opts.after === undefined) {
      const { rows } = await this.pool.query<{ head: number }>(
        `select coalesce(max(seq), 0)::int as head from "${t}".debug_events`,
      );
      return { events: [], cursor: rows[0].head, dropped: false };
    }

    const args: unknown[] = [opts.after];
    let where = "seq > $1";
    if (opts.traceId) {
      args.push(opts.traceId);
      where += ` and trace_id = $${args.length}`;
    }
    if (opts.agent) {
      args.push(opts.agent);
      where += ` and agent = $${args.length}`;
    }
    if (opts.types) {
      args.push(opts.types);
      where += ` and type = any($${args.length}::text[])`;
    }
    args.push(opts.limit ?? 1000);

    const { rows } = await this.pool.query<{ seq: string; event: DebugEvent }>(
      `select seq, event from "${t}".debug_events where ${where} order by seq asc limit $${args.length}`,
      args,
    );
    const cursor = rows.length ? Number(rows[rows.length - 1].seq) : opts.after;
    return { events: rows.map((r) => r.event), cursor, dropped: false };
  }

  async close(): Promise<void> {
    await this.#tail.catch(() => {}); // drain pending inserts before closing
    await this.pool.end();
  }
}
