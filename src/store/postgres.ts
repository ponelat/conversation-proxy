// PostgresStore — the durable ConversationStore (D1, D2). Same interface as
// InMemoryStore; all tables live in the service's dedicated schema (D12).

import type {
  Conversation,
  ConversationId,
  ConversationMeta,
  ConversationScope,
  ConversationStore,
  ContentPart,
  Role,
  StoredMessage,
} from "@/types/index";
import { assertIdentifier, makePool, type Pool } from "@/db/pg";
import { newId, nowIso } from "@/util/ids";

interface ConvRow {
  id: string;
  scope_arr: string[];
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
      id: r.id,
      scope: r.scope_arr,
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

  async listConversations(scope: ConversationScope): Promise<ConversationMeta[]> {
    const t = this.schema;
    const { rows } = await this.pool.query<ConvRow>(
      `select id, scope_arr, title, metadata, created_at, updated_at from "${t}".conversations
       where scope_arr = $1::text[] order by updated_at desc`,
      [scope],
    );
    return rows.map((r) => this.#convMeta(r));
  }

  async listConversationsByPrefix(prefix: ConversationScope): Promise<ConversationMeta[]> {
    const t = this.schema;
    const { rows } = await this.pool.query<ConvRow>(
      `select id, scope_arr, title, metadata, created_at, updated_at from "${t}".conversations
       where scope_arr[1:$2] = $1::text[] order by updated_at desc`,
      [prefix, prefix.length],
    );
    return rows.map((r) => this.#convMeta(r));
  }

  async getConversation(id: ConversationId): Promise<Conversation | null> {
    const t = this.schema;
    const { rows } = await this.pool.query<ConvRow>(
      `select id, scope_arr, title, metadata, created_at, updated_at from "${t}".conversations
       where id = $1`,
      [id],
    );
    if (rows.length === 0) return null;
    const { rows: msgs } = await this.pool.query<MsgRow>(
      `select id, role, content, token_count, metadata, created_at from "${t}".messages
       where conversation_id = $1 order by created_at asc`,
      [id],
    );
    return { ...this.#convMeta(rows[0]), messages: msgs.map((m) => this.#msg(m)) };
  }

  async createConversation(
    scope: ConversationScope,
    meta?: Partial<ConversationMeta>,
  ): Promise<Conversation> {
    const t = this.schema;
    const ts = nowIso();
    const full: ConversationMeta = {
      id: meta?.id ?? newId(),
      scope,
      title: meta?.title,
      createdAt: meta?.createdAt ?? ts,
      updatedAt: meta?.updatedAt ?? ts,
      metadata: meta?.metadata,
    };
    await this.pool.query(
      `insert into "${t}".conversations
         (id, scope_arr, title, metadata, created_at, updated_at)
       values ($1, $2::text[], $3, $4::jsonb, $5::timestamptz, $6::timestamptz)`,
      [
        full.id,
        scope,
        full.title ?? null,
        JSON.stringify(full.metadata ?? {}),
        full.createdAt,
        full.updatedAt,
      ],
    );
    return { ...full, messages: [] };
  }

  async appendMessages(id: ConversationId, msgs: StoredMessage[]): Promise<void> {
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
            id,
            m.role,
            JSON.stringify(m.content),
            m.tokenCount ?? null,
            JSON.stringify(m.metadata ?? {}),
            m.createdAt,
          ],
        );
      }
      await client.query(`update "${t}".conversations set updated_at = now() where id = $1`, [id]);
      await client.query("commit");
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
  }

  async getMessages(
    id: ConversationId,
    opts?: { limit?: number; before?: string },
  ): Promise<StoredMessage[]> {
    const t = this.schema;
    const args: unknown[] = [id];
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
