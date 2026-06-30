// Helpers for building persisted + assembled messages (D16).
// Shared by the built-in default assembler and available to custom agents.

import type {
  AssembledMessage,
  AssembledPart,
  ContentPart,
  Role,
  StoredMessage,
} from "@/types/index";
import { partsToText, textContent } from "@/types/index";
import { newId, nowIso } from "@/util/ids";

/** Build a fresh persisted message from content parts. */
export function messageFromParts(role: Role, parts: ContentPart[]): StoredMessage {
  return { id: newId(), role, content: parts, createdAt: nowIso() };
}

/** Wrap a pristine persisted message as an assembled (ephemeral) one, refs untouched. */
export function toAssembledMessage(source: StoredMessage): AssembledMessage {
  const parts: AssembledPart[] = source.content.map((part) => ({ part }));
  return { source, parts };
}

/**
 * Build an assembled message directly from content parts.
 * `hydrateMedia` is a no-op in v1 (text-only) but kept for forward-compat (D16):
 * once media exists, the current turn's parts get meta.resolve = true here.
 */
export function assembledFromParts(
  role: Role,
  parts: ContentPart[],
  hydrateMedia = false,
): AssembledMessage {
  const source = messageFromParts(role, parts);
  const aParts: AssembledPart[] = parts.map((part) =>
    hydrateMedia && part.kind !== "text" ? { part, meta: { resolve: true } } : { part }
  );
  return { source, parts: aParts };
}

/** A system-role assembled note from plain text (used by custom domain agents). */
export function systemNote(text: string): AssembledMessage {
  return assembledFromParts("system", textContent(text));
}

/** Flatten an assembled message back to plain text (for token counting / fake provider). */
export function assembledToText(m: AssembledMessage): string {
  return partsToText(m.parts.map((p) => p.part));
}
