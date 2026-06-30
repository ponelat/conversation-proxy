// Resolve an AgentManifest into a ResolvedAgent, filling missing hooks with
// built-in defaults (D11: absent → default).

import type {
  AgentManifest,
  CacheStrategy,
  ConversationStore,
  PersistenceHook,
  ResolvedAgent,
} from "@/types/index";
import { defaultAssembler } from "@/assembler/default";
import { PassthroughCache } from "@/cache/passthrough";
import { DefaultPersistence, NoopPersistence } from "./persistence";

/** Shared default implementations, constructed once against the live store. */
export class AgentDefaults {
  readonly cache: CacheStrategy = new PassthroughCache();
  readonly noop: PersistenceHook = new NoopPersistence();
  readonly persist: PersistenceHook;

  constructor(store: ConversationStore) {
    this.persist = new DefaultPersistence(store);
  }
}

export function resolveAgent(
  name: string,
  manifest: AgentManifest,
  defaults: AgentDefaults,
): ResolvedAgent {
  let persist: PersistenceHook;
  let persists: boolean;

  if (manifest.persist === false) {
    persist = defaults.noop;
    persists = false;
  } else if (manifest.persist === true || manifest.persist === undefined) {
    persist = defaults.persist;
    persists = true;
  } else {
    persist = manifest.persist; // custom hook object
    persists = true;
  }

  return {
    name,
    assemble: manifest.assemble ?? defaultAssembler,
    cache: manifest.cache ?? defaults.cache,
    persist,
    persists,
    model: manifest.model,
  };
}
