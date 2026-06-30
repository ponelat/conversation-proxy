// Wire the whole service from config. Used by the HTTP server, the embeddable
// factory, AND the in-process e2e harness, so all exercise identical wiring.

import type {
  AgentRegistry,
  CallRecordStore,
  ContextExplorer,
  ConversationAgent,
  ConversationStore,
  DebugChannel,
  DebugEventLog,
  Provider,
} from "@/types/index";
import type { Config } from "@/config";
import { InMemoryStore } from "@/store/memory";
import { InMemoryCallRecordStore } from "@/telemetry/memory";
import { FakeProvider } from "@/provider/fake";
import { AgentDefaults } from "@/agent/registry";
import { type AgentInput, loadAgents } from "@/agent/loader";
import { NullDebugChannel } from "@/debug/null";
import { InMemoryDebugLog } from "@/debug/memory-log";
import { ObservableLLMProxy } from "@/proxy/proxy";
import { PersistedConversationAgent } from "@/facade/agent";
import { DefaultContextExplorer } from "@/debug/explorer";

export interface App {
  config: Config;
  store: ConversationStore;
  records: CallRecordStore;
  registry: AgentRegistry;
  facade: ConversationAgent;
  explorer: ContextExplorer;
  debug: DebugChannel; // a DebugEventLog when debug is enabled, else NullDebugChannel
  /** The pollable event log when debug is enabled; null otherwise. */
  debugLog: DebugEventLog | null;
  /** Release backend resources (DB pools). Safe to call on shutdown. */
  close(): Promise<void>;
}

export interface ProxyOptions {
  /**
   * Programmatically registered agents (bundler-safe — the primary path when
   * embedding in a bundled app). Merged with the filesystem scan of
   * config.agentsDir, which is only used when scanDir is left enabled.
   */
  agents?: Record<string, AgentInput>;
  /**
   * Whether to also scan config.agentsDir for *.agent.{ts,js}. Defaults to true
   * for standalone; set false when embedding to avoid bundler/dynamic-import issues.
   */
  scanDir?: boolean;
}

async function makeStore(config: Config): Promise<ConversationStore> {
  if (config.store === "postgres") {
    if (!config.databaseUrl) throw new Error("CP_DATABASE_URL is required when CP_STORE=postgres");
    const { PostgresStore } = await import("@/store/postgres");
    return await PostgresStore.connect(config.databaseUrl, config.schema);
  }
  return new InMemoryStore();
}

async function makeProvider(config: Config): Promise<Provider> {
  if (config.provider === "openai") {
    if (!config.openaiApiKey) {
      throw new Error("CP_OPENAI_API_KEY is required when CP_PROVIDER=openai");
    }
    const { OpenAIProvider } = await import("@/provider/openai");
    return new OpenAIProvider(config.openaiApiKey);
  }
  return new FakeProvider();
}

async function makeRecords(config: Config): Promise<CallRecordStore> {
  if (config.store === "postgres") {
    const { PostgresCallRecordStore } = await import("@/telemetry/postgres");
    return await PostgresCallRecordStore.connect(config.databaseUrl!, config.schema);
  }
  return new InMemoryCallRecordStore();
}

/**
 * Build the wired core (store, registry, facade, proxy, explorer). The HTTP layer
 * is a separate adapter — see buildHttpApp / createServer.
 */
export async function createProxy(config: Config, opts: ProxyOptions = {}): Promise<App> {
  const store = await makeStore(config);
  const records = await makeRecords(config);
  const provider = await makeProvider(config);

  const defaults = new AgentDefaults(store);
  const registry = await loadAgents({
    agents: opts.agents,
    dir: opts.scanDir === false ? undefined : config.agentsDir,
    defaults,
  });

  let debugLog: DebugEventLog | null = null;
  if (config.debugEnabled) {
    if (config.store === "postgres") {
      const { PostgresDebugLog } = await import("@/debug/postgres");
      debugLog = await PostgresDebugLog.connect(config.databaseUrl!, config.schema);
    } else {
      debugLog = new InMemoryDebugLog();
    }
  }
  const debug: DebugChannel = debugLog ?? new NullDebugChannel();
  const proxy = new ObservableLLMProxy(provider, debug, records);
  const facade = new PersistedConversationAgent({
    registry,
    store,
    proxy,
    debug,
    defaultModel: config.model,
  });
  const explorer = new DefaultContextExplorer(registry, store, records);

  const close = async () => {
    for (const dep of [store, records, debugLog] as Array<{ close?: () => Promise<void> } | null>) {
      if (dep && typeof dep.close === "function") await dep.close();
    }
  };

  return { config, store, records, registry, facade, explorer, debug, debugLog, close };
}

/** Back-compat alias. */
export const buildApp = createProxy;
