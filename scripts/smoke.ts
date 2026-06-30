// Live smoke test: spawn the real `serve` process and drive it through the CLI
// subcommands (separate OS processes), proving the HTTP + CLI path end-to-end
// against the fake provider. Exits non-zero on any failure.
//
//   npm run smoke

import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";

const PORT = "8799";
const ENV = {
  ...process.env,
  CP_STORE: "memory",
  CP_PROVIDER: "fake",
  CP_MODEL: "fake-model",
  CP_PORT: PORT,
  CP_BASE_URL: `http://localhost:${PORT}`,
  CP_AGENTS_DIR: "./agents",
  CP_API_KEY: "smoke-control",
  CP_DEBUG_ENABLED: "true",
  CP_DEBUG_TOKEN: "smoke-debug",
};

const TSX = resolve("node_modules/.bin/tsx");
const ENTRY = "src/main.ts";

function cli(args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(TSX, [ENTRY, ...args], { env: ENV, encoding: "utf8" });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(`smoke assertion failed: ${msg}`);
}

async function waitForHealth(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`http://localhost:${PORT}/health`);
      if (r.ok) {
        await r.body?.cancel();
        return;
      }
      await r.body?.cancel();
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("server did not become healthy in time");
}

const server = spawn(TSX, [ENTRY, "serve"], { env: ENV, stdio: "inherit" });

let failed = false;
try {
  await waitForHealth();
  console.log("✓ server healthy");

  const agents = cli(["agents"]);
  assert(agents.code === 0, "agents exits 0");
  assert(/vet/.test(agents.stdout) && /summarize/.test(agents.stdout), "agents lists examples");
  console.log("✓ agents listed");

  const sent = cli([
    "send",
    "--agent",
    "vet",
    "--scope",
    "user_1/client_1",
    "--input",
    "my dog is limping",
  ]);
  assert(sent.code === 0, "send exits 0");
  assert(/my dog is limping/.test(sent.stdout), "reply echoes input");
  const traceId = /traceId=(\S+)/.exec(sent.stderr)?.[1];
  assert(traceId, "send prints a traceId");
  console.log(`✓ send ok (traceId=${traceId})`);

  const rec = cli(["record", traceId!]);
  assert(rec.code === 0 && /"agent": "vet"/.test(rec.stdout), "record returns the envelope");
  console.log("✓ record fetched");

  const explore = cli(["explore", "--scope", "user_1"]);
  assert(explore.code === 0 && /"records"/.test(explore.stdout), "explore returns storage view");
  console.log("✓ explore ok");

  console.log("\nSMOKE PASSED");
} catch (err) {
  failed = true;
  console.error("\nSMOKE FAILED:", err instanceof Error ? err.message : err);
} finally {
  server.kill("SIGTERM");
}

process.exit(failed ? 1 : 0);
