// Agent discovery (D11). Two sources, merged: programmatic registration (pass
// manifests/factories to the factory — bundler-safe, the primary path for
// embedding) and an optional filesystem dir-scan (for standalone). All-or-nothing
// boot within a timeout: a broken file/factory or a timeout fails boot loudly.

import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentFactory, AgentManifest, AgentRegistry } from "@/types/index";
import { AgentDefaults, resolveAgent } from "./registry";

const AGENT_FILE_RE = /\.agent\.(ts|js|mjs|cjs)$/;
export const BOOT_TIMEOUT_MS = 25_000;

/** A programmatically-registered agent: a manifest object or a factory. */
export type AgentInput = AgentManifest | AgentFactory;

function withTimeout<T>(ms: number, p: Promise<T>): Promise<T> {
  return new Promise<T>((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`agent boot exceeded ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        res(v);
      },
      (e) => {
        clearTimeout(timer);
        rej(e);
      },
    );
  });
}

function scanDir(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && AGENT_FILE_RE.test(e.name))
      .map((e) => e.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return []; // no dir → built-in default only
    throw err;
  }
}

/** Map agent name → filename, preferring <name>.agent.ts when several exist. */
function preferTs(files: string[]): Map<string, string> {
  const byName = new Map<string, string>();
  for (const file of files) {
    const name = file.replace(AGENT_FILE_RE, "");
    const existing = byName.get(name);
    if (!existing || (!existing.endsWith(".ts") && file.endsWith(".ts"))) {
      byName.set(name, file);
    }
  }
  return byName;
}

async function resolveManifest(input: AgentInput): Promise<AgentManifest> {
  return typeof input === "function" ? await input() : input;
}

export interface LoadAgentsOptions {
  /** Programmatic agents (bundler-safe). Keyed by agent name. */
  agents?: Record<string, AgentInput>;
  /** Optional directory to scan for <name>.agent.{ts,js} files. */
  dir?: string;
  defaults: AgentDefaults;
  timeoutMs?: number;
}

export async function loadAgents(opts: LoadAgentsOptions): Promise<AgentRegistry> {
  const { agents, dir, defaults, timeoutMs = BOOT_TIMEOUT_MS } = opts;
  const registry: AgentRegistry = new Map();

  await withTimeout(
    timeoutMs,
    (async () => {
      // 1. programmatic registrations
      for (const [name, input] of Object.entries(agents ?? {})) {
        registry.set(name, resolveAgent(name, await resolveManifest(input), defaults));
      }
      // 2. filesystem dir-scan (optional)
      if (dir) {
        const byName = preferTs(scanDir(dir));
        await Promise.all(
          [...byName].map(async ([name, file]) => {
            const mod = await import(pathToFileURL(resolve(dir, file)).href);
            if (typeof mod.default !== "function") {
              throw new Error(`${file}: default export must be an async AgentManifest factory`);
            }
            registry.set(name, resolveAgent(name, await mod.default(), defaults));
          }),
        );
      }
    })(),
  );

  // A built-in 'default' agent always exists (overridable above).
  if (!registry.has("default")) {
    registry.set("default", resolveAgent("default", {}, defaults));
  }
  return registry;
}
