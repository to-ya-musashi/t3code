import { useAtomValue } from "@effect/atom-react";
import {
  isProviderAvailable,
  type EnvironmentId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { remainingPercent } from "@t3tools/shared/usageLimits";
import { memo, useEffect, useState } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { serverEnvironment } from "../../state/server";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

/** The header summarises the first kind a provider reports, in this order. */
const KINDS = [
  { kind: "weekly", short: "週", name: "週間" },
  { kind: "monthly", short: "月", name: "月間" },
  { kind: "session", short: "セッション", name: "セッション" },
  { kind: "other", short: "他", name: "その他" },
] as const;

const VENDORS = new Map<string, string>([
  ["codex", "OpenAI"],
  ["claudeAgent", "Anthropic"],
]);
const PRIMARY_DRIVERS = [...VENDORS.keys()];

const MAX_HEADER_ROWS = 2;
// Countdowns are minute-granular, so a render every minute keeps them current. The cap
// also keeps every delay far below the 2^31 ms limit of setTimeout.
const REFRESH_INTERVAL_MS = 60_000;

type UnavailableState = "disconnected" | "unavailable" | "no_data" | "unsupported" | "probeFailed";

const STATE_TEXT: Readonly<Record<UnavailableState, { short: string; detail: string }>> = {
  disconnected: { short: "未接続", detail: "環境に接続されていないため取得できない" },
  unavailable: { short: "利用不可", detail: "プロバイダーが未インストールまたは利用できない" },
  no_data: { short: "未取得", detail: "契約枠のデータをまだ取得していない" },
  unsupported: { short: "未対応", detail: "このアカウントは契約枠の取得に未対応" },
  probeFailed: { short: "取得失敗", detail: "契約枠の取得に失敗" },
};

interface WindowView {
  readonly window: ServerProviderUsageWindow;
  readonly remaining: number;
  readonly resetMs: number | null;
  readonly expired: boolean;
}

interface HeaderSummary {
  readonly kind: (typeof KINDS)[number];
  /** The window with the least remaining; null when any window of the kind is awaiting a refresh. */
  readonly limiting: WindowView | null;
  /** Names the limiting window when the kind reports several. */
  readonly scope: string | null;
}

type ProviderQuota =
  | { readonly state: UnavailableState }
  | {
      readonly state: "ready";
      readonly checkedAt: string;
      readonly windows: ReadonlyArray<WindowView>;
      readonly summary: HeaderSummary;
    };

interface ProviderRow {
  readonly provider: ServerProvider;
  readonly label: string;
  readonly quota: ProviderQuota;
}

function quotaOf(provider: ServerProvider, connected: boolean, now: number): ProviderQuota {
  if (!connected) return { state: "disconnected" };
  if (!provider.installed || !isProviderAvailable(provider)) return { state: "unavailable" };
  const limits = provider.usageLimits;
  if (limits === undefined) return { state: "no_data" };
  if (limits.unavailable !== undefined) return { state: limits.unavailable.reason };
  if (limits.windows.length === 0) return { state: "no_data" };
  const windows = limits.windows
    .map((window): WindowView => {
      const resetMs = window.resetsAt === undefined ? null : Date.parse(window.resetsAt);
      return {
        window,
        remaining: remainingPercent(window),
        resetMs,
        expired: resetMs !== null && resetMs <= now,
      };
    })
    .toSorted(
      (a, b) =>
        KINDS.findIndex((kind) => kind.kind === a.window.kind) -
        KINDS.findIndex((kind) => kind.kind === b.window.kind),
    );
  // A window past its reset may have been the limiting one, so any expired window in the
  // summarised kind leaves the header unknown until the server publishes a new snapshot.
  const kind = KINDS.find((candidate) => windows.some((w) => w.window.kind === candidate.kind))!;
  const ofKind = windows.filter((w) => w.window.kind === kind.kind);
  const limiting = ofKind.some((w) => w.expired)
    ? null
    : ofKind.reduce((least, w) => (w.remaining < least.remaining ? w : least));
  return {
    state: "ready",
    checkedAt: limits.checkedAt,
    windows,
    summary: {
      kind,
      limiting,
      scope: ofKind.length > 1 && limiting !== null ? limiting.window.label : null,
    },
  };
}

function buildRows(
  providers: ReadonlyArray<ServerProvider>,
  connected: boolean,
  now: number,
): ReadonlyArray<ProviderRow> {
  const rank = (provider: ServerProvider) => {
    const index = PRIMARY_DRIVERS.indexOf(provider.driver);
    return index < 0 ? PRIMARY_DRIVERS.length : index;
  };
  const shown = providers
    .filter(
      (provider) =>
        provider.enabled && (VENDORS.has(provider.driver) || provider.usageLimits !== undefined),
    )
    .toSorted((a, b) => rank(a) - rank(b));
  return shown.map((provider) => {
    const vendor = VENDORS.get(provider.driver);
    const duplicated = shown.filter((other) => other.driver === provider.driver).length > 1;
    const name = provider.displayName ?? provider.instanceId;
    return {
      provider,
      label: vendor === undefined ? name : duplicated ? vendor + " · " + name : vendor,
      quota: quotaOf(provider, connected, now),
    };
  });
}

function formatCountdown(resetMs: number, now: number): string {
  const minutes = Math.floor((resetMs - now) / 60_000);
  if (minutes < 1) return "1分未満";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return days + "日" + hours + "時間";
  if (hours > 0) return hours + "時間" + (minutes % 60) + "分";
  return minutes + "分";
}

function resetText(view: WindowView, now: number, prefix = "リセットまであと"): string {
  if (view.resetMs === null) return "リセット時刻不明";
  if (view.expired) return "更新待ち";
  return prefix + formatCountdown(view.resetMs, now);
}

/** One representative of each primary driver first, so extra accounts never hide a vendor. */
function headerRows(rows: ReadonlyArray<ProviderRow>): ReadonlyArray<ProviderRow> {
  const picked = new Set<ProviderRow>();
  for (const driver of PRIMARY_DRIVERS) {
    const first = rows.find((row) => row.provider.driver === driver);
    if (first !== undefined) picked.add(first);
  }
  for (const row of rows) {
    if (picked.size >= MAX_HEADER_ROWS) break;
    picked.add(row);
  }
  return rows.filter((row) => picked.has(row));
}

function formatTime(value: string | number): string {
  return new Date(value).toLocaleString("ja-JP");
}

function HeaderRow({ row, now }: { readonly row: ProviderRow; readonly now: number }) {
  const { quota } = row;
  let content;
  if (quota.state !== "ready") {
    content = (
      <span className="shrink-0 text-muted-foreground">{STATE_TEXT[quota.state].short}</span>
    );
  } else if (quota.summary.limiting === null) {
    content = (
      <span className="shrink-0 text-muted-foreground">{quota.summary.kind.short} 更新待ち</span>
    );
  } else {
    const { kind, limiting, scope } = quota.summary;
    content = (
      <>
        <span className="shrink-0">{kind.short}</span>
        <span
          role="progressbar"
          aria-label={row.label + " " + kind.name + "の残り"}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={limiting.remaining}
          aria-valuetext={limiting.remaining + "%"}
          className="hidden h-1 w-6 shrink-0 overflow-hidden rounded-full bg-muted @xl/header-actions:block"
        >
          <span className="block h-full bg-primary" style={{ width: limiting.remaining + "%" }} />
        </span>
        <span className="shrink-0 tabular-nums">{limiting.remaining}%</span>
        {scope === null ? null : (
          <span className="hidden min-w-0 truncate text-muted-foreground @xl/header-actions:inline">
            {scope}
          </span>
        )}
        <span className="shrink-0 text-muted-foreground">{resetText(limiting, now, "あと")}</span>
      </>
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-1">
      <span className="min-w-0 max-w-20 shrink truncate font-medium">{row.label}</span>
      {content}
    </span>
  );
}

function ProviderDetails({ row, now }: { readonly row: ProviderRow; readonly now: number }) {
  const { provider, quota } = row;
  return (
    <section className="space-y-0.5">
      <p className="font-medium">
        {row.label}{" "}
        <span className="font-normal text-muted-foreground">
          {provider.displayName === undefined
            ? provider.instanceId
            : provider.displayName + " (" + provider.instanceId + ")"}{" "}
          · {provider.driver}
        </span>
      </p>
      {quota.state !== "ready" ? (
        <p className="text-muted-foreground">{STATE_TEXT[quota.state].detail}</p>
      ) : (
        <>
          <p className="text-muted-foreground">最終取得 {formatTime(quota.checkedAt)}</p>
          <ul className="space-y-0.5">
            {quota.windows.map((view) => (
              <li key={view.window.id}>
                {KINDS.find((kind) => kind.kind === view.window.kind)?.name} · {view.window.label}:{" "}
                {view.expired ? "更新待ち" : "残り " + view.remaining + "%"} ·{" "}
                {view.resetMs === null
                  ? "リセット時刻不明"
                  : "リセット " +
                    formatTime(view.resetMs) +
                    (view.expired ? "" : "（" + resetText(view, now) + "）")}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/**
 * The environment's subscription quotas, one header line per provider, regardless of
 * which thread or provider is selected. Only the snapshots the server already publishes
 * are read; no account identity is shown beyond the configured instance name.
 */
export const ProviderQuotaMeters = memo(function ProviderQuotaMeters(props: {
  readonly environmentId: EnvironmentId;
}) {
  const { environmentId } = props;
  const connectionResult = useAtomValue(environmentCatalog.stateAtom(environmentId));
  // A Failure keeps the last connected snapshot as previousSuccess; only a settled
  // Success counts as connected.
  const connected =
    connectionResult._tag === "Success" && connectionResult.value.phase === "connected";
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const [, setTick] = useState(0);
  // Read per render so a late snapshot is judged against the current time.
  const now = Date.now();
  const rows = buildRows(serverConfig?.providers ?? [], connected, now);
  let nextResetMs: number | null = null;
  for (const row of rows) {
    if (row.quota.state !== "ready") continue;
    for (const view of row.quota.windows) {
      if (view.resetMs === null || view.expired) continue;
      if (nextResetMs === null || view.resetMs < nextResetMs) nextResetMs = view.resetMs;
    }
  }
  // One timer while a future reset exists: it re-renders each minute and exactly at the
  // nearest reset, where the changed reset time replaces the effect.
  useEffect(() => {
    if (nextResetMs === null) return;
    let timer: ReturnType<typeof setTimeout>;
    // A reset that passed between the render and this effect fires at once, so the
    // render that follows replaces the stale value.
    const arm = () => {
      const remaining = nextResetMs - Date.now();
      timer = setTimeout(
        () => {
          setTick((value) => value + 1);
          if (nextResetMs > Date.now()) arm();
        },
        Math.max(0, Math.min(REFRESH_INTERVAL_MS, remaining)),
      );
    };
    arm();
    return () => clearTimeout(timer);
  }, [nextResetMs]);
  const shownRows = headerRows(rows);
  const hiddenRows = rows.length - shownRows.length;
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Provider subscription quotas"
            className="flex w-44 min-w-0 shrink flex-col items-stretch rounded-sm px-1 text-3xs leading-3 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring @xl/header-actions:w-64"
          />
        }
      >
        {rows.length === 0 ? (
          <span className="truncate text-muted-foreground">
            契約枠 {connected ? "未取得" : "未接続"}
          </span>
        ) : (
          shownRows.map((row) => <HeaderRow key={row.provider.instanceId} row={row} now={now} />)
        )}
        {hiddenRows > 0 ? (
          <span className="truncate text-muted-foreground">他 {hiddenRows} 件</span>
        ) : null}
      </PopoverTrigger>
      <PopoverPopup width="sm" align="start">
        <div className="space-y-2 text-xs">
          {rows.length === 0 ? (
            <p className="text-muted-foreground">
              {connected
                ? "契約枠を表示できるプロバイダーがない"
                : "環境に接続されていないため取得できない"}
            </p>
          ) : (
            rows.map((row) => <ProviderDetails key={row.provider.instanceId} row={row} now={now} />)
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
});
