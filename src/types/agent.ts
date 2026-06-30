// The assembler, cache strategy, persistence hook, and agent manifest (D3, D11, D15).

import type {
  AssembledMessage,
  ContentPart,
  Conversation,
  ConversationId,
  ConversationMeta,
  ConversationScope,
  StoredMessage,
} from "./core";

// --- Storage boundary (D2) --------------------------------------------------

export interface ConversationStore {
  listConversations(scope: ConversationScope): Promise<ConversationMeta[]>;
  /** Prefix query for the debug explorer: every conversation under a scope prefix. */
  listConversationsByPrefix(prefix: ConversationScope): Promise<ConversationMeta[]>;
  getConversation(id: ConversationId): Promise<Conversation | null>;
  createConversation(
    scope: ConversationScope,
    meta?: Partial<ConversationMeta>,
  ): Promise<Conversation>;
  appendMessages(id: ConversationId, msgs: StoredMessage[]): Promise<void>;
  getMessages(
    id: ConversationId,
    opts?: { limit?: number; before?: string },
  ): Promise<StoredMessage[]>;
}

/** Read-only slice handed to assembler hooks — read, never write (D11). */
export type ReadOnlyConversationStore = Pick<
  ConversationStore,
  "listConversations" | "getConversation" | "getMessages"
>;

// --- Assembler (D3, D16) ----------------------------------------------------

export type SegmentStability = "static" | "semi-static" | "volatile";

export interface ContextSegment {
  source: string; // free-form label, e.g. "system" | "history" | a domain tag
  stability: SegmentStability; // the contract with CacheStrategy (D3)
  messages: AssembledMessage[]; // enveloped, ephemeral parts (D16)
}

export interface AssembledContext {
  segments: ContextSegment[]; // ordered most-stable-first
  totalTokens: number;
}

export interface AssemblerInput {
  scope: ConversationScope;
  conversationId?: ConversationId; // absent for non-persisting agents (D15)
  message: ContentPart[]; // the incoming user turn's parts
  store: ReadOnlyConversationStore;
}

export type AssemblerHook = (input: AssemblerInput) => Promise<AssembledContext>;

// --- Cache strategy (D4) ----------------------------------------------------

export interface CacheBreakpoint {
  afterSegmentIndex: number; // breakpoint placed after this segment
}

export interface PreparedContext {
  messages: AssembledMessage[]; // final flat list to send (enveloped, D16)
  systemPrompt: string;
  breakpoints: CacheBreakpoint[];
  prefixTokens: number; // tokens in the cacheable prefix (0 for passthrough)
}

export interface CacheStrategy {
  prepare(ctx: AssembledContext): PreparedContext;
}

// --- Persistence is a hook, not a mode (D15) --------------------------------
// Reconciles spec §4.3 and §4.8 in favor of the facade's begin/end shape:
// the user turn is NOT persisted before assembly (the assembler composes prior
// history + the incoming message), and both turns are persisted after the call.
// This avoids the double-count that loadHistory + appended-current-turn implies.

export interface PersistenceHook {
  /** Ensure a conversation exists; return its id. undefined when persistence is off. */
  beginTurn(
    scope: ConversationScope,
    conversationId?: ConversationId,
  ): Promise<ConversationId | undefined>;

  /** Persist the user + assistant turns. No-op when persistence is off. */
  endTurn(
    scope: ConversationScope,
    conversationId: ConversationId | undefined,
    user: StoredMessage,
    assistant: StoredMessage,
  ): Promise<void>;
}

// --- Agent manifest (D11, D15) ----------------------------------------------

export interface AgentManifest {
  assemble?: AssemblerHook; // omitted → default assembler
  cache?: CacheStrategy; // omitted → passthrough
  persist?: PersistenceHook | boolean; // fn/obj = custom · false = off · true/undefined = default
  model?: string; // omitted → CP_MODEL
}

/** THE CONTRACT every <name>.agent.{ts,js} must default-export. */
export type AgentFactory = () => Promise<AgentManifest>;

/** A manifest with all hooks resolved to concrete implementations. */
export interface ResolvedAgent {
  name: string;
  assemble: AssemblerHook;
  cache: CacheStrategy;
  persist: PersistenceHook;
  persists: boolean; // false when manifest.persist === false
  model?: string; // resolved at call time against config default if absent
}

export type AgentRegistry = Map<string, ResolvedAgent>;
