import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId } from "./baseSchemas.ts";

export const HarnessStatusInput = Schema.Struct({ threadId: ThreadId });
export type HarnessStatusInput = typeof HarnessStatusInput.Type;

export const HarnessStatusValue = Schema.Literals(["on", "off", "unknown"]);
export type HarnessStatusValue = typeof HarnessStatusValue.Type;

/** Model assignments the harness hook read for its decision; null when unavailable. */
export const HarnessRoles = Schema.Struct({
  orchestrator: Schema.NullOr(Schema.String),
  implementer: Schema.NullOr(Schema.String),
  reviewer: Schema.NullOr(Schema.String),
});
export type HarnessRoles = typeof HarnessRoles.Type;

/**
 * Harness state of the native session behind a thread. `reason` is a stable
 * code: the hook's own decision code, or a server code explaining why the
 * status is unknown.
 */
export const HarnessStatusResult = Schema.Struct({
  threadId: ThreadId,
  status: HarnessStatusValue,
  reason: Schema.String,
  sessionId: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  evaluatedAt: Schema.NullOr(IsoDateTime),
  roles: HarnessRoles,
});
export type HarnessStatusResult = typeof HarnessStatusResult.Type;

export class HarnessStatusError extends Schema.TaggedError<HarnessStatusError>()(
  "HarnessStatusError",
  {
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to read the harness status for thread ${this.threadId}.`;
  }
}
