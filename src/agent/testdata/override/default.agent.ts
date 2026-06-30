// Overrides the built-in 'default' agent (D11) — filename is identity.
import type { AgentManifest } from "@/types/index";

export default function (): Promise<AgentManifest> {
  return Promise.resolve({ persist: false });
}
