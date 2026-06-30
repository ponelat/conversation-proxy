// The single front door (D5, D15).

import type { ContentPart, ConversationScope } from "./core";
import type { Usage } from "./proxy";

export interface AgentInput {
  agent: string; // which agent to invoke (D15); 404 if unknown
  scope: ConversationScope;
  input: ContentPart[]; // the turn's content parts (text in v1), D16
}

export interface AgentResponse {
  reply: string;
  traceId: string;
  usage: Usage;
}

export interface ConversationAgent {
  send(input: AgentInput): Promise<AgentResponse>;
}
