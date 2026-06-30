// Minimal migration runner (D12): ordered migrations applied once each, tracked
// in a ledger table inside the service's dedicated schema, serialized across
// instances with a Postgres advisory lock. No external migration tool.

import type { Config } from "@/config";
import { assertIdentifier, makePool, MIGRATION_LOCK_KEY, type PoolClient } from "./pg";
import { MIGRATIONS } from "./migrations";

async function withClient<T>(
  config: Config,
  fn: (client: PoolClient, schema: string) => Promise<T>,
): Promise<T> {
  const schema = assertIdentifier(config.schema);
  if (!config.databaseUrl) throw new Error("CP_DATABASE_URL is required for migrations");
  const pool = makePool(config.databaseUrl, 1);
  const client = await pool.connect();
  try {
    await client.query(`create schema if not exists "${schema}"`);
    await client.query(`set search_path to "${schema}"`);
    await client.query(
      `create table if not exists "${schema}".cp_migrations (` +
        `id text primary key, applied_at timestamptz not null default now())`,
    );
    return await fn(client, schema);
  } finally {
    client.release();
    await pool.end();
  }
}

export async function runMigrations(config: Config, opts: { lock: boolean }): Promise<void> {
  await withClient(config, async (client, schema) => {
    if (opts.lock) await client.query(`select pg_advisory_lock($1)`, [MIGRATION_LOCK_KEY]);
    try {
      const applied = new Set(
        (await client.query<{ id: string }>(`select id from "${schema}".cp_migrations`)).rows
          .map((r) => r.id),
      );
      let count = 0;
      for (const m of MIGRATIONS) {
        if (applied.has(m.id)) continue;
        await client.query("begin");
        try {
          for (const stmt of m.statements) await client.query(stmt);
          await client.query(`insert into "${schema}".cp_migrations (id) values ($1)`, [m.id]);
          await client.query("commit");
        } catch (e) {
          await client.query("rollback");
          throw e;
        }
        console.log(`applied ${m.id}`);
        count++;
      }
      console.log(count === 0 ? "no pending migrations" : `applied ${count} migration(s)`);
    } finally {
      if (opts.lock) await client.query(`select pg_advisory_unlock($1)`, [MIGRATION_LOCK_KEY]);
    }
  });
}

export async function migrationStatus(config: Config): Promise<void> {
  await withClient(config, async (client, schema) => {
    const applied = new Set(
      (await client.query<{ id: string }>(`select id from "${schema}".cp_migrations`)).rows
        .map((r) => r.id),
    );
    for (const m of MIGRATIONS) {
      console.log(`${applied.has(m.id) ? "[applied]" : "[pending]"} ${m.id}`);
    }
  });
}
