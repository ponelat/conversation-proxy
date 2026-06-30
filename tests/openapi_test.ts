// Contract drift check (D13): every operation documented in openapi.yaml must be
// implemented as a route, and every implemented control/debug route (except the
// SSE stream, which is AsyncAPI territory) must be documented.

import { assert, assertEquals, test } from "@/test-shim";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { buildApp } from "@/app";
import { buildHttpApp } from "@/server/http";
import type { Config } from "@/config";

const cfg: Config = {
  port: 0,
  agentsDir: "./agents",
  store: "memory",
  schema: "conversation_proxy",
  migrateMode: "command",
  provider: "fake",
  model: "m",
  apiKey: "k",
  debugEnabled: true,
  debugToken: "d",
  baseUrl: "",
};

const normalize = (p: string) => p.replace(/:([A-Za-z0-9_]+)/g, "{$1}");

const app = await buildApp(cfg);
const http = buildHttpApp(app);

const implemented = new Set(
  http.routes
    .filter((r) => r.method !== "ALL")
    .map((r) => `${r.method} ${normalize(r.path)}`),
);

const spec = parse(await readFile("openapi.yaml", "utf8")) as {
  paths: Record<string, Record<string, unknown>>;
};
const documented: string[] = [];
for (const [path, item] of Object.entries(spec.paths)) {
  for (const method of Object.keys(item)) documented.push(`${method.toUpperCase()} ${path}`);
}

test("every documented operation is implemented", () => {
  for (const op of documented) {
    assert(implemented.has(op), `documented but not implemented: ${op}`);
  }
});

test("every implemented route is documented", () => {
  const undocumented = [...implemented].filter((op) => !documented.includes(op));
  assertEquals(undocumented, [], `implemented but undocumented: ${undocumented.join(", ")}`);
});
