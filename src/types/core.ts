// Core identity, JSON, and message shapes. The server attaches NO domain meaning
// to the hierarchy — see spec D2.

import { BadRequest } from "@/util/errors";

/**
 * The conversation identity: a "/"-separated hierarchy path, broadest level
 * first, leaf last — e.g. "user_42/client_88/patient_3/2026-W26" (D2). The scope
 * IS the conversation id; there is no separate handle. To branch a fresh thread
 * under one identity, append a "/<uuid>" segment (a pure client convention — the
 * server attaches no meaning to any segment, including the leaf).
 *
 * "/" is a reserved separator: segment values may not contain it. The same string
 * is used verbatim as the storage key, so it stays human-readable in logs.
 */
export type ConversationScope = string;

/** Generous upper bound on a scope string (it is used as a storage key / PK). */
export const MAX_SCOPE_LENGTH = 1024;

/**
 * Validate a canonical scope string (D2). Rejects rather than normalizes so that
 * a client bug — a missing segment collapsing to "a//c" — surfaces as a 400
 * instead of silently writing into a malformed-but-accepted conversation.
 */
export function validateScope(scope: ConversationScope): void {
  if (!scope) throw new BadRequest("missing scope");
  if (scope.length > MAX_SCOPE_LENGTH) {
    throw new BadRequest(`scope exceeds ${MAX_SCOPE_LENGTH} characters`);
  }
  for (const segment of scope.split("/")) {
    if (segment.length === 0) {
      throw new BadRequest(
        "scope has an empty segment (a missing id between '/' separators)",
      );
    }
    if (segment.includes("\0")) throw new BadRequest("scope segment may not contain NUL");
  }
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [k: string]: JsonValue };

export type Role = "system" | "user" | "assistant" | "tool";

/**
 * Normalized, provider-agnostic content part (D16). v1 is text-only; the union is
 * kept open so image/audio/file parts (blob-backed) drop in without a breaking change.
 */
export type ContentPart = { kind: "text"; text: string };

export interface StoredMessage {
  id: string;
  role: Role;
  content: ContentPart[]; // text-only is just [{ kind: "text", text }]
  tokenCount?: number; // populated when known; used by assembler budgeting
  createdAt: string; // ISO 8601
  metadata?: Record<string, unknown>;
}

export interface ConversationMeta {
  /** The scope string — it IS the conversation id (D2). */
  scope: ConversationScope;
  title?: string;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  metadata?: Record<string, unknown>;
}

export interface Conversation extends ConversationMeta {
  messages: StoredMessage[];
}

// --- Assembled (ephemeral, per-request) envelope (D16) ----------------------
// Wraps the pristine persisted parts by value and adds a per-request `meta`
// channel. The store and cache never see these; only the proxy/provider do.

/** transport intent — true hydrates to bytes (deferred in v1); never persisted. */
export type ResolveMode = boolean;

export interface PartMeta {
  resolve?: ResolveMode;
}

export interface AssembledPart {
  part: ContentPart; // pristine persisted shape, untouched, by value
  meta?: PartMeta; // ephemeral, per-request
}

export interface MessageMeta {
  [k: string]: unknown;
}

export interface AssembledMessage {
  source: StoredMessage; // pristine persisted message, reachable untouched
  parts: AssembledPart[];
  meta?: MessageMeta;
}

/** Helper: build the canonical text content array. */
export const textContent = (text: string): ContentPart[] => [{ kind: "text", text }];

/** Helper: extract concatenated text from a content-part array. */
export const partsToText = (parts: ContentPart[]): string =>
  parts.map((p) => (p.kind === "text" ? p.text : "")).join("");
