// Scope <-> URL encoding (spec §5.1): the hierarchy array is one query param with
// elements joined by "/" and each element percent-encoded.

import type { ConversationScope } from "@/types/index";
import { BadRequest } from "@/util/errors";

export function encodeScope(scope: ConversationScope): string {
  return scope.map(encodeURIComponent).join("/");
}

export function parseScope(raw: string | undefined): ConversationScope {
  if (!raw) throw new BadRequest("missing scope");
  return raw.split("/").map(decodeURIComponent);
}

export function parseScopeOptional(raw: string | undefined): ConversationScope | undefined {
  return raw ? parseScope(raw) : undefined;
}
