/**
 * Reports whether the multi-model harness is active for the native Codex session
 * behind a thread. The harness hook owns the decision and writes it to a state file
 * named after the hashed native session ID; this service only maps a thread to that
 * session, checks the file belongs to it and is not older than the latest model
 * change or run start, and returns it. Anything it cannot establish is "unknown",
 * never "off".
 *
 * @module HarnessStatus
 */
import {
  HarnessRoles,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  HarnessStatusValue,
  IsoDateTime,
  ThreadId,
  type HarnessStatusResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as NodeOS from "node:os";

import * as Threads from "../persistence/Services/ProjectionThreads.ts";
import * as Runtime from "../persistence/ProviderSessionRuntime.ts";
import * as OrchestrationEventStore from "../persistence/Services/OrchestrationEventStore.ts";

export class HarnessStatusReadError extends Schema.TaggedError<HarnessStatusReadError>()(
  "HarnessStatusReadError",
  {
    threadId: ThreadId,
    source: Schema.Literals(["thread", "selection", "state"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read the harness ${this.source} of thread ${this.threadId}.`;
  }
}

export class HarnessStatus extends Context.Service<
  HarnessStatus,
  {
    readonly get: (
      threadId: ThreadId,
    ) => Effect.Effect<HarnessStatusResult, HarnessStatusReadError>;
  }
>()("t3/provider/HarnessStatus") {}

/** What the hook writes to `~/.agents/state/harness-status-<sha256(sessionId)>.json`. */
const HarnessStateFile = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: Schema.String,
  model: Schema.String,
  status: HarnessStatusValue,
  reason: Schema.String,
  evaluatedAt: IsoDateTime,
  cwd: Schema.String,
  roles: HarnessRoles,
});
const decodeStateFile = Schema.decodeUnknownOption(Schema.fromJsonString(HarnessStateFile));

const decodeCursor = Schema.decodeUnknownOption(
  Schema.Struct({ threadId: Schema.String.check(Schema.isMinLength(1)) }),
);
const codexInstance = defaultInstanceIdForDriver(ProviderDriverKind.make("codex"));

const NO_ROLES = { orchestrator: null, implementer: null, reviewer: null } as const;

const unknownStatus = (
  threadId: ThreadId,
  reason: string,
  session?: { readonly sessionId: string; readonly model: string },
): HarnessStatusResult => ({
  threadId,
  status: "unknown",
  reason,
  sessionId: session?.sessionId ?? null,
  model: session?.model ?? null,
  evaluatedAt: null,
  roles: NO_ROLES,
});

const make = (homeDir: string) =>
  Effect.gen(function* () {
    const threads = yield* Threads.ProjectionThreadRepository;
    const runtimes = yield* Runtime.ProviderSessionRuntimeRepository;
    const events = yield* OrchestrationEventStore.OrchestrationEventStore;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;

    const readState = (threadId: ThreadId, sessionId: string) =>
      crypto.digest("SHA-256", new TextEncoder().encode(sessionId)).pipe(
        Effect.map((digest) =>
          path.join(
            homeDir,
            ".agents",
            "state",
            `harness-status-${Encoding.encodeHex(digest)}.json`,
          ),
        ),
        Effect.flatMap((statePath) =>
          fileSystem.readFileString(statePath).pipe(
            Effect.catchIf(
              (error) => error.reason._tag === "NotFound",
              () => Effect.succeed(null),
            ),
          ),
        ),
        Effect.mapError(
          (cause) => new HarnessStatusReadError({ threadId, source: "state", cause }),
        ),
      );

    const get: HarnessStatus["Service"]["get"] = Effect.fn("HarnessStatus.get")(
      function* (threadId) {
        yield* Effect.annotateCurrentSpan({ threadId });
        const threadOption = yield* threads
          .getById({ threadId })
          .pipe(
            Effect.mapError(
              (cause) => new HarnessStatusReadError({ threadId, source: "thread", cause }),
            ),
          );
        if (Option.isNone(threadOption) || threadOption.value.deletedAt !== null)
          return unknownStatus(threadId, "thread_not_found");
        const thread = threadOption.value;
        const runtimeOption = yield* runtimes
          .getByThreadId({ threadId })
          .pipe(
            Effect.mapError(
              (cause) => new HarnessStatusReadError({ threadId, source: "thread", cause }),
            ),
          );
        if (Option.isNone(runtimeOption)) return unknownStatus(threadId, "no_provider_thread");
        const runtime = runtimeOption.value;
        if (runtime.providerName !== "codex")
          return unknownStatus(threadId, "unsupported_provider");
        if (
          runtime.threadId !== threadId ||
          (runtime.providerInstanceId ?? codexInstance) !== thread.modelSelection.instanceId
        ) {
          return unknownStatus(threadId, "provider_thread_mismatch");
        }
        const cursor = decodeCursor(runtime.resumeCursor);
        if (Option.isNone(cursor) || cursor.value.threadId.trim().length === 0)
          return unknownStatus(threadId, "no_native_session");
        const sessionId = cursor.value.threadId;
        const session = { sessionId, model: thread.modelSelection.model };

        const stateText = yield* readState(threadId, sessionId);
        if (stateText === null) return unknownStatus(threadId, "state_missing", session);
        const parsed = decodeStateFile(stateText);
        if (parsed._tag === "None") return unknownStatus(threadId, "state_invalid", session);
        const state = parsed.value;
        const evaluatedAt = Date.parse(state.evaluatedAt);
        if (Number.isNaN(evaluatedAt)) return unknownStatus(threadId, "state_invalid", session);
        if (state.sessionId !== sessionId) {
          return unknownStatus(threadId, "state_session_mismatch", session);
        }
        if (state.model !== session.model) {
          return unknownStatus(threadId, "state_model_mismatch", session);
        }

        // The model can be switched away and back while the old file still matches,
        // so a file older than the latest persisted selection change is not evidence.
        const selectionChange = yield* events
          .getLatestHarnessSelectionChange(threadId)
          .pipe(
            Effect.mapError(
              (cause) => new HarnessStatusReadError({ threadId, source: "selection", cause }),
            ),
          );
        if (selectionChange !== null && evaluatedAt < Date.parse(selectionChange.occurredAt)) {
          return unknownStatus(
            threadId,
            selectionChange.type === "thread.turn-start-requested"
              ? "awaiting_hook_after_run_start"
              : "awaiting_hook_after_model_change",
            session,
          );
        }

        return {
          threadId,
          status: state.status,
          reason: state.reason,
          sessionId,
          model: state.model,
          evaluatedAt: state.evaluatedAt,
          roles: state.roles,
        };
      },
    );

    return HarnessStatus.of({ get });
  });

/** Reads hook state below `homeDir`; tests point it at a temporary home. */
export const layerWithHome = (homeDir: string) => Layer.effect(HarnessStatus, make(homeDir));

export const layer = layerWithHome(NodeOS.homedir());
