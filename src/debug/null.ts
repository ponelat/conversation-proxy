// Production default debug channel: zero overhead, no observers (D10).

import type { DebugChannel } from "@/types/index";

export class NullDebugChannel implements DebugChannel {
  emit(): void {}
}
