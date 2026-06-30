// HTTP adapter over the facade (D6, D8, D9). Hono router; the control plane and
// the debug plane authenticate separately (D9). HTTP is just an adapter — all
// behavior lives in the layers below.

import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { App } from "@/app";
import type { ContentPart, DebugEventType } from "@/types/index";
import { textContent } from "@/types/index";
import { BadRequest, NotFound, Unauthorized } from "@/util/errors";
import { parseScope, parseScopeOptional } from "./scope";

function bearer(authHeader: string | undefined): string | undefined {
  if (!authHeader) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader);
  return m ? m[1] : undefined;
}

function normalizeInput(input: unknown): ContentPart[] {
  if (typeof input === "string") return textContent(input);
  if (Array.isArray(input)) return input as ContentPart[];
  throw new BadRequest("`input` must be a string or an array of content parts");
}

export function buildHttpApp(app: App): Hono {
  const { config, facade, store, records, registry, explorer } = app;
  const http = new Hono();

  http.onError((err, c) => {
    const status = (err as { status?: number }).status ?? 500;
    const traceId = (err as { traceId?: string }).traceId;
    if (status >= 500) console.error("[error]", err);
    return c.json({ error: err.message, ...(traceId ? { traceId } : {}) }, status as 400);
  });

  http.get("/health", (c) => c.json({ ok: true, store: config.store, provider: config.provider }));

  // --- Control plane (CP_API_KEY), scoped to its own path prefixes ----------
  const controlAuth: MiddlewareHandler = async (c, next) => {
    if (bearer(c.req.header("Authorization")) !== config.apiKey) {
      throw new Unauthorized("invalid control-plane token");
    }
    await next();
  };
  for (
    const p of [
      "/agents",
      "/agents/*",
      "/conversations",
      "/conversations/*",
      "/records",
      "/records/*",
    ]
  ) {
    http.use(p, controlAuth);
  }

  http.get(
    "/agents",
    (c) => c.json([...registry.values()].map((a) => ({ name: a.name, persists: a.persists }))),
  );

  http.post("/agents/:agent/messages", async (c) => {
    const body = await c.req.json();
    if (typeof body.scope !== "string") throw new BadRequest("`scope` must be a string");
    const res = await facade.send({
      agent: c.req.param("agent"),
      scope: body.scope,
      input: normalizeInput(body.input),
    });
    return c.json(res);
  });

  http.get("/agents/:agent/context", async (c) => {
    const ctx = await explorer.previewContext(
      c.req.param("agent"),
      parseScope(c.req.query("scope")),
    );
    return c.json(ctx);
  });

  // A conversation is addressed by its scope (the scope IS the id, D2). The scope
  // contains "/", so it rides in the query param, not the path. It is created by
  // being talked to (POST /agents/:agent/messages), not by explicit creation.
  http.get("/conversations", async (c) => {
    const conv = await store.getConversation(parseScope(c.req.query("scope")));
    if (!conv) throw new NotFound(`unknown conversation: ${c.req.query("scope")}`);
    return c.json(conv);
  });

  http.get("/records/:traceId", async (c) => {
    const rec = await records.get(c.req.param("traceId"));
    if (!rec) throw new NotFound(`unknown traceId: ${c.req.param("traceId")}`);
    return c.json(rec);
  });

  http.get("/records", async (c) => {
    const q = c.req.query();
    return c.json(
      await records.query({
        agent: q.agent,
        scope: parseScopeOptional(q.scope),
        scopePrefix: parseScopeOptional(q.scopePrefix),
        model: q.model,
        since: q.since,
        until: q.until,
      }),
    );
  });

  // --- Debug plane (CP_DEBUG_TOKEN, only when enabled) ----------------------
  const debugAuth: MiddlewareHandler = async (c, next) => {
    if (!config.debugEnabled) throw new NotFound("debug plane disabled");
    if (bearer(c.req.header("Authorization")) !== config.debugToken) {
      throw new Unauthorized("invalid debug-plane token");
    }
    await next();
  };
  http.use("/debug/*", debugAuth);

  // Poll for debug-event deltas by cursor (replaces the SSE stream): the client
  // re-polls with the returned `cursor`. Omit `after` to probe the head cursor.
  http.get("/debug/events", async (c) => {
    if (!app.debugLog) throw new NotFound("debug plane disabled");
    const afterRaw = c.req.query("after");
    const limitRaw = c.req.query("limit");
    const types = c.req.query("types")?.split(",") as DebugEventType[] | undefined;
    const result = await app.debugLog.poll({
      after: afterRaw === undefined ? undefined : Number(afterRaw),
      limit: limitRaw === undefined ? undefined : Number(limitRaw),
      traceId: c.req.query("traceId"),
      agent: c.req.query("agent"),
      types,
    });
    return c.json(result);
  });

  http.get(
    "/debug/context/:traceId",
    async (c) => c.json(await explorer.getActualContext(c.req.param("traceId"))),
  );

  http.post("/debug/preview", async (c) => {
    const body = await c.req.json();
    if (typeof body.scope !== "string") throw new BadRequest("`scope` must be a string");
    return c.json(await explorer.previewContext(body.agent, body.scope));
  });

  http.get(
    "/debug/explore",
    async (c) => c.json(await explorer.explore(parseScope(c.req.query("scope")))),
  );

  return http;
}
