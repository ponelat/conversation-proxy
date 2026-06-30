// The single front door (D5, D15).

import type { ContentPart, ConversationId, ConversationScope } from "./core";
import type { Usage } from "./proxy";

export interface AgentInput {
  agent: string; // which agent to invoke (D15); 404 if unknown
  scope: ConversationScope;
  conversationId?: ConversationId; // ignored by non-persisting agents
  input: ContentPart[]; // the turn's content parts (text in v1), D16
}

export interface AgentResponse {
  reply: string;
  conversationId?: ConversationId; // present only for persisting agents
  traceId: string;
  usage: Usage;
}

export interface ConversationAgent {
  send(input: AgentInput): Promise<AgentResponse>;
}
