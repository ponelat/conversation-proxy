// A factory that takes too long — boot must time out (D11).
import type { AgentManifest } from "@/types/index";

export default function (): Promise<AgentManifest> {
  return new Promise((resolve) => setTimeout(() => resolve({}), 1000));
}
