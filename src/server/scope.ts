// Scope <-> URL encoding (spec §5.1): the scope is a "/"-separated path carried
// in one query param. "/" stays structural; segment contents are percent-encoded
// so query-hostile bytes (spaces, &, =, unicode) survive the round-trip.

import type { ConversationScope } from "@/types/index";
import { validateScope } from "@/types/index";

export function encodeScope(scope: ConversationScope): string {
  return scope.split("/").map(encodeURIComponent).join("/");
}

export function parseScope(raw: string | undefined): ConversationScope {
  // validateScope throws BadRequest("missing scope") on empty/undefined.
  const scope = raw ? raw.split("/").map(decodeURIComponent).join("/") : "";
  validateScope(scope);
  return scope;
}

export function parseScopeOptional(raw: string | undefined): ConversationScope | undefined {
  return raw ? parseScope(raw) : undefined;
}
