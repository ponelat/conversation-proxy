import { test, assert, assertEquals, assertRejects } from "@/test-shim";
import { PassthroughCache } from "./passthrough";
import { assembledFromParts, systemNote } from "@/assembler/parts";
import { textContent } from "@/types/index";
import type { AssembledContext } from "@/types/index";

test("passthrough lifts system messages and flattens the rest, no caching", () => {
  const ctx: AssembledContext = {
    segments: [
      { source: "system", stability: "static", messages: [systemNote("be helpful")] },
      {
        source: "conversation",
        stability: "volatile",
        messages: [
          assembledFromParts("user", textContent("hi")),
          assembledFromParts("assistant", textContent("hello")),
        ],
      },
    ],
    totalTokens: 0,
  };

  const prepared = new PassthroughCache().prepare(ctx);

  assertEquals(prepared.systemPrompt, "be helpful");
  assertEquals(prepared.messages.length, 2);
  assertEquals(prepared.messages.map((m) => m.source.role), ["user", "assistant"]);
  assertEquals(prepared.breakpoints, []);
  assertEquals(prepared.prefixTokens, 0);
});

test("passthrough joins multiple system notes", () => {
  const ctx: AssembledContext = {
    segments: [
      { source: "a", stability: "static", messages: [systemNote("one")] },
      { source: "b", stability: "semi-static", messages: [systemNote("two")] },
    ],
    totalTokens: 0,
  };
  const prepared = new PassthroughCache().prepare(ctx);
  assertEquals(prepared.systemPrompt, "one\n\ntwo");
  assertEquals(prepared.messages.length, 0);
});
