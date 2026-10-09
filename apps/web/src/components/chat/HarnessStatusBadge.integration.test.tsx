import { RegistryContext } from "@effect/atom-react";
import { it } from "@effect/vitest";
import { createOrchestrationEnvironmentAtoms } from "@t3tools/client-runtime/state/orchestration";
import type { EnvironmentId, HarnessStatusResult, ThreadId } from "@t3tools/contracts";
import { EnvironmentId as makeEnvironmentId, ThreadId as makeThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, vi } from "vite-plus/test";

import {
  AVAILABLE_CONNECTION_STATE,
  EnvironmentRegistry,
  EnvironmentSupervisor,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import type { RpcSession, WsRpcProtocolClient } from "@t3tools/client-runtime/rpc";

// The badge, the query atoms and the atom registry are the real ones. Only the
// supervisor's client (every RPC waits on its own promise), the connection and
// thread-shell atoms, and the popover chrome are replaced.
const fixture = vi.hoisted(() => ({
  atoms: null as null | { harnessStatus: (target: unknown) => unknown },
  connectionAtom: null as unknown,
  shellAtom: null as unknown,
}));

vi.mock("../../connection/catalog", async () => {
  const { Atom: MockAtom, AsyncResult: MockResult } = await import("effect/unstable/reactivity");
  fixture.connectionAtom = MockAtom.make(MockResult.success({ phase: "connected", generation: 1 }));
  return { environmentCatalog: { stateAtom: () => fixture.connectionAtom } };
});
vi.mock("../../state/entities", async () => {
  const { Atom: MockAtom } = await import("effect/unstable/reactivity");
  const { useAtomValue } = await import("@effect/atom-react");
  fixture.shellAtom = MockAtom.make({
    modelSelection: { model: "gpt-5.5", instanceId: "codex" },
    session: { providerName: "codex", providerInstanceId: "codex", updatedAt: "provider-thread-1" },
  });
  return {
    useThreadShell: (ref: unknown) => {
      const shell = useAtomValue(fixture.shellAtom as Atom.Atom<unknown>);
      return ref === null ? null : shell;
    },
  };
});
vi.mock("../../state/orchestration", () => ({
  orchestrationEnvironment: {
    harnessStatus: (target: unknown) => fixture.atoms!.harnessStatus(target),
  },
}));
vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <button>{children}</button>,
  PopoverPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { HarnessStatusBadge } from "./HarnessStatusBadge";

const environmentId: EnvironmentId = makeEnvironmentId.make("environment-1");
const threadA: ThreadId = makeThreadId.make("thread-a");
const threadB: ThreadId = makeThreadId.make("thread-b");
const MODEL_A = "gpt-5.5";
const MODEL_B = "other-model";

const connectionState = (phase: string, generation: number) =>
  AsyncResult.success({ phase, generation });
const shellState = (
  model: string,
  instance: string,
  providerThread: string,
  turnId: string | null = null,
) => ({
  modelSelection: { model, instanceId: instance },
  session: { providerName: "codex", providerInstanceId: instance, updatedAt: providerThread },
  latestTurn: turnId === null ? null : { turnId },
});

const statusFor = (threadId: ThreadId, model: string): HarnessStatusResult => ({
  threadId,
  status: "on",
  reason: "orchestrator_model",
  sessionId: "session",
  model,
  evaluatedAt: null,
  roles: { orchestrator: model, implementer: null, reviewer: null },
});

interface PendingRequest {
  readonly input: unknown;
  readonly resolve: (value: HarnessStatusResult) => void;
}

/** Real query atoms over a supervisor whose RPC replies are released one request at a time. */
const makeFixture = Effect.gen(function* () {
  const pending: PendingRequest[] = [];
  const client = {
    "server.getHarnessStatus": (input: unknown) =>
      Effect.promise(
        () =>
          new Promise<HarnessStatusResult>((resolve) => {
            pending.push({ input, resolve });
          }),
      ),
  } as unknown as WsRpcProtocolClient;
  const state = yield* SubscriptionRef.make<SupervisorConnectionState>({
    ...AVAILABLE_CONNECTION_STATE,
    phase: "connected",
  });
  const supervisor = EnvironmentSupervisor.of({
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
  const environments = EnvironmentRegistry.of({
    run: (_id, effect) => Effect.provideService(effect, EnvironmentSupervisor, supervisor),
    followStream: (_id, stream) => Stream.provideService(stream, EnvironmentSupervisor, supervisor),
  } as EnvironmentRegistry["Service"]);
  const registry = AtomRegistry.make();
  fixture.atoms = createOrchestrationEnvironmentAtoms(
    Atom.runtime(Layer.succeed(EnvironmentRegistry, environments)),
  ) as unknown as NonNullable<typeof fixture.atoms>;
  let renderer: ReactTestRenderer | undefined;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      renderer?.unmount();
      registry.dispose();
    }),
  );

  /** Runs the change inside act and lets queued effects and promises settle. */
  const step = (change: () => void = () => {}) =>
    Effect.promise(() =>
      act(async () => {
        change();
        await vi.advanceTimersByTimeAsync(0);
        for (let index = 0; index < 30; index += 1) await Promise.resolve();
      }),
    );
  const render = (thread: ThreadId) =>
    step(() => {
      const element = (
        <RegistryContext.Provider value={registry}>
          <HarnessStatusBadge environmentId={environmentId} threadId={thread} isServerThread />
        </RegistryContext.Provider>
      );
      if (renderer) renderer.update(element);
      else renderer = create(element);
    });
  const text = () => {
    const flatten = (node: unknown): string => {
      if (node === null || node === undefined) return "";
      if (typeof node === "string") return node;
      if (Array.isArray(node)) return node.map(flatten).join(" ");
      return flatten((node as { children?: unknown }).children);
    };
    return flatten(renderer?.toJSON());
  };
  return {
    pending,
    text,
    render,
    step,
    setShell: (next: ReturnType<typeof shellState>) =>
      step(() => registry.set(fixture.shellAtom as Atom.Writable<unknown, unknown>, next)),
    setConnection: (phase: SupervisorConnectionState["phase"], generation: number) =>
      Effect.gen(function* () {
        yield* SubscriptionRef.update(state, (current) => ({ ...current, phase, generation }));
        yield* step(() =>
          registry.set(
            fixture.connectionAtom as Atom.Writable<unknown, unknown>,
            connectionState(phase, generation),
          ),
        );
      }),
    release: (index: number, value: HarnessStatusResult) =>
      step(() => pending[index]!.resolve(value)),
  };
});

describe("HarnessStatusBadge with the real query atom", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  for (const changed of [
    shellState(MODEL_A, "codex", "session-updated"),
    shellState(MODEL_A, "codex", "provider-thread-1", "new-turn"),
    {
      ...shellState(MODEL_A, "codex", "provider-thread-1"),
      session: {
        providerName: "other",
        providerInstanceId: "codex",
        updatedAt: "provider-thread-1",
      },
    },
    {
      ...shellState(MODEL_A, "codex", "provider-thread-1"),
      session: {
        providerName: "codex",
        providerInstanceId: "other",
        updatedAt: "provider-thread-1",
      },
    },
  ]) {
    it.effect(
      `requires a new reply after session/turn identity changes ${JSON.stringify(changed)}`,
      () =>
        Effect.gen(function* () {
          const harness = yield* makeFixture;
          yield* harness.render(threadA);
          yield* harness.setShell(changed);
          expect(harness.pending).toHaveLength(2);
          yield* harness.release(0, statusFor(threadA, MODEL_A));
          expect(harness.text()).not.toContain("Harness ON");
          yield* harness.release(1, statusFor(threadA, MODEL_A));
          expect(harness.text()).toContain("Harness ON");
        }).pipe(Effect.scoped),
    );
  }

  it.effect("ignores the old reply after a provider switch that keeps the same model", () =>
    Effect.gen(function* () {
      const harness = yield* makeFixture;
      yield* harness.render(threadA);
      expect(harness.pending).toHaveLength(1);
      expect(harness.text()).toContain("Harness 未確認");

      // Same model, different provider instance and provider thread; the old RPC is still in flight.
      yield* harness.setShell(shellState(MODEL_A, "codex-other", "provider-thread-2"));
      expect(harness.pending).toHaveLength(2);

      yield* harness.release(0, statusFor(threadA, MODEL_A));
      expect(harness.text()).toContain("Harness 未確認");
      expect(harness.text()).not.toContain("Harness ON");

      yield* harness.release(1, statusFor(threadA, MODEL_A));
      expect(harness.text()).toContain("Harness ON · 統括");
    }).pipe(Effect.scoped),
  );

  it.effect("ignores replies of earlier observers across model A to B to A", () =>
    Effect.gen(function* () {
      const harness = yield* makeFixture;
      yield* harness.render(threadA);
      yield* harness.setShell(shellState(MODEL_B, "codex", "provider-thread-1"));
      yield* harness.setShell(shellState(MODEL_A, "codex", "provider-thread-1"));
      expect(harness.pending).toHaveLength(3);

      yield* harness.release(1, statusFor(threadA, MODEL_B));
      expect(harness.text()).toContain("Harness 未確認");
      yield* harness.release(0, statusFor(threadA, MODEL_A));
      expect(harness.text()).toContain("Harness 未確認");
      expect(harness.text()).not.toContain("Harness ON");

      yield* harness.release(2, statusFor(threadA, MODEL_A));
      expect(harness.text()).toContain("Harness ON · 統括");
    }).pipe(Effect.scoped),
  );

  it.effect("ignores replies of earlier observers across thread A to B to A", () =>
    Effect.gen(function* () {
      const harness = yield* makeFixture;
      yield* harness.render(threadA);
      yield* harness.render(threadB);
      yield* harness.render(threadA);
      expect(harness.pending).toHaveLength(3);

      yield* harness.release(0, statusFor(threadA, MODEL_A));
      yield* harness.release(1, statusFor(threadB, MODEL_A));
      expect(harness.text()).toContain("Harness 未確認");
      expect(harness.text()).not.toContain("Harness ON");

      yield* harness.release(2, statusFor(threadA, MODEL_A));
      expect(harness.text()).toContain("Harness ON · 統括");
    }).pipe(Effect.scoped),
  );

  it.effect("ignores a reply issued before a disconnect and reconnect", () =>
    Effect.gen(function* () {
      const harness = yield* makeFixture;
      yield* harness.render(threadA);
      expect(harness.pending).toHaveLength(1);

      yield* harness.setConnection("backoff", 1);
      expect(harness.text()).toContain("Harness 未確認");
      yield* harness.setConnection("connected", 2);
      expect(harness.pending).toHaveLength(2);

      yield* harness.release(0, statusFor(threadA, MODEL_A));
      expect(harness.text()).toContain("Harness 未確認");
      expect(harness.text()).not.toContain("Harness ON");

      yield* harness.release(1, statusFor(threadA, MODEL_A));
      expect(harness.text()).toContain("Harness ON · 統括");
    }).pipe(Effect.scoped),
  );

  it.effect("sends only the thread id on the wire", () =>
    Effect.gen(function* () {
      const harness = yield* makeFixture;
      yield* harness.render(threadA);
      yield* harness.setShell(shellState(MODEL_B, "codex", "provider-thread-1"));
      expect(harness.pending.map((request) => request.input)).toStrictEqual([
        { threadId: threadA },
        { threadId: threadA },
      ]);
    }).pipe(Effect.scoped),
  );
});
