import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeURL from "node:url";

import { ProjectionThreadRepositoryLive } from "../persistence/Layers/ProjectionThreads.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as Threads from "../persistence/Services/ProjectionThreads.ts";
import * as Runtime from "../persistence/ProviderSessionRuntime.ts";
import * as HarnessStatus from "./HarnessStatus.ts";

const MODEL_A = "anthropic/claude-opus-5-5";
const MODEL_B = "anthropic/claude-sonnet-5-5";
const NATIVE = "native/session:with-path-like-characters";
const instance = ProviderInstanceId.make("codex");
const at = (minute: number) =>
  DateTime.formatIso(
    DateTime.add(DateTime.makeUnsafe("2026-10-01T00:00:00.000Z"), { minutes: minute }),
  );
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const hookState = (changes: Record<string, unknown> = {}) => ({
  version: 1,
  sessionId: NATIVE,
  model: MODEL_A,
  status: "on",
  reason: "orchestrator_model",
  evaluatedAt: at(1),
  cwd: "/work",
  roles: { orchestrator: MODEL_A, implementer: "impl-model", reviewer: "review-model" },
  ...changes,
});
let nextId = 0;
const makeFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const threads = yield* Threads.ProjectionThreadRepository;
  const runtimes = yield* Runtime.ProviderSessionRuntimeRepository;
  const sql = yield* SqlClient.SqlClient;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "harness-v1-" });
  const threadId = ThreadId.make(`harness-${++nextId}`);
  const harness = yield* HarnessStatus.HarnessStatus.pipe(
    Effect.provide(HarnessStatus.layerWithHome(home)),
  );
  const thread: Threads.ProjectionThread = {
    threadId,
    projectId: ProjectId.make("project"),
    title: "Harness",
    modelSelection: { instanceId: instance, model: MODEL_A },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurnId: null,
    createdAt: at(0),
    updatedAt: at(0),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    unsettledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    latestUserMessageAt: null,
    pendingApprovalCount: 0,
    pendingUserInputCount: 0,
    hasActionableProposedPlan: 0,
    deletedAt: null,
  };
  const runtime: Runtime.ProviderSessionRuntime = {
    threadId,
    providerName: "codex",
    providerInstanceId: instance,
    adapterKey: "codex",
    runtimeMode: "full-access",
    status: "running",
    lastSeenAt: at(0),
    resumeCursor: { threadId: NATIVE },
    runtimePayload: null,
  };
  const statePath = (session = NATIVE) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(session))
      .pipe(
        Effect.map((digest) =>
          path.join(home, ".agents/state", `harness-status-${Encoding.encodeHex(digest)}.json`),
        ),
      );
  const write = (state: unknown, session = NATIVE) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(path.join(home, ".agents/state"), { recursive: true });
      yield* fs.writeFileString(yield* statePath(session), encodeJson(state));
    });
  const setThread = (changes: Partial<Threads.ProjectionThread> = {}) =>
    threads.upsert({ ...thread, ...changes });
  const setRuntime = (changes: Partial<Runtime.ProviderSessionRuntime> = {}) =>
    runtimes.upsert({ ...runtime, ...changes });
  let sequence = 0;
  const event = (
    type: string,
    minute: number,
    payload: Record<string, unknown> = {},
    target = threadId,
  ) => sql`
    INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version, event_type,
      occurred_at, command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json)
    VALUES (${`${threadId}-${++sequence}`}, 'thread', ${target}, ${sequence}, ${type}, ${at(minute)},
      NULL, NULL, NULL, 'server', ${JSON.stringify(payload)}, '{}')
  `;
  yield* setThread();
  yield* setRuntime();
  yield* event("thread.created", 0);
  return {
    home,
    threadId,
    harness,
    fs,
    path,
    statePath,
    write,
    setThread,
    setRuntime,
    event,
    runtime,
    runtimes,
    sql,
  };
});
const testLayer = Layer.mergeAll(
  ProjectionThreadRepositoryLive,
  Runtime.layer,
  OrchestrationEventStoreLive,
).pipe(Layer.provideMerge(SqlitePersistenceMemory), Layer.provideMerge(NodeServices.layer));

it.layer(testLayer)("HarnessStatus V1", (it) => {
  it.effect("maps the hashed native cursor rather than the application thread ID", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture;
      yield* f.write(hookState());
      const status = yield* f.harness.get(f.threadId);
      assert.equal(status.status, "on");
      assert.equal(status.sessionId, NATIVE);
      assert.match(yield* f.statePath(), /harness-status-[a-f0-9]{64}\.json$/);
      yield* f.fs.remove(yield* f.statePath());
      yield* f.write(hookState({ sessionId: f.threadId }), f.threadId);
      assert.equal((yield* f.harness.get(f.threadId)).reason, "state_missing");
    }),
  );
  it.effect("accepts explicit OFF without inferring it from the selected model", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture;
      yield* f.write(hookState({ status: "off", reason: "child_role" }));
      assert.equal((yield* f.harness.get(f.threadId)).status, "off");
    }),
  );
  it.effect("handles missing/deleted threads and missing runtimes", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture;
      assert.equal((yield* f.harness.get(ThreadId.make("missing"))).reason, "thread_not_found");
      yield* f.setThread({ deletedAt: at(2) });
      assert.equal((yield* f.harness.get(f.threadId)).reason, "thread_not_found");
      yield* f.setThread();
      yield* f.runtimes.deleteByThreadId({ threadId: f.threadId });
      assert.equal((yield* f.harness.get(f.threadId)).reason, "no_provider_thread");
    }),
  );
  it.effect("resolves only the legacy default instance and rejects nondefault mismatches", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture;
      yield* f.write(hookState());
      yield* f.setRuntime({ providerInstanceId: null });
      assert.equal((yield* f.harness.get(f.threadId)).status, "on");
      yield* f.setThread({
        modelSelection: { instanceId: ProviderInstanceId.make("other"), model: MODEL_A },
      });
      assert.equal((yield* f.harness.get(f.threadId)).reason, "provider_thread_mismatch");
      yield* f.setRuntime({ providerInstanceId: ProviderInstanceId.make("other") });
      assert.equal((yield* f.harness.get(f.threadId)).status, "on");
      yield* f.setRuntime({ providerName: "claude-code" });
      assert.equal((yield* f.harness.get(f.threadId)).reason, "unsupported_provider");
    }),
  );
  it.effect("rejects a runtime row returned for a different application thread", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture;
      const harness = yield* HarnessStatus.HarnessStatus.pipe(
        Effect.provide(HarnessStatus.layerWithHome(f.home)),
        Effect.provideService(Runtime.ProviderSessionRuntimeRepository, {
          ...f.runtimes,
          getByThreadId: () =>
            Effect.succeed(Option.some({ ...f.runtime, threadId: ThreadId.make("wrong-thread") })),
        }),
      );
      assert.equal((yield* harness.get(f.threadId)).reason, "provider_thread_mismatch");
    }),
  );
  for (const cursor of [null, {}, { threadId: "" }, { threadId: " " }, { threadId: 3 }]) {
    it.effect(`rejects invalid native cursor ${JSON.stringify(cursor)}`, () =>
      Effect.gen(function* () {
        const f = yield* makeFixture;
        yield* f.setRuntime({ resumeCursor: cursor });
        assert.equal((yield* f.harness.get(f.threadId)).reason, "no_native_session");
      }),
    );
  }
  it.effect("validates state schema, JSON, exact model and exact session", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture;
      assert.equal((yield* f.harness.get(f.threadId)).reason, "state_missing");
      for (const state of [{}, hookState({ evaluatedAt: "invalid" }), hookState({ version: 2 })]) {
        yield* f.write(state);
        assert.equal((yield* f.harness.get(f.threadId)).reason, "state_invalid");
      }
      yield* f.fs.writeFileString(yield* f.statePath(), "{");
      assert.equal((yield* f.harness.get(f.threadId)).reason, "state_invalid");
      yield* f.write(hookState({ model: MODEL_B }));
      assert.equal((yield* f.harness.get(f.threadId)).reason, "state_model_mismatch");
      yield* f.write(hookState({ sessionId: "other-session" }));
      assert.equal((yield* f.harness.get(f.threadId)).reason, "state_session_mismatch");
      yield* f.setRuntime({ resumeCursor: { threadId: "different-native" } });
      assert.equal((yield* f.harness.get(f.threadId)).reason, "state_missing");
    }),
  );
  it.effect("surfaces filesystem errors as typed errors instead of OFF", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture;
      yield* f.fs.makeDirectory(yield* f.statePath(), { recursive: true });
      const result = yield* Effect.result(f.harness.get(f.threadId));
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.equal(result.failure._tag, "HarnessStatusReadError");
    }),
  );
  it.effect("persists A-B-A freshness while title and lifecycle changes do not invalidate", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture;
      yield* f.write(hookState());
      yield* f.event("thread.meta-updated", 2, { title: "new title" });
      yield* f.event("thread.session-set", 3);
      yield* f.setThread({ title: "new title", updatedAt: at(3) });
      assert.equal((yield* f.harness.get(f.threadId)).status, "on");
      yield* f.event("thread.meta-updated", 4, {
        modelSelection: { instanceId: instance, model: MODEL_B },
      });
      yield* f.event("thread.meta-updated", 5, {
        modelSelection: { instanceId: instance, model: MODEL_A },
      });
      assert.equal((yield* f.harness.get(f.threadId)).reason, "awaiting_hook_after_model_change");
      yield* f.write(hookState({ evaluatedAt: at(5) }));
      assert.equal((yield* f.harness.get(f.threadId)).status, "on");
      yield* f.event(
        "thread.meta-updated",
        8,
        { modelSelection: {} },
        ThreadId.make("other-thread"),
      );
      assert.equal((yield* f.harness.get(f.threadId)).status, "on");
    }),
  );
  it.effect(
    "requires fresh evidence after every requested turn even if it failed or completed",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture;
        yield* f.write(hookState());
        yield* f.event("thread.turn-start-requested", 2);
        yield* f.event("thread.turn-completed", 3);
        assert.equal((yield* f.harness.get(f.threadId)).reason, "awaiting_hook_after_run_start");
        yield* f.setRuntime({ lastSeenAt: at(8) });
        yield* f.write(hookState({ evaluatedAt: at(2) }));
        assert.equal((yield* f.harness.get(f.threadId)).status, "on");
        yield* f.event("thread.turn-start-requested", 9);
        assert.equal((yield* f.harness.get(f.threadId)).reason, "awaiting_hook_after_run_start");
      }),
  );
  it.effect(
    "consumes the real Python hook in a disposable home and invalidates a model change",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture;
        yield* f.fs.makeDirectory(f.path.join(f.home, ".agents"), { recursive: true });
        yield* f.fs.makeDirectory(f.path.join(f.home, ".codex/agents"), { recursive: true });
        yield* f.fs.makeDirectory(f.path.join(f.home, "work"));
        for (const [name, value] of [
          [".agents/harness-orchestrators.txt", "claude-opus-5-5\n"],
          [".agents/harness-agent.md", "# Harness\n"],
          [".codex/agents/implementer.toml", 'model = "impl-model"\n'],
          [".codex/agents/reviewer.toml", 'model = "review-model"\n'],
        ]) {
          yield* f.fs.writeFileString(f.path.join(f.home, name!), value!);
        }
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const platform = yield* HostProcessPlatform;
        const run = (model: string) =>
          spawner.exitCode(
            ChildProcess.make(
              platform === "win32" ? "python" : "python3",
              [
                NodeURL.fileURLToPath(
                  new URL("../../../../scripts/harness/harness_gate.py", import.meta.url),
                ),
              ],
              {
                cwd: f.home,
                env: { HOME: f.home, USERPROFILE: f.home, HARNESS_ROLE: "" },
                extendEnv: true,
                stdin: Stream.make(
                  new TextEncoder().encode(
                    JSON.stringify({
                      hook_event_name: "UserPromptSubmit",
                      session_id: NATIVE,
                      model,
                      cwd: f.path.join(f.home, "work"),
                    }),
                  ),
                ),
                stdout: "ignore",
                stderr: "ignore",
              },
            ),
          );
        assert.equal(yield* run(MODEL_A), 0);
        const result = yield* f.harness.get(f.threadId);
        assert.equal(result.status, "on");
        assert.equal(result.roles.implementer, "impl-model");
        yield* f.setThread({ modelSelection: { instanceId: instance, model: MODEL_B } });
        assert.equal((yield* f.harness.get(f.threadId)).reason, "state_model_mismatch");
        assert.equal(yield* run(MODEL_B), 0);
        assert.equal((yield* f.harness.get(f.threadId)).status, "off");
      }),
  );
});
