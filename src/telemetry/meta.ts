// Project a full CallRecord down to its queryable metadata (shared by adapters).

import type { CallRecord, CallRecordMeta } from "@/types/index";

export function toMeta(r: CallRecord): CallRecordMeta {
  const { requestMessages: _rm, response: _resp, ...rest } = r;
  return { ...rest, replyPreview: r.response.reply.slice(0, 120) };
}
