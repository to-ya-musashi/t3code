import type { EnvironmentId, HarnessStatusResult, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    values: new Map<string, unknown>(),
    /** Every query atom the badge asked for, in order: one per mounted poller. */
    queried: [] as { readonly key: string; readonly threadId: string }[],
    shell: { model: "gpt-5.5", instance: "codex", providerThread: "pt-1" },
    listeners,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: () => {
      for (const listener of listeners) listener();
    },
  };
});

// A tiny external store so state changes re-render memoized components like real atoms do.
vi.mock("@effect/atom-react", async () => {
  const { useSyncExternalStore } = await import("react");
  const { AsyncResult: Result } = await import("effect/unstable/reactivity");
  const pending = Result.initial(true);
  return {
    useAtomValue: (atom: { readonly key: string }) =>
      useSyncExternalStore(state.subscribe, () => state.values.get(atom.key) ?? pending),
  };
});
vi.mock("../../connection/catalog", () => ({
  environmentCatalog: { stateAtom: (id: string) => ({ key: `connection:${id}` }) },
}));
vi.mock("../../state/orchestration", () => ({
  orchestrationEnvironment: {
    harnessStatus: (target: {
      environmentId: string;
      input: { threadId: string; observerKey: string };
    }) => {
      const key = `harness:${target.environmentId}:${target.input.threadId}:${target.input.observerKey}`;
      if (!state.queried.some((entry) => entry.key === key)) {
        state.queried.push({ key, threadId: target.input.threadId });
      }
      return { key };
    },
  },
}));
vi.mock("../../state/entities", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useThreadShell: (ref: { threadId: string } | null) => {
      const shell = useSyncExternalStore(state.subscribe, () => state.shell);
      return ref === null
        ? null
        : {
            modelSelection: { model: shell.model, instanceId: shell.instance },
            session: {
              providerName: "codex",
              providerInstanceId: shell.instance,
              updatedAt: shell.providerThread,
            },
          };
    },
  };
});
vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <button>{children}</button>,
  PopoverPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { HarnessStatusBadge } from "./HarnessStatusBadge";

const env = "env-1" as EnvironmentId;
const threadA = "thread-a" as ThreadId;
const threadB = "thread-b" as ThreadId;
const connected = (generation: number) => AsyncResult.success({ phase: "connected", generation });
const backoff = () => AsyncResult.success({ phase: "backoff", generation: 1 });

function status(overrides: Partial<HarnessStatusResult> = {}): HarnessStatusResult {
  return {
    threadId: threadA,
    status: "on",
    reason: "orchestrator_model",
    sessionId: "s1",
    model: "gpt-5.5",
    evaluatedAt: "2026-10-09T01:00:00.000Z" as HarnessStatusResult["evaluatedAt"],
    roles: { orchestrator: "gpt-5.5", implementer: "luna", reviewer: "sol" },
    ...overrides,
  };
}

const flatten = (node: unknown): string => {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(flatten).join(" ");
  return flatten((node as { children?: unknown }).children);
};

let renderer: ReactTestRenderer | undefined;
const rendered = () => flatten(renderer?.toJSON());
async function render(thread: ThreadId = threadA, isServerThread = true) {
  await act(() => {
    const element = (
      <HarnessStatusBadge environmentId={env} threadId={thread} isServerThread={isServerThread} />
    );
    if (renderer) renderer.update(element);
    else renderer = create(element);
  });
}
async function publish(key: string, value: unknown) {
  await act(() => {
    state.values.set(key, value);
    state.emit();
  });
}
const latestKey = (thread: ThreadId) =>
  state.queried.findLast((entry) => entry.threadId === thread)!.key;
/** The newest mounted poller of the thread receives the server's answer. */
const respond = (thread: ThreadId, value: HarnessStatusResult) =>
  publish(latestKey(thread), AsyncResult.success(value));
async function changeShell(change: Partial<typeof state.shell>) {
  await act(() => {
    state.shell = { ...state.shell, ...change };
    state.emit();
  });
}

beforeEach(() => {
  state.values.clear();
  state.queried.length = 0;
  state.shell = { model: "gpt-5.5", instance: "codex", providerThread: "pt-1" };
  state.values.set(`connection:${env}`, connected(1));
});
afterEach(() => {
  renderer?.unmount();
  renderer = undefined;
});

describe("HarnessStatusBadge", () => {
  it("shows ON with role details and a Japanese reason", async () => {
    await render();
    await respond(threadA, status());
    const text = rendered();
    expect(text).toContain("Harness ON · 統括");
    expect(text).toContain("統括モデルのためハーネスが有効");
    expect(text).toContain("luna");
    expect(text).toContain("sol");
    expect(text).toContain("子エージェントの稼働状態は未確認");
  });

  it("shows OFF with unassigned roles as 未確認, and unknown before any response", async () => {
    await render();
    expect(rendered()).toContain("Harness 未確認");
    await respond(
      threadA,
      status({
        status: "off",
        reason: "non_orchestrator_model",
        roles: { orchestrator: null, implementer: null, reviewer: null },
      }),
    );
    expect(rendered()).toContain("Harness OFF");
    expect(rendered()).toContain("実装担当 未確認");
  });

  it("replaces a cached ON with unknown when the next request fails", async () => {
    await render();
    await respond(threadA, status());
    expect(rendered()).toContain("Harness ON");
    await publish(
      latestKey(threadA),
      AsyncResult.failure(Cause.fail("boom"), {
        previousSuccess: Option.some(AsyncResult.success(status())),
      }),
    );
    expect(rendered()).toContain("Harness 未確認");
    expect(rendered()).not.toContain("Harness ON");
  });

  it("does not trust a connected snapshot kept by a failed connection state", async () => {
    await render();
    await respond(threadA, status());
    expect(rendered()).toContain("Harness ON");
    await publish(
      `connection:${env}`,
      AsyncResult.failure(Cause.fail("lost"), { previousSuccess: Option.some(connected(1)) }),
    );
    expect(rendered()).toContain("Harness 未確認");
    expect(rendered()).not.toContain("Harness ON");
  });

  it("does not query for a draft", async () => {
    await render(threadA, false);
    expect(rendered()).toContain("Harness 未確認");
    expect(state.queried).toEqual([]);
  });

  it("asks through a new query atom after A to B to A, so A's earlier answer is not reused", async () => {
    await render(threadA);
    await respond(threadA, status());
    expect(rendered()).toContain("Harness ON");
    await render(threadB);
    expect(rendered()).toContain("Harness 未確認");
    await render(threadA);
    expect(rendered()).toContain("Harness 未確認");
    expect(new Set(state.queried.map((entry) => entry.key)).size).toBe(3);
    await respond(threadA, status());
    expect(rendered()).toContain("Harness ON");
  });

  it("rejects a response for another thread", async () => {
    await render();
    await respond(threadA, status({ threadId: threadB }));
    expect(rendered()).toContain("Harness 未確認");
  });

  it("asks again after the model is switched away and back", async () => {
    await render();
    await respond(threadA, status());
    await changeShell({ model: "other-model" });
    expect(rendered()).toContain("Harness 未確認");
    await changeShell({ model: "gpt-5.5" });
    expect(rendered()).toContain("Harness 未確認");
    expect(state.queried).toHaveLength(3);
    await respond(threadA, status());
    expect(rendered()).toContain("Harness ON");
  });

  it("asks again after a provider switch that keeps the same model", async () => {
    await render();
    await respond(threadA, status());
    await changeShell({ instance: "codex-other", providerThread: "pt-2" });
    expect(rendered()).toContain("Harness 未確認");
    await changeShell({ instance: "codex", providerThread: "pt-1" });
    expect(rendered()).toContain("Harness 未確認");
    await changeShell({ providerThread: "pt-3" });
    expect(rendered()).toContain("Harness 未確認");
    expect(state.queried).toHaveLength(4);
    await respond(threadA, status());
    expect(rendered()).toContain("Harness ON");
  });

  it("shows unknown when disconnected and asks again after reconnect", async () => {
    await render();
    await respond(threadA, status());
    await publish(`connection:${env}`, backoff());
    expect(rendered()).toContain("Harness 未確認");
    await publish(`connection:${env}`, connected(2));
    expect(rendered()).toContain("Harness 未確認");
    expect(state.queried).toHaveLength(2);
    await respond(threadA, status());
    expect(rendered()).toContain("Harness ON");
  });
});
