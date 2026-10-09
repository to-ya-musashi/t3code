import { it } from "@effect/vitest";
import { type HarnessStatusResult, EnvironmentId, ThreadId, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { afterEach, beforeEach, describe, expect, vi } from "vite-plus/test";

import * as EnvironmentRegistry from "../connection/registry.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { createOrchestrationEnvironmentAtoms } from "./orchestration.ts";

const environmentId = EnvironmentId.make("environment-1");
const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");

const statusFor = (threadId: ThreadId, call: number): HarnessStatusResult => ({
  threadId,
  status: "on",
  reason: `call-${call}`,
  sessionId: "session",
  model: "gpt-5.5",
  evaluatedAt: null,
  roles: { orchestrator: null, implementer: null, reviewer: null },
});

/** A real query atom over a supervisor whose connection phase the test controls. */
const makeHarness = (phase: SupervisorConnectionState["phase"]) =>
  Effect.gen(function* () {
    const calls: ThreadId[] = [];
    const wireInputs: unknown[] = [];
    const client = {
      [WS_METHODS.serverGetHarnessStatus]: (input: { readonly threadId: ThreadId }) => {
        wireInputs.push(input);
        calls.push(input.threadId);
        return Effect.succeed(statusFor(input.threadId, calls.length));
      },
    } as unknown as WsRpcProtocolClient;
    const state = yield* SubscriptionRef.make<SupervisorConnectionState>({
      ...AVAILABLE_CONNECTION_STATE,
      phase,
    });
    const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
      target: new PrimaryConnectionTarget({
        environmentId,
        label: "environment",
        httpBaseUrl: "https://environment.test",
        wsBaseUrl: "wss://environment.test",
      }),
      state,
      session: yield* SubscriptionRef.make(Option.some({ client } as RpcSession)),
      prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Effect.void,
    });
    const environments = EnvironmentRegistry.EnvironmentRegistry.of({
      run: (_id, effect) =>
        Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      followStream: (_id, stream) =>
        Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
    const registry = AtomRegistry.make();
    yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
    const atoms = createOrchestrationEnvironmentAtoms(
      Atom.runtime(Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environments)),
    );
    return {
      calls,
      wireInputs,
      registry,
      query: (threadId: ThreadId, observerKey = "observer-1") =>
        atoms.harnessStatus({ environmentId, input: { threadId, observerKey } }),
      setPhase: (next: SupervisorConnectionState["phase"]) =>
        SubscriptionRef.update(state, (current) => ({ ...current, phase: next })),
    };
  });

const settle = (milliseconds = 0) =>
  Effect.promise(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
  });

describe("harnessStatus query atom", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.effect("is one atom per environment, thread and observer", () =>
    Effect.gen(function* () {
      const { query } = yield* makeHarness("connected");
      expect(query(threadA)).toBe(query(threadA));
      expect(query(threadA)).not.toBe(query(threadB));
      expect(query(threadA, "observer-2")).not.toBe(query(threadA, "observer-1"));
    }).pipe(Effect.scoped),
  );

  it.effect("keeps the observer key off the wire and asks once per observer", () =>
    Effect.gen(function* () {
      const { calls, wireInputs, registry, query } = yield* makeHarness("connected");
      registry.mount(query(threadA, "observer-1"));
      registry.mount(query(threadA, "observer-2"));
      yield* settle();
      expect(calls).toEqual([threadA, threadA]);
      expect(wireInputs).toStrictEqual([{ threadId: threadA }, { threadId: threadA }]);
    }).pipe(Effect.scoped),
  );

  it.effect("requests on mount and again every two seconds, and stops once unmounted", () =>
    Effect.gen(function* () {
      const { calls, registry, query } = yield* makeHarness("connected");
      const unmount = registry.mount(query(threadA));
      yield* settle();
      expect(calls).toEqual([threadA]);
      expect(registry.get(query(threadA))._tag).toBe("Success");

      yield* settle(2_000);
      expect(calls).toHaveLength(2);
      yield* settle(2_000);
      expect(calls).toHaveLength(3);

      unmount();
      yield* settle(10_000);
      expect(calls).toHaveLength(3);
    }).pipe(Effect.scoped),
  );

  it.effect("does not request while the connection is down and requests once it is up", () =>
    Effect.gen(function* () {
      const { calls, registry, query, setPhase } = yield* makeHarness("backoff");
      registry.mount(query(threadA));
      yield* settle(6_000);
      expect(calls).toEqual([]);
      expect(registry.get(query(threadA))._tag).not.toBe("Success");

      yield* setPhase("connected");
      yield* settle();
      expect(calls).toEqual([threadA]);
    }).pipe(Effect.scoped),
  );

  it.effect("does not serve a cached answer to a remounted badge", () =>
    Effect.gen(function* () {
      const { calls, registry, query } = yield* makeHarness("connected");
      const unmount = registry.mount(query(threadA));
      yield* settle();
      expect(calls).toHaveLength(1);
      unmount();
      yield* settle();

      registry.mount(query(threadA));
      yield* settle();
      expect(calls).toHaveLength(2);
      const result = registry.get(query(threadA));
      expect(AsyncResult.isSuccess(result) ? result.value.reason : null).toBe("call-2");
    }).pipe(Effect.scoped),
  );
});
