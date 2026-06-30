import { test, assert, assertEquals, assertRejects } from "@/test-shim";
import { OpenAIProvider } from "./openai";
import { assembledFromParts, systemNote } from "@/assembler/parts";
import { textContent } from "@/types/index";
import type { CallContext, LLMRequest } from "@/types/index";

const ctx: CallContext = { agent: "default", scope: "u", traceId: "tr" };

test("maps prepared context to chat messages and parses usage", async () => {
  const original = globalThis.fetch;
  let captured: { url: string; body: unknown } | undefined;

  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    captured = { url: String(url), body: JSON.parse(String(init?.body)) };
    return Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "hi there" } }],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 3,
            prompt_tokens_details: { cached_tokens: 8 },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  }) as typeof fetch;

  try {
    const provider = new OpenAIProvider("sk-test");
    const req: LLMRequest = {
      model: "gpt-4o-mini",
      prepared: {
        systemPrompt: "be brief",
        messages: [assembledFromParts("user", textContent("hello"))],
        breakpoints: [],
        prefixTokens: 0,
      },
    };
    const res = await provider.complete(req, ctx);

    assertEquals(res.reply, "hi there");
    assertEquals(res.usage, { promptTokens: 12, completionTokens: 3, cachedTokens: 8 });

    const body = captured!.body as {
      model: string;
      messages: Array<{ role: string; content: string }>;
    };
    assertEquals(captured!.url, "https://api.openai.com/v1/chat/completions");
    assertEquals(body.model, "gpt-4o-mini");
    assertEquals(body.messages, [
      { role: "system", content: "be brief" },
      { role: "user", content: "hello" },
    ]);
  } finally {
    globalThis.fetch = original;
  }
});

test("surfaces non-2xx as an error", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(new Response("nope", { status: 429 }))) as typeof fetch;
  try {
    const provider = new OpenAIProvider("sk-test");
    let threw = false;
    try {
      await provider.complete(
        {
          model: "m",
          prepared: {
            systemPrompt: "",
            messages: [systemNote("x")],
            breakpoints: [],
            prefixTokens: 0,
          },
        },
        ctx,
      );
    } catch (e) {
      threw = true;
      assertEquals((e as Error).message.includes("429"), true);
    }
    assertEquals(threw, true);
  } finally {
    globalThis.fetch = original;
  }
});
