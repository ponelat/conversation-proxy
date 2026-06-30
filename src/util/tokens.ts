// Pre-call token counting via js-tiktoken. Provider `usage` overwrites these
// estimates with ground truth in the CallRecord (see docs/DECISIONS.md).

import { getEncoding, type Tiktoken } from "js-tiktoken";

// o200k_base covers the gpt-4o / gpt-4.1 family; cl100k_base the older models.
// We default to o200k_base and cache the encoder (loading ranks is not free).
let encoder: Tiktoken | undefined;

function enc(): Tiktoken {
  encoder ??= getEncoding("o200k_base");
  return encoder;
}

export function countTokens(text: string): number {
  if (!text) return 0;
  return enc().encode(text).length;
}

export function countTokensMany(texts: string[]): number {
  let n = 0;
  for (const t of texts) n += countTokens(t);
  return n;
}
