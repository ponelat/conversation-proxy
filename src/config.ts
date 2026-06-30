// Environment-driven configuration (12-factor). All keys are prefixed CP_.

export type StoreKind = "memory" | "postgres";
export type ProviderKind = "fake" | "openai";
export type MigrateMode = "command" | "startup-with-lock";

export interface Config {
  port: number;
  agentsDir: string;
  store: StoreKind;
  databaseUrl?: string;
  schema: string;
  migrateMode: MigrateMode;
  provider: ProviderKind;
  openaiApiKey?: string;
  model: string;
  apiKey: string;
  debugEnabled: boolean;
  debugToken: string;
  baseUrl: string; // used by the CLI client
}

function env(key: string): string | undefined {
  const v = process.env[key];
  return v === undefined || v === "" ? undefined : v;
}

function bool(key: string, fallback = false): boolean {
  const v = env(key);
  if (v === undefined) return fallback;
  return v === "1" || v.toLowerCase() === "true";
}

export function loadConfig(): Config {
  const port = Number(env("CP_PORT") ?? 8787);
  return {
    port,
    agentsDir: env("CP_AGENTS_DIR") ?? "./agents",
    store: (env("CP_STORE") ?? "memory") as StoreKind,
    databaseUrl: env("CP_DATABASE_URL"),
    schema: env("CP_DB_SCHEMA") ?? "conversation_proxy",
    migrateMode: (env("CP_MIGRATE_MODE") ?? "command") as MigrateMode,
    provider: (env("CP_PROVIDER") ?? "fake") as ProviderKind,
    openaiApiKey: env("CP_OPENAI_API_KEY"),
    model: env("CP_MODEL") ?? "gpt-4o-mini",
    apiKey: env("CP_API_KEY") ?? "dev-control-token",
    debugEnabled: bool("CP_DEBUG_ENABLED", false),
    debugToken: env("CP_DEBUG_TOKEN") ?? "dev-debug-token",
    baseUrl: env("CP_BASE_URL") ?? `http://localhost:${port}`,
  };
}
