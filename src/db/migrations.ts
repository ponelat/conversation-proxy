// Ordered migrations, inlined as the single source of truth (D12). Inlining (vs.
// reading .sql off disk) keeps the runner bundle-safe: no path resolution that
// breaks when tsup bundles into dist/, and no files to ship alongside the lib.

export interface Migration {
  id: string;
  /** statements run in order, inside one transaction, after `set search_path` */
  statements: string[];
}

export const MIGRATIONS: Migration[] = [
  {
    id: "001_init",
    statements: [
      // The scope IS the conversation id (D2): `id` holds the "/"-joined scope
      // string. Opaque for equality/FK; path-structured only for prefix queries
      // (`starts_with(id, prefix || '/')`).
      `create table if not exists conversations (
         id          text primary key,
         title       text,
         metadata    jsonb not null default '{}',
         created_at  timestamptz not null,
         updated_at  timestamptz not null
       )`,
      `create table if not exists messages (
         id              uuid primary key,
         conversation_id text not null references conversations (id) on delete cascade,
         role            text not null,
         content         jsonb not null,
         token_count     int,
         metadata        jsonb not null default '{}',
         created_at      timestamptz not null
       )`,
      `create index if not exists messages_conversation_idx on messages (conversation_id, created_at)`,
    ],
  },
  {
    id: "002_call_records",
    statements: [
      `create table if not exists call_records (
         trace_id      text primary key,
         agent         text not null,
         scope         text not null,
         model         text not null,
         reply_preview text,
         ts            timestamptz not null,
         envelope      jsonb not null
       )`,
      `create index if not exists call_records_agent_idx on call_records (agent)`,
      `create index if not exists call_records_scope_idx on call_records (scope)`,
      `create index if not exists call_records_ts_idx on call_records (ts)`,
    ],
  },
  {
    id: "003_debug_events",
    statements: [
      // Pollable debug event log (D10). `seq` is the monotonic cursor clients
      // poll against. No retention/pruning yet — see docs/NOT_DONE.md.
      `create table if not exists debug_events (
         seq       bigserial primary key,
         trace_id  text not null,
         agent     text not null,
         type      text not null,
         ts        timestamptz not null,
         event     jsonb not null
       )`,
      `create index if not exists debug_events_trace_idx on debug_events (trace_id)`,
    ],
  },
];
