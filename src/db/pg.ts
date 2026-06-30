// Shared Postgres helpers (node-postgres / pg).

import pg from "pg";

const { Pool } = pg;
export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

/** A dedicated advisory-lock key for migration serialization across instances. */
export const MIGRATION_LOCK_KEY = 4242424242;

/** Guard schema/identifier interpolation — schema comes from config, not users. */
export function assertIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`invalid SQL identifier: ${name}`);
  }
  return name;
}

export function makePool(databaseUrl: string, max = 8): Pool {
  return new Pool({ connectionString: databaseUrl, max });
}
