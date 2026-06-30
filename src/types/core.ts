// Core identity, JSON, and message shapes. The server attaches NO domain meaning
// to the hierarchy — see spec D2.

/**
 * The identity hierarchy, as an ordered array of opaque IDs (D2).
 * Broadest level first, leaf last, e.g. ["user_42","client_88","patient_3","2026-W26"].
 */
export type ConversationScope = string[];

/**
 * Reserved separator used to serialize a scope to a storage key (D2).
 * A NUL character that cannot appear in any opaque ID. Defined via
 * fromCharCode so the source file stays free of raw control bytes.
 */
export const SCOPE_SEP: string = String.fromCharCode(0);

/** Serialize a scope to a stable storage key. */
export const scopeKey = (s: ConversationScope): string => s.join(SCOPE_SEP);

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [k: string]: JsonValue };

export type ConversationId = string;

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
  id: ConversationId;
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
