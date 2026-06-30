// CLI entrypoint (Node). `serve`/`migrate` run the service; the remaining
// subcommands are a thin HTTP client so every feature is exercisable end-to-end
// from a terminal (see README "closing the loop").

import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { loadConfig } from "@/config";
import { createProxy } from "@/app";
import { buildHttpApp } from "@/server/http";
import { ConversationProxyClient } from "@/cli/client";
import { parseScope } from "@/server/scope";
import type { DebugEventType } from "@/types/index";

// Load .env if present (Node 20.6+); harmless when absent or already loaded.
try {
  process.loadEnvFile();
} catch { /* no .env — rely on the real environment */ }

const HELP = `conversation-proxy — observable LLM conversation proxy

Usage:
  conversation-proxy serve [--migrate-on-startup]   start the service
  conversation-proxy migrate                        run pending migrations and exit
  conversation-proxy migrate:status                 print applied/pending migrations

  conversation-proxy agents                         list loaded agents
  conversation-proxy send --agent <a> --scope a/b/c --input "..."
  conversation-proxy preview --agent <a> --scope a/b/c
  conversation-proxy record <traceId>               fetch one call envelope by trace id
  conversation-proxy records --scope a/b/c [--agent <a>]   list a scope's call records (trace ids)
  conversation-proxy explore --scope a/b/c          browse storage (debug plane)
  conversation-proxy stream [--trace <id>] [--agent <a>] [--types a,b]   tail debug events

Config is read from environment (CP_*). See .env.example.`;

function client() {
  const config = loadConfig();
  return new ConversationProxyClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    debugToken: config.debugToken,
  });
}

function pretty(v: unknown) {
  console.log(JSON.stringify(v, null, 2));
}

async function cmdServe(migrateOnStartupFlag: boolean) {
  const config = loadConfig();
  const migrateOnStartup = migrateOnStartupFlag || config.migrateMode === "startup-with-lock";
  if (migrateOnStartup && config.store === "postgres") {
    const { runMigrations } = await import("@/db/migrate");
    await runMigrations(config, { lock: true });
  }
  const proxy = await createProxy(config);
  const app = buildHttpApp(proxy);
  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(
      `conversation-proxy on :${info.port}  store=${config.store} provider=${config.provider} debug=${config.debugEnabled}`,
    );
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const { values: flags, positionals } = parseArgs({
    args: argv.slice(1),
    options: {
      agent: { type: "string" },
      scope: { type: "string" },
      input: { type: "string" },
      trace: { type: "string" },
      types: { type: "string" },
      "migrate-on-startup": { type: "boolean" },
    },
    allowPositionals: true,
  });

  switch (cmd) {
    case "serve":
      await cmdServe(Boolean(flags["migrate-on-startup"]));
      break;

    case "migrate": {
      const config = loadConfig();
      if (config.store !== "postgres") {
        console.log("memory store: nothing to migrate");
        break;
      }
      const { runMigrations } = await import("@/db/migrate");
      await runMigrations(config, { lock: false });
      break;
    }

    case "migrate:status": {
      const config = loadConfig();
      if (config.store !== "postgres") {
        console.log("memory store: no migration ledger");
        break;
      }
      const { migrationStatus } = await import("@/db/migrate");
      await migrationStatus(config);
      break;
    }

    case "agents":
      pretty(await client().listAgents());
      break;

    case "send": {
      if (!flags.agent || !flags.scope || flags.input === undefined) {
        throw new Error("send requires --agent, --scope and --input");
      }
      const res = await client().send({
        agent: flags.agent,
        scope: parseScope(flags.scope),
        input: [{ kind: "text", text: flags.input }],
      });
      console.log(res.reply);
      console.error(
        `\ntraceId=${res.traceId} ` +
          `tokens(prompt/completion/cached)=${res.usage.promptTokens}/${res.usage.completionTokens}/${res.usage.cachedTokens}`,
      );
      break;
    }

    case "preview": {
      if (!flags.agent || !flags.scope) throw new Error("preview requires --agent and --scope");
      pretty(await client().previewContext(flags.agent, parseScope(flags.scope)));
      break;
    }

    case "record": {
      const traceId = flags.trace ?? positionals[0];
      if (!traceId) throw new Error("record requires a traceId");
      pretty(await client().getRecord(traceId));
      break;
    }

    case "records": {
      if (!flags.scope) throw new Error("records requires --scope");
      pretty(
        await client().queryRecords({ scope: parseScope(flags.scope), agent: flags.agent }),
      );
      break;
    }

    case "explore": {
      if (!flags.scope) throw new Error("explore requires --scope");
      pretty(await client().explore(parseScope(flags.scope)));
      break;
    }

    case "stream": {
      const types = flags.types?.split(",") as DebugEventType[] | undefined;
      console.error("polling debug events (Ctrl-C to stop)…");
      for await (
        const ev of client().watchDebug({ traceId: flags.trace, agent: flags.agent, types })
      ) {
        console.log(`${ev.ts}  ${ev.type.padEnd(18)} trace=${ev.traceId} agent=${ev.agent}`);
      }
      break;
    }

    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      break;

    default:
      console.error(`unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((e) => {
  const err = e as { message?: string; traceId?: string };
  console.error(`error: ${err.message ?? e}`);
  if (err.traceId) {
    console.error(`traceId=${err.traceId}  (inspect the envelope: conversation-proxy record ${err.traceId})`);
  }
  process.exit(1);
});
