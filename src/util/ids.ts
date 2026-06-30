// Small runtime helpers. (Plain Deno runtime code — Date/crypto are fine here.)

export const newId = (): string => crypto.randomUUID();

export const newTraceId = (): string => `tr_${crypto.randomUUID()}`;

export const nowIso = (): string => new Date().toISOString();
