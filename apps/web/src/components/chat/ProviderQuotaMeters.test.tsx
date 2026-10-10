import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { act, cloneElement, type ReactElement, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    values: new Map<string, unknown>(),
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
      useSyncExternalStore(state.subscribe, () =>
        state.values.has(atom.key) ? state.values.get(atom.key) : pending,
      ),
  };
});
vi.mock("../../connection/catalog", () => ({
  environmentCatalog: { stateAtom: (id: string) => ({ key: "connection:" + id }) },
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { configValueAtom: (id: string) => ({ key: "config:" + id }) },
}));
vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(render, undefined, children),
  PopoverPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { ProviderQuotaMeters } from "./ProviderQuotaMeters";

const env = "env-1" as EnvironmentId;
const env2 = "env-2" as EnvironmentId;
const NOW = Date.parse("2026-10-09T00:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();
const local = (ms: number) => new Date(ms).toLocaleString("ja-JP");

type Window = {
  id: string;
  kind: "session" | "weekly" | "monthly" | "other";
  label: string;
  usedPercent: number;
  resetsAt?: string;
};
const win = (
  id: string,
  kind: Window["kind"],
  usedPercent: number,
  resetsAt: number | null = NOW + 2 * HOUR,
  label = id,
): Window => ({
  id,
  kind,
  label,
  usedPercent,
  ...(resetsAt === null ? {} : { resetsAt: iso(resetsAt) }),
});

function provider(
  instanceId: string,
  driver: string,
  windows: Window[] | null,
  overrides: Record<string, unknown> = {},
): ServerProvider {
  const checkedAt = iso(NOW - HOUR);
  return {
    instanceId,
    driver,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", email: "secret@example.com" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    ...(windows === null
      ? {}
      : { usageLimits: { checkedAt, windows, credentialFingerprint: "fp-secret" } }),
    ...overrides,
  } as unknown as ServerProvider;
}
const codex = (windows: Window[] | null, overrides: Record<string, unknown> = {}) =>
  provider("codex", "codex", windows, overrides);
const claude = (windows: Window[] | null, overrides: Record<string, unknown> = {}) =>
  provider("claudeAgent", "claudeAgent", windows, overrides);

const connected = () => AsyncResult.success({ phase: "connected", generation: 1 });
const setConfig = (environment: string, ...providers: ServerProvider[]) =>
  state.values.set("config:" + environment, { providers });

const flatten = (node: unknown): string => {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(flatten).join("");
  return flatten((node as { children?: unknown }).children);
};

let renderer: ReactTestRenderer | undefined;
const text = () => flatten(renderer?.toJSON());
const trigger = () =>
  renderer!.root.find(
    (node) => node.type === "button" && node.props["aria-label"] === "Provider subscription quotas",
  );
const header = () => flatten(trigger().children);
const bars = () =>
  renderer!.root
    .findAll((node) => typeof node.type === "string" && node.props.role === "progressbar")
    .map((node) => [node.props["aria-label"], node.props["aria-valuenow"]]);
async function render(environmentId = env) {
  await act(() => {
    const element = <ProviderQuotaMeters environmentId={environmentId} />;
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
const advance = (ms: number) =>
  act(async () => {
    vi.advanceTimersByTime(ms);
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  state.values.clear();
  state.values.set("connection:" + env, connected());
  state.values.set("connection:" + env2, connected());
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
});

describe("ProviderQuotaMeters", () => {
  it("shows OpenAI and Anthropic side by side with remaining quota and reset countdown", async () => {
    setConfig(
      env,
      claude([win("w", "weekly", 40, NOW + 4 * DAY + 3 * HOUR + 20 * MINUTE)]),
      codex([win("w", "weekly", 42, NOW + 5 * DAY + 2 * HOUR)]),
    );
    await render();
    expect(trigger()).toBeDefined();
    expect(bars()).toEqual([
      ["OpenAI 週間の残り", 58],
      ["Anthropic 週間の残り", 60],
    ]);
    expect(header()).toContain("OpenAI");
    expect(header()).toContain("あと5日2時間");
    expect(header()).toContain("Anthropic");
    expect(header()).toContain("あと4日3時間");
    expect(text()).not.toContain("secret@example.com");
    expect(text()).not.toContain("fp-secret");
  });

  it("lists every reported window with exact reset time and check time in details", async () => {
    setConfig(
      env,
      codex([
        win("s", "session", 10, NOW + 2 * HOUR, "5時間"),
        win("w1", "weekly", 20, NOW + 5 * DAY, "全モデル"),
        win("w2", "weekly", 70, NOW + 1 * DAY, "Opus"),
        win("m", "monthly", 60, NOW + 20 * DAY, "30日"),
        win("o", "other", 5, NOW + 3 * DAY, "追加枠"),
      ]),
    );
    await render();
    expect(text()).toContain("最終取得 " + local(NOW - HOUR));
    expect(text()).toContain(
      "セッション · 5時間: 残り 90% · リセット " +
        local(NOW + 2 * HOUR) +
        "（リセットまであと2時間0分）",
    );
    expect(text()).toContain("週間 · 全モデル: 残り 80% · リセット " + local(NOW + 5 * DAY));
    expect(text()).toContain("週間 · Opus: 残り 30% · リセット " + local(NOW + DAY));
    expect(text()).toContain("月間 · 30日: 残り 40%");
    expect(text()).toContain("その他 · 追加枠: 残り 95%");
  });

  it("summarises the limiting window of the preferred kind with its own scope and countdown", async () => {
    setConfig(
      env,
      codex([
        win("w1", "weekly", 20, NOW + 5 * DAY, "全モデル"),
        win("w2", "weekly", 70, NOW + DAY, "Opus"),
        win("s", "session", 99, NOW + HOUR, "5時間"),
      ]),
    );
    await render();
    expect(bars()).toEqual([["OpenAI 週間の残り", 30]]);
    expect(header()).toContain("Opus");
    expect(header()).toContain("あと1日0時間");
    expect(header()).not.toContain("5日");
  });

  it("falls back from weekly to monthly to session without a monthly placeholder", async () => {
    setConfig(
      env,
      codex([win("w", "weekly", 25), win("s", "session", 10)]),
      claude([win("s", "session", 10)]),
    );
    await render();
    expect(bars()).toEqual([
      ["OpenAI 週間の残り", 75],
      ["Anthropic セッションの残り", 90],
    ]);
    expect(text()).not.toContain("月間");
  });

  it("shows both providers regardless of any thread selection and isolates environments", async () => {
    setConfig(env, codex([win("w", "weekly", 25)]), claude([win("w", "weekly", 90)]));
    setConfig(env2, codex([win("w", "weekly", 50)]));
    await render(env);
    expect(bars()).toEqual([
      ["OpenAI 週間の残り", 75],
      ["Anthropic 週間の残り", 10],
    ]);
    await render(env2);
    expect(bars()).toEqual([["OpenAI 週間の残り", 50]]);
    expect(text()).not.toContain("Anthropic");
  });

  it("keeps configured providers identifiable when data is missing, unsupported or failed", async () => {
    setConfig(
      env,
      codex(null),
      claude([win("w", "weekly", 25)], {
        usageLimits: { checkedAt: iso(NOW), windows: [], unavailable: { reason: "unsupported" } },
      }),
      provider("cursor", "cursor", null),
      provider("grok", "grok", [win("w", "weekly", 30)], {
        usageLimits: { checkedAt: iso(NOW), windows: [], unavailable: { reason: "probeFailed" } },
      }),
    );
    await render();
    expect(bars()).toEqual([]);
    expect(text()).toContain("OpenAI");
    expect(text()).toContain("契約枠のデータをまだ取得していない");
    expect(text()).toContain("Anthropic");
    expect(text()).toContain("このアカウントは契約枠の取得に未対応");
    expect(text()).toContain("grok");
    expect(text()).toContain("契約枠の取得に失敗");
    expect(text()).not.toContain("cursor");
  });

  it("marks a provider that is not installed as unavailable", async () => {
    setConfig(
      env,
      codex([win("w", "weekly", 25)], { installed: false }),
      claude(null, { enabled: false }),
    );
    await render();
    expect(bars()).toEqual([]);
    expect(header()).toContain("利用不可");
    expect(text()).not.toContain("Anthropic");
  });

  it("distinguishes duplicate accounts by configured name without exposing identity", async () => {
    setConfig(
      env,
      provider("codex_personal", "codex", [win("w", "weekly", 25)], { displayName: "個人" }),
      provider("codex_work", "codex", [win("w", "weekly", 60)]),
    );
    await render();
    expect(bars()).toEqual([
      ["OpenAI · 個人 週間の残り", 75],
      ["OpenAI · codex_work 週間の残り", 40],
    ]);
    expect(text()).toContain("個人 (codex_personal)");
    expect(text()).not.toContain("secret@example.com");
  });

  it("keeps one line per primary vendor in the header when a vendor has several accounts", async () => {
    setConfig(
      env,
      provider("codex_personal", "codex", [win("w", "weekly", 25)], { displayName: "個人" }),
      provider("codex_work", "codex", [win("w", "weekly", 60)], { displayName: "仕事" }),
      claude([win("w", "weekly", 90)]),
    );
    await render();
    expect(bars()).toEqual([
      ["OpenAI · 個人 週間の残り", 75],
      ["Anthropic 週間の残り", 10],
    ]);
    expect(header()).toContain("他 1 件");
    expect(header()).not.toContain("仕事");
    expect(text()).toContain("仕事 (codex_work)");
    expect(text()).toContain("週間 · w: 残り 40%");
  });

  it("handles empty, full and unknown-reset windows", async () => {
    setConfig(
      env,
      codex([win("w", "weekly", 100, null)]),
      claude([win("w", "weekly", 0, NOW + DAY)]),
    );
    await render();
    expect(bars()).toEqual([
      ["OpenAI 週間の残り", 0],
      ["Anthropic 週間の残り", 100],
    ]);
    expect(header()).toContain("リセット時刻不明");
    expect(text()).toContain("週間 · w: 残り 0% · リセット時刻不明");
    expect(vi.getTimerCount()).toBe(1);
  });

  it("counts down in days, hours and minutes and updates without a new snapshot", async () => {
    setConfig(env, codex([win("w", "weekly", 25, NOW + 90 * MINUTE)]));
    await render();
    expect(header()).toContain("あと1時間30分");
    await advance(MINUTE);
    expect(header()).toContain("あと1時間29分");
    await advance(60 * MINUTE);
    expect(header()).toContain("あと29分");
    await advance(28 * MINUTE + 10_000);
    expect(header()).toContain("あと1分未満");
    expect(vi.getTimerCount()).toBe(1);
  });

  it("replaces a window with 更新待ち exactly at its reset and stops the timer", async () => {
    setConfig(env, codex([win("w", "weekly", 25, NOW + 30_000)]));
    await render();
    expect(bars()).toEqual([["OpenAI 週間の残り", 75]]);
    await advance(30_000);
    expect(bars()).toEqual([]);
    expect(header()).toContain("週 更新待ち");
    expect(text()).toContain("週間 · w: 更新待ち · リセット " + local(NOW + 30_000));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves the summarised kind unknown when any of its windows expired but keeps other details", async () => {
    setConfig(
      env,
      codex([
        win("w1", "weekly", 20, NOW - HOUR, "全モデル"),
        win("w2", "weekly", 70, NOW + DAY, "Opus"),
        win("m", "monthly", 40, NOW + 10 * DAY),
      ]),
    );
    await render();
    expect(bars()).toEqual([]);
    expect(header()).toContain("週 更新待ち");
    expect(text()).toContain("週間 · 全モデル: 更新待ち");
    expect(text()).toContain("週間 · Opus: 残り 30%");
    expect(text()).toContain("月間 · m: 残り 60%");
    await publish("config:" + env, {
      providers: [
        codex([
          win("w1", "weekly", 20, NOW + DAY, "全モデル"),
          win("w2", "weekly", 70, NOW + DAY, "Opus"),
        ]),
      ],
    });
    expect(bars()).toEqual([["OpenAI 週間の残り", 30]]);
  });

  it("keeps ticking to the reset when the system clock moves backwards during the last timer", async () => {
    setConfig(env, codex([win("w", "weekly", 25, NOW + 30_000)]));
    await render();
    expect(header()).toContain("あと1分未満");
    vi.setSystemTime(NOW - MINUTE);
    await advance(30_000);
    expect(header()).toContain("あと1分");
    expect(header()).not.toContain("1分未満");
    expect(vi.getTimerCount()).toBe(1);
    await advance(MINUTE);
    expect(bars()).toEqual([]);
    expect(header()).toContain("週 更新待ち");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps one bounded timer for far resets and removes it on snapshot change and unmount", async () => {
    setConfig(env, codex([win("w", "weekly", 25, NOW + 60 * DAY)]));
    await render();
    expect(vi.getTimerCount()).toBe(1);
    await advance(3 * HOUR);
    expect(vi.getTimerCount()).toBe(1);
    expect(header()).toContain("あと59日21時間");
    await publish("config:" + env, { providers: [codex([win("w", "weekly", 25, null)])] });
    expect(vi.getTimerCount()).toBe(0);
    await publish("config:" + env, {
      providers: [codex([win("w", "weekly", 25, NOW + 90 * DAY)])],
    });
    expect(vi.getTimerCount()).toBe(1);
    act(() => renderer!.unmount());
    renderer = undefined;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops live values while disconnected, keeps provider names and restores them on reconnect", async () => {
    setConfig(env, codex([win("w", "weekly", 25)]), claude([win("w", "weekly", 90)]));
    await render();
    expect(bars()).toHaveLength(2);
    await publish("connection:" + env, AsyncResult.success({ phase: "backoff", generation: 1 }));
    expect(bars()).toEqual([]);
    expect(header()).toContain("OpenAI");
    expect(header()).toContain("Anthropic");
    expect(header()).toContain("未接続");
    expect(text()).toContain("環境に接続されていないため取得できない");
    expect(vi.getTimerCount()).toBe(0);
    // A failure keeps the last connected value as previousSuccess; it must not count.
    await publish(
      "connection:" + env,
      AsyncResult.failure(Cause.fail("lost"), {
        previousSuccess: Option.some(AsyncResult.success({ phase: "connected", generation: 1 })),
      }),
    );
    expect(bars()).toEqual([]);
    await publish("connection:" + env, connected());
    expect(bars()).toHaveLength(2);
  });

  it("shows a status line before any provider config arrives", async () => {
    await render();
    expect(header()).toContain("契約枠");
    expect(bars()).toEqual([]);
  });
});
