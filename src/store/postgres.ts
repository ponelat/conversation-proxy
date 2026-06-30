// PostgresStore — the durable ConversationStore (D1, D2). Same interface as
// InMemoryStore; all tables live in the service's dedicated schema (D12).
// The `id` column holds the scope string (the scope IS the conversation id, D2):
// opaque for equality/FK, path-structured only for the prefix query.

import type {
  Conversation,
  ConversationMeta,
  ConversationScope,
  ConversationStore,
  ContentPart,
  Role,
  StoredMessage,
} from "@/types/index";
import { assertIdentifier, makePool, type Pool } from "@/db/pg";
import { nowIso } from "@/util/ids";

interface ConvRow {
  id: string; // the scope string
  title: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

interface MsgRow {
  id: string;
  role: string;
  content: ContentPart[];
  token_count: number | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

const iso = (d: Date | string): string => (d instanceof Date ? d.toISOString() : d);

export class PostgresStore implements ConversationStore {
  private constructor(private pool: Pool, private schema: string) {}

  static connect(databaseUrl: string, schema: string): Promise<PostgresStore> {
    return Promise.resolve(new PostgresStore(makePool(databaseUrl), assertIdentifier(schema)));
  }

  #convMeta(r: ConvRow): ConversationMeta {
    return {
      scope: r.id,
      title: r.title ?? undefined,
      metadata: r.metadata,
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
    };
  }

  #msg(r: MsgRow): StoredMessage {
    return {
      id: r.id,
      role: r.role as Role,
      content: r.content,
      tokenCount: r.token_count ?? undefined,
      metadata: r.metadata,
      createdAt: iso(r.created_at),
    };
  }

  async listConversationsByPrefix(prefix: ConversationScope): Promise<ConversationMeta[]> {
    const t = this.schema;
    // Boundary-aware: the exact scope or any descendant under "prefix/".
    const { rows } = await this.pool.query<ConvRow>(
      `select id, title, metadata, created_at, updated_at from "${t}".conversations
       where id = $1 or starts_with(id, $1 || '/') order by updated_at desc`,
      [prefix],
    );
    return rows.map((r) => this.#convMeta(r));
  }

  async getConversation(scope: ConversationScope): Promise<Conversation | null> {
    const t = this.schema;
    const { rows } = await this.pool.query<ConvRow>(
      `select id, title, metadata, created_at, updated_at from "${t}".conversations where id = $1`,
      [scope],
    );
    if (rows.length === 0) return null;
    const { rows: msgs } = await this.pool.query<MsgRow>(
      `select id, role, content, token_count, metadata, created_at from "${t}".messages
       where conversation_id = $1 order by created_at asc`,
      [scope],
    );
    return { ...this.#convMeta(rows[0]), messages: msgs.map((m) => this.#msg(m)) };
  }

  async getOrCreateConversation(scope: ConversationScope): Promise<Conversation> {
    const t = this.schema;
    const ts = nowIso();
    // Race-safe via the PK: a concurrent first turn no-ops instead of erroring.
    await this.pool.query(
      `insert into "${t}".conversations (id, title, metadata, created_at, updated_at)
       values ($1, null, '{}'::jsonb, $2::timestamptz, $2::timestamptz)
       on conflict (id) do nothing`,
      [scope, ts],
    );
    const conv = await this.getConversation(scope);
    if (!conv) throw new Error(`failed to create conversation: ${scope}`);
    return conv;
  }

  async appendMessages(scope: ConversationScope, msgs: StoredMessage[]): Promise<void> {
    const t = this.schema;
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      for (const m of msgs) {
        await client.query(
          `insert into "${t}".messages
             (id, conversation_id, role, content, token_count, metadata, created_at)
           values ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7::timestamptz)`,
          [
            m.id,
            scope,
            m.role,
            JSON.stringify(m.content),
            m.tokenCount ?? null,
            JSON.stringify(m.metadata ?? {}),
            m.createdAt,
          ],
        );
      }
      await client.query(`update "${t}".conversations set updated_at = now() where id = $1`, [scope]);
      await client.query("commit");
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
  }

  async getMessages(
    scope: ConversationScope,
    opts?: { limit?: number; before?: string },
  ): Promise<StoredMessage[]> {
    const t = this.schema;
    const args: unknown[] = [scope];
    let where = `conversation_id = $1`;
    if (opts?.before) {
      args.push(opts.before);
      where += ` and created_at < $${args.length}::timestamptz`;
    }
    // Most-recent N, returned in chronological order (matches InMemoryStore).
    let sql =
      `select id, role, content, token_count, metadata, created_at from "${t}".messages where ${where}`;
    if (opts?.limit !== undefined) {
      args.push(opts.limit);
      sql =
        `select * from (${sql} order by created_at desc limit $${args.length}) s order by created_at asc`;
    } else {
      sql += ` order by created_at asc`;
    }
    const { rows } = await this.pool.query<MsgRow>(sql, args);
    return rows.map((r) => this.#msg(r));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
