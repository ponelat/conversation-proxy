// In-memory pollable debug event log (D10): a bounded ring buffer with a
// monotonic cursor. Used for the memory-store / dev / test path. Not shared
// across processes — the Postgres log is the durable, multi-instance option.

import type { DebugEvent, DebugEventLog, DebugPollOptions, DebugPollResult } from "@/types/index";

interface Entry {
  seq: number;
  event: DebugEvent;
}

function matches(e: DebugEvent, opts: DebugPollOptions): boolean {
  if (opts.traceId && e.traceId !== opts.traceId) return false;
  if (opts.agent && e.agent !== opts.agent) return false;
  if (opts.types && !opts.types.includes(e.type)) return false;
  return true;
}

export class InMemoryDebugLog implements DebugEventLog {
  #buf: Entry[] = [];
  #seq = 0;

  constructor(private capacity = 1000) {}

  emit(event: DebugEvent): void {
    this.#seq += 1;
    this.#buf.push({ seq: this.#seq, event });
    if (this.#buf.length > this.capacity) this.#buf.shift();
  }

  poll(opts: DebugPollOptions): Promise<DebugPollResult> {
    // head probe: no `after` → report the current cursor, no events
    if (opts.after === undefined) {
      return Promise.resolve({ events: [], cursor: this.#seq, dropped: false });
    }
    const oldest = this.#buf.length ? this.#buf[0].seq : this.#seq;
    const dropped = opts.after > 0 && opts.after < oldest - 1;

    const matched = this.#buf.filter((e) => e.seq > opts.after! && matches(e.event, opts));
    const limited = opts.limit !== undefined ? matched.slice(0, opts.limit) : matched;
    const cursor = limited.length ? limited[limited.length - 1].seq : opts.after;

    return Promise.resolve({ events: limited.map((e) => e.event), cursor, dropped });
  }
}
